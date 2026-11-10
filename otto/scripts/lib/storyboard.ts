// Storyboard definition: what the agent writes per issue (videos/<KEY>/storyboard.ts).
import type { Lang } from './tts.ts';
import type { UI } from './fast-driver.ts';
import type { Demo } from './demo.ts';
import type { Viewport } from './session.ts';

/** A text in one language, or per language when the video must be renderable in both. */
export type Localized = string | Partial<Record<Lang, string>>;

export type Story = {
  key: string;
  title: Localized;
  type?: string; // Story, Bug, ...
  summary?: Localized;
  /** Language the story is written in; decides the narration language unless --lang overrides. */
  language?: Lang;
  /** `say`: optional spoken version for the chapter announcement (default: the text, or just the number when long). */
  acceptance: Array<{ id: string; text: Localized; say?: Localized }>;
  /** Short bullets for the title card: what changed for the user. */
  changes?: Localized[];
  /** Selectors of changed UI elements (from changed-ui.ts). Review checks each one gets annotated. */
  changedUi?: string[];
  /** One line shown on the title card, e.g. "Test data: Maija Meikäläinen (customer 1001)". */
  testData?: Localized;
  app?: string;
};

export type StoryboardDef = {
  story: Story;
  /** App repo (relative to the storyboard file) for the branch and commit shown on the cards. */
  repo?: string;
  baseUrl?: string;
  lang?: Lang | 'auto';
  pace?: 'calm' | 'normal' | 'brisk';
  viewport?: Viewport;
  ignoreRequests?: RegExp[];
  /** Make the run repeatable: restore test data. Runs before setup, in dry and real runs. */
  reset?: () => Promise<void> | void;
  /** Off camera, fast: sign in, open the starting page. */
  setup?: (ui: UI) => Promise<void>;
  /** On camera: the human-paced walkthrough. */
  scenes: (demo: Demo) => Promise<void>;
};

export function storyboard(def: StoryboardDef): StoryboardDef {
  return def;
}

export const LABELS: Record<Lang, Record<string, string>> = {
  en: {
    changes: 'What changed',
    criterion: 'Acceptance criterion',
    of: 'of',
    verified: 'Acceptance criteria verified',
    outroKicker: 'Summary',
    previously: 'Previously',
    branch: 'branch',
    recorded: 'recorded',
  },
  fi: {
    changes: 'Mitä muuttui',
    criterion: 'Hyväksymiskriteeri',
    of: '/',
    verified: 'Hyväksymiskriteerit todennettu',
    outroKicker: 'Yhteenveto',
    previously: 'Aiemmin',
    branch: 'haara',
    recorded: 'tallennettu',
  },
};

/**
 * Narration markup `{written|spoken}`: captions and the screen show `written`, the voice gets `spoken`.
 * Use it for every number in Finnish (`{35|kolmeenkymmeneenviiteen}` laatikkoon): digits carry no case,
 * so the voice would guess the base form. Also for codes and abbreviations (`{AB-104|aa bee sataneljä}`).
 */
const MARKUP = /\{([^{}|]*)\|([^{}]*)\}/g;
export const written = (s: string) => s.replace(MARKUP, '$1');
export const spoken = (s: string) => s.replace(MARKUP, '$2');

/** The text for a language, markup kept (for narration). Throws when a forced language has no variant. */
export function pickRaw(text: Localized | undefined, lang: Lang): string {
  if (text == null) return '';
  if (typeof text === 'string') return text;
  const v = text[lang];
  if (v == null) throw new Error(`Missing "${lang}" text for ${JSON.stringify(text).slice(0, 80)}. Add a ${lang} variant or drop --lang.`);
  return v;
}

/** The text for a language as shown on screen (markup resolved to its written form). */
export function pick(text: Localized | undefined, lang: Lang): string {
  return written(pickRaw(text, lang));
}

const FI_WORDS = /\b(ja|on|kun|että|tai|ei|se|asiakas|asiakkaan|tulee|näkyy|voi|jos|myös|uusi|kenttä|painike|tilaus)\b/gi;

export function detectLanguage(story: Story): Lang {
  if (story.language) return story.language;
  const sample = [story.title, story.summary, ...story.acceptance.map((a) => a.text)]
    .map((t) => (typeof t === 'string' ? t : Object.values(t ?? {})[0] ?? ''))
    .join(' ');
  const fiHits = (sample.match(FI_WORDS) ?? []).length + (sample.match(/[äö]/gi) ?? []).length * 0.3;
  const words = sample.split(/\s+/).length || 1;
  return fiHits / words > 0.06 ? 'fi' : 'en';
}
