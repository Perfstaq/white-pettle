// Every single-choice <select> in the app and the Command Deck opens this pop-up instead of the browser's own menu.
// The <select> stays the trigger and the source of truth: picking an option sets its value and fires input + change,
// so existing handlers, forms and selects drawn later need nothing. Touch devices keep their native picker.
(() => {
  if (window.__selectPopup) return; window.__selectPopup = true;
  if (matchMedia("(pointer: coarse)").matches) return;

  const css = `
.wpsp{position:fixed;z-index:1000;min-width:180px;max-width:min(420px,calc(100vw - 16px));display:flex;flex-direction:column;
  background:var(--wpsp-bg);color:var(--wpsp-ink);border:1px solid var(--wpsp-line);border-radius:12px;
  box-shadow:0 18px 44px -14px rgba(16,14,10,.32),0 2px 6px rgba(16,14,10,.08);font:inherit;font-size:.88rem;overflow:hidden;
  animation:wpsp-in .12s ease-out}
@keyframes wpsp-in{from{transform:translateY(-4px)}to{transform:none}}
.wpsp.up{animation-name:wpsp-up}@keyframes wpsp-up{from{transform:translateY(4px)}to{transform:none}}
.wpsp-search{margin:6px 6px 2px;padding:7px 10px;border:1px solid var(--wpsp-line);border-radius:8px;background:transparent;color:inherit;font:inherit;outline:none}
.wpsp-search:focus{border-color:var(--wpsp-accent)}
.wpsp-list{overflow:auto;padding:4px;overscroll-behavior:contain}
.wpsp-group{padding:8px 10px 4px;font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;color:var(--wpsp-muted)}
.wpsp-opt{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;line-height:1.3}
.wpsp-opt .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wpsp-opt .k{width:14px;flex:none;color:var(--wpsp-accent)}
.wpsp-opt.on{font-weight:600}
.wpsp-opt.act{background:var(--wpsp-hover)}
.wpsp-opt[aria-disabled="true"]{opacity:.45;cursor:default}
.wpsp-empty{padding:10px;color:var(--wpsp-muted)}
select.wpsp-open{border-color:var(--wpsp-accent,currentColor)}`;
  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));

  let open = null; // { sel, box, items, act }
  const eligible = (s) => s instanceof HTMLSelectElement && !s.multiple && !(s.size > 1) && !s.disabled && !s.hasAttribute("data-native");
  // Colours come from how the select itself looks (its text, the first solid background behind it, its border), so the pop-up
  // matches the dark app, the light screens and the console without knowing any of their themes.
  const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const solid = (c) => { const [, , , a = 1] = rgb(c); return c && c !== "transparent" && a > 0.9; };
  function theme(sel) {
    const cs = getComputedStyle(sel), ink = cs.color;
    let bg = null; for (let el = sel; el && !bg; el = el.parentElement) { const b = getComputedStyle(el).backgroundColor; if (solid(b)) bg = b; }
    if (!bg) { const [r, g, b] = rgb(ink); bg = 0.299 * r + 0.587 * g + 0.114 * b > 128 ? "#18181b" : "#ffffff"; }
    const border = parseFloat(cs.borderTopWidth) > 0 && solid(cs.borderTopColor) ? cs.borderTopColor : `color-mix(in srgb, ${ink} 16%, ${bg})`;
    const v = (n) => cs.getPropertyValue(n).trim();
    return { "--wpsp-bg": bg, "--wpsp-ink": ink, "--wpsp-line": border, "--wpsp-muted": `color-mix(in srgb, ${ink} 58%, ${bg})`,
      "--wpsp-hover": `color-mix(in srgb, ${ink} 7%, ${bg})`, "--wpsp-accent": v("--accent") || v("--petal") || v("--coral") || "#e8742a" };
  }

  function show(sel) {
    close();
    const box = document.createElement("div"); box.className = "wpsp"; box.setAttribute("role", "listbox");
    for (const [k, val] of Object.entries(theme(sel))) box.style.setProperty(k, val);
    const items = [], opts = [...sel.options];
    const search = opts.length > 8 ? Object.assign(document.createElement("input"), { className: "wpsp-search", placeholder: "Search…", type: "text" }) : null;
    if (search) { search.setAttribute("aria-label", "Search options"); box.append(search); }
    const list = document.createElement("div"); list.className = "wpsp-list"; box.append(list);
    let group = null;
    for (const o of opts) {
      if (o.hidden) continue;
      const g = o.parentElement.tagName === "OPTGROUP" ? o.parentElement : null;
      if (g !== group) { group = g; if (g) { const h = document.createElement("div"); h.className = "wpsp-group"; h.textContent = g.label; list.append(h); items.push({ head: h, g }); } }
      const b = document.createElement("button"); b.type = "button"; b.className = "wpsp-opt" + (o.selected ? " on" : ""); b.setAttribute("role", "option");
      b.setAttribute("aria-selected", o.selected ? "true" : "false"); b.tabIndex = -1;
      const dis = o.disabled || g?.disabled; if (dis) b.setAttribute("aria-disabled", "true");
      b.innerHTML = `<span class="k">${o.selected ? "✓" : ""}</span><span class="t"></span>`; b.querySelector(".t").textContent = o.textContent.trim() || " ";
      b.title = o.textContent.trim();
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => { if (!dis) pick(o); });
      b.addEventListener("mousemove", () => activate(items.indexOf(item)));
      const item = { el: b, o, dis, text: o.textContent.trim().toLowerCase(), g };
      items.push(item); list.append(b);
    }
    const empty = Object.assign(document.createElement("div"), { className: "wpsp-empty", textContent: "No matches", hidden: true }); list.append(empty);
    document.body.append(box);
    open = { sel, box, list, items, empty, search, act: -1 };
    sel.classList.add("wpsp-open"); sel.setAttribute("aria-expanded", "true");
    place();
    activate(items.findIndex((x) => x.o?.selected && !x.dis));
    if (search) { search.addEventListener("input", filter); search.addEventListener("keydown", keys); search.focus(); }
  }

  function place() {
    if (!open) return;
    const r = open.sel.getBoundingClientRect(), box = open.box, gap = 6, vh = innerHeight;
    box.style.minWidth = Math.max(180, r.width) + "px";
    const below = vh - r.bottom - gap - 8, above = r.top - gap - 8, up = below < 220 && above > below;
    const room = Math.max(120, Math.min(360, up ? above : below));
    open.list.style.maxHeight = room - (open.search ? 44 : 0) + "px";
    const w = box.offsetWidth, left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    box.style.left = left + "px";
    box.classList.toggle("up", up);
    if (up) { box.style.top = ""; box.style.bottom = vh - r.top + gap + "px"; } else { box.style.bottom = ""; box.style.top = r.bottom + gap + "px"; }
  }

  const visible = () => open.items.filter((x) => x.el && !x.el.hidden && !x.dis);
  function activate(i) {
    if (!open) return;
    open.items.forEach((x, k) => x.el?.classList.toggle("act", k === i));
    open.act = i; open.items[i]?.el?.scrollIntoView({ block: "nearest" });
  }
  function step(d) {
    const vis = visible(); if (!vis.length) return;
    const cur = vis.indexOf(open.items[open.act]);
    const next = cur < 0 ? (d > 0 ? 0 : vis.length - 1) : Math.min(vis.length - 1, Math.max(0, cur + d));
    activate(open.items.indexOf(vis[next]));
  }
  function filter() {
    const t = open.search.value.trim().toLowerCase();
    for (const x of open.items) if (x.el) x.el.hidden = !!t && !x.text.includes(t);
    for (const x of open.items) if (x.head) x.head.hidden = !open.items.some((y) => y.el && y.g === x.g && !y.el.hidden);
    const vis = visible(); open.empty.hidden = !!vis.length || open.items.some((x) => x.el && !x.el.hidden);
    activate(vis.length ? open.items.indexOf(vis[0]) : -1);
  }

  function pick(o) {
    const sel = open.sel; close(true);
    if (sel.value !== o.value || sel.selectedIndex !== o.index) {
      sel.selectedIndex = o.index;
      sel.dispatchEvent(new Event("input", { bubbles: true })); sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  function close(refocus) {
    if (!open) return;
    const { sel, box } = open; open = null;
    box.remove(); sel.classList.remove("wpsp-open"); sel.setAttribute("aria-expanded", "false");
    if (refocus && document.contains(sel)) sel.focus({ preventScroll: true });
  }

  let typed = "", typedAt = 0;
  function keys(e) {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
    else if (e.key === "Home" && !open.search) { e.preventDefault(); step(-1e6); }
    else if (e.key === "End" && !open.search) { e.preventDefault(); step(1e6); }
    else if (e.key === "Enter" || (e.key === " " && !open.search && !(typed && Date.now() - typedAt < 700))) { e.preventDefault(); const x = open.items[open.act]; if (x?.o && !x.dis) pick(x.o); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "Tab") close(false);
    else if (!open.search && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      // Type to jump, like the native menu.
      typed = (Date.now() - typedAt < 700 ? typed : "") + e.key.toLowerCase(); typedAt = Date.now();
      const hit = visible().find((x) => x.text.startsWith(typed)); if (hit) activate(open.items.indexOf(hit));
    }
  }

  // If something else on the page removed the pop-up, forget it rather than treat the next click as "close".
  const stale = () => { if (open && !open.box.isConnected) { open.sel.classList.remove("wpsp-open"); open = null; } };
  document.addEventListener("mousedown", (e) => {
    stale();
    const sel = e.target.closest?.("select");
    if (open && !open.box.contains(e.target) && sel !== open.sel) close(false);
    if (!eligible(sel) || e.button !== 0) return;
    e.preventDefault(); // keeps the browser's own menu shut
    if (open?.sel === sel) { close(true); return; }
    sel.focus({ preventScroll: true }); show(sel);
  }, true);
  document.addEventListener("keydown", (e) => {
    stale();
    if (open && (e.target === open.sel || open.box.contains(e.target))) { keys(e); return; }
    const sel = e.target;
    if (!eligible(sel)) return;
    if ([" ", "Enter", "ArrowDown", "ArrowUp", "F4"].includes(e.key) && !e.metaKey && !e.ctrlKey) { e.preventDefault(); show(sel); }
  }, true);
  addEventListener("resize", () => close(false));
  document.addEventListener("scroll", (e) => { if (open && !open.box.contains(e.target)) place(); }, true);
  // A select that's redrawn or removed while open takes its pop-up with it.
  new MutationObserver(() => { if (open && !document.contains(open.sel)) close(false); }).observe(document.body, { childList: true, subtree: true });
})();
