// Selector engine evaluated inside the page. Same syntax as the UI skill scripts:
// plain CSS, `text=Exact text`, and chains with `>>` (e.g. `[data-testid=notes-panel] >> text=Delete`).
// Prefers the first *visible* match.
export const FIND_FN = `function __find(selector) {
  const parts = selector.split('>>').map((s) => s.trim());
  let scope = [document];
  for (const part of parts) {
    const next = [];
    for (const root of scope) {
      if (part.startsWith('text=')) {
        const want = part.slice(5).trim().replace(/^"|"$/g, '');
        const cands = root.querySelectorAll('button, a, [role=tab], [role=button], label, th, td, li, h1, h2, h3, span, div, option, p, strong');
        for (const el of cands) {
          const t = (el.innerText ?? el.textContent ?? '').trim().replace(/\\s+/g, ' ');
          if (t.toLowerCase() === want.toLowerCase() && ![...el.children].some((c) => (c.innerText ?? '').trim().replace(/\\s+/g, ' ').toLowerCase() === want.toLowerCase())) next.push(el);
        }
      } else {
        next.push(...root.querySelectorAll(part));
      }
    }
    scope = next;
    if (!scope.length) return null;
  }
  const visible = scope.find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  return visible ?? scope[0] ?? null;
}`;
