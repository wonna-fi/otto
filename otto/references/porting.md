# Porting to another app or environment

## What the toolkit needs

- Node >= 22.18 (built-in WebSocket and TypeScript type stripping), `ffmpeg` and `ffprobe` on PATH. Tested on Node 22.18 and 24.
- A Chrome with remote debugging the toolkit can reach (`--port`, default 9333).
- For narration: a realtime TTS endpoint (below).
- A UI skill for the app (`references/ui-skill.md`).

Run `node $OTTO/scripts/preflight.ts --app <url>` first. It checks all of this and gives the fix for each problem.

## CDP layer

`scripts/lib/cdp.ts` is the only transport. Everything else calls `send(method, params, sessionId)` and `on(event, handler)`. To reuse an existing helper such as your own CDP wrapper, either:
- point `connectBrowser()` at the same port (simplest; both clients can talk to one Chrome), or
- implement the `Cdp` interface on top of that helper and pass it to `PageSession.open()`.

The recorder always opens its own tab (`Target.createTarget`) with a fixed viewport, so the user's tabs are untouched.

## Starting Chrome

Run Chrome on the same machine as the toolkit, headless (inside WSL too, if that is where the toolkit runs).

```bash
google-chrome --headless=new --remote-debugging-port=9333 --user-data-dir="$HOME/.cache/otto-chrome" \
  --window-size=1600,1000 --no-first-run --no-default-browser-check \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
  --force-color-profile=srgb --disable-dev-shm-usage about:blank &
```

The other flags that Playwright uses for its Chrome (`--allow-pre-commit-input`, PaintHolding off, `--disable-field-trial-config`) made no difference to click delivery in 1,200 timed clicks, so they aren't needed.

Things that can differ from a normal desktop browser:
- **Sign-in:** headless Chrome has no desktop sign-in to fall back on, so NTLM needs `OTTO_HTTP_USER` and `OTTO_HTTP_PASSWORD` (`references/ui-skill.md`).
- **Company firewalls that inspect TLS:** Chrome and Node each need the company root certificate. Chrome: `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n company-root -i company-root.crt` (package `libnss3-tools`), then restart it. Node: `export NODE_EXTRA_CA_CERTS=/path/to/company-root.pem` before running it; setting it in `.env.local` is too late.
- **WSL networking:** in WSL's default NAT mode some hosts may not be reachable; `networkingMode=mirrored` in `.wslconfig` can help.
- **Fonts:** if the app asks for a font this machine lacks (Segoe UI on Linux, for instance), it looks different in the video than for its users. Install it or a close match. The overlay's own fonts are bundled.
- **User agent:** headless Chrome calls itself `HeadlessChrome`. If a sign-in page or gateway refuses that, add `--user-agent="…"` with a normal browser's value.

A headed Chrome, or one on another machine, can work through the port too, as long as its window stays on screen: the screencast only gets frames while the tab paints.

| Setting | |
|---|---|
| `CDP_PORT` | Chrome's remote debugging port for `record.ts`, `preflight.ts` and the other scripts (default `9333`; `--port` overrides it). |
| `APP_URL` | The app's address when a storyboard sets no `baseUrl` (default `http://localhost:3000`). |
| `OTTO_CACHE_DIR` | Where narration clips are cached (default `.cache/` in the skill folder). |

## Flow scripts

Storyboards reuse the UI skill's flows by passing `demo` as the driver. `references/ui-skill.md` explains how to write them, how to reuse scripts you already have, and how to sign in.

## Browser sign-in prompts

| Env | Meaning |
|---|---|
| `OTTO_HTTP_USER`, `OTTO_HTTP_PASSWORD` | Answers for HTTP sign-in prompts (NTLM, Basic). For NTLM usually `DOMAIN\user`. Without them the prompts aren't answered. |
| `OTTO_HTTP_ORIGINS` | Other addresses that may get the credentials, comma-separated. The app's own address always may; nothing else does, and proxies never do. |

## TTS (realtime)

Default model `gpt-realtime-2.1-mini` over the Realtime API (WebSocket). Each line is a one-off session told to speak the text verbatim; the model's audio transcript is compared with the text and retried on mismatch.

| Env | Meaning |
|---|---|
| `TTS_PROVIDER` | `openai`, `azure` or `none` (auto: openai if `OPENAI_API_KEY`, else azure if `AZURE_TTS_ENDPOINT`/`AZURE_TTS_WS_URL`). |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | OpenAI. |
| `AZURE_TTS_ENDPOINT`, `AZURE_TTS_DEPLOYMENT`, `AZURE_TTS_KEY` | Azure Foundry: `wss://<endpoint>/openai/v1/realtime?model=<deployment>`, header `api-key`. |
| `AZURE_TTS_WS_URL` | Full realtime WebSocket URL instead of the composed one (API gateways, older `api-version` URLs). |
| `AZURE_TTS_KEY_HEADER` | Header name for the key when a gateway wants e.g. `x-api-key`. |
| `AZURE_TTS_API_VERSION` | API version for the non-realtime `TTS_API=speech` path (default `2025-03-01-preview`). |
| `TTS_MODEL` | Model / deployment name (default `gpt-realtime-2.1-mini`). `gpt-realtime-2.1` also works and needs no other change. Measured on four stories of a practice app, one take per line, at OpenAI's prices: about $0.12 per video against $0.03 for the mini. It speaks Finnish more slowly (about a quarter longer in one story), and it sometimes answers a line instead of reading it (2 of 49 lines in one run; 0 of 49 for the mini), which the checks are there to catch and costs a retake. |
| `TTS_SPEED`, `TTS_SPEED_EN`, `TTS_SPEED_FI` | Speaking rate. Defaults: English `1.0`, Finnish `0.92`. `TTS_SPEED` sets both; a per-language one wins. |
| `TTS_VOICE`, `TTS_VOICE_FI`, `TTS_VOICE_EN` | Voice (defaults: Finnish `ash`, English `marin`). The realtime voices are alloy, ash, ballad, cedar, coral, echo, marin, sage, shimmer and verse. Listen to them in Finnish before choosing: with some voices (cedar, alloy, ballad, shimmer) the transcriber writes numbers as digits, so the listening check cannot verify the case of Finnish numbers. |
| `TTS_INSTRUCTIONS_FI`, `TTS_INSTRUCTIONS_EN` | Override the narrator instructions. |
| `TTS_API=speech` | Use the `/audio/speech` endpoint instead (non-realtime TTS deployments). |

### Listening check

A voice model's own transcript only echoes its input text, so it cannot tell when the audio said something else (a number in the wrong case, fifteen read as fifty). Each clip is therefore transcribed by a separate speech-to-text model and compared with the intended words: numbers exactly (words in the same case, or digits with the same value), other words with some tolerance. A mismatch is resynthesized (up to 3 attempts); one that persists fails the review. Pace is checked too: pauses inside a line are shortened to 0.4 s, and a take of six or more words that still runs clearly slower than the voice normally speaks is resynthesized the same way. The recording log names a line whose every take came out slow.

| Env | Meaning |
|---|---|
| `TTS_ASR=off` | Turn the check off. |
| `TTS_ASR_MODEL` | Transcription model (OpenAI default `gpt-transcribe`). |
| `TTS_ASR_PROMPT` | What the transcriber is told: `guided` (an example sentence), `short` (an instruction) or `none`. Default: `short` for models with `4o` or `whisper` in the name, otherwise `guided`. If a guided prompt comes back as the transcript, the check switches to `short` by itself and says so. |
| `AZURE_ASR_DEPLOYMENT` | Azure Foundry transcription deployment, e.g. `gpt-transcribe` or Azure OpenAI `whisper`. On Azure the check is off until this is set; it needs its own deployment next to the TTS one. |
| `AZURE_ASR_ENDPOINT`, `AZURE_ASR_KEY`, `AZURE_ASR_API_VERSION` | Default to the TTS endpoint and key, and `2025-03-01-preview`. |

**Choosing the transcriber.** Use `gpt-transcribe` if you can. Measured on the same clips, five listens each:

| | `gpt-transcribe` | `gpt-4o-transcribe`, short prompt |
|---|---|---|
| Good clips that pass a listen | 100% (the clips were first approved by this model, which flatters it) | English 98%, Finnish with the ash voice 87% |
| A number in the wrong case gets through (Finnish) | 0 of 15 listens | 11 of 15 |
| A wrong amount, different words or a Finnicized label get through | 0 of 20 | 0 of 20 |

`gpt-4o-transcribe` works, with two costs. It often writes Finnish numbers as digits, and digits carry no case, so review warns about those lines and someone should listen to them. And it fails good lines now and then, which costs retakes. Don't use `TTS_ASR_PROMPT=guided` with it: on short clips it repeats the prompt or translates the line.

Clips are cached in the skill folder's `.cache/tts/` by provider, model, voice, instructions and text, so re-recording only pays for changed lines.

## Your own look

The overlay's colors and type are tokens. Set `OTTO_THEME` to a JSON file, or to the JSON itself, with any of these: `pen`, `penText` (small text in the pen color; keep 4.5:1 contrast on white), `penLarge`, `ink`, `ink2`, `ink3`, `hair`, `rule`, `ground` (behind the title and outro cards), `paper` and `paperEdge` (the notes' paper and the outline that keeps it apart from a white page), and `font` (a font installed on this machine).

```bash
OTTO_THEME='{"pen":"#6b3fa0","penText":"#5a338a","penLarge":"#633a95"}'
```

## Publishing

The toolkit never posts anything. Upload and comment with your tracker's CLI (see SKILL.md, step 8).
