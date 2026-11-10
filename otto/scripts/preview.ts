// Preview annotations on a live page without recording: opens a tab, draws the overlay, takes a screenshot.
// Handy while writing a storyboard (does the callout cover something? is the text readable?).
//
//   node otto/scripts/preview.ts / \
//     --annotate '#priority::Priority::Low, Normal or High.' --badge NEW --out /tmp/p.png
//
// --annotate 'selector::title::text' can repeat (numbered when more than one). --caption adds a caption line.
// --click <selector> clicks first (fast, no pacing). --placement auto|right|left|top|bottom.
// Reuses the cookies of the Chrome on --port: sign in once (e.g. with a dry run) and previews open logged in.
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectBrowser } from './lib/cdp.ts';
import { loadEnv } from './lib/env.ts';
import { PageSession } from './lib/session.ts';
import { overlaySource } from './lib/overlay-source.ts';
import { FastDriver } from './lib/fast-driver.ts';

loadEnv();

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    annotate: { type: 'string', multiple: true, default: [] },
    click: { type: 'string', multiple: true, default: [] },
    badge: { type: 'string' },
    tone: { type: 'string', default: 'new' },
    placement: { type: 'string', default: 'auto' },
    caption: { type: 'string' },
    spotlight: { type: 'boolean', default: false },
    out: { type: 'string', default: 'preview.png' },
    port: { type: 'string', default: process.env.CDP_PORT ?? '9333' },
    base: { type: 'string', default: process.env.APP_URL ?? 'http://localhost:3000' },
  },
});
if (!positionals[0]) {
  console.error("usage: node preview.ts <url> --annotate 'selector::title::text' [--click sel] [--caption text] [--out file.png]");
  process.exit(1);
}

const cdp = await connectBrowser(Number(o.port));
const s = await PageSession.open(cdp, {
  baseUrl: o.base!, viewport: { width: 1600, height: 900, dpr: 1.2 },
  overlaySource: overlaySource(),
});
try {
  const ui = new FastDriver(s);
  await ui.goto(positionals[0]);
  await s.settle(300, 8000);
  for (const c of o.click!) {
    await ui.click(c);
    await s.settle(300, 8000);
  }
  await s.overlay('activate', { cursor: { x: -100, y: -100, visible: false } });
  if (o.caption) await s.overlay('caption', o.caption);
  const many = o.annotate!.length > 1;
  for (const [i, spec] of o.annotate!.entries()) {
    const [selector, title, text] = spec.split('::');
    await s.overlay('scrollTo', selector);
    const info = await s.overlay<Record<string, unknown>>('annotate', {
      id: `p${i}`, selector, title, text, badge: o.badge, tone: o.tone, spotlight: o.spotlight, placement: o.placement, number: many ? i + 1 : undefined,
    });
    console.log(`${selector}: ${JSON.stringify(info)}`);
  }
  await new Promise((r) => setTimeout(r, 700));
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(o.out!, Buffer.from(data, 'base64'));
  console.log(`screenshot: ${resolve(o.out!)}`);
} finally {
  await s.close();
  cdp.close();
}
