// The human-paced driver handed to storyboard scenes. Implements the same UI interface as the fast driver
// (so the UI skill's flow functions run unchanged) plus the video-only extras: narration, captions,
// chapters, annotations, verification callouts and cards.
//
// mode 'dry':    no capture, no pacing, no TTS. Validates selectors and the flow, collects narration lines.
// mode 'record': visible cursor, human timing, overlay, narration timing, timeline + cuts for the renderer.
import type { PageSession, Rect } from './session.ts';
import type { Capture } from './capture.ts';
import type { Cut, Timeline, TimelineEvent } from './timeline.ts';
import { checkFilled, deleteSelection, FastDriver, KEYS, optionIndex, pressKey, selectField, setSelect, type UI, type WaitOpts } from './fast-driver.ts';
import { readingMs, type Pace } from './pacing.ts';
import { Tts, type Lang } from './tts.ts';
import { labelsFor, pick, pickRaw, spoken as spokenForm, written, type Localized, type Story } from './storyboard.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
/** How long a slip takes to appear (its fade-in in overlay.js); it can't be read before that. */
export const SLIP_IN_MS = 500;
/** A wait longer than this is shortened in the video: the viewer sees it start and end, not all of it. */
const LONG_WAIT_MS = 2000;
const WAIT_HEAD_MS = 900;
const WAIT_TAIL_MS = 300;
const pointInside = (p: { x: number; y: number }, r: Rect) => p.x >= r.x + 1 && p.x <= r.x + r.width - 1 && p.y >= r.y + 1 && p.y <= r.y + r.height - 1;

export type AnnotateOpts = {
  /** NEW (default), CHANGED, REMOVED, or any short text. false hides the badge. */
  badge?: string | false;
  tone?: 'new' | 'changed' | 'removed' | 'info' | 'success' | 'error';
  title?: Localized;
  text?: Localized;
  /** Shown as "Previously: ..." under the text. */
  previously?: Localized;
  placement?: 'auto' | 'right' | 'left' | 'top' | 'bottom';
  spotlight?: boolean;
  number?: number;
  /** Keep this annotation when the next one is added (default: the next one replaces it). */
  keep?: boolean;
  /** How long to hold before continuing. Default: reading time, or until the current narration ends. 0 = don't wait. */
  hold?: number;
  /** Move the cursor next to the element while it is explained. */
  point?: boolean;
  id?: string;
};

export type DemoContext = {
  mode: 'dry' | 'record';
  session: PageSession;
  pace: Pace;
  lang: Lang;
  tts: Tts;
  capture: Capture | null;
  timeline: Timeline;
  story: Story;
  footer: string;
  log: (line: string) => void;
};

type DialogPlan = { accept: boolean; value?: string };

export class Demo implements UI {
  private c: DemoContext;
  private s: PageSession;
  private fast: FastDriver;
  private t0 = Date.now();
  private cursor = { x: 800, y: 470 };
  private chip: { label: string; title: string } | null = null;
  private captionText: string | null = null;
  private speechUntil = 0;
  private captionTimer: NodeJS.Timeout | null = null;
  private annCounter = 0;
  private kept = new Set<string>();
  private transient: string | null = null;
  private transientSel: string | null = null;
  private dialogPlan: DialogPlan[] = [];
  private lastAction: { kind: 'click'; selector: string; x: number; y: number } | { kind: 'press'; key: string } | null = null;
  /** Narration queue: each line starts after the previous one; actions wait until queued lines have started. */
  private sayChain: Promise<void> = Promise.resolve();
  private speechError: Error | null = null;
  private stepNo = 0;
  private currentChapter: string | null = null;
  /** Narration lines seen (dry runs write these for TTS prefetch). */
  readonly lines: Array<{ text: string; lang: Lang; caption?: string }> = [];
  /** Problems found while running; reported by review. */
  readonly warnings: string[] = [];

  constructor(c: DemoContext) {
    this.c = c;
    this.s = c.session;
    this.fast = new FastDriver(c.session);
    this.s.onNavStart = null;
  }

  get dry() {
    return this.c.mode === 'dry';
  }
  get lang() {
    return this.c.lang;
  }
  /** The fast driver, for flows that should run without pacing (still on camera). */
  get quick(): UI {
    return this.fast;
  }

  now() {
    return this.c.capture ? this.c.capture.now() : Date.now() - this.t0;
  }

  private event(type: string, data: Record<string, unknown> = {}) {
    const e: TimelineEvent = { t: this.now(), type, step: this.stepNo, chapter: this.currentChapter, ...data };
    this.c.timeline.events.push(e);
    return e;
  }

  private addCut(start: number, end: number, reason: string) {
    if (end - start < 120) return;
    const cut: Cut = { start, end, reason };
    this.c.timeline.cuts.push(cut);
    // Speech keeps playing in output time, so a cut during narration pushes its end back.
    if (this.speechUntil > start) this.speechUntil += end - start;
    this.armCaptionHide();
  }

  /** Slow pages shouldn't make a slow video. Narration keeps playing across the cut, as with page loads. */
  private trimWait(start: number) {
    if (this.dry) return;
    const end = this.now();
    if (end - start > LONG_WAIT_MS) this.addCut(start + WAIT_HEAD_MS, end - WAIT_TAIL_MS, 'wait');
  }

  private async step<T>(labelOf: string | (() => Promise<string>), fn: () => Promise<T>): Promise<T> {
    if (!this.dry) await this.sayChain;
    if (this.speechError) throw this.speechError;
    this.stepNo++;
    const n = this.stepNo;
    const label = typeof labelOf === 'string' ? labelOf : await labelOf();
    this.c.log(`  ${String(n).padStart(3)} ${(this.now() / 1000).toFixed(1).padStart(6)}s  ${label}`);
    try {
      return await fn();
    } catch (e) {
      const err = new Error(`Step ${n} (${label}) failed: ${(e as Error).message}`);
      (err as any).step = n;
      throw err;
    }
  }

  /**
   * A non-kept annotation stays while the presenter works on that element (typing into the highlighted
   * field), and goes away as soon as they act on something else.
   */
  private async release(selector: string) {
    if (this.dry || !this.transient || !this.transientSel) return;
    const inside = await this.s.eval((ann: string, sel: string) => {
      // @ts-ignore injected
      const a = __find(ann) as Element | null, t = __find(sel) as Element | null;
      return !!a && !!t && (a === t || a.contains(t));
    }, this.transientSel, selector).catch(() => false);
    if (inside) return;
    await this.s.overlay('unannotate', this.transient);
    this.event('annotation-off', { id: this.transient });
    this.transient = null;
    this.transientSel = null;
  }

  // ---------------- cursor & input primitives ----------------

  private async ensureVisible(selector: string, enabled = false): Promise<Rect> {
    const waitStart = this.now();
    await this.s.waitFor(selector, { timeout: 10000, enabled });
    this.trimWait(waitStart);
    if (this.dry) return (await this.s.rectOf(selector))!;
    const res = await this.s.overlay<{ ok: boolean; scrolled: boolean; rect: Rect }>('scrollTo', selector);
    if (res?.scrolled) {
      this.event('scroll', { selector });
      await sleep(180);
    }
    const r = await this.s.rectOf(selector);
    if (!r) throw new Error(`"${selector}" disappeared`);
    // Keep the caption off the element being used.
    await this.s.overlay('avoid', { x: r.x - 12, y: r.y - 12, width: r.width + 24, height: r.height + 24 });
    return r;
  }

  private async moveCursor(x: number, y: number, speed = 1) {
    const p = this.c.pace;
    const dist = Math.hypot(x - this.cursor.x, y - this.cursor.y);
    if (dist < 3) return;
    // Fitts's law: long moves are not proportionally slower; the hand covers most of the way fast and settles.
    const fitts = p.cursorBase * 0.6 + p.cursorPerPx * 300 * Math.log2(1 + dist / 40);
    const dur = Math.round(Math.min(p.cursorMax, Math.max(p.cursorMin, fitts)) / speed);
    const anim = this.s.overlay('cursorMove', x, y, dur, dist > 300 ? 0.1 : 0.06);
    // The real mouse follows the drawn cursor, so hover styles and mouseenter handlers fire under what the viewer sees.
    const steps = Math.max(4, Math.round(dur / 60));
    for (let i = 1; i <= steps; i++) {
      await sleep(dur / steps);
      const pos = await this.s.overlay<{ x: number; y: number }>('cursorPos').catch(() => null);
      if (pos) await this.s.mouse('mouseMoved', pos.x, pos.y).catch(() => {});
    }
    await anim;
    await this.s.mouse('mouseMoved', x, y).catch(() => {});
    this.cursor = { x, y };
    this.event('cursor', { x, y, dur });
  }

  private pointFor(r: Rect, kind: string): { x: number; y: number } {
    const isText = kind === 'text';
    const x = isText ? r.x + Math.min(r.width * 0.3, 110) : r.x + r.width / 2;
    return { x: Math.round(x), y: Math.round(r.y + r.height / 2) };
  }

  /**
   * Move the cursor to an element and make sure it is still there before anything presses. Content that loads late
   * can shift the page during the move, and a spinner or scrim can cover the target; the old point would hit
   * whatever is there now.
   */
  private async aim(selector: string, opts: { enabled?: boolean; point?: (r: Rect) => { x: number; y: number } } = {}) {
    const kind = opts.point ? '' : await this.kindOf(selector);
    const pointOf = opts.point ?? ((b: Rect) => this.pointFor(b, kind));
    let r = await this.ensureVisible(selector, opts.enabled);
    let pt = pointOf(r);
    await this.moveCursor(pt.x, pt.y);
    for (let i = 0; i < 3; i++) {
      const now = await this.s.rectOf(selector);
      if (!now) throw new Error(`"${selector}" disappeared while the cursor was moving to it`);
      r = now;
      if (pointInside(pt, now)) break;
      this.event('retarget', { selector, from: pt, rect: now });
      r = await this.ensureVisible(selector, opts.enabled);
      pt = pointOf(r);
      await this.moveCursor(pt.x, pt.y);
    }
    await this.s.waitUncovered(selector, pt);
    return { r, pt };
  }

  private async kindOf(selector: string): Promise<string> {
    return this.s.eval((sel: string) => {
      // @ts-ignore injected
      const el = __find(sel) as HTMLElement | null;
      if (!el) return 'none';
      if (el instanceof HTMLTextAreaElement) return 'text';
      if (el instanceof HTMLInputElement) return ['text', 'email', 'tel', 'number', 'password', 'search', 'url', 'date'].includes(el.type) ? 'text' : el.type;
      if (el instanceof HTMLSelectElement) return 'select';
      return 'other';
    }, selector);
  }

  /** After an action: handle intercepted JS dialogs, full reloads, then let the UI settle. */
  private async afterAction(navBefore: number, opts: { observe?: boolean; depth?: number; keepWait?: boolean } = {}) {
    await sleep(70);
    const d = await this.s.overlay<{ type: string; message: string; defaultValue: string; origin: string }>('takeDialog');
    if (d && (opts.depth ?? 0) < 2) {
      await this.showDialog(d);
      return;
    }
    // Settle first: a click can start a reload right away (link, form) or after an XHR (location.href = ...).
    const waitStart = this.now();
    await this.s.settle(this.c.pace.settleQuiet, 9000);
    if (this.s.navCount > navBefore) await this.onNavigation(navBefore);
    else if (!opts.keepWait) this.trimWait(waitStart);
    if (opts.observe !== false) await sleep(this.c.pace.observe);
  }

  private async onNavigation(navBefore: number) {
    const navStart = (this.s.navStartedAt || Date.now()) - (this.c.capture?.t0 ?? this.t0);
    this.event('navigation-start', { t: navStart });
    await this.s.waitForNavigation(navBefore, 20000);
    await this.s.resetMouse();
    await this.restoreOverlay();
    this.kept.clear();
    this.transient = null;
    await this.s.settle(this.c.pace.settleQuiet + 150, 9000);
    const settled = this.now();
    this.event('navigation-end', { url: await this.s.eval(() => location.pathname + location.search).catch(() => '') });
    // Cut the page load: keep a moment of the click and a moment before the new page is ready.
    this.addCut(navStart + 160, settled - 260, 'load');
  }

  private async restoreOverlay() {
    for (let i = 0; i < 40; i++) {
      const ok = await this.s.overlay('activate', {
        cursor: { ...this.cursor, visible: true },
        chip: this.chip,
        caption: this.now() < this.speechUntil ? this.captionText : null,
      });
      if (ok) return;
      await sleep(50);
    }
    this.warnings.push('Overlay did not come back after a page load');
  }

  private async showDialog(d: { type: string; message: string; defaultValue: string; origin: string }) {
    const plan = this.dialogPlan.shift() ?? { accept: true };
    this.event('dialog', { dialog: d.type, message: d.message, accept: plan.accept });
    this.c.log(`        ${d.type}("${d.message.slice(0, 60)}") -> ${plan.accept ? 'OK' : 'Cancel'}`);
    const btns = await this.s.overlay<{ ok: { x: number; y: number }; cancel: { x: number; y: number } | null; input: { x: number; y: number } | null }>('dialogShow', d);
    if (!btns) throw new Error('Could not show the dialog stand-in');
    await sleep(readingMs(this.c.pace, d.message) * 0.8);
    if (d.type === 'prompt' && plan.accept && plan.value != null && btns.input) {
      let typed = '';
      for (const ch of plan.value) {
        typed += ch;
        await this.s.overlay('dialogType', typed);
        await sleep(this.typeDelay(ch));
      }
      await sleep(250);
    }
    const target = plan.accept || !btns.cancel ? btns.ok : btns.cancel;
    await this.moveCursor(target.x, target.y);
    await sleep(this.c.pace.hoverDwell);
    void this.s.overlay('cursorClick');
    await this.s.overlay('dialogPress', plan.accept || !btns.cancel ? 'ok' : 'cancel');
    if (d.type !== 'alert' && plan.accept && this.lastAction) {
      // Replay the original action with the answer queued; the app now gets "OK".
      await this.s.overlay('queueDialogAnswer', { type: d.type, accept: true, value: plan.value });
      const navBefore = this.s.navCount;
      if (this.lastAction.kind === 'click') {
        // The element may have moved since (e.g. an error message was hidden): click where it is now.
        const r = await this.s.rectOf(this.lastAction.selector).catch(() => null);
        const p = r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : this.lastAction;
        await this.s.click(p.x, p.y);
      } else await pressKey(this.s, this.lastAction.key);
      await this.afterAction(navBefore, { depth: 1 });
    } else {
      await this.s.settle(this.c.pace.settleQuiet, 6000);
      await sleep(this.c.pace.observe);
    }
  }

  /** href of a plain link that should open another page, or null. */
  private async linkTarget(selector: string): Promise<string | null> {
    return this.s.eval((sel: string) => {
      // @ts-ignore injected
      const el = __find(sel) as HTMLElement | null;
      const a = el?.closest('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.href.startsWith('javascript:') || a.getAttribute('href')!.startsWith('#')) return null;
      return a.href === location.href ? null : a.href;
    }, selector).catch(() => null);
  }

  private typeDelay(ch: string) {
    const p = this.c.pace;
    const base = p.typeMin + Math.random() * (p.typeMax - p.typeMin);
    return /[\s.,@-]/.test(ch) ? base + 60 : base;
  }

  private async typeText(text: string) {
    const start = Date.now();
    let i = 0;
    while (i < text.length) {
      const fast = Date.now() - start > this.c.pace.typeFastAfter;
      const chunk = fast ? text.slice(i, i + 4) : text[i];
      await this.s.send('Input.insertText', { text: chunk });
      i += chunk.length;
      await sleep(fast ? this.c.pace.typeMin : this.typeDelay(chunk));
    }
  }

  /** Dry runs skip pacing but still wait for the UI to react, so the flow behaves like the real run. */
  private async dryAction(fn: () => Promise<void>) {
    await fn();
    await this.s.settle(150, 9000);
  }

  // ---------------- UI interface (paced) ----------------

  async goto(url: string) {
    return this.step(`goto ${url}`, async () => {
      if (this.dry) return this.fast.goto(url);
      const before = this.s.navCount;
      const res = await this.s.send('Page.navigate', { url: this.s.resolveUrl(url) });
      if (res.errorText) throw new Error(res.errorText);
      await this.s.waitForNavigation(before, 20000);
      await this.onNavigation(before);
      await sleep(this.c.pace.observe);
    });
  }

  /** keepWait: show a slow response in full, when the wait itself is what the story is about. */
  async click(selector: string, opts: { observe?: boolean; dialog?: DialogPlan; keepWait?: boolean } = {}) {
    return this.step(`click ${selector}`, async () => {
      if (opts.dialog) (this.dry ? this.s.nativeDialogAnswers : this.dialogPlan).push(opts.dialog);
      if (this.dry) return this.dryAction(() => this.fast.click(selector));
      await this.release(selector);
      const { r, pt } = await this.aim(selector, { enabled: true });
      await sleep(this.c.pace.hoverDwell);
      const navBefore = this.s.navCount;
      this.lastAction = { kind: 'click', selector, ...pt };
      this.event('click', { selector, x: pt.x, y: pt.y, rect: r });
      void this.s.overlay('cursorClick');
      const link = await this.linkTarget(selector);
      await this.s.click(pt.x, pt.y);
      await this.afterAction(navBefore, { observe: opts.observe, keepWait: opts.keepWait });
      if (link && this.s.navCount === navBefore && (await this.s.eval(() => location.href)) !== link) {
        throw new Error(`clicking the link to ${link} did not open it (the click did not reach the link, or the page cancelled it)`);
      }
    });
  }

  /**
   * Is this field for a password or similar? Its value must stay out of the step log, failure messages and
   * timeline.json. When the field can't be found, the answer is yes: the step is about to fail and print its label.
   */
  private async isSecret(selector?: string): Promise<boolean> {
    await this.s.waitFor(selector ?? 'body', { timeout: 3000 }).catch(() => {});
    return this.s.eval((sel: string | null) => {
      // @ts-ignore injected
      const el = (sel ? __find(sel) : document.activeElement) as HTMLInputElement | null;
      if (!el) return sel != null;
      return el.type === 'password' || /pass|pwd|secret|token/i.test(`${el.name ?? ''} ${el.id ?? ''} ${el.getAttribute('autocomplete') ?? ''}`);
    }, selector ?? null).catch(() => true);
  }

  async fill(selector: string, value: string) {
    let secret = true;
    const label = async () => {
      secret = await this.isSecret(selector);
      return `fill ${selector} = ${secret ? '(hidden)' : `"${value}"`}`;
    };
    return this.step(label, async () => {
      if (this.dry) return this.fast.fill(selector, value);
      await this.release(selector);
      await this.clickQuiet(selector);
      const before = await selectField(this.s, selector);
      if (before) {
        await sleep(260);
        if (!value) await deleteSelection(this.s);
      }
      this.event('type', { selector, text: secret ? '(hidden)' : value });
      await this.typeText(value);
      await checkFilled(this.s, selector, value, before);
      await this.s.settle(200, 3000);
      await sleep(this.c.pace.observe * 0.6);
    });
  }

  /** Move to the element and click it, without the post-click observe pause (used before typing). */
  private async clickQuiet(selector: string) {
    const { r, pt } = await this.aim(selector, { enabled: true });
    await sleep(this.c.pace.hoverDwell * 0.7);
    this.event('click', { selector, x: pt.x, y: pt.y, rect: r });
    void this.s.overlay('cursorClick');
    await this.s.click(pt.x, pt.y);
    await sleep(160);
  }

  async type(text: string) {
    let secret = true;
    const label = async () => {
      secret = await this.isSecret();
      return `type ${secret ? '(hidden)' : `"${text}"`}`;
    };
    return this.step(label, async () => {
      if (this.dry) return this.fast.type(text);
      this.event('type', { text: secret ? '(hidden)' : text });
      await this.typeText(text);
      await sleep(this.c.pace.observe * 0.5);
    });
  }

  async press(key: string, opts: { dialog?: DialogPlan } = {}) {
    return this.step(`press ${key}`, async () => {
      if (opts.dialog) (this.dry ? this.s.nativeDialogAnswers : this.dialogPlan).push(opts.dialog);
      if (this.dry) return this.dryAction(() => this.fast.press(key));
      const navBefore = this.s.navCount;
      void this.s.overlay('keycap', KEYS[key]?.label ?? key, this.cursor.x, this.cursor.y);
      this.lastAction = { kind: 'press', key };
      this.event('press', { key });
      await sleep(250);
      await pressKey(this.s, key);
      await this.afterAction(navBefore);
    });
  }

  async select(selector: string, option: string) {
    return this.step(`select ${selector} = "${option}"`, async () => {
      if (this.dry) return this.dryAction(() => this.fast.select(selector, option));
      await this.release(selector);
      await this.s.waitFor(selector, { timeout: 10000 });
      const idx = await optionIndex(this.s, selector, option);
      if (idx < 0) throw new Error(`No option "${option}" in ${selector}`);
      const { r } = await this.aim(selector, { point: (b) => ({ x: Math.round(b.x + Math.min(b.width * 0.5, 160)), y: Math.round(b.y + b.height / 2) }) });
      await sleep(this.c.pace.hoverDwell);
      void this.s.overlay('cursorClick');
      this.event('click', { selector, rect: r, select: true });
      await this.s.eval((sel: string) => {
        // @ts-ignore injected
        (__find(sel) as HTMLElement).focus();
      }, selector);
      const open = await this.s.overlay<{ ok: boolean; error?: string }>('selectOpen', selector);
      if (!open?.ok) throw new Error(open?.error ?? 'Could not open the select stand-in');
      await sleep(Math.max(450, this.c.pace.observe));
      // The cursor travels down the list (rows light up as it passes), rests on the option, clicks; the option
      // stays highlighted for a moment, then the list closes as the value changes, as with a real mouse.
      const pos = await this.s.overlay<{ x: number; y: number }>('selectOptionPoint', idx);
      if (pos) await this.moveCursor(pos.x, pos.y, 1.3);
      await sleep(this.c.pace.hoverDwell);
      void this.s.overlay('cursorClick');
      await sleep(260);
      const navBefore = this.s.navCount;
      await this.s.overlay('selectClose');
      await setSelect(this.s, selector, option);
      this.event('select', { selector, option });
      await this.afterAction(navBefore);
    });
  }

  async check(selector: string, checked = true) {
    const cur = await this.s.eval((sel: string) => {
      // @ts-ignore injected
      return (__find(sel) as HTMLInputElement | null)?.checked ?? null;
    }, selector);
    if (cur === null) await this.s.waitFor(selector);
    if (cur !== checked) await this.click(selector);
  }

  async waitFor(selector: string, opts: WaitOpts & { keepWait?: boolean } = {}) {
    const waitStart = this.now();
    await this.s.waitFor(selector, opts);
    if (!opts.keepWait) this.trimWait(waitStart);
  }
  text(selector: string) {
    return this.fast.text(selector);
  }
  url() {
    return this.fast.url();
  }
  eval<T = unknown>(fn: string | ((...args: any[]) => T), ...args: unknown[]) {
    return this.s.eval<T>(fn, ...args);
  }

  // ---------------- video extras ----------------

  /** Move the cursor onto an element and rest there (tooltips, "look here"). */
  async hover(selector: string, ms = 700) {
    return this.step(`hover ${selector}`, async () => {
      if (this.dry) return void (await this.s.waitFor(selector));
      const r = await this.ensureVisible(selector);
      const pt = this.pointFor(r, 'other');
      await this.moveCursor(pt.x, pt.y);
      this.event('hover', { selector, rect: r });
      await sleep(ms);
    });
  }

  async scrollTo(selector: string) {
    return this.step(`scroll to ${selector}`, async () => {
      if (this.dry) return void (await this.s.waitFor(selector));
      await this.ensureVisible(selector);
      await sleep(this.c.pace.observe * 0.6);
    });
  }

  async pause(ms: number) {
    if (!this.dry) await sleep(ms);
  }

  /** Queue the answer for the next alert/confirm/prompt the app opens. Default answer is OK. */
  answerDialog(plan: DialogPlan) {
    (this.dry ? this.s.nativeDialogAnswers : this.dialogPlan).push(plan);
  }

  /**
   * Narrate a line (TTS + caption). Returns immediately so actions continue while it plays;
   * the next say() waits until this one has finished. Use `await demo.say(..., { wait: true })` to block.
   */
  async say(text: Localized, opts: { wait?: boolean } = {}) {
    const raw = pickRaw(text, this.c.lang);
    const caption = written(raw);
    const voice = spokenForm(raw);
    this.lines.push({ text: voice, lang: this.c.lang, caption });
    if (this.dry) return;
    const started = this.sayChain.then(() => this.speak(caption, voice));
    this.sayChain = started.catch((e) => { this.speechError = e as Error; });
    await this.sayChain;
    if (opts.wait) await this.waitSpeech();
  }

  private async speak(line: string, voice: string) {
    await this.speechIdle(this.c.pace.speechGap);
    let clip = this.c.tts.cached(voice, this.c.lang);
    if (!clip) {
      const cutStart = this.now();
      this.c.log(`        (synthesizing narration)`);
      clip = await this.c.tts.synthesize(voice, this.c.lang);
      this.addCut(cutStart, this.now(), 'tts');
    }
    const t = this.now();
    this.c.timeline.narration.push({
      t, text: line, spoken: voice, wav: clip.wav, durationMs: clip.durationMs, id: this.c.timeline.narration.length,
      transcript: clip.transcript, match: clip.match, heard: clip.heard, heardMatch: clip.heardMatch, heardOk: clip.heardOk, heardProblems: clip.heardProblems,
    });
    this.event('say', { text: line, durationMs: clip.durationMs });
    this.c.log(`        "${line.length > 90 ? line.slice(0, 87) + '…' : line}" (${(clip.durationMs / 1000).toFixed(1)}s)`);
    this.speechUntil = t + clip.durationMs;
    this.captionText = line;
    await this.s.overlay('caption', line);
    this.armCaptionHide();
  }

  private armCaptionHide() {
    if (this.captionTimer) clearTimeout(this.captionTimer);
    if (!this.captionText) return;
    const left = this.speechUntil + 250 - this.now();
    this.captionTimer = setTimeout(() => {
      if (this.now() < this.speechUntil + 200) return this.armCaptionHide();
      this.captionText = null;
      void this.s.overlay('caption', null);
    }, Math.max(0, left));
  }

  /** Wait until all narration requested so far has finished (+ optional gap). */
  async waitSpeech(gap = 0) {
    if (this.dry) return;
    await this.sayChain;
    await this.speechIdle(gap);
  }

  private async speechIdle(gap = 0) {
    while (this.now() < this.speechUntil + gap) await sleep(Math.min(100, this.speechUntil + gap - this.now()));
  }

  /** Caption without voice (or null to hide). */
  async caption(text: Localized | null) {
    if (this.dry) return;
    this.captionText = text == null ? null : pick(text, this.c.lang);
    await this.s.overlay('caption', this.captionText);
  }

  /**
   * Start a chapter, normally one per acceptance criterion: banner, then a chip at the top.
   * The banner is read aloud ("Acceptance criterion 2. ...") unless announce is false.
   */
  async chapter(id: string, title?: Localized, opts: { announce?: boolean | Localized } = {}) {
    const ac = this.c.story.acceptance.find((a) => a.id === id);
    const rawTitle = title != null ? pickRaw(title, this.c.lang) : ac ? pickRaw(ac.text, this.c.lang) : id;
    const text = written(rawTitle);
    const L = labelsFor(this.c.story, this.c.lang);
    const idx = this.c.story.acceptance.findIndex((a) => a.id === id);
    const FI_NUM = ['nolla', 'yksi', 'kaksi', 'kolme', 'neljä', 'viisi', 'kuusi', 'seitsemän', 'kahdeksan', 'yhdeksän', 'kymmenen'];
    const nth = this.c.lang === 'fi' && FI_NUM[idx + 1] ? `{${idx + 1}|${FI_NUM[idx + 1]}}` : String(idx + 1);
    const spoken = ac?.say != null ? pickRaw(ac.say, this.c.lang) : rawTitle.replace(/["“”„«»]/g, '');
    const short = written(spoken).split(/\s+/).length <= 14;
    const announce = opts.announce === false ? null
      : opts.announce && opts.announce !== true ? pickRaw(opts.announce, this.c.lang)
      : idx >= 0 ? (short || ac?.say != null ? `${L.criterion} ${nth}. ${spoken.replace(/[.!]?$/, '.')}` : `${L.criterion} ${nth}.`) : spoken;
    return this.step(`chapter ${id}`, async () => {
      this.currentChapter = id;
      this.c.timeline.chapters.push({ t: this.now(), id, title: text, verified: false });
      if (this.dry) {
        if (announce) await this.say(announce);
        return;
      }
      await this.waitSpeech();
      await this.clear();
      const kicker = idx >= 0 ? `${L.criterion} ${idx + 1} ${L.of} ${this.c.story.acceptance.length}` : id;
      this.chip = { label: id, title: text };
      await this.s.overlay('chip', null);
      // Know the announcement length up front so the banner stays exactly while it is read.
      let speechMs = 0;
      if (announce) {
        const voice = spokenForm(announce);
        const clip = this.c.tts.cached(voice, this.c.lang) ?? (await this.withTtsCut(() => this.c.tts.synthesize(voice, this.c.lang)));
        speechMs = clip.durationMs;
      }
      this.event('chapter', { id, title: text });
      const hold = Math.max(this.c.pace.bannerMs, readingMs(this.c.pace, text) * 0.8, speechMs ? speechMs + 650 : 0);
      const banner = this.s.overlay('banner', { kicker, title: text, ...(idx >= 0 ? { n: idx + 1, total: this.c.story.acceptance.length, of: L.of, label: L.criterion } : {}) }, hold);
      if (announce) {
        await sleep(350);
        await this.say(announce);
      }
      await banner;
      await this.s.overlay('chip', this.chip);
      await sleep(250);
    });
  }

  private async withTtsCut<T>(fn: () => Promise<T>): Promise<T> {
    const start = this.now();
    this.c.log('        (synthesizing narration)');
    const r = await fn();
    this.addCut(start, this.now(), 'tts');
    return r;
  }

  /** Highlight an element with a ring and a text callout. Returns the annotation id. */
  async annotate(selector: string, opts: AnnotateOpts = {}) {
    const title = pick(opts.title, this.c.lang);
    return this.step(`annotate ${selector}${title ? ` "${title}"` : ''}`, async () => {
      const id = opts.id ?? `a${++this.annCounter}`;
      if (this.dry) {
        await this.s.waitFor(selector, { timeout: 8000 });
        this.event('annotate', { selector, id, title, covers: await this.covers(selector) });
        return id;
      }
      if (!opts.keep && this.transient) {
        await this.s.overlay('unannotate', this.transient);
        this.event('annotation-off', { id: this.transient });
        this.transient = null;
      }
      const r = await this.ensureVisible(selector);
      const text = pick(opts.text, this.c.lang);
      const info = await this.s.overlay<Record<string, unknown>>('annotate', {
        id, selector, badge: opts.badge, tone: opts.tone ?? 'new', title, text,
        previously: pick(opts.previously, this.c.lang), previouslyLabel: labelsFor(this.c.story, this.c.lang).previously,
        placement: opts.placement ?? 'auto', spotlight: !!opts.spotlight, number: opts.number,
      });
      if (!info?.ok) throw new Error(String(info?.error ?? 'annotation failed'));
      if (opts.keep) this.kept.add(id);
      else { this.transient = id; this.transientSel = selector; }
      this.event('annotate', { selector, id, title, text, tone: opts.tone ?? 'new', info, rect: r, covers: await this.covers(selector) });
      if (opts.point) {
        const pt = { x: Math.round(r.x + Math.min(r.width - 6, 28)), y: Math.round(r.y + r.height - 4) };
        await this.moveCursor(pt.x, pt.y);
      } else await this.parkCursor(info);
      await this.hold(opts.hold, `${title} ${text}`);
      return id;
    });
  }

  /** A hand moves the mouse off what it just pointed at, so the cursor doesn't cover what is being explained. */
  private async parkCursor(info: Record<string, any> | null) {
    const ring = info?.ringRect;
    if (!ring) return;
    const { x, y } = this.cursor;
    const near = 20;
    const slip = info?.calloutRect;
    const onMark = x >= ring.x - near && x <= ring.x + ring.width + near && y >= ring.y - near && y <= ring.y + ring.height + near;
    const onSlip = slip && x >= slip.x - 6 && x <= slip.x + slip.width + 6 && y >= slip.y - 6 && y <= slip.y + slip.height + 6;
    if (!onMark && !onSlip) return;
    const height = await this.s.eval(() => window.innerHeight);
    const free = (p: { x: number; y: number }) => p.y > 70 && p.y < height - 130
      && !(slip && p.x > slip.x - 24 && p.x < slip.x + slip.width + 24 && p.y > slip.y - 36 && p.y < slip.y + slip.height + 24);
    const spots = [{ x: x + 26, y: ring.y + ring.height + 42 }, { x: x + 26, y: ring.y - 46 }, { x: x + 90, y: ring.y + ring.height + 74 }, ...(slip ? [{ x: slip.x + slip.width + 40, y: slip.y + slip.height / 2 }, { x: slip.x - 40, y: slip.y + slip.height / 2 }] : [])];
    const spot = spots.find(free);
    if (spot) await this.moveCursor(Math.round(spot.x), Math.round(spot.y), 1.15);
  }

  /** Which story.changedUi selectors this annotation shows (same element, inside it, or around it). */
  private async covers(selector: string): Promise<string[]> {
    const list = this.c.story.changedUi ?? [];
    if (!list.length) return [];
    return this.s.eval((sel: string, cands: string[]) => {
      // @ts-ignore injected
      const a = __find(sel) as Element | null;
      if (!a) return [];
      return cands.filter((c) => {
        // @ts-ignore injected
        const e = __find(c) as Element | null;
        return !!e && (e === a || a.contains(e) || e.contains(a));
      });
    }, selector, list).catch(() => []);
  }

  private async hold(ms: number | undefined, text: string) {
    if (ms === 0) return;
    // `hold` can lengthen a slip's time on screen, never shorten it below its reading time. Reading starts when the
    // slip is in place, after the pen has drawn and the slip has faded in.
    const min = SLIP_IN_MS + Math.max(ms ?? 0, readingMs(this.c.pace, text));
    const start = this.now();
    await sleep(min);
    if (ms == null) await this.waitSpeech();
    this.event('hold', { ms: this.now() - start });
  }

  /** Check that an element is there (fails the run otherwise) and mark it as verified (underline and tick, with a slip). */
  async verify(selector: string, title: Localized, opts: Omit<AnnotateOpts, 'tone' | 'badge'> & { contains?: string } = {}) {
    const text = pick(title, this.c.lang);
    if (opts.contains) await this.s.waitFor(selector, { text: opts.contains, timeout: 8000 });
    const id = await this.annotate(selector, { ...opts, tone: 'success', badge: false, title });
    const ch = this.c.timeline.chapters[this.c.timeline.chapters.length - 1];
    if (ch) ch.verified = true;
    this.event('verify', { selector, title: text });
    return id;
  }

  /** Remove annotations (all, or one id). */
  async clear(id?: string) {
    if (this.dry) return;
    await this.s.overlay('unannotate', id ?? null);
    this.event('annotation-off', { id: id ?? null });
    if (id) { this.kept.delete(id); if (this.transient === id) this.transient = null; }
    else { this.kept.clear(); this.transient = null; }
    await sleep(120);
  }

  /** Full-screen title card from the story (key, title, summary, what changed). */
  async titleCard(opts: { say?: Localized } = {}) {
    return this.step('title card', async () => {
      const st = this.c.story;
      const L = labelsFor(this.c.story, this.c.lang);
      const sayLine = opts.say ?? `${st.key}: ${pickRaw(st.title, this.c.lang)}.`;
      if (this.dry) { await this.say(sayLine); return; }
      await this.s.overlay('cursorShow', false);
      await this.s.overlay('avoid', null);
      await this.s.overlay('card', {
        kind: 'title', key: st.key, type: st.type ?? 'Story', title: pick(st.title, this.c.lang), summary: pick(st.summary, this.c.lang),
        changes: (st.changes ?? []).map((c) => pick(c, this.c.lang)), changesLabel: L.changes,
        foot: [st.testData ? pick(st.testData, this.c.lang) : '', this.c.footer].filter(Boolean).join('  ·  '),
      });
      this.event('card', { kind: 'title' });
      const start = this.now();
      await sleep(600);
      await this.say(sayLine);
      await sleep(Math.max(0, this.c.pace.cardMinMs - (this.now() - start)));
      await this.waitSpeech();
      await sleep(400);
      await this.s.overlay('card', null);
      await sleep(450);
      await this.s.overlay('cursorShow', true);
      await sleep(300);
    });
  }

  /** Full-screen summary card: each acceptance criterion with a check when its chapter had a verify(). */
  async outroCard(opts: { say?: Localized } = {}) {
    return this.step('outro card', async () => {
      const st = this.c.story;
      const L = labelsFor(this.c.story, this.c.lang);
      if (this.dry) { if (opts.say) await this.say(opts.say); return; }
      await this.waitSpeech();
      await this.clear();
      await this.s.overlay('chip', null);
      this.chip = null;
      await this.s.overlay('cursorShow', false);
      const items = st.acceptance.map((a) => ({ id: a.id, text: pick(a.text, this.c.lang), ok: this.c.timeline.chapters.some((c) => c.id === a.id && c.verified) }));
      await this.s.overlay('avoid', null);
      await this.s.overlay('card', { kind: 'outro', key: st.key, kicker: L.outroKicker, title: L.verified, items, foot: this.c.footer });
      this.event('card', { kind: 'outro' });
      const start = this.now();
      await sleep(700);
      if (opts.say) await this.say(opts.say);
      await sleep(Math.max(0, this.c.pace.cardMinMs - (this.now() - start)));
      await this.waitSpeech();
    });
  }

  /** Run steps fast and cut them from the video (e.g. navigating somewhere boring). */
  async offCamera(fn: (ui: UI) => Promise<void>) {
    return this.step('off camera', async () => {
      if (this.dry) return fn(this.fast);
      const start = this.now();
      await this.s.overlay('caption', null);
      await fn(this.fast);
      await this.s.settle(300, 8000);
      await this.restoreOverlay();
      await sleep(200);
      this.addCut(start + 200, this.now() - 100, 'offcamera');
    });
  }

  /** Begin the recording: overlay on, cursor visible. */
  async begin() {
    if (this.dry) return;
    await this.restoreOverlay();
    await sleep(300);
  }

  /** End: let narration finish, short tail. */
  async end() {
    if (this.dry) return;
    await this.waitSpeech();
    if (this.captionTimer) clearTimeout(this.captionTimer);
    await this.s.overlay('caption', null);
    await sleep(900);
  }
}
