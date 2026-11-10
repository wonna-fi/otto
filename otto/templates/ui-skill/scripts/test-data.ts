// Test data on a shared database: create what you need, through the UI, under a name nobody else has.
// Then refer to it by that name or its id, and say nothing about the rest of the data.
import type { UI } from '../../../scripts/lib/fast-driver.ts'; // adjust the path to where the otto skill lives

/** "Maija Test 7Q2F". Short enough to read in a video, unique enough for a shared database. */
export function uniqueName(name: string, now = Date.now()) {
  return `${name} Test ${now.toString(36).slice(-4).toUpperCase()}`;
}

/** Example of a create flow: fills the form through the UI, and returns the new record's id from the page it lands on. */
export async function createCustomer(ui: UI, firstName: string) {
  const name = uniqueName(firstName);
  await ui.goto('/customers/new');
  await ui.fill('#name', name);
  await ui.click('[data-testid=save]');
  await ui.waitFor('[data-testid=customer-header]', { text: name });
  const id = Number((await ui.url()).match(/customers\/(\d+)/)?.[1]);
  if (!id) throw new Error(`Created ${name}, but found no id in ${await ui.url()}`);
  return { id, name };
}
