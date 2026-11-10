// Test helpers: a throwaway headless Chrome (own port, own temporary profile) and a small page server.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectBrowser, type CdpClient } from '../scripts/lib/cdp.ts';
import { overlaySource } from '../scripts/lib/overlay-source.ts';
import { PageSession } from '../scripts/lib/session.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tempDirs: string[] = [];
process.on('exit', () => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

/** A temporary directory, removed when the test file ends. */
export function tempDir(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `otto-test-${name}-`));
  tempDirs.push(dir);
  return dir;
}

export type TestChrome = { cdp: CdpClient; port: number; proc: ChildProcess; profile: string; close: () => Promise<void> };

export async function startChrome(extraFlags: string[] = []): Promise<TestChrome> {
  const profile = mkdtempSync(join(tmpdir(), 'otto-test-chrome-'));
  const proc = spawn(process.env.CHROME_BIN ?? 'google-chrome', [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--headless=new',
    '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000',
    ...(process.env.OTTO_TEST_CHROME_FLAGS?.split(' ').filter(Boolean) ?? []), ...extraFlags, 'about:blank',
  ], { stdio: 'ignore' });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
  }
  if (!port) { proc.kill('SIGKILL'); throw new Error('Chrome did not start'); }
  const cdp = await connectBrowser(port);
  return {
    cdp, port, proc, profile,
    close: async () => {
      cdp.close();
      const gone = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await Promise.race([gone, sleep(3000)]);
      proc.kill('SIGKILL');
      await sleep(100);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export type TestServer = { base: string; close: () => void };

/** Serves the given pages by path. A function page gets the request and can answer by itself. */
export async function serve(pages: Record<string, string | ((req: http.IncomingMessage, res: http.ServerResponse) => void)>): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    const page = pages[(req.url ?? '/').split('?')[0]];
    if (page === undefined) return void res.writeHead(404).end();
    if (typeof page === 'function') return page(req, res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

export function openSession(c: TestChrome, baseUrl: string) {
  return PageSession.open(c.cdp, { baseUrl, viewport: { width: 1600, height: 900, dpr: 1 }, overlaySource: overlaySource() });
}
