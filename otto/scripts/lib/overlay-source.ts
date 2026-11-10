// What gets injected into every document of the recording tab: the overlay and its bundled fonts.
import { readFileSync } from 'node:fs';

/** Archivo SemiCondensed (SIL OFL, see fonts/OFL.txt), static cuts of weights 300-600: the overlay can't fetch anything, so the fonts travel with it. */
const WEIGHTS = [300, 400, 500, 600];

/**
 * OTTO_THEME: a path to a JSON file, or the JSON itself, with any of pen, penText, penLarge, ink, ink2, ink3, hair, rule, ground, paper, paperEdge
 * (colors) and font (the name of a font installed on this machine).
 */
function themeSource(): string {
  const raw = process.env.OTTO_THEME;
  if (!raw) return '';
  const json = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
  let theme: unknown;
  try {
    theme = JSON.parse(json);
  } catch (e) {
    throw new Error(`OTTO_THEME is not valid JSON: ${(e as Error).message}`);
  }
  return `window.__ottoTheme = ${JSON.stringify(theme)};\n`;
}

export function overlaySource(): string {
  const file = (name: string) => new URL(name, import.meta.url);
  const fonts = Object.fromEntries(WEIGHTS.map((w) => [w, readFileSync(file(`fonts/archivo-semi-condensed-${w}.woff2`)).toString('base64')]));
  return `${themeSource()}if (!window.__otto) window.__ottoFontData = ${JSON.stringify(fonts)};\n${readFileSync(file('overlay.js'), 'utf8')}`;
}
