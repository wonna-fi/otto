// Changed UI from a git diff: which new or changed elements could the video annotate?
//
//   node otto/scripts/changed-ui.ts --repo <app repo> [--base main] [--app <base url>] [--url /path ...]
//        [--login <module.ts>#<export>] [--json]
//
// --login runs a UI flow first (e.g. <ui-skill>/scripts/login.ts#login) so pages behind a sign-in open.
//
// Reads the added lines of UI files in `git diff <base>...HEAD`, pulls out test ids, ids, names, labels
// and visible texts, and turns them into selectors. With --url (repeatable) it opens each page in the
// Chrome on --port and reports which selectors match a visible element there.
// It is a heuristic starting point: confirm with chrome-devtools-axi snapshot, and add what it misses.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { connectBrowser } from './lib/cdp.ts';
import { loadEnv } from './lib/env.ts';
import { PageSession } from './lib/session.ts';
import { overlaySource } from './lib/overlay-source.ts';
import { FastDriver } from './lib/fast-driver.ts';
import { pathToFileURL } from 'node:url';

loadEnv();

const { values: o } = parseArgs({
  options: {
    repo: { type: 'string', default: '.' },
    base: { type: 'string', default: 'main' },
    url: { type: 'string', multiple: true, default: [] },
    port: { type: 'string', default: process.env.CDP_PORT ?? '9333' },
    app: { type: 'string', default: process.env.APP_URL ?? 'http://localhost:3000' },
    json: { type: 'boolean', default: false },
    login: { type: 'string' },
  },
});

const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|marko|riot|tag|html?|hbs|handlebars|mustache|njk|twig|erb|haml|php|cshtml|razor|jsp|ejs)$|(pages|views|templates|components)\/.*\.(ts|js)$/;
const repo = resolve(o.repo!);
const diff = execFileSync('git', ['diff', '-U0', `${o.base}...HEAD`], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

type Cand = { selector: string; kind: string; file: string; line: string };
const cands = new Map<string, Cand>();
const add = (selector: string, kind: string, file: string, line: string) => {
  if (!cands.has(selector)) cands.set(selector, { selector, kind, file, line: line.trim().slice(0, 140) });
};

let file = '';
for (const raw of diff.split('\n')) {
  if (raw.startsWith('+++ ')) { file = raw.slice(6); continue; }
  if (!raw.startsWith('+') || raw.startsWith('+++') || !UI_FILE.test(file)) continue;
  const line = raw.slice(1);
  for (const m of line.matchAll(/data-testid=(?:\{?["'`])([\w:.-]+)["'`]/g)) add(`[data-testid=${m[1]}]`, 'test id', file, line);
  for (const m of line.matchAll(/\bid=(?:\{?["'`])([A-Za-z][\w:-]*)["'`]/g)) add(`#${m[1]}`, 'id', file, line);
  for (const m of line.matchAll(/\bname=(?:\{?["'`])([\w-]+)["'`]/g)) add(`[name=${m[1]}]`, 'name', file, line);
  // Visible texts of labels, headings, buttons, table headers, options
  for (const m of line.matchAll(/<(label|h[1-4]|button|th|option|legend|a)\b[^>]*>([^<>{}]{3,60})</g)) {
    const text = m[2].trim();
    if (text && !/^[\W\d]+$/.test(text)) add(`text=${text}`, `${m[1]} text`, file, line);
  }
}

let found: Record<string, string[]> = {};
if (o.url!.length && cands.size) {
  const cdp = await connectBrowser(Number(o.port));
  const s = await PageSession.open(cdp, {
    baseUrl: o.app!, viewport: { width: 1600, height: 900, dpr: 1 },
    overlaySource: overlaySource(),
  });
  try {
    if (o.login) {
      const [mod, name] = o.login.split('#');
      const fn = (await import(pathToFileURL(resolve(mod)).href))[name ?? 'default'];
      await fn(new FastDriver(s));
    }
    for (const url of o.url!) {
      await s.goto(url);
      await s.settle(300, 8000);
      const hits = await s.eval((sels: string[]) => sels.filter((sel) => {
        // @ts-ignore injected
        const el = __find(sel) as HTMLElement | null;
        return !!el && el.getBoundingClientRect().width > 0;
      }), [...cands.keys()]);
      for (const h of hits) (found[h] ??= []).push(url);
    }
  } finally {
    await s.close();
    cdp.close();
  }
}

const list = [...cands.values()].map((c) => ({ ...c, pages: found[c.selector] ?? [] }));
if (o.json) console.log(JSON.stringify(list, null, 2));
else {
  console.log(`${list.length} candidate selectors from ${o.base}...HEAD in ${repo}${o.url!.length ? ` (checked on ${o.url!.join(', ')})` : ''}\n`);
  for (const c of list) {
    const where = o.url!.length ? (c.pages.length ? `  on ${c.pages.join(', ')}` : '  (not on the checked pages)') : '';
    console.log(`${c.selector.padEnd(44)} ${c.kind.padEnd(12)} ${c.file}${where}`);
  }
}
