// Flows for the task list. Each takes the driver, so they run fast in setup and at human pace on camera.
import type { UI } from '../../../../otto/scripts/lib/fast-driver.ts';
import { uniqueName } from '../../../../otto/templates/ui-skill/scripts/test-data.ts';

/** A title nobody else has. Find the task again with rowOf. */
export const uniqueTitle = (text: string) => uniqueName(text);

/** The row of one task, whatever else is in the list. */
export const rowOf = (title: string) => `tr[data-title="${title}"]`;

export async function addTask(ui: UI, task: { title: string; priority?: 'Low' | 'Normal' | 'High' }) {
  await ui.fill('#title', task.title);
  if (task.priority) await ui.select('#priority', task.priority);
  await ui.click('[data-testid=add-task]');
  await ui.waitFor(rowOf(task.title));
}
