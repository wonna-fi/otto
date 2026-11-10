// Fast driver: no cursor, no pacing. Used for storyboard setup steps, off-camera steps and dry runs.
// Implements the same UI interface as the flow scripts expect.
import type { PageSession } from './session.ts';

export type WaitOpts = { timeout?: number; text?: string; hidden?: boolean };

export interface UI {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  select(selector: string, option: string): Promise<void>;
  check(selector: string, checked?: boolean): Promise<void>;
  waitFor(selector: string, opts?: WaitOpts): Promise<void>;
  text(selector: string): Promise<string>;
  url(): Promise<string>;
  eval<T = unknown>(fn: string | ((...args: any[]) => T), ...args: unknown[]): Promise<T>;
}

export const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string; label: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', label: 'Enter ⏎' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, label: 'Tab ⇥' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27, label: 'Esc' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, label: '⌫' },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46, label: 'Del' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, label: '↓' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, label: '↑' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, label: '←' },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, label: '→' },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ', label: 'Space' },
};

/**
 * Press a key and make sure the page received it, the way session.click() does for the mouse. Key events can stop
 * arriving for a while, with text input and the mouse still working; see PageSession.open().
 */
export async function pressKey(s: PageSession, key: string) {
  const k = KEYS[key];
  const down = k ? { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: k.text } : { type: 'keyDown', key, text: key };
  const up = k ? { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode } : { type: 'keyUp', key };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = await s.keysSeen();
    const navBefore = s.navCount;
    await s.send('Input.dispatchKeyEvent', down);
    await s.send('Input.dispatchKeyEvent', up);
    if (before == null) return; // no counter (overlay not loaded yet): nothing to verify against
    await new Promise((r) => setTimeout(r, 40));
    const after = await s.keysSeen();
    if (after == null || after > before || s.navCount !== navBefore || s.loading) return;
    s.recoveredKeys.push({ key, t: Date.now() });
    await s.send('Page.bringToFront').catch(() => {});
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200 * attempt));
  }
  throw new Error(`the page did not receive the key ${key} after 3 attempts. Chrome has stopped delivering key events to this tab; try again in a minute, or restart Chrome.`);
}

/**
 * Select what a field holds, so that the text typed next replaces it, and return what it held. From inside the page
 * rather than with Ctrl+A, because text input keeps working when key events don't arrive.
 */
export async function selectField(s: PageSession, selector: string): Promise<string> {
  return s.eval((sel: string) => {
    // @ts-ignore injected
    const el = __find(sel) as HTMLInputElement;
    el.focus();
    if (el.select) el.select();
    else document.execCommand('selectAll');
    return (el.value ?? el.textContent ?? '') as string;
  }, selector);
}

/** Delete the selected text. The page sees an ordinary edit, so React and the like notice. */
export async function deleteSelection(s: PageSession) {
  await s.eval(() => document.execCommand('delete'));
}

/**
 * Did typing do what was meant? Text left behind or added to the old value would go on camera, or be saved, looking
 * fine. Only these two cases are looked for, because a field may format its value (a phone number, a date).
 */
export async function checkFilled(s: PageSession, selector: string, value: string, before: string) {
  const fixed = await s.eval((sel: string, want: string, old: string) => {
    // @ts-ignore injected
    const el = __find(sel) as HTMLInputElement;
    if (!el || el.value == null) return false;
    const wrong = want === '' ? el.value !== '' : !!old && el.value === old + want;
    if (!wrong) return false;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, want);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value, before);
  if (fixed) s.fixedFields.push(selector);
}

/** Set a <select> by value or visible label, firing the input and change events that frameworks and plain scripts listen to. */
export async function setSelect(s: PageSession, selector: string, option: string) {
  const ok = await s.eval((sel: string, want: string) => {
    // @ts-ignore injected
    const el = __find(sel) as HTMLSelectElement | null;
    if (!el || el.tagName !== 'SELECT') return 'not-select';
    const opt = [...el.options].find((o) => o.value === want) ?? [...el.options].find((o) => o.label.trim() === want || o.text.trim() === want);
    if (!opt) return 'no-option';
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(el, opt.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  }, selector, option);
  if (ok === 'not-select') throw new Error(`${selector} is not a <select>`);
  if (ok === 'no-option') throw new Error(`No option "${option}" in ${selector}`);
}

/** Index of the option (by value or label), waiting up to `timeout` for options that load asynchronously. */
export async function optionIndex(s: PageSession, selector: string, option: string, timeout = 6000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const i = await optionIndexNow(s, selector, option);
    if (i >= 0 || Date.now() - start > timeout) return i;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function optionIndexNow(s: PageSession, selector: string, option: string): Promise<number> {
  return s.eval((sel: string, want: string) => {
    // @ts-ignore injected
    const el = __find(sel) as HTMLSelectElement;
    const opts = [...el.options];
    let i = opts.findIndex((o) => o.value === want);
    if (i < 0) i = opts.findIndex((o) => o.label.trim() === want || o.text.trim() === want);
    return i;
  }, selector, option);
}

export class FastDriver implements UI {
  readonly s: PageSession;
  constructor(s: PageSession) {
    this.s = s;
  }
  goto(url: string) {
    return this.s.goto(url);
  }
  async centerOf(selector: string) {
    await this.s.waitFor(selector, { enabled: true });
    return this.s.eval((sel: string) => {
      // @ts-ignore injected
      const el = __find(sel) as HTMLElement;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
  }
  async click(selector: string) {
    const { x, y } = await this.centerOf(selector);
    await this.s.waitUncovered(selector, { x, y });
    await this.s.mouse('mouseMoved', x, y);
    await this.s.click(x, y);
    const navBefore = this.s.navCount;
    await new Promise((r) => setTimeout(r, 60));
    if (this.s.loading) await this.s.waitWhileLoading(20000);
    if (this.s.navCount > navBefore || this.s.loading) await this.s.resetMouse();
  }
  async fill(selector: string, value: string) {
    await this.click(selector);
    const before = await selectField(this.s, selector);
    if (value === '') await deleteSelection(this.s);
    else await this.s.send('Input.insertText', { text: value });
    await checkFilled(this.s, selector, value, before);
  }
  async type(text: string) {
    await this.s.send('Input.insertText', { text });
  }
  async press(key: string) {
    await pressKey(this.s, key);
    await new Promise((r) => setTimeout(r, 60));
    if (this.s.loading) await this.s.waitWhileLoading(20000);
  }
  async select(selector: string, option: string) {
    await this.s.waitFor(selector);
    if ((await optionIndex(this.s, selector, option)) < 0) throw new Error(`No option "${option}" in ${selector}`);
    await setSelect(this.s, selector, option);
  }
  async check(selector: string, checked = true) {
    await this.s.waitFor(selector);
    const cur = await this.s.eval((sel: string) => {
      // @ts-ignore injected
      return (__find(sel) as HTMLInputElement).checked;
    }, selector);
    if (cur !== checked) await this.click(selector);
  }
  waitFor(selector: string, opts?: WaitOpts) {
    return this.s.waitFor(selector, opts);
  }
  async text(selector: string) {
    await this.s.waitFor(selector);
    return this.s.eval((sel: string) => {
      // @ts-ignore injected
      const el = __find(sel) as HTMLInputElement;
      return ((el.innerText || el.value) ?? '').trim();
    }, selector);
  }
  url() {
    return this.s.eval(() => location.href);
  }
  eval<T = unknown>(fn: string | ((...args: any[]) => T), ...args: unknown[]) {
    return this.s.eval<T>(fn, ...args);
  }
}
