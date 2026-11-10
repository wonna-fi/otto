---
name: otto
description: Record a narrated, human-paced demo video (mp4) of an implemented story - visible cursor, highlighted and annotated changes, one chapter per acceptance criterion, captions and TTS voice in the story's language. Runs as its own pass after implementation and e2e testing. Invoke when asked to "make a video of <KEY>", "record the change", "video for QA/review" or "/otto".
---

# otto: story videos

You write a **storyboard** (a small TypeScript file) that walks through the change the way a person would show it to a colleague. The toolkit plays it at human pace while recording, narrates it, and renders an mp4. You never record while you think: you iterate on the storyboard with fast dry runs, then record in one go.

The video is for reviewers, QA and stakeholders who have not seen the code. It answers: *what changed, where is it, and does each acceptance criterion work?*

Everything runs with plain `node` (>= 22.18, no install) plus `ffmpeg`. Scripts are in `scripts/` next to this file; below, `$OTTO` is this skill's directory.

## Before you start

- The app runs from the issue branch, and Chrome is running with remote debugging (the UI skill of the app explains both). The recorder opens its own tab, so the user's tabs stay untouched.
- You have the app's UI skill and its flow scripts (login, navigation). Reuse them: storyboards import the same flow functions the e2e checks use. No UI skill yet? `references/ui-skill.md` explains how to make one, with a template.
- In a new environment, or when something fails in a strange way, run `node $OTTO/scripts/preflight.ts --app <url>`. It checks Chrome, the mouse, screen capture, the voice service, the app's sign-in prompt and fonts, and gives the fix for each problem.
- Narration: `OPENAI_API_KEY` (or `AZURE_TTS_*`) in `$OTTO/.env.local`. Without it the video is silent with estimated timing; say so when you hand it over.

## Workflow

### 1. Gather

- The story with acceptance criteria and design images (from your issue tracker, e.g. with [lassi](https://github.com/wonna-fi/lassi), a Jira CLI for coding agents: `lassi jira issue get <KEY> --all`; or the story file you were given).
- The diff: `git diff <base>...HEAD --stat` in the app repo, then the UI files.
- If an e2e pass ran: its notes, screenshots and the test data it used. Reuse that test data.
- Any decisions recorded for the issue (a decisions file, PR description or ticket comments): decisions that change behaviour belong in the video.
- **Language**: narration, captions and card texts follow the story's language (Finnish story → Finnish video). If the user asks for another language, write the texts in that language and pass `--lang`.

### 2. List the changed UI

```bash
node $OTTO/scripts/changed-ui.ts --repo <app repo> --base <base> --app <app url> \
  --login <ui-skill>/scripts/login.ts#login --url <page> [--url <page> ...]
```

It lists test ids, ids, names and label texts added in the diff, and which of them are visible on the pages you pass. Confirm and fill gaps with [`chrome-devtools-axi`](https://www.npmjs.com/package/chrome-devtools-axi) `snapshot` (attach it to the same Chrome: `CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:<port>`). Put the selectors of the elements a viewer must notice into `story.changedUi`; review fails if one is never annotated. An annotation counts when it shows that element, an element inside it, or one around it, so the selectors don't have to be written the same way. The list is a heuristic: it also shows lines that were only edited, and `text=` hits on other pages.

### 3. Test data

The data must show the change in its natural state (e.g. a customer who does not have the new field filled yet). Put sign-in, creating data and navigation to the starting page in `setup`: it runs fast and off camera.

**Is the database shared?** If several people or agents use it, assume yes:
- **Never reset, reseed or delete.** Leave out `reset`. Data you create can stay, unless the user asks you to clean up.
- **Create what the story needs in `setup`**, through the UI flows the e2e pass uses, under a name unique to this run. Keep its id in a variable for `scenes`:

  ```ts
  let customer: { id: number; name: string };
  export default storyboard({
    setup: async (ui) => { await login(ui); customer = await createCustomer(ui, 'Maija'); },
    scenes: async (demo) => { await demo.click(`tr[data-customer-id="${customer.id}"] [data-testid=open]`); /* … */ },
  });
  ```
- **Point at what you created**, never at "the first row". Other rows can appear at any time.
- **Say and check only facts about your own data.** "It lists all 48 tasks" and "7 of 48" break as soon as someone adds a row. Check a property instead: every listed task has the High badge, your own task is in the list, and a row that shouldn't be there isn't.
- Dry runs really submit forms, so they create data too. That's fine, but every run needs its own new record if the story changes it.
- If the story needs data the UI can't create, ask the user before changing the database directly.

If the database is yours alone (per-branch database, container), a `reset` that restores the state (reseed, API call or SQL) makes every run start the same.

### 4. Write the storyboard

Create `videos/<KEY>/storyboard.ts` (or the location your project uses). Imports and `repo` are paths **relative to the storyboard file**. Start from this shape:

```ts
import { storyboard } from '../../<skills>/otto/scripts/lib/storyboard.ts';   // relative to this file; <skills> is where your agent keeps skills
import { login } from '../../<skills>/<app>-ui/scripts/login.ts';

export default storyboard({
  story: {
    key: 'PROJ-101', title: '…', type: 'Story', language: 'en', app: 'MyApp',
    summary: 'One sentence: who gets what, and why.',
    acceptance: [{ id: 'AC1', text: '…' }, { id: 'AC2', text: '…' }],
    changes: ['Short bullet per visible change'],          // title card
    changedUi: ['#new-field', '[data-testid=new-column]'],  // from step 2
    testData: 'Test data: Maija Meikäläinen (customer 1001)',
  },
  repo: '../..', baseUrl: 'http://localhost:3000',            // repo relative to this file
  setup: async (ui) => { await login(ui); await ui.goto('/start/page'); },
  scenes: async (demo) => {
    await demo.titleCard({ say: '…' });
    await demo.chapter('AC1');                 // banner + spoken "Acceptance criterion 1. …"
    demo.say('Where we are and what we do next.');
    await demo.click('…');
    await demo.annotate('#new-field', { title: 'New field', text: 'What it does, in one line.' });
    await demo.verify('…', 'What the viewer should now see');
    // … one chapter per AC …
    await demo.outroCard({ say: '…' });
  },
});
```

Rules:
- **One chapter per acceptance criterion**, in story order, each ending with at least one `verify()` that shows the criterion holding. The outro card ticks the ACs that had a verify.
- **Annotate every changed element** the first time it appears: `badge` NEW (default), CHANGED or REMOVED; a short `title`; one-line `text`. Use `previously` for changed behaviour ("Previously: free text"). Use `spotlight: true` for the single most important new element.
- **Narrate like a colleague sitting next to the viewer**: say where we are and what happens next, before or while it happens. 1-2 short sentences per line, plain words, no UI-test jargon, no selectors. `say()` returns immediately so the actions continue while it plays; the next `say()` waits for the previous one.
- **Numbers the voice says**: write `{written|spoken}`, e.g. `Tavarat pakataan {35|kolmeenkymmeneenviiteen} laatikkoon`. Captions keep the digits; the voice gets words. In Finnish this is required: digits carry no case and the voice reads them in the base form. A listening check transcribes every line and resynthesizes it when the voice said something else.
- **Test data is never "real"**: naming test customers is fine, but never call them real customers, orders or cases; when it needs a word, it is a test customer, testiasiakas, a test order.
- **English UI labels in Finnish narration**: as on screen, never Finnicized, and never with a Finnish ending attached (the voice then says "Customs-vaihe" the Finnish way). Keep the word apart (`{Customs-vaihe|uusi vaihe, Customs,}`) or use the Finnish word and let the callout show the label.
- **Use the app's flow functions** for navigation (`openCustomer(demo, 1001)`), so paths stay in one place. Pass `demo` as the driver: it is the same interface, human-paced.
- Use `demo.offCamera(async (ui) => …)` for steps nobody needs to watch (long form fills unrelated to the story).
- Keep it short: about 20-40 s per acceptance criterion, 1-3 minutes in total.
- Annotate a specific part of very large elements (a table's header row, one row) rather than the whole thing; a callout cannot sit next to something that fills the screen.
- Never put credentials in the storyboard; the flow scripts read them from env.
- Make the checks strict where a callout alone could lie: `verify(sel, title, { contains })`, or read data with `demo.eval(...)` and `throw` when it is wrong ("every listed task is High, and mine is among them"). The run then fails instead of filming a broken state.

The full API with all options: `references/storyboard-api.md`. Narration and annotation style, with examples in English and Finnish: `references/writing.md`.

### 5. Dry run

```bash
node $OTTO/scripts/record.ts videos/<KEY>/storyboard.ts --dry
```

Runs the whole flow fast, without recording or TTS, and checks every selector. **Always dry-run before recording**: it also writes the narration list that the recording synthesizes up front (otherwise lines are synthesized mid-recording and that time is cut out). Fix failures (the message names the step; `work/failure.png` shows the page). It also warns about ACs without a chapter or verify and changed UI never annotated. Repeat until clean. Use `node $OTTO/scripts/preview.ts <url> --annotate 'selector::title::text' [--placement right]` to check a callout's placement on a live page without recording. It reuses the browser's cookies, so after a dry run it opens pages signed in.

### 6. Record

```bash
node $OTTO/scripts/record.ts videos/<KEY>/storyboard.ts [--lang fi|en] [--pace calm|normal|brisk]
```

Takes about as long as the video plus a minute. It synthesizes the narration first (cached), records, renders and reviews. Exit code 2 means the review found errors.

### 7. Review, then fix and re-record

Open `videos/<KEY>/review/review.md`, look at the contact sheets `review/sheet-*.jpg` (and single frames `review/frame-NNN.jpg` where needed). Check:
- Every action is visible: cursor on target, callouts readable and not covering what is being explained.
- Each AC chapter shows the criterion actually holding (the verify callout is on the right element, with the right state).
- No error states, empty pages or loading spinners you did not intend.
- Narration matches what is on screen at that moment, in the right language.

Fix the storyboard (or test data) and record again. Typical fixes: wrong element annotated → better selector; callout covers the next click → `placement` or `point`; narration too long → split or shorten; something happens off screen → `scrollTo` first. Re-recording reuses cached narration, so it is cheap.

### 8. Publish to the audience

Outputs in `videos/<KEY>/`: `video.mp4` (1080p H.264/AAC with chapters), `chapters.md` (timestamps), `captions.vtt`, `poster.jpg`, `storyboard.ts`. Tell the user the path, the length and the chapter list. The aim is no human gate: once the critic loop in `references/critic.md` (proposed, not built yet) approves a video, the agent publishes it itself. Until those critics exist, ask before posting anywhere. To post to Jira with `lassi`, or the same with your tracker's CLI:

```bash
lassi jira issue attach upload <KEY> videos/<KEY>/video.mp4
lassi jira issue comment add <KEY> --file <comment.md>     # chapters.md + "[video](attachment:video.mp4)"
```

## Troubleshooting

`references/troubleshooting.md`. Porting to another app or environment: `references/porting.md`. Making a UI skill for an app: `references/ui-skill.md`.
