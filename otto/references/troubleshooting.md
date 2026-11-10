# Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No Chrome with remote debugging on port N` | Start Chrome with `--remote-debugging-port=<port>` (see `references/porting.md`), or pass `--port`. |
| `Step 7 (click …) failed: Timed out … waiting for "…"` | Selector wrong, element not rendered yet, or the previous step went somewhere else. Open `work/failure.png`. Check with `chrome-devtools-axi snapshot` in the same Chrome. |
| A `text=` selector misses | It matches the element's whole visible text (case-insensitive). Use a container + `>> text=…`, or a test id. |
| Something fails in a strange way | Run `preflight.ts --app <url>`: it checks the machine, the network and the sign-in prompt. |
| Dry run passes, real run fails | Timing: the real run waits for network/DOM quiet; an app that polls forever never settles → add the polling URL to `ignoreRequests`. Or state: the dry run changed data the real run expects unchanged. Create a new record in `setup` every run, or on a database of your own, `reset` it. |
| A count or a list changes between runs | Someone else's data, on a shared database. Don't state or check totals; check a property of the rows and your own record (SKILL.md, step 3). |
| Login page appears in the video | `setup` didn't sign in, or another app on the same host replaced the session cookie. Give each app its own host name (`app1.localhost`), or sign in inside `setup` every time. |
| Review: "Slip too short to read" | The next step removed the slip too soon, usually after `hold: 0` or an action on another element. Remove `hold: 0`, or move the action later. |
| Callout covers the next thing clicked | `placement: 'left'` etc., or `clear()` before the next action. Check with `preview.ts`. |
| Annotated element not on screen (review error) | It was hidden, scrolled away or replaced. `scrollTo` first, or annotate after the UI settled. |
| Review: "Voice said something else" | The listening check heard different words or numbers than intended, even after resynthesis. Numbers: write them in words, inflected for the sentence, with `{written\|spoken}`. Otherwise rephrase the line (simpler words) and record again. |
| Note: "Mouse input did not reach N new tab(s)" | Chrome gave a tab with no mouse input, so the toolkit replaced it. The cause is not known; it's rare and can't be brought on at will. The run is fine. Keep the note if you see it often: it says whether the problem belonged to the tab or to the moment. |
| `Chrome is not delivering mouse input` | New tabs kept getting no mouse input for 45 seconds. Restart Chrome. |
| Note: "A click … did not reach the page at first", or "never reached the page, so it was delivered from inside the page" | Chrome stopped delivering mouse input during the run. It can last a few minutes, across runs, and then come back by itself; the cause is not known. The page never got the first click, so sending it again can't cause a double click. A video with clicks delivered from inside the page plays correctly but may miss hover styles: record it again if you can. |
| Note: "Key events are not reaching new tabs", or "The key … did not reach the page" | Chrome stopped delivering key events for a while. The cause is not known. Filling fields doesn't need them, so most runs are fine. `the page did not receive the key` means a `press` failed even after retries: wait a minute and run again, or restart Chrome. |
| Note: "Typing into … left the wrong text in it" | The old text stayed or the new text was added to it, so the field was corrected from inside the page. The run goes on, and the app saw an ordinary change. |
| `"…" is covered by <div.something>` | A spinner, scrim, toast or dialog stayed on top of the target for 5 seconds. Wait for it to go first, or close it. If what covers it is part of the control (a custom-styled checkbox), click that part instead. |
| `clicking the link to … did not open it` | The click landed but the page did not navigate: something covered the link, the app cancelled it, or the page was still busy. Look at `work/failure.png`; add a `waitFor` for what must be ready before the click. |
| Callout covers a huge element | Elements larger than the screen get a loop round their visible part only. Annotate a smaller part (header row, one row) instead. |
| Silent video | No `OPENAI_API_KEY` / `AZURE_TTS_*` in `$OTTO/.env.local` (`TTS_PROVIDER=none`). |
| `browser sign-in: … refused` or a page that stays on 401 | The app uses a browser prompt (NTLM or Basic). Set `OTTO_HTTP_USER` (`DOMAIN\user`) and `OTTO_HTTP_PASSWORD`. A prompt from another host needs that host in `OTTO_HTTP_ORIGINS`. |
| Certificate errors (`ERR_CERT_…`, `SELF_SIGNED_CERT_IN_CHAIN`) | A firewall that inspects TLS. Chrome and Node each need the company root certificate (`references/porting.md`). |
| The app looks different in the video | A font the app asks for is missing on this machine. `preflight.ts --app <url>` names it. |
| `No screencast frames were received` | The tab isn't painting: a minimized or hidden headed window. Start Chrome with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`, keep the window un-minimized, or use headless. |
| Native date picker or file chooser | Not visible in recordings. Type dates into the field; use `offCamera` for uploads. |
| JS `alert/confirm/prompt` | Handled: shown as a look-alike dialog, answered with `{ dialog: { accept } }` on the click (default OK). The app must not do anything before reading the answer (normal `if (!confirm()) return`). |
