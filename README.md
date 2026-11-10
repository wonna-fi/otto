# otto

Your coding agent implemented a story. Now it shows you that it works: a narrated, human-paced video with one chapter per acceptance criterion, ready to attach to the ticket.

The agent writes a short storyboard, checks it with a fast dry run, and records in one go. The result is a 1080p mp4 of the real app with a visible cursor, marks on what changed, captions, and a voice in the story's language.

It's a **skill for coding agents** plus a small toolkit. Plain Node and ffmpeg, no npm install.

> **Status: alpha.** So far it has been used on small demo apps, not yet on a production app. See [Limitations](#limitations).

## What makes it different

Plenty of tools turn a browser script into a polished product video. This one makes evidence for reviewers, QA and product owners who haven't seen the code, and it checks itself:

- **Follows the acceptance criteria.** One chapter each. Review reports a criterion with no chapter or no on-screen verification.
- **Checks that the change was shown.** The diff gives a list of changed UI, and review fails if an element on it is never annotated.
- **Checks what the voice said.** Every line is transcribed by a separate model and compared with the script. A voice model can misread a number, or use the wrong case in a language like Finnish. Bad takes are redone.
- **Stops instead of filming a broken state.** A failed `verify` fails the run, and a click on something covered by a spinner fails too.
- **Keeps notes on screen long enough to read,** and review fails the video if one leaves too soon.
- **Shows what screen capture can't see:** native select popups and `confirm` dialogs get look-alike stand-ins that use the real values.
- **Handles what older apps do:** full page reloads, native `<select>` popups and `confirm` dialogs, browser sign-in prompts, forms that load late.

Want something else?
- **Product marketing videos:** [Argo](https://github.com/shreyaskarnik/argo) has zooms, transitions, free local voices and more.
- **Building blocks for your own tool:** [Playwright's screencast API](https://playwright.dev/docs/api/class-screencast).
- **Terminal demos:** [VHS](https://github.com/charmbracelet/vhs).

## Try it

You need Node 22.18 or newer, ffmpeg and Chrome. The example is a small task list with one story.

```bash
# 1. Start Chrome and the example app
google-chrome --headless=new --remote-debugging-port=9333 --user-data-dir="$HOME/.cache/otto-chrome" --window-size=1600,1000 about:blank &
node examples/tasks-app/server.ts &

# 2. Is everything ready?
node otto/scripts/preflight.ts --app http://localhost:3200

# 3. Check the storyboard, then record it
node otto/scripts/record.ts examples/tasks-app/storyboard.ts --dry
node otto/scripts/record.ts examples/tasks-app/storyboard.ts
```

The video lands in `examples/tasks-app/video.mp4`. For a voice, put `OPENAI_API_KEY=...` in `otto/.env.local`, or configure Azure ([porting.md](otto/references/porting.md)). Without one the video is silent, with estimated timing.

A storyboard looks like this:

```ts
export default storyboard({
  story: { key: 'TASK-7', title: 'Give tasks a priority', acceptance: [{ id: 'AC1', text: 'A new task can be given a priority.' }] /* … */ },
  setup: async (ui) => { await login(ui); await ui.goto('/'); },     // fast, off camera
  scenes: async (demo) => {
    await demo.titleCard({ say: 'Tasks now have a priority.' });
    await demo.chapter('AC1');
    demo.say('The form for a new task has a new field, Priority.');
    await demo.annotate('#priority', { title: 'Priority', text: 'Low, Normal or High.' });
    await demo.select('#priority', 'High');
    await demo.click('[data-testid=add-task]');
    await demo.verify('[data-testid=priority]', 'Saved with priority High', { contains: 'High' });
    await demo.outroCard({ say: 'All criteria are covered.' });
  },
});
```

## Using it on your app

1. Copy `otto/` to where your agent finds skills (for example `.claude/skills/` or `.github/skills/`).
2. Make a UI skill for your app, so the agent knows how to sign in and move around: [references/ui-skill.md](otto/references/ui-skill.md), with a template in `otto/templates/`.
3. Ask your agent for a video of the story. [SKILL.md](otto/SKILL.md) tells it how.

More: [storyboard API](otto/references/storyboard-api.md) · [writing narration](otto/references/writing.md) · [porting and configuration](otto/references/porting.md) · [troubleshooting](otto/references/troubleshooting.md).

## Limitations

- **Unproven on real apps.** So far it has only run on small demo apps, on Linux with headless Chrome.
- **Chromium only, and no Playwright.** It speaks CDP directly, so it can't reuse Playwright tests, locators or saved logins.
- **No iframes or shadow DOM** in its selectors.
- **Needs a paid voice service** for narration: OpenAI, or Azure OpenAI (supported, not yet tested against a live deployment). Your narration text goes to that service. The voice is AI-generated.
- **A person or a critic still has to watch.** An agent that writes its own demo can script around a defect. [critic.md](otto/references/critic.md) proposes an independent review of script and video, but that isn't built in yet.
- **Sign-in:** NTLM has been tested against a stand-in server that does the handshake, but not a real one. The Entra template has been tested for its logic only, against a stand-in page.
- **A known Chrome oddity:** very rarely, a new tab gets no mouse input. The cause is unknown. The toolkit detects it and opens another tab.
- **Input is real, but some browser UI isn't:** native date pickers and file choosers don't show in recordings.

No support is promised, but issues and pull requests are welcome.

## Tests

```bash
node --test --test-concurrency=1 'otto/tests/*.test.ts' 'otto/scripts/lib/*.test.ts'
```

They start their own headless Chrome and need no API keys.

## License

MIT, see [LICENSE](LICENSE). The bundled Archivo SemiCondensed font is under the SIL Open Font License ([OFL.txt](otto/scripts/lib/fonts/OFL.txt)).
