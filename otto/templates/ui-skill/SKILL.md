---
name: myapp-ui
description: How to drive the MyApp UI and create test data - page map, stable selectors and flow scripts. Invoke before any e2e check, screenshot or video of MyApp, and when asked to "open MyApp" or "create a test customer".
---

# MyApp UI

<!-- One or two sentences: what the app is, and what kinds of pages it has. See references/ui-skill.md in otto. -->

| Page | URL | Tech | Full reload? | Selectors that matter |
|---|---|---|---|---|
| Sign in | `/login` | | | |
| | | | | |

## Starting it

- Local, from the issue branch: <!-- command, URL -->
- Shared test environment, if there is one: <!-- URL -->

Browser: <!-- how Chrome is started, and on which port -->

## Signing in

Credentials come from the environment (`APP_USER`, `APP_PASSWORD`). Never put them in prompts, outputs or storyboards.

## Flows

Each flow takes a `UI` driver, so it runs fast in e2e checks and at human pace in videos.

| Script | Functions |
|---|---|
| `scripts/login.ts` | `login(ui)` |

## Test data

<!-- Is the database shared? Can data stay? How do you create what a test needs? -->
<!-- If it is shared: --> Never reset the database or delete from it. Create what a test needs with the flows, under a unique name (`scripts/test-data.ts`), and refer to it by that name or its id.
