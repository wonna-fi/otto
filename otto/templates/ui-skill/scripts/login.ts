// Signing in. Keep the kinds your app needs and delete the rest. `login(ui)` is what storyboards and e2e checks call.
// Credentials come from the environment. Browser prompts (NTLM) need no flow: see references/ui-skill.md in otto.
import type { UI } from '../../../scripts/lib/fast-driver.ts'; // adjust the path to where the otto skill lives

type SignIn = {
  /** Where to start. An app that needs a sign-in sends the browser on from here. */
  start?: string;
  /** An element only a signed-in user sees. */
  signedIn: string;
  user?: string;
  password?: string;
  timeout?: number;
};

const credentials = (o: SignIn) => {
  const user = o.user ?? process.env.APP_USER;
  const password = o.password ?? process.env.APP_PASSWORD;
  if (!user || !password) throw new Error('Set APP_USER and APP_PASSWORD (in .env.local) to sign in.');
  return { user, password };
};

/** Which of these is on the page? Keeps asking through page loads, because sign-in pages redirect a lot. */
async function firstOf<K extends string>(ui: UI, selectors: Record<K, string>, timeout: number): Promise<K> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await ui.eval((all: Record<string, string>) => {
      for (const [k, sel] of Object.entries(all)) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden') return k;
      }
      return null;
    }, selectors).catch(() => null);
    if (found) return found as K;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out after ${timeout} ms at ${await ui.url().catch(() => '?')}: found none of ${Object.values(selectors).join(', ')}`);
}

/** The app's own username and password form. */
export async function signInWithForm(ui: UI, o: SignIn & { userField: string; passwordField: string; submit: string; error?: string }) {
  await ui.goto(o.start ?? '/');
  const timeout = o.timeout ?? 15000;
  const first = await firstOf(ui, { app: o.signedIn, form: o.passwordField }, timeout);
  if (first === 'app') return;
  const { user, password } = credentials(o);
  await ui.fill(o.userField, user);
  await ui.fill(o.passwordField, password);
  await ui.click(o.submit);
  const after = await firstOf(ui, { app: o.signedIn, error: o.error ?? '[role=alert], .error, .alert-danger' }, timeout);
  if (after === 'error') throw new Error(`Sign-in refused for ${user}: ${await ui.text(o.error ?? '[role=alert], .error, .alert-danger')}`);
}

// Microsoft's sign-in page. These selectors were written from memory and have not run against a real tenant: tests/
// template.test.ts only checks the flow's logic against a stand-in. Check them on the first real sign-in.
const ENTRA = {
  email: 'input[name=loginfmt]',
  password: 'input[name=passwd]',
  next: '#idSIButton9, [data-testid=primaryButton]',
  // "Stay signed in?" Choosing yes keeps later runs from signing in again.
  staySignedIn: '#KmsiCheckboxField, #kmsiTitle, [data-testid=kmsiVideo]',
  accountPicker: '#tilesHolder, [data-testid=tilesHolder]',
  otherAccount: '#otherTile, [data-testid=otherTile]',
  error: '#usernameError, #passwordError, #errorText, [data-testid=passwordError]',
};

/**
 * Entra ID, for test users without MFA. Federated tenants that send the browser on to their own sign-in page
 * need that page's fields added here.
 */
export async function signInWithEntra(ui: UI, o: SignIn) {
  const { user, password } = credentials(o);
  await ui.goto(o.start ?? '/');
  const timeout = o.timeout ?? 30000;
  const start = Date.now();
  let passwordSent = false;
  while (true) {
    const left = timeout - (Date.now() - start);
    if (left <= 0) throw new Error(`Entra sign-in did not finish in ${timeout} ms, last at ${await ui.url().catch(() => '?')}`);
    const step = await firstOf(ui, {
      app: o.signedIn,
      error: ENTRA.error,
      stay: ENTRA.staySignedIn,
      password: ENTRA.password,
      email: ENTRA.email,
      picker: ENTRA.accountPicker,
    }, left);
    switch (step) {
      case 'app':
        return;
      case 'error':
        throw new Error(`Entra refused the sign-in for ${user}: ${await ui.text(ENTRA.error)}`);
      case 'stay':
        await ui.click(ENTRA.next);
        break;
      case 'password':
        // The same page again after we answered means it didn't take the password, whatever it says.
        if (passwordSent) throw new Error(`Entra asked for the password again for ${user}.`);
        await ui.fill(ENTRA.password, password);
        await ui.click(ENTRA.next);
        passwordSent = true;
        break;
      case 'email':
        await ui.fill(ENTRA.email, user);
        await ui.click(ENTRA.next);
        break;
      case 'picker': {
        const tile = `[data-test-id="${user}"]`;
        const known = await ui.eval((sel: string) => !!document.querySelector(sel), tile).catch(() => false);
        await ui.click(known ? tile : ENTRA.otherAccount);
        break;
      }
    }
    // Let the step's page load start before looking again, or we would answer the same page twice.
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** What the rest of the skill calls. Pick the kind your app uses. */
export const login = (ui: UI) => signInWithEntra(ui, { signedIn: '[data-testid=current-user]' });
