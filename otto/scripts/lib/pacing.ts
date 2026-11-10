// Pacing presets. All times in ms. "normal" is tuned so a person who has never seen the screen can follow.
export type Pace = {
  cursorBase: number; // cursor travel time (Fitts's law) = 0.6 * base + 300 * perPx * log2(1 + distance / 40), clamped to [cursorMin, cursorMax]
  cursorPerPx: number;
  cursorMin: number;
  cursorMax: number;
  hoverDwell: number; // rest on the target before clicking
  typeMin: number; // per-character typing delay range
  typeMax: number;
  typeFastAfter: number; // after this much typing, speed up (long texts)
  settleQuiet: number; // DOM + network quiet period that counts as "the UI reacted"
  observe: number; // pause after the UI settles so the viewer sees the result
  readBase: number; // annotation/caption minimum hold = readBase + perWord * words
  readPerWord: number;
  speechGap: number; // silence between narration lines
  bannerMs: number; // chapter banner hold
  cardMinMs: number; // title/outro card minimum hold
};

export const PACES: Record<string, Pace> = {
  calm: { cursorBase: 450, cursorPerPx: 0.62, cursorMin: 380, cursorMax: 1300, hoverDwell: 320, typeMin: 70, typeMax: 125, typeFastAfter: 3000, settleQuiet: 350, observe: 750, readBase: 1500, readPerWord: 300, speechGap: 380, bannerMs: 2200, cardMinMs: 5000 },
  normal: { cursorBase: 360, cursorPerPx: 0.5, cursorMin: 320, cursorMax: 1100, hoverDwell: 240, typeMin: 50, typeMax: 95, typeFastAfter: 2500, settleQuiet: 300, observe: 550, readBase: 1200, readPerWord: 260, speechGap: 280, bannerMs: 1900, cardMinMs: 4200 },
  brisk: { cursorBase: 260, cursorPerPx: 0.36, cursorMin: 240, cursorMax: 800, hoverDwell: 160, typeMin: 32, typeMax: 62, typeFastAfter: 1800, settleQuiet: 250, observe: 350, readBase: 900, readPerWord: 210, speechGap: 180, bannerMs: 1500, cardMinMs: 3400 },
};

export const readingMs = (p: Pace, text: string) => p.readBase + p.readPerWord * text.trim().split(/\s+/).filter(Boolean).length;
