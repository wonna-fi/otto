// A video of one story on the example app: node otto/scripts/record.ts examples/tasks-app/storyboard.ts
// The story is in English; --lang fi records the same video with Finnish narration, cards and notes.
import { storyboard } from '../../otto/scripts/lib/storyboard.ts';
import { login } from './ui-skill/scripts/login.ts';
import { rowOf, uniqueTitle } from './ui-skill/scripts/tasks.ts';

// Made fresh for every run: the data is shared, so the video only talks about tasks it created itself.
const urgent = uniqueTitle('Call the landlord');
const spare = uniqueTitle('Tidy the storeroom');

export default storyboard({
  story: {
    key: 'TASK-7',
    title: { en: 'Give tasks a priority', fi: 'Tehtäville prioriteetti' },
    type: 'Story',
    language: 'en',
    app: 'Tasks',
    summary: { en: 'People can see at a glance which tasks are urgent.', fi: 'Kiireelliset tehtävät erottuvat listasta yhdellä silmäyksellä.' },
    acceptance: [
      { id: 'AC1', text: { en: 'A new task can be given the priority Low, Normal or High.', fi: 'Uudelle tehtävälle voi valita prioriteetin Low, Normal tai High.' } },
      { id: 'AC2', text: { en: 'High priority tasks have a red badge and go to the top of the list.', fi: 'Tehtävät, joiden prioriteetti on High, saavat punaisen merkin ja nousevat listan kärkeen.' } },
      { id: 'AC3', text: { en: 'Deleting a task asks for confirmation first.', fi: 'Tehtävän poistaminen kysyy ensin vahvistuksen.' } },
    ],
    changes: [
      { en: 'New task form: new Priority field', fi: 'Uuden tehtävän lomake: uusi kenttä Priority' },
      { en: 'Task list: new Priority column, with urgent tasks first', fi: 'Tehtävälista: uusi sarake Priority, kiireelliset ensin' },
      { en: 'Delete asks for confirmation', fi: 'Poisto kysyy vahvistuksen' },
    ],
    changedUi: ['#priority', '[data-testid=priority]', '[data-testid=delete]'],
    testData: { en: 'Test data: tasks created for this video', fi: 'Testidata: tätä videota varten luodut tehtävät' },
  },
  repo: '../..',
  baseUrl: process.env.APP_URL ?? 'http://localhost:3200',

  setup: async (ui) => {
    await login(ui);
    await ui.goto('/');
    await ui.waitFor('[data-testid=tasks]');
  },

  scenes: async (demo) => {
    await demo.titleCard({ say: { en: 'TASK-7. Tasks now have a priority, so urgent work stands out.', fi: '{TASK-7|Task seitsemän}. Tehtävillä on nyt prioriteetti, joten kiireelliset työt erottuvat.' } });

    await demo.chapter('AC1');
    demo.say({ en: 'The form for a new task has a new field, Priority.', fi: 'Uuden tehtävän lomakkeessa on uusi kenttä, Priority.' });
    await demo.annotate('#priority', { title: 'Priority', text: { en: 'Low, Normal or High. Normal unless you choose otherwise.', fi: 'Low, Normal tai High. Normal, ellei muuta valita.' }, spotlight: true });
    demo.say({ en: 'Let\'s add something urgent.', fi: 'Lisätään jotain kiireellistä.' });
    await demo.fill('#title', urgent);
    await demo.select('#priority', 'High');
    await demo.click('[data-testid=add-task]');
    await demo.verify(`${rowOf(urgent)} [data-testid=priority]`, { en: 'Saved with priority High', fi: 'Tallentui prioriteetilla High' }, { contains: 'High' });

    await demo.chapter('AC2');
    demo.say({ en: 'It has a red badge, and it went to the top of the list.', fi: 'Sillä on punainen merkki, ja se nousi listan kärkeen.' });
    const top = await demo.eval(() => (document.querySelector('[data-testid=tasks] tbody tr') as HTMLElement).querySelector('[data-testid=priority]')!.textContent);
    if (top !== 'High') throw new Error(`The first row should have priority High, it has ${top}`);
    const order = await demo.eval((t: string) => {
      const rows = [...document.querySelectorAll('[data-testid=tasks] tbody tr')] as HTMLElement[];
      const lastHigh = rows.map((r) => r.querySelector('[data-testid=priority]')!.textContent).lastIndexOf('High');
      return { lastHigh, mine: rows.findIndex((r) => r.dataset.title === t) };
    }, urgent);
    if (order.mine > order.lastHigh) throw new Error('The new task should be among the High priority tasks');
    await demo.verify(rowOf(urgent), { en: 'Urgent tasks come first', fi: 'Kiireelliset tehtävät ensin' });

    await demo.chapter('AC3');
    await demo.offCamera(async (ui) => {
      await ui.fill('#title', spare);
      await ui.click('[data-testid=add-task]');
      await ui.waitFor(rowOf(spare));
    });
    demo.say({ en: 'Here is a task we no longer need. Deleting it now asks first.', fi: 'Tätä tehtävää emme enää tarvitse. Poisto kysyy nyt ensin.' });
    await demo.annotate(`${rowOf(spare)} [data-testid=delete]`, { badge: 'CHANGED', title: 'Delete', text: { en: 'Asks for confirmation.', fi: 'Kysyy vahvistuksen.' }, previously: { en: 'Deleted right away.', fi: 'Poistui heti.' } });
    await demo.click(`${rowOf(spare)} [data-testid=delete]`);
    await demo.waitFor(rowOf(spare), { hidden: true });
    await demo.verify('[data-testid=tasks]', { en: 'Gone after confirming', fi: 'Poistui vahvistuksen jälkeen' });

    await demo.outroCard({ say: { en: 'All three acceptance criteria are covered.', fi: 'Kaikki kolme hyväksymiskriteeriä on käyty läpi.' } });
  },
});
