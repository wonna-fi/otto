// Sign in to Tasks. Credentials come from the environment.
import type { UI } from '../../../../otto/scripts/lib/fast-driver.ts';
import { signInWithForm } from '../../../../otto/templates/ui-skill/scripts/login.ts';

export const login = (ui: UI) => signInWithForm(ui, {
  start: '/',
  signedIn: '[data-testid=current-user]',
  userField: '#username',
  passwordField: '#password',
  submit: '[data-testid=sign-in]',
  user: process.env.APP_USER ?? 'demo',
  password: process.env.APP_PASSWORD ?? 'demo123',
});
