// One recording tab: CDP session plumbing shared by the fast and paced drivers.
// Tracks main-frame navigations (full reloads), in-flight network requests and DOM quiet periods,
// and injects the overlay script into every new document.
import type { Cdp } from './cdp.ts';
import { FIND_FN } from './find.ts';

export type Viewport = { width: number; height: number; dpr: number };
export type Rect = { x: number; y: number; width: number; height: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SessionOpts = {
  baseUrl: string;
  viewport: Viewport;
  overlaySource: string;
  /** Requests whose URL matches are ignored by the network-idle check (polling, websockets, analytics). */
  ignoreRequests?: RegExp[];
  hideScrollbars?: boolean;
  /** How long to keep trying new tabs if the mouse doesn't work in them. Default 45 s. */
  mouseWaitMs?: number;
  /** Answers for browser sign-in prompts. Default: from the environment (httpAuthFromEnv). null turns it off. */
  httpAuth?: HttpAuth | null;
};

/** Credentials for browser sign-in prompts (NTLM, Basic). Only `origins` and the app's own origin ever get them. */
export type HttpAuth = { username: string; password: string; origins?: string[] };

/** OTTO_HTTP_USER (for NTLM usually DOMAIN\user), OTTO_HTTP_PASSWORD and optionally OTTO_HTTP_ORIGINS (comma-separated). */
export function httpAuthFromEnv(env: NodeJS.ProcessEnv = process.env): HttpAuth | null {
  if (!env.OTTO_HTTP_USER || env.OTTO_HTTP_PASSWORD == null) return null;
  return { username: env.OTTO_HTTP_USER, password: env.OTTO_HTTP_PASSWORD, origins: (env.OTTO_HTTP_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
}

const originOf = (url: string) => {
  try { return new URL(url).origin; } catch { return url; }
};

export class PageSession {
  readonly cdp: Cdp;
  readonly sessionId: string;
  readonly targetId: string;
  readonly opts: SessionOpts;
  mainFrameId = '';
  /** Number of main-frame loads started so far. */
  navCount = 0;
  loading = false;
  navStartedAt = 0;
  loadedAt = 0;
  private inflight = new Map<string, { url: string; started: number }>();
  private offs: Array<() => void> = [];
  /** Called when a full-page navigation starts / finishes loading (used by the recorder for cuts). */
  onNavStart: ((t: number) => void) | null = null;
  onLoad: ((t: number) => void) | null = null;
  autoAcceptNativeDialogs = true;
  /** Things that went wrong while opening the tab, for the log and the review. */
  readonly startupNotes: string[] = [];
  /** Browser sign-in prompts that got no credentials, or whose credentials the server refused. */
  readonly signInProblems: string[] = [];
  /** Answers for native alert/confirm/prompt in fast mode (dry runs, setup). Default: accept. */
  nativeDialogAnswers: Array<{ accept: boolean; value?: string }> = [];

  private constructor(cdp: Cdp, sessionId: string, targetId: string, opts: SessionOpts) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.opts = opts;
  }

  /**
   * Open a fresh tab for the recording so the user's own tabs stay untouched, and make sure the mouse works in it.
   *
   * Chrome now and then gives a tab that gets no mouse input at all, while its JavaScript runs normally, and the next
   * tab in the same Chrome is fine. Restarting Chrome, killing it, click timing and Playwright's
   * Chrome flags don't bring it on, so the cause is not known. A tab like that is replaced before anything happens in
   * it. Its fate is written to startupNotes: comparing the old tab with the new one tells whether the problem belongs
   * to the tab or to the moment.
   *
   * The mouse can also stop later, with the tab already in use: in the middle of a recording, for a few minutes, after
   * which it comes back by itself. A headless Chrome has no link to the desktop, so screen locks and the like are not
   * the cause. session.click() covers that case.
   *
   * Key events have the same trouble: they can stop for a couple of minutes, in new tabs too, with text input and the
   * mouse working, and then come back by themselves. Nothing waits for them here: fill doesn't need them, and press
   * checks and reports for itself. The note marks the moment.
   */
  static async open(cdp: Cdp, opts: SessionOpts): Promise<PageSession> {
    const deadline = Date.now() + (opts.mouseWaitMs ?? 45000);
    const started = Date.now();
    const dead: PageSession[] = [];
    try {
      while (true) {
        const s = await PageSession.openTab(cdp, opts);
        if (await s.mouseWorks()) {
          if (dead.length) {
            const waited = ((Date.now() - started) / 1000).toFixed(1);
            const old = await Promise.all(dead.map((d) => d.mouseWorks(600)));
            s.startupNotes.push(`Mouse input did not reach ${dead.length} new tab(s). Tab ${dead.length + 1} worked after ${waited}s; meanwhile the earlier tab(s) ${old.some(Boolean) ? 'started working too, so it was the moment and not the tab' : 'stayed dead, so it belongs to the tab'}.`);
          }
          if (!(await s.keysWork())) s.startupNotes.push('Key events are not reaching new tabs right now. Filling fields still works; pressing keys may not.');
          return s;
        }
        dead.push(s);
        if (Date.now() >= deadline) {
          throw new Error(`Chrome is not delivering mouse input: ${dead.length} new tabs in a row got none in ${Math.round((Date.now() - started) / 1000)}s. Restart Chrome and run again.`);
        }
        await sleep(Math.min(500 * dead.length, 4000));
      }
    } finally {
      for (const d of dead) await d.close().catch(() => {});
    }
  }

  private static async openTab(cdp: Cdp, opts: SessionOpts): Promise<PageSession> {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: false });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = new PageSession(cdp, sessionId, targetId, opts);
    await s.init();
    return s;
  }

  /** Presses Shift on a blank page and sees if the page noticed. */
  private async keysWork(timeout = 500): Promise<boolean> {
    await this.send('Runtime.evaluate', { expression: `window.__ottoProbeKeys = 0; addEventListener('keydown', () => { window.__ottoProbeKeys++; }, true); 0`, returnByValue: true });
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
      await sleep(60);
      if ((await this.send('Runtime.evaluate', { expression: 'window.__ottoProbeKeys', returnByValue: true })).result.value > 0) return true;
    }
    return false;
  }

  /** Clicks a blank page and sees if the page noticed. Only for a tab that hasn't opened anything yet. */
  private async mouseWorks(timeout = 1500): Promise<boolean> {
    const seen = (await this.send('Runtime.evaluate', { expression: `(() => { if (window.__ottoProbe == null) { window.__ottoProbe = 0; addEventListener('mousedown', () => { window.__ottoProbe++; }, true); } return window.__ottoProbe; })()`, returnByValue: true })).result.value as number;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 4, y: 4, button: 'left', buttons: 1, clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 4, y: 4, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(100);
      const now = (await this.send('Runtime.evaluate', { expression: 'window.__ottoProbe', returnByValue: true })).result.value as number;
      if (now > seen) return true;
    }
    return false;
  }

  private async init() {
    const send = this.send.bind(this);
    this.listen();
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.setBypassCSP', { enabled: true });
    const auth = this.opts.httpAuth === undefined ? httpAuthFromEnv() : this.opts.httpAuth;
    if (auth) await this.answerSignInPrompts(auth);
    const { width, height, dpr } = this.opts.viewport;
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false, screenWidth: width, screenHeight: height });
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    if (this.opts.hideScrollbars !== false) await send('Emulation.setScrollbarsHidden', { hidden: true }).catch(() => {});
    await send('Page.addScriptToEvaluateOnNewDocument', { source: this.opts.overlaySource });
    const { frameTree } = await send('Page.getFrameTree');
    this.mainFrameId = frameTree.frame.id;
    await send('Page.bringToFront').catch(() => {});
    // A click that started a page load in an earlier run can leave the browser thinking the button is down.
    await this.mouse('mouseReleased', 1, 1).catch(() => {});
  }

  /**
   * Answer the browser's own sign-in prompt (HTTP 401 with NTLM, Negotiate or Basic). Headless Chrome has no prompt to
   * show, and in Linux or WSL no Windows sign-in to fall back on, so the page would just fail. Chrome does the NTLM
   * handshake itself once it has the credentials. Other sites and proxies never get them.
   */
  private async answerSignInPrompts(auth: HttpAuth) {
    const allowed = new Set([originOf(this.opts.baseUrl), ...(auth.origins ?? []).map(originOf)]);
    const tries = new Map<string, number>();
    const refuse = (requestId: string, problem: string) => {
      if (!this.signInProblems.includes(problem)) this.signInProblems.push(problem);
      this.send('Fetch.continueWithAuth', { requestId, authChallengeResponse: { response: 'CancelAuth' } }).catch(() => {});
    };
    this.offs.push(
      // Fetch pauses every request while it is on; only the sign-in prompts need anything done.
      this.cdp.on('Fetch.requestPaused', (p, sid) => {
        if (sid === this.sessionId) this.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      }),
      this.cdp.on('Fetch.authRequired', (p, sid) => {
        if (sid !== this.sessionId) return;
        const { origin, source, scheme } = p.authChallenge;
        const from = originOf(origin);
        if (source === 'Proxy') return refuse(p.requestId, `A proxy asked for a sign-in (${scheme}) at ${origin}. The toolkit doesn't send credentials to proxies.`);
        if (!allowed.has(from)) return refuse(p.requestId, `${from} asked for a sign-in (${scheme}), and it isn't the app or in OTTO_HTTP_ORIGINS, so it got no credentials.`);
        // Wrong credentials bring the prompt back straight away, for ever.
        const n = (tries.get(p.request.url) ?? 0) + 1;
        tries.set(p.request.url, n);
        if (n > 2) return refuse(p.requestId, `${from} refused the sign-in (${scheme}) for user ${auth.username}. Check OTTO_HTTP_USER and OTTO_HTTP_PASSWORD.`);
        this.send('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse: { response: 'ProvideCredentials', username: auth.username, password: auth.password } }).catch(() => {});
      }),
    );
    await this.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
  }

  private listen() {
    const mine = (sid?: string) => sid === this.sessionId;
    const ignored = (url: string) => url.startsWith('data:') || (this.opts.ignoreRequests ?? []).some((re) => re.test(url));
    // frameStartedLoading/frameStoppedLoading also fire for history.pushState/replaceState (SPA routing), so a
    // full reload is counted at frameNavigated (cross-document only) and timed from its frameStartedLoading.
    let pendingStart = 0;
    this.offs.push(
      this.cdp.on('Page.frameStartedLoading', (p, sid) => {
        if (!mine(sid) || p.frameId !== this.mainFrameId) return;
        this.loading = true;
        pendingStart = Date.now();
      }),
      this.cdp.on('Page.frameNavigated', (p, sid) => {
        if (!mine(sid) || p.frame.parentId || p.frame.id !== this.mainFrameId) return;
        this.navCount++;
        this.navStartedAt = pendingStart || Date.now();
        this.onNavStart?.(this.navStartedAt);
      }),
      this.cdp.on('Page.frameStoppedLoading', (p, sid) => {
        if (!mine(sid) || p.frameId !== this.mainFrameId) return;
        this.loading = false;
        this.loadedAt = Date.now();
        this.onLoad?.(this.loadedAt);
      }),
      this.cdp.on('Network.requestWillBeSent', (p, sid) => {
        if (!mine(sid) || ignored(p.request.url) || p.type === 'EventSource' || p.type === 'WebSocket') return;
        this.inflight.set(p.requestId, { url: p.request.url, started: Date.now() });
      }),
      this.cdp.on('Network.loadingFinished', (p, sid) => { if (mine(sid)) this.inflight.delete(p.requestId); }),
      this.cdp.on('Network.loadingFailed', (p, sid) => { if (mine(sid)) this.inflight.delete(p.requestId); }),
      this.cdp.on('Page.javascriptDialogOpening', (_p, sid) => {
        if (!mine(sid) || !this.autoAcceptNativeDialogs) return;
        const a = this.nativeDialogAnswers.shift() ?? { accept: true };
        this.send('Page.handleJavaScriptDialog', { accept: a.accept, promptText: a.value }).catch(() => {});
      }),
    );
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.sessionId);
  }

  resolveUrl(url: string) {
    return /^[a-z]+:/i.test(url) ? url : `${this.opts.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  /** Evaluate a function (or expression) in the page. `__find(selector)` is available inside. */
  async eval<T = unknown>(fn: string | ((...args: any[]) => T), ...args: unknown[]): Promise<T> {
    const expression = typeof fn === 'function'
      ? `(() => { ${FIND_FN}; return (${fn.toString()})(...${JSON.stringify(args)}); })()`
      : `(() => { ${FIND_FN}; return (${fn}); })()`;
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value as T;
  }

  /** Call a method on the overlay (window.__otto). Returns null if the overlay is not there (e.g. mid-navigation). */
  async overlay<T = unknown>(method: string, ...args: unknown[]): Promise<T | null> {
    const expression = `window.__otto ? window.__otto.call(${JSON.stringify(method)}, ${JSON.stringify(args)}) : null`;
    try {
      const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
      return res.result.value as T;
    } catch (e) {
      const msg = (e as Error).message;
      if (/context|destroyed|navigat|Cannot find context/i.test(msg)) return null;
      throw new Error(`overlay.${method} failed: ${msg}`);
    }
  }

  async goto(url: string) {
    const before = this.navCount;
    const res = await this.send('Page.navigate', { url: this.resolveUrl(url) });
    if (res.errorText) throw new Error(`Navigation to ${url} failed: ${res.errorText}`);
    await this.waitForNavigation(before, 20000);
  }

  /** Wait until a navigation started after `navCountBefore` has finished loading. */
  async waitForNavigation(navCountBefore: number, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.navCount > navCountBefore && !this.loading) return;
      await sleep(30);
    }
    throw new Error('Timed out waiting for the page to load');
  }

  /** If the main frame is loading (a click started a navigation), wait for it to finish. */
  async waitWhileLoading(timeout = 20000) {
    const start = Date.now();
    while (this.loading && Date.now() - start < timeout) await sleep(30);
    if (this.loading) throw new Error('Timed out waiting for the page to load');
  }

  async networkIdle(quietMs = 300, timeoutMs = 8000) {
    const start = Date.now();
    let idleSince = 0;
    while (Date.now() - start < timeoutMs) {
      // Requests running longer than 10 s are treated as background (long polling) and ignored.
      for (const [id, r] of this.inflight) if (Date.now() - r.started > 10000) this.inflight.delete(id);
      if (this.inflight.size === 0 && !this.loading) {
        if (!idleSince) idleSince = Date.now();
        if (Date.now() - idleSince >= quietMs) return true;
      } else idleSince = 0;
      await sleep(25);
    }
    return false;
  }

  /** Resolves when the DOM has not changed for quietMs (or after timeoutMs). */
  async domQuiet(quietMs = 300, timeoutMs = 5000) {
    try {
      return await this.eval((quiet: number, timeout: number) => new Promise<boolean>((resolve) => {
        let timer = setTimeout(done, quiet, true);
        const hard = setTimeout(done, timeout, false);
        const mo = new MutationObserver((records) => {
          if (records.every((r) => (r.target as Element).nodeName === 'OTTO-OVERLAY')) return;
          clearTimeout(timer);
          timer = setTimeout(done, quiet, true);
        });
        mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        function done(ok: boolean) { mo.disconnect(); clearTimeout(timer); clearTimeout(hard); resolve(ok); }
      }), quietMs, timeoutMs);
    } catch {
      return false; // navigated away mid-wait
    }
  }

  /** Network idle and DOM quiet: the UI has finished reacting. */
  async settle(quietMs = 300, timeoutMs = 8000) {
    const start = Date.now();
    for (let round = 0; round < 3; round++) {
      const nav = this.navCount;
      await this.networkIdle(quietMs, Math.max(500, timeoutMs - (Date.now() - start)));
      if (this.loading) await this.waitWhileLoading(Math.max(500, timeoutMs - (Date.now() - start))).catch(() => {});
      const quiet = await this.domQuiet(quietMs, Math.max(500, timeoutMs - (Date.now() - start)));
      if (quiet && nav === this.navCount && !this.loading) return;
      if (Date.now() - start > timeoutMs) return;
    }
  }

  /** enabled: also wait until the element is not disabled (actionable), like a person would. */
  async waitFor(selector: string, opts: { timeout?: number; text?: string; hidden?: boolean; enabled?: boolean } = {}) {
    const timeout = opts.timeout ?? 10000;
    const start = Date.now();
    let lastErr = '';
    while (Date.now() - start < timeout) {
      try {
        const ok = await this.eval((sel: string, text: string | null, hidden: boolean, enabled: boolean) => {
          // @ts-ignore injected
          const el = __find(sel) as HTMLElement | null;
          const visible = !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
          if (hidden) return !visible;
          if (!visible) return false;
          if (enabled && ((el as HTMLButtonElement).disabled || el!.getAttribute('aria-disabled') === 'true')) return false;
          return text ? (el!.innerText ?? (el as HTMLInputElement).value ?? '').includes(text) : true;
        }, selector, opts.text ?? null, !!opts.hidden, !!opts.enabled);
        if (ok) return;
      } catch (e) {
        lastErr = (e as Error).message;
      }
      await sleep(80);
    }
    throw new Error(`Timed out after ${timeout} ms waiting for ${opts.hidden ? 'disappearance of ' : ''}"${selector}"${opts.enabled ? ' to be enabled' : ''}${opts.text ? ` with text "${opts.text}"` : ''}${lastErr ? ` (${lastErr.slice(0, 120)})` : ''}`);
  }

  async rectOf(selector: string): Promise<Rect | null> {
    return this.eval((sel: string) => {
      // @ts-ignore injected
      const el = __find(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }, selector);
  }

  /**
   * What would get a click at this point instead of the element: a description of it, or null if the element would.
   * Labels of the control count as the control, and so do a control's own parts and wrappers.
   */
  async coveredBy(selector: string, pt: { x: number; y: number }): Promise<string | null> {
    return this.eval((sel: string, x: number, y: number) => {
      // @ts-ignore injected
      const el = __find(sel) as HTMLElement | null;
      const top = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el || !top || el === top || el.contains(top) || top.contains(el)) return null;
      const label = top.closest('label');
      if (label && (label.contains(el) || label.control === el)) return null;
      const cls = typeof top.className === 'string' && top.className.trim() ? `.${top.className.trim().split(/\s+/).join('.')}` : '';
      return `<${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}${cls}>`;
    }, selector, pt.x, pt.y);
  }

  /** Wait for a spinner, scrim or toast to get out of the way. Pressing anyway would hit it and look like a working click. */
  async waitUncovered(selector: string, pt: { x: number; y: number }, timeout = 5000) {
    const start = Date.now();
    let by = await this.coveredBy(selector, pt);
    while (by && Date.now() - start < timeout) {
      await sleep(100);
      by = await this.coveredBy(selector, pt);
    }
    if (by) throw new Error(`"${selector}" is covered by ${by} at ${Math.round(pt.x)},${Math.round(pt.y)}`);
  }

  private lastMouse = { x: 0, y: 0 };

  /**
   * A click that starts a full page load (form submit, link) can leave Chrome's input layer thinking the button
   * is still down, and then later clicks are ignored. A release after the load resets it.
   */
  async resetMouse() {
    await this.mouse('mouseReleased', this.lastMouse.x, this.lastMouse.y).catch(() => {});
  }

  private navAtLastPress = -1;

  async mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number) {
    this.lastMouse = { x, y };
    // After a click that started a page load, Chrome may still think the button is down and swallow the next
    // clicks. Spotting the load right after the click depends on timing, so instead: before any press, if a page
    // load happened since the previous press, release first. A release while no button is down does nothing.
    if (type === 'mousePressed') {
      if (this.navAtLastPress !== this.navCount) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
      }
      this.navAtLastPress = this.navCount;
    }
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }

  private async downs(): Promise<number | null> {
    try {
      const r = await this.send('Runtime.evaluate', { expression: 'window.__ottoDowns ?? null', returnByValue: true });
      return r.result?.value ?? null;
    } catch {
      return null; // navigating
    }
  }

  /** How many keydowns the page has seen, or null without the overlay or during a page load. */
  async keysSeen(): Promise<number | null> {
    try {
      const r = await this.send('Runtime.evaluate', { expression: 'window.__ottoKeys ?? null', returnByValue: true });
      return r.result?.value ?? null;
    } catch {
      return null;
    }
  }

  /** Keys that had to be sent again, and fields whose text had to be corrected, for the review. */
  recoveredKeys: Array<{ key: string; t: number }> = [];
  fixedFields: string[] = [];

  /** One line per click that had trouble, with its time, so a run can be compared with what else happened then. */
  clickNotes(): string[] {
    const notes: string[] = [];
    let retries = 0;
    for (const c of this.recoveredClicks) {
      const at = `${Math.round(c.x)},${Math.round(c.y)}`;
      const time = new Date(c.t).toLocaleTimeString('en-GB');
      if (c.state === 'delivered from inside the page') {
        notes.push(`A click at ${at} never reached the page, so it was delivered from inside the page at ${time}. Hover styles may be missing there.`);
        retries = 0;
        continue;
      }
      retries++;
      const next = this.recoveredClicks[this.recoveredClicks.indexOf(c) + 1];
      if (!next || next.x !== c.x || next.y !== c.y) {
        notes.push(`A click at ${at} did not reach the page at first and was sent again (${retries}x) at ${time}.`);
        retries = 0;
      }
    }
    return notes;
  }

  /** Clicks for which the page had to be nudged (a click that never arrived), for the review. */
  recoveredClicks: Array<{ x: number; y: number; t: number; state: unknown }> = [];

  /**
   * Click at a viewport point and make sure the page received it. Chrome occasionally swallows clicks after a
   * page load; then the page gets nothing (no mousedown at all), so resending cannot cause a double click.
   */
  async click(x: number, y: number) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await this.downs();
      const navBefore = this.navCount;
      await this.mouse('mousePressed', x, y);
      await this.mouse('mouseReleased', x, y);
      if (before == null) return; // no counter (overlay not loaded yet): nothing to verify against
      // A page that has just loaded can take a while to handle input. Give it time before calling the click lost:
      // a retry on top of a press that was only late can land on the next page, or replay a click the page took.
      let after: number | null = before;
      for (let waited = 0; waited < 400 && after === before && this.navCount === navBefore && !this.loading; waited += 40) {
        await sleep(40);
        after = await this.downs();
      }
      if (after == null || after > before || this.navCount !== navBefore || this.loading) return;
      const state = await this.eval(() => ({ focus: document.hasFocus(), visibility: document.visibilityState, active: document.activeElement?.tagName })).catch(() => null);
      this.recoveredClicks.push({ x, y, t: Date.now(), state });
      // Recover: release any button Chrome thinks is down, bring the tab forward, re-enable focus emulation.
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
      await this.send('Page.bringToFront').catch(() => {});
      await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await this.mouse('mouseMoved', x, y);
      await sleep(120 * attempt);
    }
    // Chrome has stopped delivering mouse input to this tab (see open()). Deliver the click from inside the page so
    // the run can go on, and leave a note: the app gets untrusted events, and hover styles won't show.
    const delivered = await this.eval((px: number, py: number) => {
      const el = document.elementFromPoint(px, py) as HTMLElement | null;
      if (!el) return false;
      const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: px, clientY: py, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', o));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      (el.closest('input, select, textarea, button, a, [tabindex]') as HTMLElement | null)?.focus();
      el.dispatchEvent(new PointerEvent('pointerup', o));
      el.dispatchEvent(new MouseEvent('mouseup', o));
      el.click();
      return true;
    }, x, y).catch(() => false);
    if (delivered) { this.recoveredClicks.push({ x, y, t: Date.now(), state: 'delivered from inside the page' }); return; }
    throw new Error(`the page did not receive a click at ${Math.round(x)},${Math.round(y)} after 3 attempts`);
  }

  async close() {
    for (const off of this.offs) off();
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}
