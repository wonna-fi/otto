/* otto overlay. Injected into every document of the recording tab (Page.addScriptToEvaluateOnNewDocument).
 *
 * Draws everything the viewer sees on top of the app without touching the app's DOM: cursor, click ripple,
 * annotation rings and callouts, spotlight, captions, chapter chip and banner, title/outro cards, and
 * stand-ins for browser UI a screencast cannot capture (native <select> popups, alert/confirm/prompt).
 *
 * Lives in one closed shadow root on an <otto-overlay> element that is promoted to the top layer as a manual
 * popover, so it stays above native <dialog> modals too. pointer-events: none everywhere.
 * The recorder talks to it through window.__otto.call(method, args).
 */
(() => {
  if (window.__otto) return;

  // ---------- main-world patch for window.alert/confirm/prompt ----------
  // While recording (window.__ottoActive), the first call records the dialog and returns "cancel" so the app does
  // nothing yet. The recorder then shows a look-alike dialog, clicks the answer and replays the click with the
  // answer queued, so the app continues as if the user had answered the real dialog.
  // Click receipts: the recorder checks this counter to know a click really reached the page.
  let downs = 0;
  window.addEventListener('mousedown', () => { downs++; }, true);
  Object.defineProperty(window, '__ottoDowns', { get: () => downs, enumerable: false });
  // The same for keys.
  let keys = 0;
  window.addEventListener('keydown', () => { keys++; }, true);
  Object.defineProperty(window, '__ottoKeys', { get: () => keys, enumerable: false });

  const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  let pendingDialog = null;
  let queuedAnswer = null;
  function patch(type) {
    window[type] = function (message, defaultValue) {
      if (!window.__ottoActive) return native[type].apply(window, arguments);
      if (queuedAnswer && queuedAnswer.type === type) {
        const a = queuedAnswer;
        queuedAnswer = null;
        return type === 'confirm' ? !!a.accept : type === 'prompt' ? (a.accept ? a.value ?? '' : null) : undefined;
      }
      pendingDialog = { type, message: String(message ?? ''), defaultValue: defaultValue == null ? '' : String(defaultValue), origin: location.host };
      return type === 'confirm' ? false : type === 'prompt' ? null : undefined;
    };
  }
  patch('alert');
  patch('confirm');
  patch('prompt');

  // One orange felt-tip pen: marks carry meaning by shape (loop: look here; strike: removed; underline + tick:
  // verified), so the tone only picks the badge word.
  const TONES = {
    new: { label: 'NEW' },
    changed: { label: 'CHANGED' },
    removed: { label: 'REMOVED' },
    info: { label: '' },
    success: { label: '' },
    error: { label: '' },
  };
  // Colors and type are tokens: OTTO_THEME replaces any of them with a team's own brand (see references/porting.md).
  const THEME = window.__ottoTheme ?? {};
  const INK = { pen: '#e8491d', penText: '#b8330f', penLarge: '#d63c14', ink: '#24272b', ink2: '#3e434a', ink3: '#626973', hair: '#d8dce1', rule: '#b3b9c1', ground: '#e8eaed', paper: '#ffffff', paperEdge: 'rgba(36,39,43,.42)', ...THEME };
  const FONT = `${THEME.font ? `${THEME.font}, ` : ''}"Otto Archivo", "Archivo", "Segoe UI", system-ui, sans-serif`;

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .layer { position: fixed; inset: 0; pointer-events: none; font-family: ${FONT}; color: ${INK.ink}; -webkit-font-smoothing: antialiased; font-kerning: normal; word-spacing: .04em; }
  .spot { position: fixed; inset: 0; width: 100vw; height: 100vh; opacity: 0; transition: opacity 360ms cubic-bezier(.2,.8,.2,1); }
  .spot.on { opacity: 1; }

  /* pen marks: a white under-stroke keeps the orange readable over any UI */
  .mark, .lead, .cardpen { position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: visible; }
  .mark path, .lead path, .cardpen path, .pen-ink path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .halo { stroke: rgba(255,255,255,.45); }
  .ink { stroke: ${INK.pen}; }
  .mark .num circle { fill: ${INK.penLarge}; }
  .mark .num text { fill: #fff; font: 600 15px ${FONT}; }

  /* paper slips: square corners, a graphite edge so they stand apart from white pages, a soft paper shadow, graphite ink */
  .slip { background: ${INK.paper}; border-radius: 1px; box-shadow: 0 0 0 1px ${INK.paperEdge}, 0 1px 2px rgba(36,39,43,.12), 0 12px 28px -10px rgba(36,39,43,.32); }
  .callout { position: fixed; max-width: 400px; min-width: 150px; padding: 14px 20px 16px; opacity: 0; transform: translateY(6px); transition: opacity 260ms cubic-bezier(.2,.8,.2,1) 200ms, transform 320ms cubic-bezier(.2,.8,.2,1) 200ms; }
  .callout.on { opacity: 1; transform: none; }
  .callout .title { font-size: 28px; font-weight: 400; line-height: 1.16; text-wrap: balance; }
  .callout .badge { position: relative; display: inline-block; margin-right: 10px; font-size: 15px; font-weight: 600; letter-spacing: .1em; color: ${INK.penText}; vertical-align: .24em; line-height: 1; }
  .callout .badge svg { position: absolute; left: -3px; bottom: -7px; width: calc(100% + 7px); height: 7px; overflow: visible; }
  .callout .n { display: inline-block; margin-right: 9px; font-weight: 600; color: ${INK.penText}; }
  .callout .tick { display: inline-block; width: 24px; height: 22px; margin: 0 8px -2px -2px; overflow: visible; }
  .callout .text { margin-top: 6px; font-size: 20px; line-height: 1.38; color: ${INK.ink2}; }
  .callout .prev { margin-top: 10px; padding-top: 8px; border-top: 1px solid ${INK.hair}; font-size: 16.5px; line-height: 1.35; color: ${INK.ink3}; }
  .callout .prev b { color: ${INK.ink2}; font-weight: 600; }
  .lead { opacity: 0; }
  .lead.on { opacity: 1; }

  /* the voice is ink, notes are paper: a caption must read over any app, white pages included */
  .caption { position: fixed; z-index: 5; left: 50%; bottom: 34px; transform: translate(-50%, 8px); max-width: min(1160px, calc(100vw - 80px)); padding: 12px 26px 14px; background: ${INK.ink}; color: #fff; box-shadow: 0 1px 2px rgba(36,39,43,.3), 0 12px 28px -10px rgba(36,39,43,.55); font-size: 25px; line-height: 1.36; font-weight: 400; text-align: center; text-wrap: balance; opacity: 0; transition: opacity 220ms cubic-bezier(.2,.8,.2,1), transform 280ms cubic-bezier(.2,.8,.2,1); }
  .caption.on { opacity: 1; transform: translate(-50%, 0); }
  .caption.top { bottom: auto; top: 66px; }

  /* running head: a slip hanging from the top edge */
  .chip { position: fixed; top: 0; left: 50%; transform: translate(-50%, -110%); opacity: 0; display: flex; align-items: baseline; gap: 12px; padding: 9px 20px 11px; max-width: 780px; white-space: nowrap; overflow: hidden; transition: transform 380ms cubic-bezier(.2,.8,.2,1), opacity 120ms linear; box-shadow: 0 0 0 1px ${INK.paperEdge}, 0 10px 20px -10px rgba(36,39,43,.4); }
  .chip.on { transform: translate(-50%, 0); opacity: 1; }
  .chip .lbl { flex: none; font-size: 15px; font-weight: 600; letter-spacing: .1em; color: ${INK.penText}; }
  .chip .ttl { min-width: 0; font-size: 19px; font-weight: 400; color: ${INK.ink}; overflow: hidden; }

  /* criterion banner: the number in the margin, the criterion as the line */
  .banner { position: fixed; inset: 0; z-index: 4; display: grid; place-items: center; background: rgba(36,39,43,.3); opacity: 0; transition: opacity 280ms cubic-bezier(.2,.8,.2,1); }
  .banner.on { opacity: 1; }
  .banner .box { position: relative; display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; width: min(1000px, calc(100vw - 200px)); padding: 34px 46px 38px 0; transform: translateY(10px); transition: transform 420ms cubic-bezier(.2,.8,.2,1); }
  .banner.on .box { transform: none; }
  .banner .side { padding: 0 30px 0 40px; min-width: 172px; }
  .banner .n { font-size: 88px; font-weight: 300; line-height: .9; color: ${INK.penLarge}; letter-spacing: -.02em; }
  .banner .n small { font-size: 22px; font-weight: 400; color: ${INK.ink3}; letter-spacing: 0; margin-left: 6px; }
  .banner .k { margin-top: 14px; font-size: 15px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: ${INK.ink3}; line-height: 1.3; white-space: nowrap; }
  .banner .t { font-size: 37px; font-weight: 300; line-height: 1.2; color: ${INK.ink}; text-wrap: balance; border-left: 1px solid ${INK.hair}; padding-left: 34px; }
  .banner .pen-ink { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }

  /* title and outro: one review sheet lying on the desk */
  .card { position: fixed; inset: 0; background: ${INK.ground}; opacity: 0; transition: opacity 420ms cubic-bezier(.2,.8,.2,1); }
  .card.on { opacity: 1; }
  .card .sheet { position: absolute; inset: 30px 56px 160px; background: #fff; box-shadow: 0 1px 2px rgba(36,39,43,.08), 0 24px 60px -28px rgba(36,39,43,.35); display: grid; grid-template-columns: 300px minmax(0, 1fr); grid-template-rows: 1fr auto; }
  .card .margin { padding: 64px 0 0 76px; }
  .card .key { display: inline-block; font-size: 33px; font-weight: 500; letter-spacing: .01em; color: ${INK.ink}; }
  .card .type { margin-top: 26px; font-size: 15px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: ${INK.ink3}; }
  .card .body { padding: 52px 90px 0 0; max-width: 1120px; }
  .card h1 { margin: 0; font-size: 62px; font-weight: 300; line-height: 1.08; letter-spacing: -.006em; color: ${INK.ink}; text-wrap: balance; max-width: 20em; }
  .card .sum { margin: 18px 0 0; font-size: 27px; line-height: 1.38; color: ${INK.ink2}; max-width: 56ch; }
  .card h2 { margin: 34px 0 14px; font-size: 15px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: ${INK.ink3}; }
  .card ul { margin: 0; padding: 0; list-style: none; }
  .card .changes li { position: relative; padding-left: 34px; margin: 0 0 9px; font-size: 26px; line-height: 1.3; color: ${INK.ink}; }
  .card .changes li svg { position: absolute; left: 0; top: 16px; width: 20px; height: 8px; overflow: visible; }
  .card .acs { margin-top: 30px; border-top: 1px solid ${INK.hair}; }
  .card .acs li { display: grid; grid-template-columns: 40px 60px minmax(0, 1fr); align-items: start; gap: 14px; padding: 15px 0 15px; border-bottom: 1px solid ${INK.hair}; }
  .card .acs .box { width: 32px; height: 32px; overflow: visible; margin-top: -1px; }
  .card .acs .ac { padding-top: 9px; font-size: 15px; font-weight: 600; letter-spacing: .1em; color: ${INK.ink3}; }
  .card .acs .tx { font-size: 29px; line-height: 1.26; color: ${INK.ink}; }
  .card .acs li.miss .tx { color: ${INK.ink3}; }
  .card .foot { grid-column: 1 / -1; margin: 0 76px; padding: 16px 0 20px; border-top: 1px solid ${INK.hair}; font-size: 16px; line-height: 1.4; color: ${INK.ink3}; }
  .cardpen { z-index: 1; }

  .fsel { position: fixed; background: #fff; border: 1px solid #9aa4b2; border-radius: 4px; box-shadow: 0 8px 22px rgba(15,23,42,.22); overflow: hidden; opacity: 0; transform: translateY(-4px); transition: opacity 140ms ease, transform 140ms ease; font-size: 15px; font-family: "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; }
  .fsel.on { opacity: 1; transform: none; }
  .fsel .opt { padding: 6px 12px; white-space: nowrap; color: #111827; }
  .fsel .opt.sel { background: #e8eefc; }
  .fsel .opt.hover { background: #2457c5; color: #fff; }

  .fdlg { position: fixed; top: 64px; left: 50%; transform: translate(-50%, -6px); width: 460px; background: #fff; border-radius: 10px; box-shadow: 0 12px 40px rgba(15,23,42,.35); padding: 20px 22px 18px; opacity: 0; transition: opacity 160ms ease, transform 160ms ease; font-family: "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; color: #202124; }
  .fdlg.on { opacity: 1; transform: translate(-50%, 0); }
  .fdlg .o { font-size: 15px; font-weight: 600; color: #202124; margin-bottom: 10px; }
  .fdlg .m { font-size: 15px; color: #3c4043; line-height: 1.45; white-space: pre-wrap; margin-bottom: 18px; }
  .fdlg .in { border: 2px solid #1a73e8; border-radius: 4px; padding: 6px 8px; font-size: 15px; margin: -6px 0 18px; min-height: 34px; }
  .fdlg .b { display: flex; justify-content: flex-end; gap: 8px; }
  .fdlg .btn { min-width: 76px; height: 36px; border-radius: 18px; display: grid; place-items: center; font-size: 14.5px; font-weight: 600; padding: 0 16px; border: 1px solid #dadce0; color: #1a73e8; background: #fff; transition: transform 90ms ease, filter 90ms ease; }
  .fdlg .btn.ok { background: #1a73e8; border-color: #1a73e8; color: #fff; }
  .fdlg .btn.press { transform: scale(.95); filter: brightness(.9); }
  .fdlg-dim { position: fixed; inset: 0; background: rgba(15,23,42,.18); opacity: 0; transition: opacity 160ms ease; }
  .fdlg-dim.on { opacity: 1; }

  .keycap { position: fixed; padding: 5px 12px 4px; border-radius: 4px; border: 1px solid ${INK.rule}; background: #fff; color: ${INK.ink}; font-size: 16px; font-weight: 600; letter-spacing: .02em; box-shadow: 0 6px 14px -8px rgba(36,39,43,.45); opacity: 0; transform: translateY(4px); transition: opacity 160ms cubic-bezier(.2,.8,.2,1), transform 200ms cubic-bezier(.2,.8,.2,1); white-space: nowrap; }
  .keycap.on { opacity: 1; transform: none; }

  .cursor { position: fixed; left: 0; top: 0; width: 28px; height: 32px; transform: translate3d(-100px,-100px,0); transition: opacity 200ms ease; filter: drop-shadow(0 2px 3px rgba(0,0,0,.32)); will-change: transform; z-index: 3; }
  .cursor svg { width: 100%; height: 100%; transform-origin: 3px 2px; transition: transform 110ms ease; }
  .cursor.down svg { transform: scale(.86); }
  .cursor.hidden { opacity: 0; }
  .ripple { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 2.5px solid ${INK.pen}; animation: rip 480ms cubic-bezier(.2,.8,.2,1) forwards; }
  @keyframes rip { from { transform: scale(.25); opacity: .95; } to { transform: scale(1.3); opacity: 0; } }
  `;

  let host = null;
  let root = null;
  const el = {};
  const state = {
    active: false,
    cursor: { x: -100, y: -100, visible: true },
    caption: null,
    chip: null,
    anns: new Map(), // id -> { opts, ring, callout, target, placement, info }
    spotIds: new Set(),
    fsel: null,
    dialog: null,
  };

  function h(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  const vw = () => window.innerWidth;
  const vh = () => window.innerHeight;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- fonts ----------
  // Bundled with the toolkit (overlay-source.ts) and added through the FontFace API: @font-face does not work inside
  // a shadow root, and this leaves the app's DOM untouched. The family name can't collide with the app's.
  let fontsReady = Promise.resolve();
  try {
    const data = window.__ottoFontData;
    if (data) {
      const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
      fontsReady = Promise.all(Object.entries(data).map(([weight, b64]) => {
        const face = new FontFace('Otto Archivo', bytes(b64), { weight });
        document.fonts.add(face);
        return face.load();
      })).catch(() => {});
      delete window.__ottoFontData;
    }
  } catch (e) { /* falls back to the stack in FONT */ }

  // ---------- pen: hand-drawn marks ----------
  // Seeded, so a mark keeps its shape while it follows its element. One width for marks and arrows on the app; slips use a finer nib.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PEN_W = 4;
  const PAD = 6;
  const svg = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  function rng(seed) {
    let s = 2166136261;
    for (const ch of String(seed)) { s ^= ch.charCodeAt(0); s = Math.imul(s, 16777619); }
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const f1 = (n) => n.toFixed(1);
  /** Smooth stroke through points (Catmull-Rom as cubic Béziers). */
  function smooth(pts) {
    let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += `C${f1(p1[0] + (p2[0] - p0[0]) / 6)} ${f1(p1[1] + (p2[1] - p0[1]) / 6)} ${f1(p2[0] - (p3[0] - p1[0]) / 6)} ${f1(p2[1] - (p3[1] - p1[1]) / 6)} ${f1(p2[0])} ${f1(p2[1])}`;
    }
    return d;
  }
  /** A loop as a hand closes it round a box: starts top right, goes round once, overlaps its start slightly further out. */
  function loopShape(r, rnd, room) {
    // r is padded by PAD already: the loop hugs the element above and below and takes more room at the sides,
    // but only as much as there is before the next control.
    const grow = 10 + Math.min(14, r.width * 0.03);
    const x0 = r.x - (room ? Math.min(grow, room.left) : grow), x1 = r.x + r.width + (room ? Math.min(grow, room.right) : grow);
    const cx = (x0 + x1) / 2, cy = r.y + r.height / 2, a = (x1 - x0) / 2, hh = r.height / 2;
    const b = hh - 2 + Math.min(6, 60 / Math.max(r.height, 12));
    // Squareness: just enough that the element's corners stay inside the loop.
    let e = 2.4;
    while (e < 12 && Math.pow((r.width / 2 - PAD) / a, e) + Math.pow((hh - PAD) / b, e) > 0.82) e += 0.2;
    const pow = 2 / e;
    const n = 34, start = -0.5 + rnd() * 0.3, sweep = Math.PI * 2 + 0.42 + rnd() * 0.3;
    const ph1 = rnd() * 6.28, ph2 = rnd() * 6.28;
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, th = start - t * sweep;
      const c = Math.cos(th), s = Math.sin(th);
      const wob = 1 + 0.008 * Math.sin(2 * th + ph1) + 0.005 * Math.sin(3 * th + ph2);
      const drift = (t < 0.1 ? (0.1 - t) * -22 : 0) + (t > 0.84 ? ((t - 0.84) / 0.16) * 7 : 0);
      pts.push([
        cx + (a * wob + drift) * Math.sign(c) * Math.pow(Math.abs(c), pow),
        cy + (b * wob + drift) * Math.sign(s) * Math.pow(Math.abs(s), pow),
      ]);
    }
    // An arrow lands on the loop's one clean pass, away from where the pen started and closed.
    const land = pts.slice(Math.round(n * 0.14), Math.round(n * 0.82));
    const tan = (i) => { const p = land[Math.max(0, i - 1)], q = land[Math.min(land.length - 1, i + 1)], l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };
    return { strokes: [smooth(pts)], land, tan, all: pts, hole: smooth(pts) + 'Z', left: Math.min(...pts.map((p) => p[0])) };
  }
  const along = (x0, x1, y, to = 1) => Array.from({ length: 12 }, (_, i) => [x0 + (x1 - x0) * (i / 11) * to, y]);
  /** Removed: a stroke through the element. */
  function strikeShape(r, rnd) {
    const y = r.y + r.height * (0.45 + rnd() * 0.1), x0 = r.x - 8, x1 = r.x + r.width + 8;
    const pts = [[x0, y + 3 * (rnd() - 0.5)], [x0 + (x1 - x0) * 0.35, y - 2 - rnd() * 2], [x0 + (x1 - x0) * 0.7, y + 2 + rnd() * 2], [x1, y - 3 * rnd()]];
    return { strokes: [smooth(pts)], land: along(x0, x1, y), tan: () => [1, 0], all: pts };
  }
  /** Verified: the element underlined, the line flowing into a tick. */
  function verifyShape(r, rnd) {
    const y = r.y + r.height + 4, x0 = r.x - 2, x1 = r.x + r.width - 4;
    const line = [[x0, y + rnd() * 2], [x0 + (x1 - x0) * 0.4, y + 1.5 + rnd() * 2], [x0 + (x1 - x0) * 0.78, y - rnd()], [x1, y + 2]];
    const tick = `M${f1(x1)} ${f1(y + 2)}C${f1(x1 + 2)} ${f1(y + 4)} ${f1(x1 + 4)} ${f1(y + 6.5)} ${f1(x1 + 5.5)} ${f1(y + 8.5)}C${f1(x1 + 8)} ${f1(y)} ${f1(x1 + 12)} ${f1(y - 10)} ${f1(x1 + 18)} ${f1(y - 19)}`;
    // An arrow can land on the line, or point at the tick's upstroke; never on its foot.
    const up = [[x1 + 9, y + 1], [x1 + 13, y - 8], [x1 + 18, y - 19]];
    const onLine = along(x0, x1, y + 2, 0.7);
    return { strokes: [smooth(line), tick], land: [...onLine, ...up], tan: (i) => (i < onLine.length ? [1, 0] : [0.5, -0.87]), all: [...along(x0, x1, y + 2), [x1 + 5.5, y + 8.5], ...up] };
  }
  /** Add a stroke (white under-stroke + ink); returns both paths. */
  function penStroke(parent, d, width = PEN_W) {
    const halo = svg('path', { class: 'halo', d, 'stroke-width': width + 2.5 });
    const ink = svg('path', { class: 'ink', d, 'stroke-width': width });
    parent.append(halo, ink);
    return [halo, ink];
  }
  /** The signature move: a mark draws itself on at one pen speed. Returns how long it takes. */
  const PEN_SPEED = 1.9; // px per ms
  function drawOn(paths, delay, min = 140, max = 900) {
    const dur = Math.round(Math.max(min, Math.min(max, paths[0].getTotalLength() / PEN_SPEED)));
    for (const p of paths) {
      const len = p.getTotalLength();
      p.style.strokeDasharray = `${len} ${len + 4}`;
      p.style.strokeDashoffset = String(len);
      p.style.opacity = '0'; // a round cap would show as a dot until the stroke starts
      p.getBoundingClientRect();
      p.style.transition = `stroke-dashoffset ${dur}ms cubic-bezier(.45,.05,.2,1) ${delay}ms, opacity 1ms linear ${delay}ms`;
      p.style.strokeDashoffset = '0';
      p.style.opacity = '1';
      setTimeout(() => { p.style.strokeDasharray = ''; p.style.strokeDashoffset = ''; p.style.transition = ''; }, delay + dur + 80);
    }
    return dur;
  }

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('otto-overlay');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;color-scheme:light!important;';
    root = host.attachShadow({ mode: 'closed' });
    const style = h('style');
    style.textContent = CSS;
    root.appendChild(style);
    const layer = h('div', 'layer');
    root.appendChild(layer);
    el.layer = layer;
    el.spot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.spot.setAttribute('class', 'spot');
    el.spotPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.spotPath.setAttribute('fill', 'rgba(36,39,43,0.46)');
    el.spotPath.setAttribute('fill-rule', 'evenodd');
    el.spot.appendChild(el.spotPath);
    layer.appendChild(el.spot);
    el.anns = h('div');
    layer.appendChild(el.anns);
    el.fsel = h('div', 'fsel');
    layer.appendChild(el.fsel);
    el.fdlgDim = h('div', 'fdlg-dim');
    layer.appendChild(el.fdlgDim);
    el.fdlg = h('div', 'fdlg');
    layer.appendChild(el.fdlg);
    el.chip = h('div', 'chip slip', '<span class="lbl"></span><span class="ttl"></span>');
    layer.appendChild(el.chip);
    el.caption = h('div', 'caption');
    layer.appendChild(el.caption);
    layer.appendChild(el.fdlgDim);
    layer.appendChild(el.fdlg);
    el.banner = h('div', 'banner', '<div class="box slip"><div class="side"></div><div class="t"></div><svg class="pen-ink"></svg></div>');
    layer.appendChild(el.banner);
    el.card = h('div', 'card');
    layer.insertBefore(el.card, el.chip); // captions stay readable on title/outro cards
    el.keycap = h('div', 'keycap');
    layer.appendChild(el.keycap);
    el.cursor = h('div', 'cursor', '<svg viewBox="0 0 28 32"><path d="M3 2 L3 25 L9.2 19.4 L13.4 29 L17.6 27.2 L13.5 17.9 L22 17.6 Z" fill="#fff" stroke="' + INK.ink + '" stroke-width="2" stroke-linejoin="round"/></svg>');
    layer.appendChild(el.cursor);
    document.documentElement.appendChild(host);
    raise();
    placeCursor();
  }

  // Keep the overlay at the top of the top layer: a later showModal()/showPopover() would cover it.
  function raise() {
    if (!host) return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch (e) { /* not connected yet */ }
  }
  let raising = false;
  function maybeRaise() {
    if (raising || !host) return;
    raising = true;
    queueMicrotask(() => { raising = false; raise(); });
  }
  new MutationObserver((records) => {
    for (const r of records) if (r.target !== host && (r.attributeName === 'open' || r.attributeName === 'popover')) { maybeRaise(); return; }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['open', 'popover'] });
  document.addEventListener('toggle', (e) => { if (e.target !== host) maybeRaise(); }, true);

  // ---------- cursor ----------
  function placeCursor() {
    if (!el.cursor) return;
    el.cursor.style.transform = `translate3d(${state.cursor.x - 3}px, ${state.cursor.y - 2}px, 0)`;
    el.cursor.classList.toggle('hidden', !state.active || !state.cursor.visible);
    if (state.fsel) selectHoverAt(state.cursor.x, state.cursor.y);
  }
  // Hand-like pointer motion: a fast start and a long settle (a skewed minimum-jerk profile), a slight curve that
  // bulges early, and on longer moves a small miss corrected by a short second movement.
  const minJerk = (u) => u * u * u * (10 - 15 * u + 6 * u * u);
  let moveCount = Math.floor(Math.random() * 1e9); // a page reload must not replay the same moves
  function cursorSegment(sx, sy, x, y, dur, bend) {
    const dx = x - sx, dy = y - sy, dist = Math.hypot(dx, dy) || 1;
    const cx = sx + dx * 0.42 - (dy / dist) * bend, cy = sy + dy * 0.42 + (dx / dist) * bend;
    const start = performance.now();
    return new Promise((resolve) => {
      function step(now) {
        const t = Math.min(1, (now - start) / dur);
        const e = minJerk(Math.pow(t, 0.78));
        const u = 1 - e;
        state.cursor.x = u * u * sx + 2 * u * e * cx + e * e * x;
        state.cursor.y = u * u * sy + 2 * u * e * cy + e * e * y;
        placeCursor();
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
  }
  async function cursorMove(x, y, dur, arc) {
    ensure();
    const sx = state.cursor.x, sy = state.cursor.y;
    if (sx < -50 || dur <= 0) { state.cursor.x = x; state.cursor.y = y; placeCursor(); return; }
    const rnd = rng(`move${moveCount++}`);
    const dx = x - sx, dy = y - sy, dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    // The same hand sweeps the same way most of the time.
    const bend = (rnd() < 0.72 ? 1 : -1) * Math.min(70, dist * (arc ?? 0.08) * (0.6 + rnd() * 0.8));
    if (dist < 140 || rnd() < 0.62) { await cursorSegment(sx, sy, x, y, dur, bend); return; }
    // Long moves tend to overshoot, shorter ones to fall short, each with a little sideways error.
    const miss = dist > 380 ? 6 + rnd() * 10 : -(3 + rnd() * 6);
    const off = (rnd() - 0.5) * 8;
    const ax = x + ux * miss - uy * off, ay = y + uy * miss + ux * off;
    const fix = Math.max(110, Math.min(200, dur * 0.18));
    await cursorSegment(sx, sy, ax, ay, Math.max(120, dur - fix), bend);
    await cursorSegment(ax, ay, x, y, fix, 0);
  }
  async function cursorClick() {
    ensure();
    el.cursor.classList.add('down');
    const r = h('div', 'ripple');
    r.style.left = state.cursor.x + 'px';
    r.style.top = state.cursor.y + 'px';
    el.layer.insertBefore(r, el.cursor);
    setTimeout(() => r.remove(), 600);
    await sleep(110);
    el.cursor.classList.remove('down');
  }

  // ---------- caption / chip / banner ----------
  function caption(text) {
    ensure();
    state.caption = text || null;
    if (text) {
      el.caption.textContent = text;
      // Balanced text leaves the box wider than its lines: the strip fits the lines, with no empty bands at the sides.
      el.caption.style.width = '';
      let l = Infinity, r = -Infinity;
      const range = document.createRange();
      range.selectNodeContents(el.caption);
      for (const b of range.getClientRects()) { if (b.width) { l = Math.min(l, b.left); r = Math.max(r, b.right); } }
      if (r > l) el.caption.style.width = Math.ceil(r - l + 54) + 'px'; // side padding + rounding
      el.caption.classList.add('on');
    } else el.caption.classList.remove('on');
  }
  let avoidRect = null;
  function captionBox() {
    // Where the caption is at the bottom (even when currently moved to the top).
    const w = el.caption.offsetWidth || Math.min(1160, vw() - 80), hgt = el.caption.offsetHeight || 80;
    return { x: (vw() - w) / 2, y: vh() - 34 - hgt, width: w, height: hgt };
  }
  function placeCaption() {
    if (!el.caption) return;
    const box = captionBox();
    const rings = [...state.anns.values()].map((a) => a.info && a.info.ringRect).filter(Boolean);
    const top = (avoidRect && overlaps(avoidRect, box)) || rings.some((r) => overlaps(r, box));
    el.caption.classList.toggle('top', !!top);
  }
  function captionReserve() {
    if (!state.caption || !el.caption || el.caption.classList.contains('top')) return 0;
    return el.caption.getBoundingClientRect().height + 50;
  }
  function chip(c) {
    ensure();
    state.chip = c || null;
    if (!c) { el.chip.classList.remove('on'); return; }
    el.chip.querySelector('.lbl').textContent = c.label;
    const ttl = el.chip.querySelector('.ttl');
    ttl.textContent = c.title;
    el.chip.style.left = '';
    el.chip.style.maxWidth = '';
    // The running head stays in the centre when that's free; otherwise it moves into the longest free stretch of the
    // app's top row. Only text that can't fit even there is cut, at a word, never inside one.
    const want = el.chip.offsetWidth, row = 22, step = 12;
    const hits = (x) => inkAt(x, row) > 0;
    let run = null, best = null;
    for (let x = 8; x <= vw() - 8; x += step) {
      if (hits(x)) run = null;
      else { run = run ? { a: run.a, b: x } : { a: x, b: x }; if (!best || run.b - run.a > best.b - best.a) best = { ...run }; }
    }
    const cx = vw() / 2;
    let centreFree = true;
    for (let x = cx - want / 2; x <= cx + want / 2; x += step) if (hits(x)) { centreFree = false; break; }
    if (!centreFree && best) {
      const room = best.b - best.a - 24;
      if (want > room && room >= 360) el.chip.style.maxWidth = room + 'px';
      if (room >= 360) el.chip.style.left = (best.a + best.b) / 2 + 'px';
    }
    el.chip.classList.add('on');
    const words = String(c.title).split(/\s+/);
    while (words.length > 1 && ttl.scrollWidth > ttl.clientWidth) { words.pop(); ttl.textContent = words.join(' ') + ' …'; }
  }
  async function banner(b, ms) {
    ensure();
    await fontsReady;
    const side = el.banner.querySelector('.side');
    side.innerHTML = b.n != null
      ? `<div class="n">${esc(b.n)}<small>${esc(b.of)} ${esc(b.total)}</small></div><div class="k">${esc(b.label)}</div>`
      : `<div class="k">${esc(b.kicker)}</div>`;
    el.banner.querySelector('.t').textContent = b.title;
    const pen = el.banner.querySelector('.pen-ink');
    pen.innerHTML = '';
    el.banner.classList.add('on');
    const num = side.querySelector('.n');
    if (num) {
      // The number gets the pen: an underline drawn as the banner lands.
      const box = el.banner.querySelector('.box').getBoundingClientRect(), r = num.getBoundingClientRect();
      const rnd = rng(`banner${b.n}`);
      const x0 = r.left - box.left - 2, x1 = x0 + Math.min(r.width + 2, 96), y = r.bottom - box.top + 3;
      drawOn(penStroke(pen, smooth([[x0, y + rnd() * 2], [x0 + (x1 - x0) * 0.45, y - 2 + rnd()], [x1, y + 1 + rnd()]])), 260, 260);
    }
    await sleep(ms);
    el.banner.classList.remove('on');
    await sleep(280);
  }

  // ---------- annotations ----------
  function findTarget(selector) {
    try {
      // Same engine as the recorder: CSS, text=..., chains with >>
      const parts = selector.split('>>').map((s) => s.trim());
      let scope = [document];
      for (const part of parts) {
        const next = [];
        for (const r of scope) {
          if (part.startsWith('text=')) {
            const want = part.slice(5).trim().replace(/^"|"$/g, '');
            for (const n of r.querySelectorAll('button, a, [role=tab], [role=button], label, th, td, li, h1, h2, h3, span, div, option, p, strong')) {
              const t = (n.innerText ?? '').trim().replace(/\s+/g, ' ');
              if (t.toLowerCase() === want.toLowerCase() && ![...n.children].some((c) => (c.innerText ?? '').trim().replace(/\s+/g, ' ').toLowerCase() === want.toLowerCase())) next.push(n);
            }
          } else next.push(...r.querySelectorAll(part));
        }
        scope = next;
        if (!scope.length) return null;
      }
      return scope.find((n) => { const b = n.getBoundingClientRect(); return b.width > 0 && b.height > 0; }) ?? scope[0] ?? null;
    } catch (e) {
      return null;
    }
  }

  const UNDERLINE = '<svg viewBox="0 0 100 7" preserveAspectRatio="none"><path class="ink" d="M1 4C30 1.5 62 6 99 2.5" stroke-width="2.4" fill="none" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
  const TICK = '<svg class="tick" viewBox="0 0 24 22"><path class="ink" d="M3 12.5C5 14.5 7 17 8.5 19.5C11.5 13 15.5 7 21.5 2" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function annotate(o) {
    ensure();
    unannotate(o.id);
    const target = findTarget(o.selector);
    if (!target) return { ok: false, error: `No element for ${o.selector}` };
    const tone = TONES[o.tone] ?? TONES.new;
    const ring = svg('svg', { class: 'mark' });
    el.anns.appendChild(ring);
    let callout = null;
    if (o.title || o.text) {
      callout = h('div', 'callout slip');
      const badge = o.badge === false ? '' : (o.badge || tone.label);
      const lede = (o.number != null ? `<span class="n">${esc(o.number)}</span>` : '') +
        (o.tone === 'success' ? TICK : '') +
        (badge ? `<span class="badge">${esc(badge)}${UNDERLINE}</span>` : '');
      // The word sits on the title's line, not above it; without a title it leads the text.
      callout.innerHTML =
        (o.title ? `<div class="title">${lede}${esc(o.title)}</div>` : '') +
        (o.text ? `<div class="text">${o.title ? '' : lede}${esc(o.text)}</div>` : '') +
        (o.previously ? `<div class="prev"><b>${esc(o.previouslyLabel || 'Previously')}:</b> ${esc(o.previously)}</div>` : '');
      el.anns.appendChild(callout);
    }
    let lead = null;
    if (callout) {
      lead = svg('svg', { class: 'lead' });
      lead.style.display = 'none';
      el.anns.insertBefore(lead, callout);
    }
    const a = { opts: o, ring, callout, lead, tone, target, placement: null, info: null };
    state.anns.set(o.id, a);
    if (o.spotlight) state.spotIds.add(o.id);
    if (callout) fitSlip(callout);
    layoutAnn(a, true);
    for (const o of state.anns.values()) {
      if (o === a || o.opts.number == null || !o.leadLine || !a.shape) continue;
      if (o.leadLine.some(([x, y]) => polyDist(x, y, a.shape.all) < 10)) {
        o.lead.style.transition = 'opacity 240ms ease';
        o.lead.classList.remove('on');
        o.leadLine = null;
        o.leadGone = true;
      }
    }
    requestAnimationFrame(() => {
      callout?.classList.add('on');
      lead?.classList.add('on');
      const tick = callout?.querySelector('.tick path');
      if (tick) drawOn([tick], 620, 240);
      const under = callout?.querySelector('.badge path');
      if (under) drawOn([under], 560, 200);
    });
    updateSpot();
    return { ok: true, ...a.info };
  }

  /** Balanced text leaves a slip wider than its lines: shrink it to the widest line. */
  function fitSlip(c) {
    let l = Infinity, r = -Infinity;
    const range = document.createRange();
    for (const n of c.querySelectorAll('.title, .text, .prev')) {
      range.selectNodeContents(n);
      for (const b of range.getClientRects()) { if (b.width) { l = Math.min(l, b.left); r = Math.max(r, b.right); } }
    }
    if (r > l) c.style.width = Math.ceil(r - l + 42) + 'px'; // the slip's side padding + rounding
  }

  /** Free pixels beside an element before the next control, so a loop doesn't run into its neighbour. */
  function sideRoom(target, ring) {
    const m = { x: ring.x + PAD, width: ring.width - 2 * PAD };
    const rows = [ring.y + PAD + 2, ring.y + ring.height / 2, ring.y + ring.height - PAD - 2];
    const scan = (dir) => {
      for (let d = 6; d <= 36; d += 3) {
        const x = dir > 0 ? m.x + m.width + d : m.x - d;
        for (const y of rows) {
          const hit = document.elementsFromPoint(x, y).find((n) => n !== host && !host.contains(n));
          const ctl = hit?.closest('input, select, textarea, button, a, label, td, th, [role=button], [role=tab]');
          if (ctl && !ctl.contains(target) && !target.contains(ctl)) return d;
        }
      }
      return 36;
    };
    return { left: Math.max(1, scan(-1) - PAD - 5), right: Math.max(1, scan(1) - PAD - 5) };
  }

  /** Draw or move the mark on an annotated element. It animates only the first time. */
  function setMark(a, ring) {
    const key = [ring.x, ring.y, ring.width, ring.height].map(Math.round).join();
    if (a.markKey === key) return;
    a.markKey = key;
    const rnd = rng(`${a.opts.id}|${a.opts.selector}`);
    const shape = a.opts.tone === 'success' ? verifyShape(ring, rnd) : a.opts.tone === 'removed' ? strikeShape(ring, rnd) : loopShape(ring, rnd, sideRoom(a.target, ring));
    a.shape = shape;
    a.ring.setAttribute('viewBox', `0 0 ${vw()} ${vh()}`);
    if (!a.strokes) {
      a.strokes = shape.strokes.map((d) => penStroke(a.ring, d));
      let t = 0;
      for (const pair of a.strokes) t += drawOn(pair, t) - 20;
      a.penDone = t;
      if (a.opts.number != null) {
        const g = svg('g', { class: 'num' });
        g.append(svg('circle', { r: 14 }), Object.assign(svg('text', { 'text-anchor': 'middle', y: 5.5 }), { textContent: String(a.opts.number) }));
        a.ring.append(g);
        a.numEl = g;
      }
    } else {
      a.strokes.forEach((pair, i) => pair.forEach((p) => p.setAttribute('d', shape.strokes[i])));
    }
    if (a.numEl) a.numEl.setAttribute('transform', `translate(${f1(shape.left ?? ring.x - 8)} ${f1(ring.y + ring.height / 2)})`);
  }

  /** Is there text or a control under this point? Arrows should not run over what the viewer needs to read. */
  function inkAt(x, y) {
    const hit = document.elementsFromPoint(x, y).find((n) => n !== host && !host.contains(n));
    if (!hit) return 0;
    if (hit.closest('input, select, textarea, button, a, [role=button], [role=tab]')) return 1;
    const range = document.createRange();
    for (const c of hit.childNodes) {
      if (c.nodeType !== 3 || !c.textContent.trim()) continue;
      range.selectNode(c);
      for (const b of range.getClientRects()) if (x >= b.left - 4 && x <= b.right + 4 && y >= b.top - 2 && y <= b.bottom + 2) return 1;
    }
    return 0;
  }

  /** Distance from a point to a polyline. */
  function polyDist(x, y, pts) {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
      const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      best = Math.min(best, Math.hypot(x - ax - k * dx, y - ay - k * dy));
    }
    return best;
  }

  /** The hand arrow from a slip to its mark: takes the route that runs over the least text and pen ink, and arrives at a real angle. A slip right beside its mark needs none. */
  function setLead(a, box, place) {
    const key = [box.x, box.y, box.width, box.height].map(Math.round).join() + a.markKey;
    if (a.leadKey === key || a.leadGone) return;
    a.leadKey = key;
    const land = a.shape.land;
    const edge = (pt) => ({ x: Math.max(box.x, Math.min(pt[0], box.x + box.width)), y: Math.max(box.y, Math.min(pt[1], box.y + box.height)) });
    const route = (pt, sign, kind) => {
      const e = edge(pt), d0x = e.x - pt[0], d0y = e.y - pt[1], d0 = Math.hypot(d0x, d0y) || 1;
      const q = { x: pt[0] + (d0x / d0) * 8, y: pt[1] + (d0y / d0) * 8 }; // the tip stops short of the mark
      const p = { x: e.x - (d0x / d0) * 6, y: e.y - (d0y / d0) * 6 }; // the shaft starts off the slip
      const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1;
      const bend = sign * (kind === 0 ? Math.min(14, len * 0.07) : kind === 1 ? Math.min(34, len * 0.2) : Math.min(70, len * 0.4));
      const mx = (p.x + q.x) / 2 - (dy / len) * bend, my = (p.y + q.y) / 2 + (dx / len) * bend;
      const tl = Math.hypot(q.x - mx, q.y - my) || 1, ux = (q.x - mx) / tl, uy = (q.y - my) / tl;
      const hl = Math.min(13, len * 0.38), co = Math.cos(0.52), si = Math.sin(0.52);
      const h1 = [q.x - hl * (ux * co - uy * si), q.y - hl * (uy * co + ux * si)];
      const h2 = [q.x - hl * (ux * co + uy * si), q.y - hl * (uy * co - ux * si)];
      return { p, q, len, mx, my, ux, uy, h1, h2 };
    };
    const at = (r, t) => { const u = 1 - t; return [u * u * r.p.x + 2 * u * t * r.mx + t * t * r.q.x, u * u * r.p.y + 2 * u * t * r.my + t * t * r.q.y]; };
    const dist = (pt) => { const e = edge(pt); return Math.hypot(e.x - pt[0], e.y - pt[1]); };
    if (Math.min(...land.map(dist)) < 48) { a.lead.style.display = 'none'; a.leadLine = null; return; }
    if (!a.leadPick || a.leadPick.place !== place) {
      const own = a.shape.all;
      const others = [...state.anns.values()].filter((o) => o !== a).flatMap((o) => [o.shape?.all, o.leadLine]).filter(Boolean);
      let best = null;
      const near = land.map((pt, i) => ({ pt, i, d: dist(pt) })).sort((m, n) => m.d - n.d).slice(0, 14);
      for (const { pt, i } of near) for (const sign of [-1, 1]) for (const kind of [0, 1, 2]) {
        const r = route(pt, sign, kind);
        let cost = r.len / 260 + (kind === 2 ? 0.3 : 0);
        let crosses = 0;
        const n = Math.min(40, Math.ceil(r.len / 12));
        for (let k = 1; k <= n; k++) {
          const [x, y] = at(r, k / n);
          cost += inkAt(x, y);
          if (others.some((pts) => polyDist(x, y, pts) < 10)) { cost += 1.5; crosses++; }
          if (Math.hypot(x - r.q.x, y - r.q.y) > 20 && polyDist(x, y, own) < 10) cost += 1.5;
        }
        // The head counts double: it is what the eye follows, and it must not sit on what it explains.
        for (const h of [r.h1, r.h2, [(r.h1[0] + r.q.x) / 2, (r.h1[1] + r.q.y) / 2], [(r.h2[0] + r.q.x) / 2, (r.h2[1] + r.q.y) / 2]]) {
          cost += inkAt(h[0], h[1]) * 2;
          if (others.some((pts) => polyDist(h[0], h[1], pts) < 8)) cost += 2;
        }
        // Arrive across the stroke, not along it.
        const [tx, ty] = a.shape.tan(i);
        const along = Math.abs(r.ux * tx + r.uy * ty);
        if (along > 0.7) cost += (along - 0.7) * 14;
        if (!best || cost < best.cost) best = { cost, i, sign, kind, crosses };
      }
      // 2. A numbered slip is linked by its number: no arrow rather than one across another mark.
      a.leadPick = { place, i: best.i, sign: best.sign, kind: best.kind, none: a.opts.number != null && best.crosses > 0 };
    }
    if (a.leadPick.none) { a.lead.style.display = 'none'; a.leadLine = null; return; }
    const r = route(land[a.leadPick.i], a.leadPick.sign, a.leadPick.kind);
    a.leadLine = Array.from({ length: 33 }, (_, k) => at(r, k / 32));
    const shaft = `M${f1(r.p.x)} ${f1(r.p.y)}Q${f1(r.mx)} ${f1(r.my)} ${f1(r.q.x)} ${f1(r.q.y)}`;
    const head = `M${f1(r.h1[0])} ${f1(r.h1[1])}L${f1(r.q.x)} ${f1(r.q.y)}L${f1(r.h2[0])} ${f1(r.h2[1])}`;
    a.lead.setAttribute('viewBox', `0 0 ${vw()} ${vh()}`);
    a.lead.style.display = '';
    if (!a.leadPaths) {
      const s = penStroke(a.lead, shaft), t = penStroke(a.lead, head);
      a.leadPaths = [s, t];
      const start = Math.round((a.penDone ?? 400) * 0.8);
      const d = drawOn(s, start, 120, 460);
      drawOn(t, start + d - 10, 90, 120);
    } else {
      a.leadPaths[0].forEach((n) => n.setAttribute('d', shaft));
      a.leadPaths[1].forEach((n) => n.setAttribute('d', head));
    }
  }

  function unannotate(id) {
    const ids = id == null ? [...state.anns.keys()] : [id];
    for (const k of ids) {
      const a = state.anns.get(k);
      if (!a) continue;
      a.ring.classList.remove('on');
      a.callout?.classList.remove('on');
      a.lead?.classList.remove('on');
      setTimeout(() => { a.ring.remove(); a.callout?.remove(); a.lead?.remove(); }, 260);
      state.anns.delete(k);
      state.spotIds.delete(k);
    }
    updateSpot();
  }

  function rectOf(target) {
    if (!target.isConnected) return null;
    if (target.checkVisibility && !target.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    const r = target.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  /** What the pen goes round: a field and its label together; a text element by its words, not its full-width box. */
  function textRect(n) {
    const range = document.createRange();
    range.selectNodeContents(n);
    const b = range.getBoundingClientRect();
    return b.width && b.height ? { x: b.left, y: b.top, width: b.width, height: b.height } : null;
  }
  function markRect(target, r, tone) {
    const field = /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
    const control = target.tagName === 'LABEL' ? target.control : field ? target : null;
    const label = target.tagName === 'LABEL' ? target : field ? target.labels?.[0] : null;
    if (control && label && tone !== 'removed') {
      const c = rectOf(control), l = textRect(label);
      if (c && l && boxDistance(c, l) < 28) {
        const x = Math.min(c.x, l.x), y = Math.min(c.y, l.y);
        return { x, y, width: Math.max(c.x + c.width, l.x + l.width) - x, height: Math.max(c.y + c.height, l.y + l.height) - y };
      }
    }
    const textish = /^(LABEL|SPAN|A|P|H[1-6]|LI|TD|TH|DT|DD|STRONG|EM|SMALL|B)$/.test(target.tagName) || (target.tagName === 'DIV' && !target.children.length);
    if (!textish || target.querySelector('input,select,textarea,button,img,svg,table')) return r;
    const b = textRect(target);
    return b && b.width <= r.width * 0.85 ? b : r;
  }

  // How much app UI a callout box would hide: fields and buttons count most, other text a little.
  function occlusion(box, dense) {
    const seen = new Set();
    const controls = new Set();
    let score = 0;
    const grid = (from, size, step) => { const out = []; for (let v = 3; v < size - 2; v += step) out.push(from + v); out.push(from + size - 3); return out; };
    const xs = dense ? grid(box.x, box.width, 44) : [3, 0.25, 0.5, 0.75, -3].map((f) => box.x + (f < 0 ? box.width + f : f < 1 ? box.width * f : f));
    const ys = dense ? grid(box.y, box.height, 14) : [3, 0.35, 0.65, -3].map((f) => box.y + (f < 0 ? box.height + f : f < 1 ? box.height * f : f));
    for (const x of xs) for (const y of ys) {
      const hit = document.elementsFromPoint(x, y).find((n) => n !== host && !host.contains(n));
      if (!hit) continue;
      const ctl = hit.closest('input, select, textarea, button, a, [role=button], [role=tab], label');
      if (ctl) { if (!controls.has(ctl)) { controls.add(ctl); score += 3; } continue; }
      if (seen.has(hit)) continue;
      seen.add(hit);
      if ([...hit.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) score += 1;
    }
    return score;
  }
  function boxDistance(a, b) {
    const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
    const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
    return Math.hypot(dx, dy);
  }
  /** How many app controls a straight arrow from a slip to its mark would run over. */
  function arrowCrossings(box, ring) {
    const rx = ring.x + ring.width / 2, ry = ring.y + ring.height / 2;
    const px = Math.max(box.x, Math.min(rx, box.x + box.width)), py = Math.max(box.y, Math.min(ry, box.y + box.height));
    const qx = Math.max(ring.x, Math.min(px, ring.x + ring.width)), qy = Math.max(ring.y, Math.min(py, ring.y + ring.height));
    const seen = new Set();
    for (let i = 1; i < 8; i++) {
      const k = i / 8;
      const hit = document.elementsFromPoint(px + (qx - px) * k, py + (qy - py) * k).find((n) => n !== host && !host.contains(n));
      const ctl = hit?.closest('input, select, textarea, button, a, [role=button], [role=tab], label');
      if (ctl) seen.add(ctl);
    }
    return seen.size;
  }
  function chooseFree(ring, cw, ch, blocked, top, bottom, margin) {
    const found = [];
    const step = 40;
    for (let y = top; y + ch <= bottom; y += step) for (let x = margin; x + cw <= vw() - margin; x += step) {
      const box = { x, y, width: cw, height: ch };
      const dist = boxDistance(box, ring);
      if (dist < 28 || dist > 640 || blocked(box)) continue;
      found.push({ box, x, y, dist, s: occlusion(box) + 1 + dist / 240 + arrowCrossings(box, ring) * 0.7 });
    }
    // The best few get a closer look.
    found.sort((m, n) => m.s - n.s);
    let best = null;
    for (const c of found.slice(0, 16)) {
      const s = occlusion(c.box, true) + 1 + c.dist / 240 + arrowCrossings(c.box, ring) * 0.7;
      if (!best || s < best.s) best = { x: c.x, y: c.y, s };
    }
    return best;
  }
  function overlaps(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }

  function layoutAnn(a, choose) {
    if (!a.target.isConnected) {
      const t = findTarget(a.opts.selector);
      if (t) a.target = t;
    }
    const r = rectOf(a.target);
    if (!r) { a.ring.style.display = 'none'; if (a.callout) a.callout.style.display = 'none'; if (a.lead) a.lead.style.display = 'none'; return; }
    a.ring.style.display = '';
    // Elements taller or wider than the screen: ring only the visible part.
    const m = markRect(a.target, r, a.opts.tone);
    const vx0 = Math.max(m.x - PAD, 4), vy0 = Math.max(m.y - PAD, 4);
    const vx1 = Math.min(m.x + m.width + PAD, vw() - 4), vy1 = Math.min(m.y + m.height + PAD, vh() - 4);
    const ring = { x: vx0, y: vy0, width: Math.max(0, vx1 - vx0), height: Math.max(0, vy1 - vy0) };
    setMark(a, ring);
    const info = { rect: r, ringRect: ring, targetVisible: r.y + r.height > 0 && r.y < vh() && r.x + r.width > 0 && r.x < vw() };
    if (a.callout) {
      a.callout.style.display = '';
      const cw = a.callout.offsetWidth, ch = a.callout.offsetHeight;
      const margin = 14, gap = 44; // room for the hand arrow
      const top = 58, bottom = vh() - margin - captionReserve();
      const others = [...state.anns.values()].filter((o) => o !== a && o.info && o.info.calloutRect).map((o) => o.info.calloutRect);
      const rings = [...state.anns.values()].filter((o) => o !== a && o.info).map((o) => o.info.ringRect);
      const clampY = (y) => Math.max(top, Math.min(y, bottom - ch));
      const clampX = (x) => Math.max(margin, Math.min(x, vw() - margin - cw));
      const cands = {
        right: () => ({ x: ring.x + ring.width + gap, y: clampY(ring.y + ring.height / 2 - ch / 2) }),
        left: () => ({ x: ring.x - gap - cw, y: clampY(ring.y + ring.height / 2 - ch / 2) }),
        bottom: () => ({ x: clampX(ring.x + ring.width / 2 - cw / 2), y: ring.y + ring.height + gap }),
        top: () => ({ x: clampX(ring.x + ring.width / 2 - cw / 2), y: ring.y - gap - ch }),
        free: () => ({ x: ring.x + (a.free?.dx ?? 0), y: ring.y + (a.free?.dy ?? 0) }),
      };
      const fits = (p) => p.x >= margin && p.x + cw <= vw() - margin && p.y >= top && p.y + ch <= bottom;
      const control = a.target.tagName === 'LABEL' ? a.target.control : null;
      const subject = control ? rectOf(control) : null;
      const blocked = (box) => others.some((o) => overlaps(o, box)) || rings.some((o) => overlaps(o, box)) || overlaps(box, ring) || overlaps(box, r) || (subject && overlaps(box, subject));
      let place = a.placement;
      if (choose || !place || !fits(cands[place]())) {
        const pref = a.opts.placement && a.opts.placement !== 'auto' ? [a.opts.placement] : [];
        const order = [...pref, 'right', 'left', 'bottom', 'top'].filter((v, i, arr) => arr.indexOf(v) === i);
        place = null;
        let best = Infinity;
        order.forEach((p, rank) => {
          const pos = cands[p]();
          const box = { x: pos.x, y: pos.y, width: cw, height: ch };
          if (!fits(pos) || blocked(box)) return;
          const score = occlusion(box, true) + rank * 0.5;
          if (score < best) { best = score; place = p; }
        });
        // Anywhere nearby, joined by a leader line, when that hides clearly less of the app.
        if (!pref.length && best > 0) {
          const free = chooseFree(ring, cw, ch, blocked, top, bottom, margin);

          if (free && free.s < best) { place = 'free'; a.free = { dx: free.x - ring.x, dy: free.y - ring.y }; }
        }
        if (!place) for (const p of order) if (fits(cands[p]())) { place = p; break; }
        if (!place) place = order[0];
        a.placement = place;
      }
      const pos = cands[place]();
      const x = Math.max(margin, Math.min(pos.x, vw() - margin - cw));
      const y = Math.max(top, Math.min(pos.y, vh() - margin - ch));
      a.callout.className = a.callout.className.replace(/ ?p-\w+/g, '') + ` p-${place}`;
      Object.assign(a.callout.style, { left: x + 'px', top: y + 'px' });
      const box = { x, y, width: cw, height: ch };
      if (a.lead) setLead(a, box, place);
      info.calloutRect = box;
      info.placement = place;
      info.clamped = !fits({ x, y });
      info.coversTarget = overlaps(box, ring);
      info.offscreen = x < 0 || y < 0 || x + cw > vw() || y + ch > vh();
    }
    a.info = info;
  }

  function updateSpot() {
    if (!el.spot) return;
    const lit = [...state.spotIds].map((id) => state.anns.get(id)).filter((a) => a?.info?.ringRect);
    if (!lit.length) { el.spot.classList.remove('on'); return; }
    el.spot.setAttribute('viewBox', `0 0 ${vw()} ${vh()}`);
    let d = `M0 0H${vw()}V${vh()}H0Z`;
    for (const a of lit) {
      if (a.shape?.hole) { d += a.shape.hole; continue; }
      const r = a.info.ringRect, rad = 12, x = r.x - 12, y = r.y - 10, w = r.width + 24, hh = r.height + 20;
      d += `M${x + rad} ${y}H${x + w - rad}Q${x + w} ${y} ${x + w} ${y + rad}V${y + hh - rad}Q${x + w} ${y + hh} ${x + w - rad} ${y + hh}H${x + rad}Q${x} ${y + hh} ${x} ${y + hh - rad}V${y + rad}Q${x} ${y} ${x + rad} ${y}Z`;
    }
    el.spotPath.setAttribute('d', d);
    el.spot.classList.add('on');
  }

  // Follow targets every frame (scrolling, reflow, animations).
  function tick() {
    if (state.anns.size) {
      for (const a of state.anns.values()) layoutAnn(a, false);
      updateSpot();
    }
    if (state.caption) placeCaption();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---------- cards ----------
  const DASH = '<svg viewBox="0 0 20 8"><path class="ink" d="M1 5C6 2.5 12 6.5 19 3.5" stroke-width="3" fill="none" stroke-linecap="round"/></svg>';
  function card(c) {
    ensure();
    if (!c) { el.card.classList.remove('on'); return; }
    const foot = c.foot ? `<div class="foot">${esc(c.foot)}</div>` : '';
    if (c.kind === 'title') {
      el.card.innerHTML = `<div class="sheet">
        <div class="margin"><div class="key">${esc(c.key)}</div>${c.type ? `<div class="type">${esc(c.type)}</div>` : ''}</div>
        <div class="body"><h1>${esc(c.title)}</h1>
        ${c.summary ? `<p class="sum">${esc(c.summary)}</p>` : ''}
        ${c.changes?.length ? `<h2>${esc(c.changesLabel)}</h2><ul class="changes">${c.changes.map((x) => `<li>${DASH}${esc(x)}</li>`).join('')}</ul>` : ''}</div>
        ${foot}</div>`;
    } else {
      const items = (c.items ?? []).map((x) => `<li class="${x.ok ? 'ok' : 'miss'}"><svg class="box" viewBox="0 0 32 32"><rect x="3" y="7" width="22" height="22" rx="1.5" fill="#fff" stroke="${INK.rule}" stroke-width="1.5"/></svg><span class="ac">${esc(x.id)}</span><span class="tx">${esc(x.text)}</span></li>`).join('');
      el.card.innerHTML = `<div class="sheet">
        <div class="margin"><div class="key">${esc(c.key)}</div><div class="type">${esc(c.kicker)}</div></div>
        <div class="body"><h1>${esc(c.title)}</h1><ul class="acs">${items}</ul></div>
        ${foot}</div>`;
    }
    void el.card.offsetWidth;
    el.card.classList.add('on');
    const pen = svg('svg', { class: 'cardpen', viewBox: `0 0 ${vw()} ${vh()}` });
    el.card.appendChild(pen);
    // The key gets circled; on the outro each proven criterion gets its tick, one by one.
    const k = el.card.querySelector('.key').getBoundingClientRect();
    const shape = loopShape({ x: k.left - 8, y: k.top - 8, width: k.width + 16, height: k.height + 16 }, rng(`card${c.key}${c.kind}`));
    drawOn(penStroke(pen, shape.strokes[0]), 420, 420);
    el.card.querySelectorAll('.acs li').forEach((li, i) => {
      const box = li.querySelector('.box');
      const b = box.getBoundingClientRect();
      const sx = b.width / 32, x = b.left, y = b.top;
      const P = (px, py) => `${f1(x + px * sx)} ${f1(y + py * sx)}`;
      const r = rng(`tick${i}${c.key}`), v = () => (r() - 0.5) * 2;
      if (li.classList.contains('ok')) {
        const d = `M${P(6 + v(), 17 + v())}C${P(8.5, 20)} ${P(11, 23)} ${P(13, 26 + v())}C${P(17, 17)} ${P(22, 8)} ${P(30 + v(), 1 + v())}`;
        drawOn(penStroke(pen, d), 1000 + i * 520, 320);
      } else {
        const stroke = penStroke(pen, `M${P(8, 18 + v())}C${P(12, 16)} ${P(16, 20)} ${P(21, 17 + v())}`, 3);
        stroke[1].style.stroke = INK.ink3;
        drawOn(stroke, 1000 + i * 520, 200);
      }
    });
  }

  // ---------- native <select> stand-in ----------
  function selectOpen(selector) {
    ensure();
    const s = findTarget(selector);
    if (!s || s.tagName !== 'SELECT') return { ok: false, error: `${selector} is not a <select>` };
    const r = s.getBoundingClientRect();
    const opts = [...s.options].map((o) => o.label || o.text);
    el.fsel.innerHTML = opts.map((t, i) => `<div class="opt${i === s.selectedIndex ? ' sel' : ''}">${esc(t)}</div>`).join('');
    const rowH = 31;
    const maxRows = Math.min(opts.length, 10);
    const listH = maxRows * rowH + 2;
    const below = r.bottom + 2 + listH <= vh() - 10;
    Object.assign(el.fsel.style, { left: r.left + 'px', top: (below ? r.bottom + 2 : r.top - 2 - listH) + 'px', width: Math.max(r.width, 140) + 'px', maxHeight: listH + 'px' });
    [...el.fsel.children].forEach((n) => (n.style.height = rowH + 'px'));
    el.fsel.classList.add('on');
    const sel = el.fsel.children[s.selectedIndex];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
    state.fsel = { s };
    return { ok: true, options: opts, selectedIndex: s.selectedIndex };
  }
  // Like a real dropdown, the highlight follows the pointer: whichever row the cursor is over (none outside the list).
  function selectHoverAt(x, y) {
    for (const c of el.fsel.children) {
      const b = c.getBoundingClientRect();
      c.classList.toggle('hover', x >= b.left && x <= b.right && y >= b.top && y < b.bottom);
    }
  }
  /** Scroll option i into view and return a point on it; the highlight comes when the cursor gets there. */
  function selectOptionPoint(i) {
    const n = el.fsel.children[i];
    if (!n) return null;
    n.scrollIntoView({ block: 'nearest' });
    const b = n.getBoundingClientRect();
    return { x: b.left + Math.min(60, b.width / 3), y: b.top + b.height / 2 };
  }
  function selectClose() {
    el.fsel?.classList.remove('on');
    state.fsel = null;
  }

  // ---------- alert/confirm/prompt stand-in ----------
  function dialogShow(d) {
    ensure();
    el.fdlg.innerHTML = `<div class="o">${esc(d.origin)} says</div><div class="m">${esc(d.message)}</div>${d.type === 'prompt' ? `<div class="in">${esc(d.defaultValue ?? '')}</div>` : ''}<div class="b">${d.type === 'alert' ? '' : '<div class="btn cancel">Cancel</div>'}<div class="btn ok">OK</div></div>`;
    el.fdlgDim.classList.add('on');
    el.fdlg.classList.add('on');
    const c = (q) => { const n = el.fdlg.querySelector(q); if (!n) return null; const b = n.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; };
    return { ok: c('.btn.ok'), cancel: c('.btn.cancel'), input: c('.in') };
  }
  function dialogType(text) {
    const n = el.fdlg.querySelector('.in');
    if (n) n.textContent = text;
  }
  async function dialogPress(which) {
    const n = el.fdlg.querySelector(which === 'ok' ? '.btn.ok' : '.btn.cancel');
    n?.classList.add('press');
    await sleep(140);
    el.fdlg.classList.remove('on');
    el.fdlgDim.classList.remove('on');
  }

  // ---------- keycap ----------
  let keyTimer = null;
  function keycap(label, x, y) {
    ensure();
    el.keycap.textContent = label;
    Object.assign(el.keycap.style, { left: Math.min(vw() - 140, x + 18) + 'px', top: Math.min(vh() - 60, y + 22) + 'px' });
    el.keycap.classList.add('on');
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => el.keycap.classList.remove('on'), 900);
  }

  // ---------- scrolling ----------
  async function scrollTo(selector, margin) {
    const t = findTarget(selector);
    if (!t) return { ok: false };
    const r = t.getBoundingClientRect();
    const m = margin ?? 90;
    const reserve = Math.max(captionReserve(), 120);
    const fully = r.top >= 64 + m * 0.3 && r.bottom <= vh() - reserve && r.left >= 0 && r.right <= vw();
    if (!fully) {
      t.scrollIntoView({ behavior: 'smooth', block: r.height > vh() * 0.6 ? 'start' : 'center', inline: 'nearest' });
      let last = '';
      let stable = 0;
      const start = performance.now();
      while (performance.now() - start < 2500) {
        await new Promise((res) => requestAnimationFrame(res));
        const b = t.getBoundingClientRect();
        const k = `${Math.round(b.top)}:${Math.round(b.left)}`;
        if (k === last) { if (++stable > 6) break; } else stable = 0;
        last = k;
      }
    }
    const b = t.getBoundingClientRect();
    return { ok: true, scrolled: !fully, rect: { x: b.left, y: b.top, width: b.width, height: b.height } };
  }

  const api = {
    async activate(s) {
      await fontsReady;
      ensure();
      state.active = true;
      window.__ottoActive = true;
      if (s?.cursor) Object.assign(state.cursor, s.cursor);
      placeCursor();
      if (s?.chip) chip(s.chip);
      if (s?.caption) caption(s.caption);
      raise();
      return true;
    },
    deactivate() {
      state.active = false;
      window.__ottoActive = false;
      placeCursor();
      return true;
    },
    ready() { ensure(); return document.readyState; },
    cursorMove, cursorClick,
    cursorShow(v) { state.cursor.visible = !!v; placeCursor(); return true; },
    cursorPos() { return { ...state.cursor }; },
    caption(t) { caption(t); placeCaption(); return true; },
    avoid(r) { avoidRect = r || null; placeCaption(); return true; },
    chip(c) { chip(c); return true; },
    banner,
    annotate, unannotate(id) { unannotate(id); return true; },
    geometry() { return [...state.anns.entries()].map(([id, a]) => ({ id, selector: a.opts.selector, ...a.info })); },
    async card(c) { await fontsReady; card(c); return true; },
    selectOpen, selectOptionPoint, selectClose() { selectClose(); return true; },
    dialogShow, dialogType(t) { dialogType(t); return true; }, dialogPress,
    takeDialog() { const d = pendingDialog; pendingDialog = null; return d; },
    queueDialogAnswer(a) { queuedAnswer = a; return true; },
    keycap(label, x, y) { keycap(label, x, y); return true; },
    scrollTo,
    raise() { raise(); return true; },
  };
  Object.defineProperty(window, '__otto', {
    value: { call: (m, args) => { if (!api[m]) throw new Error('unknown overlay method ' + m); return api[m](...(args || [])); } },
    enumerable: false,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure, { once: true });
  else ensure();
})();
