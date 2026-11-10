# Creating a UI skill for an app

Videos and e2e checks drive the app through a **UI skill**: a short description of the app plus flow scripts for signing in, moving around and creating test data. Write it once per app. Without it, every agent has to rediscover the pages, and the storyboards fill up with selectors.

If you already have scripts for the app, start from those (see "Reusing scripts you already have"). The otto repository has a small complete example in `examples/tasks-app/ui-skill`. `templates/ui-skill/` in this skill is a starting point: copy it to where your agent finds skills, and rename it.

## What goes in it

```
<app>-ui/
  SKILL.md             what the app is, how to start it, the page map, known test data
  scripts/
    login.ts           signing in
    <area>.ts          flows for each part of the app: open a customer, create an order...
```

**SKILL.md** holds what an agent can't get cheaply from the code:
- How to start the app and which URL it runs on, locally and in any shared test environment.
- A page map: each page, its URL, its technology, whether moving to it is a full reload, and the selectors that matter. A table is enough.
- How to create test data, and how data behaves (is the database shared? can data stay?).
- Which flows exist.

## Building it

1. **Look at the real app.** Attach `chrome-devtools-axi` to the Chrome the toolkit uses (`CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:<port>`) and take a `snapshot` of each page. Don't guess selectors from the code alone: build steps rename things, and server-rendered pages often get their ids from templates or data the diff doesn't show.
2. **Write down stable selectors.** In order of preference: `data-testid`, `id`, `name`, then `text=Exact label`. Avoid generated class names and positions (`tr:nth-child(3)`). If an important element has nothing stable, add a `data-testid` to the app in the issue branch rather than building on sand.
3. **Write the sign-in flow first**, then one flow per thing agents repeatedly do.
4. **Try each flow** against the running app before relying on it. A small command-line entry in each file makes that easy.

## Rules for flows

- **A flow takes the driver as a parameter:** `export async function openCustomer(ui: UI, id: number)`. The same function then runs fast in e2e checks and `setup`, and at human pace on camera when a storyboard passes `demo`. The `UI` interface is in `scripts/lib/fast-driver.ts`: `goto`, `click`, `fill`, `type`, `press`, `select`, `check`, `waitFor`, `text`, `url`, `eval`.
- **End on what proves you arrived.** `await ui.waitFor('[data-testid=customer-header]')`, not a sleep. After a full reload the old page is gone, so wait for something that only exists on the new one.
- **Never sleep for a fixed time.** Wait for content. A slow day on a shared environment turns a fixed sleep into a failure.
- **No credentials in code.** Read them from the environment. The toolkit keeps values typed into password fields out of its logs, but it can't protect a password written into a script.
- **Return what the caller needs**, such as the id of what you created.
- **Be safe to run twice.** A sign-in flow checks whether it is already signed in. A create flow makes a new record with a new name.
- **No assumptions about other people's data.** See the next section.

## Test data on a shared database

If several people or agents use one database, you can't reset it, and rows can appear while you work. Flows for test data then follow these rules:

- **Create what you need through the UI**, with a name unique to the run. `templates/ui-skill/scripts/test-data.ts` has a helper.
- **Find your rows by what you created:** `tr[data-customer-id="4711"]`, or `text=` with your unique name. Never "the first row".
- **Never reset, reseed or delete** shared data, unless the user tells you to clean up after a special case.

`references/writing.md` and the storyboard rules in `SKILL.md` cover what this means for what a video may say.

## Signing in

`templates/ui-skill/scripts/login.ts` has a flow for each kind. Always sign in off camera, in the storyboard's `setup`. Keep the sign-in in one function, because every storyboard calls it.

| The app uses | What to do |
|---|---|
| **Entra ID** | `signInWithEntra`: email, password, "Stay signed in?". Works when test users have no MFA and a conditional access policy doesn't block this machine. Set `APP_USER` and `APP_PASSWORD`. If your existing e2e scripts already sign in, reuse those instead. |
| **Its own username and password form** | `signInWithForm`, with the app's selectors. |
| **Browser prompt (NTLM)** | No flow needed: set `OTTO_HTTP_USER` (`DOMAIN\user`) and `OTTO_HTTP_PASSWORD` in `.env.local`, and the toolkit answers the prompt for the app's own address. If the prompt comes from another address (a separate sign-in host), list it in `OTTO_HTTP_ORIGINS`. Credentials go to no other site. |

`preflight.ts --app <url>` tells which browser prompt the app uses, if any. To check by hand: `curl -sI <url> | grep -i www-authenticate`.

Because the recording tab uses the Chrome profile's cookies, "stay signed in" carries over between runs. If two apps on one host overwrite each other's session cookie, give each its own host name.

## Reusing scripts you already have

Existing scripts usually work if they can use the toolkit's driver.

- **A shared CDP helper, with flows that call it directly** (`click('#x')`): make the driver a parameter with your current helpers as the default, for example `export const login = (ui = defaultPage) => …`. Your e2e scripts keep working, and a storyboard can pass `demo`.
- **Selectors:** the toolkit accepts CSS, `text=Exact text` and chains with `>>`. It does not look inside iframes or shadow DOM.
- **Same Chrome:** both can use one Chrome at the same port. The toolkit opens its own tab and leaves the others alone.

## Checking the result

```bash
node $OTTO/scripts/preflight.ts --app <url>          # the machine, the network, the sign-in prompt, fonts
node $OTTO/scripts/record.ts <storyboard> --dry      # the flows, in a real storyboard
```

A first storyboard that signs in, opens one page and verifies one element is enough to prove the skill works.
