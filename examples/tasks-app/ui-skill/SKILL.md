---
name: tasks-ui
description: How to drive the Tasks example app and create test data - page map, stable selectors and flow scripts. Invoke before any e2e check, screenshot or video of Tasks, and when asked to "open Tasks" or "create a test task".
---

# Tasks UI

A task list, server-rendered. **Every action is a full page reload.**

| Page | URL | Selectors that matter |
|---|---|---|
| Sign in | `/login` | `#username`, `#password`, `[data-testid=sign-in]` |
| Tasks | `/` | `#title`, `#priority` (native select), `[data-testid=add-task]`, `#title-error`, rows `tr[data-title="…"]`, in a row `[data-testid=priority]` and `[data-testid=delete]` (asks with `window.confirm`) |

## Starting it

`node examples/tasks-app/server.ts` (http://localhost:3200). Data lives in memory, until the server stops.

## Signing in

`APP_USER` and `APP_PASSWORD` in the environment (the example's defaults are demo / demo123). Never put them in prompts, outputs or storyboards.

## Flows

Each flow takes a `UI` driver, so it runs fast in e2e checks and at human pace in videos.

| Script | Functions |
|---|---|
| `scripts/login.ts` | `login(ui)` |
| `scripts/tasks.ts` | `addTask(ui, { title, priority })`, `rowOf(title)`, `uniqueTitle(text)` |

## Test data

Treat the data as shared: other tasks can appear at any time. Create what a test needs under a unique title (`uniqueTitle`), find it with `rowOf`, and say nothing about the other rows.
