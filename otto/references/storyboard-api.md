# Storyboard API

A storyboard default-exports `storyboard({...})` from `scripts/lib/storyboard.ts`.

## Definition

| Field | Meaning |
|---|---|
| `story.key`, `story.title`, `story.type`, `story.summary` | Title card. Texts can be a string or `{ fi: '…', en: '…' }`. |
| `story.language` | `'fi'` or `'en'`. Narration language unless `--lang` overrides. Detected from the texts if missing. |
| `story.acceptance` | `[{ id: 'AC1', text: '…', say?: '…' }]`. Chapters reference the ids; the outro card ticks verified ones. `say` is an optional spoken version for the chapter announcement. |
| `story.changes` | Bullets on the title card ("What changed"). |
| `story.changedUi` | Selectors of changed elements. Review errors if one is never annotated. An annotation counts when its element is that element, contains it or is inside it. |
| `story.testData` | One line on the title card. |
| `story.app` | App name shown in the card footer. |
| `story.labels` | Your own words for the cards and banners, over the defaults: `criterion`, `of`, `verified`, `outroKicker`, `changes`, `previously`. A guide with steps instead of acceptance criteria: `{ criterion: 'Step', verified: 'Covered', changes: 'You need' }`, with `type: ''` to hide the type. Texts can be per language. |
| `repo` | App repo, relative to the storyboard. Branch and commit go on the cards. |
| `baseUrl` | App URL. Relative URLs in `goto()` resolve against it. |
| `lang` | Force `'fi'` / `'en'` (same as `--lang`). |
| `pace` | `'calm'`, `'normal'` (default), `'brisk'`. |
| `viewport` | Default `{ width: 1600, height: 900, dpr: 1.2 }`, which renders 1920×1080 frames. |
| `ignoreRequests` | RegExps of URLs the "UI has settled" check ignores (polling, websockets, analytics). |
| `reset()` | Restores test data before setup, in dry and real runs. Optional. Only for a database that is yours alone: on a shared one, create data in `setup` instead (SKILL.md, step 3). |
| `setup(ui)` | Fast driver, off camera: sign in, create test data, open the starting page. Variables set here can be used in `scenes`. |
| `scenes(demo)` | The walkthrough, on camera. |

## The `demo` driver

Same interface as the UI skill flow scripts (`goto`, `click`, `fill`, `type`, `press`, `select`, `check`, `waitFor`, `text`, `url`, `eval`), human-paced: the cursor glides to the target, rests, clicks with a ripple; typing is per character; after each action it waits for network and DOM to settle, then pauses so the viewer sees the result. Full page reloads are cut short in the render, and so are waits over 2 seconds: the viewer sees the wait start and end, and the narration keeps playing.

Before pressing, the cursor checks that the element is still where it went: if late content moved it, the cursor follows. If a spinner, scrim or toast covers it, the step waits up to 5 seconds and then fails, naming what is in the way.

Selectors: CSS, `text=Exact text` (case-insensitive), chained with `>>` (`[data-testid=notes] >> text=Delete`).

### Actions

| Call | Notes |
|---|---|
| `click(sel, { dialog?, keepWait? })` | `dialog: { accept: false }` answers the next alert/confirm/prompt the click opens (default OK). `keepWait: true` shows a slow response in full, for a story about the wait itself. |
| `fill(sel, value)` | Clicks the field, selects existing text, types the value. `''` clears. Values of password fields, and of fields named like pass, pwd, secret or token, stay out of the logs and `timeline.json`. |
| `type(text)` / `press(key)` | `press` shows a keycap (Enter, Tab, Escape, arrows…). |
| `select(sel, option)` | Native `<select>`: shows a dropdown stand-in, moves to the option, picks it (by value or label). For custom dropdowns use `click`. |
| `check(sel, checked = true)` | Clicks only when the state differs. |
| `hover(sel, ms = 700)` | Move onto an element and rest (tooltips, "look here"). |
| `scrollTo(sel)` | Smooth scroll so the element is in view. Actions scroll automatically. |
| `pause(ms)` | Extra pause (no-op in dry runs). |
| `answerDialog({ accept, value })` | Queue the answer for the next JS dialog. |
| `offCamera(async (ui) => …)` | Run steps fast and cut them from the video. |
| `quick` | The fast driver, on camera (rarely needed). |

### Narration and structure

| Call | Notes |
|---|---|
| `say(text, { wait? })` | TTS line plus caption. Returns immediately; the next `say` waits. `{ wait: true }` blocks until it ends. `{written\|spoken}` in the text shows `written` in the caption and gives `spoken` to the voice (numbers in Finnish, codes); the same markup works in story texts (AC texts are read aloud by `chapter`). Every line is synthesized, then checked by an independent transcription (the listening check) and resynthesized when the voice said something else; numbers must be heard exactly. |
| `waitSpeech()` | Wait for the current line to finish. |
| `caption(text \| null)` | Caption without voice. |
| `chapter(id, title?, { announce? })` | Clears annotations, shows a banner and then a chip at the top. Reads "Acceptance criterion N. …" aloud (the AC text, or only the number when the text is over 14 words; AC `say` overrides); `announce: false` keeps it silent, a string replaces the line. Title defaults to the AC text. |
| `titleCard({ say? })` | Full-screen card from `story`. |
| `outroCard({ say? })` | Full-screen AC checklist; the line is spoken while the card shows. |

### Annotations

`annotate(sel, opts)` marks the element with an orange pen stroke that draws itself on, and adds a paper slip with text, joined by a hand arrow and placed where it hides the least of the app. The pen goes round a field and its label together, and round a text element's words rather than its full-width box. A slip avoids a label's own field; only when no clean spot exists does it take the first spot that fits. It holds for the reading time, or until the narration that is playing ends.

| Option | Meaning |
|---|---|
| `badge` | `'NEW'` (default for tone new), `'CHANGED'`, `'REMOVED'`, any short text, or `false`. |
| `tone` | Picks the mark and the badge word; there is one pen color. `'new'` (default), `'changed'`, `'info'`, `'error'`: a loop round the element. `'removed'`: a stroke through it. `'success'` (what `verify` uses): an underline ending in a tick. |
| `title`, `text` | Slip heading and one line of explanation. |
| `previously` | Adds "Previously: …" (localized label). |
| `placement` | `'auto'` (default), `'right'`, `'left'`, `'top'`, `'bottom'`. |
| `spotlight` | Dim everything else. |
| `number` | Numbered marker, for several annotations at once (with `keep`). |
| `keep` | Stays when the next annotation is added. By default the next annotation, or an action on another element, removes it. |
| `hold` | Without it the step waits for the reading time and for the current narration to end. With a number (ms), it waits at least that long and doesn't wait for the narration, so the next action can start while the voice is still speaking; it can't shorten a slip below its reading time. `0` = don't wait: the next step starts at once, and review fails the video if the slip then leaves the screen too soon to read. |
| `point` | Move the cursor next to the element. |

`verify(sel, title, { contains?, ...annotate options })` checks the element is there (and contains the text), fails the run if not, and underlines it with a tick. It marks the current chapter verified.

`clear(id?)` removes annotations.

## CLIs

| Script | Purpose |
|---|---|
| `preflight.ts [--port] [--app <url>]` | Is this machine ready? Checks tools, Chrome, the mouse, capture, the voice service, the app's sign-in prompt and fonts. Gives the fix for each problem. |
| `record.ts <storyboard> [--dry] [--lang] [--pace] [--port] [--out] [--fps] [--no-render] [--keep-tab]` | Dry run or record + render + review. |
| `render.ts <video dir>` | Re-render from `work/` (after changing cuts or audio code). |
| `review.ts <video dir>` | Keyframes, contact sheets, lint findings. |
| `preview.ts <url> --annotate 'sel::title::text' [--click sel] [--caption text]` | Screenshot of callouts on a live page. |
| `changed-ui.ts --repo <repo> [--base] [--app] [--login mod#fn] [--url …]` | Diff → candidate selectors. |
