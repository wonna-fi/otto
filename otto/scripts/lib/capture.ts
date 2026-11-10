// Screencast capture: CDP Page.startScreencast frames -> ffmpeg -> constant-frame-rate intermediate mp4.
// Chrome only sends a frame when the page changes, so each frame is repeated until the next one arrives.
// Time 0 of the output is the moment start() was called (Date.now() clock, same as the timeline).
import { spawn, type ChildProcess } from 'node:child_process';
import type { PageSession } from './session.ts';

export type CaptureOpts = { fps: number; width: number; height: number; quality?: number; ffmpeg?: string };

export class Capture {
  private s: PageSession;
  private opts: CaptureOpts;
  private ff: ChildProcess | null = null;
  private off: (() => void) | null = null;
  private last: Buffer | null = null;
  private written = 0;
  private offsets: number[] = [];
  private offset: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private ffErr = '';
  t0 = 0;
  frames = 0;
  outPath = '';

  constructor(s: PageSession, opts: CaptureOpts) {
    this.s = s;
    this.opts = opts;
  }

  async start(outPath: string) {
    this.outPath = outPath;
    const { fps } = this.opts;
    this.ff = spawn(this.opts.ffmpeg ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
      '-vf', `scale=${this.opts.width}:${this.opts.height}:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-r', String(fps), outPath,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    this.ff.stderr!.on('data', (d) => (this.ffErr += String(d)));
    this.t0 = Date.now();
    this.off = this.s.cdp.on('Page.screencastFrame', (p, sid) => {
      if (sid !== this.s.sessionId) return;
      this.s.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      const recv = Date.now();
      const meta = (p.metadata?.timestamp ?? recv / 1000) * 1000;
      // Align Chrome's frame clock to ours with a running median of (receive - frame) offsets.
      this.offsets.push(recv - meta);
      if (this.offsets.length > 41) this.offsets.shift();
      this.offset = [...this.offsets].sort((a, b) => a - b)[this.offsets.length >> 1];
      const t = Math.max(0, Math.min(meta + this.offset, recv) - this.t0);
      const buf = Buffer.from(p.data, 'base64');
      this.queue = this.queue.then(() => this.onFrame(buf, t));
      this.frames++;
    });
    await this.s.send('Page.startScreencast', { format: 'jpeg', quality: this.opts.quality ?? 90, maxWidth: this.opts.width, maxHeight: this.opts.height, everyNthFrame: 1 });
  }

  private async write(buf: Buffer) {
    if (!this.ff?.stdin?.writable) return;
    if (!this.ff.stdin.write(buf)) await new Promise<void>((r) => this.ff!.stdin!.once('drain', () => r()));
  }

  private async onFrame(buf: Buffer, tMs: number) {
    const frameMs = 1000 / this.opts.fps;
    const target = Math.floor(tMs / frameMs);
    if (!this.last) this.last = buf; // fill from 0 with the first frame
    while (this.written < target) {
      await this.write(this.last);
      this.written++;
    }
    this.last = buf;
  }

  /** Current position in the capture timeline (ms). */
  now() {
    return Date.now() - this.t0;
  }

  async stop(): Promise<{ durationMs: number; frames: number }> {
    await this.s.send('Page.stopScreencast').catch(() => {});
    this.off?.();
    const end = this.now();
    await this.queue;
    const frameMs = 1000 / this.opts.fps;
    const target = Math.ceil(end / frameMs);
    if (this.last) while (this.written < target) { await this.write(this.last); this.written++; }
    this.ff!.stdin!.end();
    const code: number = await new Promise((r) => this.ff!.on('close', r));
    if (code !== 0) throw new Error(`ffmpeg capture failed (${code}): ${this.ffErr.slice(-500)}`);
    if (!this.frames) throw new Error('No screencast frames were received. Is the tab visible and painting?');
    return { durationMs: this.written * frameMs, frames: this.frames };
  }
}
