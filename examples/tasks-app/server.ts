// A very small task list, to try the toolkit on. Server-rendered, so every action is a full page reload.
// Keeps everything in memory, and answers a little slowly, like a real server.
//   node examples/tasks-app/server.ts        # http://localhost:3200, sign in with demo / demo123
import http from 'node:http';

type Task = { id: number; title: string; priority: 'Low' | 'Normal' | 'High' };
const tasks: Task[] = [
  { id: 1, title: 'Renew the office lease', priority: 'Normal' },
  { id: 2, title: 'Order new badges', priority: 'Low' },
  { id: 3, title: 'Plan the summer party', priority: 'Normal' },
];
let nextId = 4;
const sessions = new Set<string>();
const USER = process.env.APP_USER ?? 'demo';
const PASSWORD = process.env.APP_PASSWORD ?? 'demo123';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const CSS = `
  body { font: 16px/1.5 system-ui, sans-serif; color: #1f2933; margin: 0; background: #f5f7fa; }
  header { background: #1f3a5f; color: #fff; padding: 14px 32px; display: flex; justify-content: space-between; }
  main { max-width: 860px; margin: 32px auto; padding: 0 16px; }
  section { background: #fff; border: 1px solid #d9e2ec; border-radius: 6px; padding: 20px 24px; margin-bottom: 24px; }
  h1 { font-size: 22px; margin: 0 0 16px; } label { display: block; font-weight: 600; margin: 12px 0 4px; }
  input, select { font: inherit; padding: 8px 10px; border: 1px solid #9fb3c8; border-radius: 4px; width: 320px; box-sizing: border-box; }
  button { font: inherit; padding: 8px 18px; border: 0; border-radius: 4px; background: #1f6feb; color: #fff; cursor: pointer; margin-top: 14px; }
  button:hover { background: #1558c0; } button.quiet { background: #e4e7eb; color: #1f2933; margin: 0; padding: 4px 12px; }
  table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e4e7eb; }
  .badge { padding: 2px 10px; border-radius: 10px; font-size: 13px; background: #e4e7eb; }
  .badge.High { background: #c81e1e; color: #fff; } .error { color: #c81e1e; margin-top: 6px; }`;
const page = (title: string, body: string, user = false) => `<!doctype html><html lang="en"><title>${title} - Tasks</title><style>${CSS}</style>
  <header><strong>Tasks</strong>${user ? `<span data-testid="current-user">${esc(USER)}</span>` : ''}</header><main>${body}</main></html>`;

const signIn = (error = '') => page('Sign in', `<section><h1>Sign in</h1><form method="post" action="/login">
  <label for="username">Username</label><input id="username" name="username" autocomplete="off">
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="off">
  ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}<button data-testid="sign-in">Sign in</button></form></section>`);

const rank = { High: 0, Normal: 1, Low: 2 };
const list = (error = '') => {
  const rows = [...tasks].sort((a, b) => rank[a.priority] - rank[b.priority]).map((t) => `<tr data-task-id="${t.id}" data-title="${esc(t.title)}">
    <td>${esc(t.title)}</td><td><span class="badge ${t.priority}" data-testid="priority">${t.priority}</span></td>
    <td style="text-align:right"><form method="post" action="/tasks/${t.id}/delete" onsubmit="return confirm('Delete this task?')"><button class="quiet" data-testid="delete">Delete</button></form></td></tr>`).join('');
  return page('Tasks', `<section><h1>New task</h1><form method="post" action="/tasks">
    <label for="title">Title</label><input id="title" name="title" autocomplete="off">${error ? `<div class="error" id="title-error" role="alert">${esc(error)}</div>` : ''}
    <label for="priority">Priority</label><select id="priority" name="priority"><option>Low</option><option selected>Normal</option><option>High</option></select>
    <div><button data-testid="add-task">Add task</button></div></form></section>
    <section><h1>All tasks</h1><table data-testid="tasks"><thead><tr><th>Title</th><th>Priority</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`, true);
};

const form = (req: http.IncomingMessage) => new Promise<URLSearchParams>((resolve) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => resolve(new URLSearchParams(body)));
});

const server = http.createServer(async (req, res) => {
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
  const html = (body: string, status = 200) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
  const go = (to: string, extra: Record<string, string> = {}) => res.writeHead(303, { location: to, ...extra }).end();
  const path = (req.url ?? '/').split('?')[0];
  const token = /(?:^|;\s*)session=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
  const signedIn = !!token && sessions.has(token);

  if (path === '/login' && req.method === 'POST') {
    const f = await form(req);
    if (f.get('username') !== USER || f.get('password') !== PASSWORD) return html(signIn('Wrong username or password'), 401);
    const t = Math.random().toString(36).slice(2);
    sessions.add(t);
    return go('/', { 'set-cookie': `session=${t}; Path=/; HttpOnly; SameSite=Lax` });
  }
  if (path === '/login') return signedIn ? go('/') : html(signIn());
  if (!signedIn) return go('/login');
  if (path === '/' && req.method === 'GET') return html(list());
  if (path === '/tasks' && req.method === 'POST') {
    const f = await form(req);
    const title = (f.get('title') ?? '').trim();
    if (!title) return html(list('Give the task a title'), 422);
    const priority = f.get('priority');
    tasks.push({ id: nextId++, title, priority: priority === 'High' || priority === 'Low' ? priority : 'Normal' });
    return go('/');
  }
  const del = /^\/tasks\/(\d+)\/delete$/.exec(path);
  if (del && req.method === 'POST') {
    const at = tasks.findIndex((t) => t.id === Number(del[1]));
    if (at >= 0) tasks.splice(at, 1);
    return go('/');
  }
  res.writeHead(404).end('Not found');
});

const port = Number(process.env.PORT ?? 3200);
server.listen(port, () => console.log(`Tasks on http://localhost:${port}, sign in with ${USER} / ${PASSWORD}`));
