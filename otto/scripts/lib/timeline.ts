// The recording timeline: everything that happened, with times in ms from capture start.
// `cuts` are stretches removed at render (page loads, TTS waits); mapTime() converts recording time to
// output time.
export type Cut = { start: number; end: number; reason: string };
export type TimelineEvent = { t: number; type: string; [k: string]: unknown };
/** text: the caption; spoken: what the voice was given; heard: what an independent transcription heard in the audio. */
export type Narration = { t: number; text: string; spoken?: string; wav: string | null; durationMs: number; id: number; transcript?: string; match?: number; heard?: string; heardMatch?: number; heardOk?: boolean; heardProblems?: string[] };
export type Chapter = { t: number; id: string; title: string; verified: boolean };

export type Timeline = {
  meta: Record<string, unknown>;
  durationMs: number;
  events: TimelineEvent[];
  cuts: Cut[];
  narration: Narration[];
  chapters: Chapter[];
};

export function mergeCuts(cuts: Cut[], minMs = 120): Cut[] {
  const sorted = cuts.filter((c) => c.end - c.start >= minMs).sort((a, b) => a.start - b.start);
  const out: Cut[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      last.reason = last.reason === c.reason ? last.reason : `${last.reason}+${c.reason}`;
    } else out.push({ ...c });
  }
  return out;
}

/** Recording time -> output time. A time inside a cut maps to the cut's start. */
export function mapTime(t: number, cuts: Cut[]): number {
  let removed = 0;
  for (const c of cuts) {
    if (c.end <= t) removed += c.end - c.start;
    else if (c.start < t) return c.start - removed;
    else break;
  }
  return t - removed;
}

export function keepSegments(cuts: Cut[], durationMs: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let pos = 0;
  for (const c of cuts) {
    if (c.start > pos) out.push({ start: pos, end: Math.min(c.start, durationMs) });
    pos = Math.max(pos, c.end);
  }
  if (pos < durationMs) out.push({ start: pos, end: durationMs });
  return out.filter((s) => s.end - s.start > 1);
}

export function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
