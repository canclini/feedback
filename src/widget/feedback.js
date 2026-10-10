// Feedback widget. A site's loader adds this script only in a browser that
// holds a site key, so ordinary visitors never load it. Everything it draws
// lives in one shadow root, styled through a constructed stylesheet (which a
// page's CSP does not block); the page's own DOM is never changed.
(() => {
  if (window.__feedbackWidget) return;
  window.__feedbackWidget = true;

  const SERVICE = new URL(document.currentScript?.src ?? "https://feedback.canclini.dev/v1/feedback.js").origin;
  const KEY_NAME = "feedback-key";
  const STATUS = { new: "neu", in_progress: "in Arbeit", question: "Rückfrage", done: "erledigt", dismissed: "verworfen" };
  const OPEN = ["new", "in_progress", "question"];
  const POLL_MS = 20000;

  // A key handed over by "Aktivieren" arrives in the fragment; keep it and
  // take it out of the address bar.
  let key;
  try {
    const parts = location.hash.slice(1).split("&");
    const handed = parts.find((part) => part.startsWith("feedback-key="));
    if (handed) {
      localStorage.setItem(KEY_NAME, handed.slice("feedback-key=".length));
      const rest = parts.filter((part) => part !== handed).join("&");
      history.replaceState(history.state, "", location.pathname + location.search + (rest ? `#${rest}` : ""));
    }
    key = localStorage.getItem(KEY_NAME);
    if (handed && key) setTimeout(() => toast("Feedback ist in diesem Browser aktiviert. Alt+K oder der Knopf unten rechts."), 300);
  } catch {
    return;
  }
  if (!key) return;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
    [hidden] { display: none !important; }
    .pill { position: fixed; right: 16px; bottom: 16px; z-index: 2147483000; display: flex; box-shadow: 0 4px 16px rgba(0,0,0,.2); }
    .pill button { border: 0; padding: 8px 12px; background: #2f5d46; color: #faf7f1; cursor: pointer; }
    .pill button + button { border-left: 1px solid rgba(250,247,241,.35); min-width: 36px; }
    .pill button:hover { background: #24493a; }
    .banner { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483001; padding: 6px; text-align: center; background: #2f5d46; color: #faf7f1; }
    .box { position: fixed; z-index: 2147482999; pointer-events: none; outline: 2px dashed #2f5d46; outline-offset: 2px; }
    .box.picked { outline-style: solid; }
    .marker { outline: 2px solid #2f5d46; }
    .marker.in_progress { background: rgba(250,247,241,.55); outline-color: #7a7266; }
    .marker.question { outline-color: #b07a10; }
    .tag { position: absolute; top: -24px; left: -2px; padding: 1px 6px; font-size: 12px; white-space: nowrap; pointer-events: auto; cursor: pointer;
      border: 0; background: #2f5d46; color: #faf7f1; }
    .marker.in_progress .tag { background: #7a7266; }
    .marker.question .tag { background: #b07a10; }
    .card { position: fixed; z-index: 2147483002; width: 360px; max-width: calc(100vw - 16px); padding: 12px; background: #fffdf8; color: #26221c;
      border: 1px solid #ddd5c6; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
    .what { margin-bottom: 8px; font-size: 12px; color: #52493a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    textarea { width: 100%; min-height: 84px; padding: 6px; border: 1px solid #ddd5c6; background: #fff; color: #26221c; resize: vertical; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
    .actions button, .item button { padding: 5px 12px; border: 1px solid #2f5d46; background: #2f5d46; color: #faf7f1; cursor: pointer; }
    .actions button.quiet, .item button.quiet { background: none; color: #2f5d46; }
    .panel { right: 16px; bottom: 64px; max-height: min(70vh, 560px); overflow-y: auto; }
    .panel h2 { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
    .item { padding: 8px 0; border-top: 1px solid #ddd5c6; }
    .item p { margin: 4px 0 0; white-space: pre-wrap; }
    .item .meta { font-size: 12px; color: #52493a; }
    .item textarea { min-height: 56px; margin-top: 6px; }
    .status { display: inline-block; padding: 0 6px; font-size: 12px; font-weight: 600; background: #ece6da; color: #52493a; }
    .status.new { background: #e6ede4; color: #2f5d46; }
    .status.question { background: #f6ead1; color: #8a5a00; }
    .foot { display: flex; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid #ddd5c6; font-size: 12px; }
    .foot a, .foot button { color: #2f5d46; background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; }
    .toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 2147483003; max-width: calc(100vw - 32px);
      padding: 8px 14px; background: #26221c; color: #faf7f1; }
    @media (max-width: 500px) { .card { left: 8px !important; right: 8px; top: auto !important; bottom: 64px; width: auto; } }`;

  // DOM helper: no innerHTML, so no page content is ever parsed as markup.
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (value === undefined || value === false) continue;
      if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else if (name === "class") node.className = value;
      else if (name in node) node[name] = value;
      else node.setAttribute(name, value);
    }
    node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
    return node;
  }

  const host = document.createElement("feedback-widget");
  const root = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];

  const banner = h("div", { class: "banner", hidden: true }, "Feedback: Element anklicken. Esc bricht ab.");
  const hoverBox = h("div", { class: "box", hidden: true });
  const pickedBox = h("div", { class: "box picked", hidden: true });
  const markers = h("div");
  const countButton = h("button", { title: "Feedback auf dieser Seite", onclick: () => togglePanel() }, "0");
  const pill = h(
    "div",
    { class: "pill" },
    h("button", { title: "Feedback geben (Alt+K)", onclick: () => togglePick() }, "Feedback"),
    countButton,
  );
  root.append(markers, hoverBox, pickedBox, banner, pill);
  (document.body ?? document.documentElement).append(host);

  let entries = [];
  let known = new Map();
  let picking = false;
  let picked = null;
  let pop = null;
  let panel = null;
  let pollTimer = null;

  // Service

  async function api(method, path, body) {
    const res = await fetch(SERVICE + path, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      disable("Der Feedback-Schlüssel gilt nicht mehr und wurde aus diesem Browser entfernt.");
      throw new Error("unauthorized");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Fehler ${res.status}`);
    return data;
  }

  async function refresh() {
    let list;
    try {
      list = (await api("GET", "/v1/entries?limit=200")).entries;
    } catch {
      return;
    }
    entries = list.filter((entry) => samePage(entry.url));
    for (const entry of entries) {
      const before = known.get(entry.id);
      if (before && before !== entry.status) {
        if (entry.status === "done") toast(`Erledigt: ${entry.last_event?.body || clip(entry.comment, 60)}`);
        if (entry.status === "question") toast(`Rückfrage: ${entry.last_event?.body || clip(entry.comment, 60)}`);
      }
      known.set(entry.id, entry.status);
    }
    const open = entries.filter((entry) => OPEN.includes(entry.status)).length;
    countButton.textContent = String(open);
    renderMarkers();
    if (panel) renderPanel();
  }

  function samePage(url) {
    try {
      const u = new URL(url);
      return u.origin === location.origin && u.pathname === location.pathname;
    } catch {
      return false;
    }
  }

  // Picking an element

  function togglePick() {
    if (picking) return stopPick();
    closePop();
    closePanel();
    picking = true;
    banner.hidden = false;
  }

  function stopPick() {
    picking = false;
    banner.hidden = true;
    hoverBox.hidden = true;
  }

  document.addEventListener(
    "mousemove",
    (event) => {
      if (!picking || event.target === host) return;
      place(hoverBox, event.target);
    },
    true,
  );

  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    document.addEventListener(type, (event) => {
      if (picking && event.target !== host) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }

  document.addEventListener(
    "click",
    (event) => {
      if (!picking || event.target === host) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      picked = event.target;
      stopPick();
      openPop(picked);
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.altKey && event.code === "KeyK") {
        event.preventDefault();
        event.stopImmediatePropagation();
        togglePick();
      } else if (event.key === "Escape" && (picking || pop || panel)) {
        stopPick();
        closePop();
        closePanel();
      }
    },
    true,
  );

  function openPop(element) {
    place(pickedBox, element);
    const textarea = h("textarea", { placeholder: "Was soll anders sein? Enter sendet, Shift+Enter für eine neue Zeile." });
    const send = () => submit(element, textarea.value);
    textarea.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
      } else if (event.key === "Escape") closePop();
    });
    pop = h(
      "div",
      { class: "card" },
      h("div", { class: "what" }, `${selectorOf(element)} · «${clip(textOf(element), 60)}»`),
      textarea,
      h(
        "div",
        { class: "actions" },
        h("button", { class: "quiet", onclick: closePop }, "Abbrechen"),
        h("button", { onclick: send }, "Senden"),
      ),
    );
    const rect = element.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(innerWidth - 376, rect.left))}px`;
    pop.style.top = `${Math.max(8, Math.min(innerHeight - 200, rect.bottom + 10))}px`;
    root.append(pop);
    textarea.focus();
  }

  function closePop() {
    pop?.remove();
    pop = null;
    picked = null;
    pickedBox.hidden = true;
  }

  async function submit(element, comment) {
    if (!comment.trim()) return closePop();
    const html = element.outerHTML;
    const entry = {
      url: location.href,
      version: document.querySelector('meta[name="app-version"]')?.content || undefined,
      selector: selectorOf(element),
      element_text: clip(textOf(element), 400),
      element_html: html.length > 2048 ? `${html.slice(0, 2047)}…` : html,
      viewport: `${innerWidth}x${innerHeight}`,
      user_agent: navigator.userAgent,
      comment: comment.trim(),
    };
    closePop();
    try {
      await api("POST", "/v1/entries", entry);
      toast("Danke, ist erfasst.");
    } catch (error) {
      if (error.message !== "unauthorized") toast(`Nicht gespeichert: ${error.message}`);
    }
    refresh();
  }

  // A selector that finds exactly this element, as short as that allows.
  function selectorOf(element) {
    const parts = [];
    for (let node = element; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll(`#${node.id}`).length === 1) {
        parts.unshift(`#${node.id}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter((name) => /^[A-Za-z_-][\w-]*$/.test(name)).slice(0, 2);
      if (classes.length) part += `.${classes.join(".")}`;
      const parent = node.parentElement;
      if (parent && parent.querySelectorAll(`:scope > ${part}`).length > 1) {
        part += `:nth-of-type(${[...parent.children].filter((c) => c.tagName === node.tagName).indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
    }
    return parts.join(" > ");
  }

  function textOf(element) {
    return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Status on the page

  function renderMarkers() {
    markers.replaceChildren(
      ...entries
        .filter((entry) => OPEN.includes(entry.status))
        .map((entry) => {
          const element = find(entry.selector);
          if (!element) return null;
          const marker = h(
            "div",
            { class: `box marker ${entry.status}` },
            h("button", { class: "tag", onclick: () => togglePanel(entry.id) }, `#${entry.id} ${STATUS[entry.status]}`),
          );
          marker.target = element;
          return marker;
        })
        .filter(Boolean),
    );
    reposition();
  }

  function find(selector) {
    try {
      return selector ? document.querySelector(selector) : null;
    } catch {
      return null;
    }
  }

  function place(box, element) {
    const rect = element.getBoundingClientRect();
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.hidden = rect.width === 0 && rect.height === 0;
  }

  let frame = 0;
  function reposition() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const marker of markers.children) place(marker, marker.target);
      if (picked && pop) place(pickedBox, picked);
    });
  }
  addEventListener("scroll", reposition, { passive: true, capture: true });
  addEventListener("resize", reposition, { passive: true });

  // The list of this page's entries

  function togglePanel(focusId) {
    if (panel && focusId === undefined) return closePanel();
    stopPick();
    closePop();
    panel ??= root.appendChild(h("div", { class: "card panel" }));
    renderPanel(focusId);
  }

  function closePanel() {
    panel?.remove();
    panel = null;
  }

  function renderPanel(focusId) {
    const visible = entries.filter(
      (entry) => OPEN.includes(entry.status) || Date.now() - Date.parse(entry.updated_at) < 14 * 86400000,
    );
    panel.replaceChildren(
      h("h2", {}, "Feedback auf dieser Seite"),
      ...(visible.length === 0 ? [h("p", {}, "Noch keines. Alt+K oder «Feedback», dann ein Element anklicken.")] : []),
      ...visible.map(item),
      h(
        "div",
        { class: "foot" },
        h("a", { href: `${SERVICE}/${entries[0] ? `apps/${entries[0].app}` : ""}`, target: "_blank", rel: "noopener" }, "Alle Einträge"),
        h("button", { onclick: () => disable("Feedback ist in diesem Browser ausgeschaltet.") }, "In diesem Browser ausschalten"),
      ),
    );
    if (focusId !== undefined) panel.querySelector(`[data-id="${focusId}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function item(entry) {
    const last = entry.last_event;
    const node = h(
      "div",
      { class: "item", "data-id": String(entry.id) },
      h("span", { class: `status ${entry.status}` }, STATUS[entry.status]),
      " ",
      h("span", { class: "meta" }, `#${entry.id}`),
      h("p", {}, entry.comment),
      last && last.kind !== "created" && last.body ? h("p", { class: "meta" }, `${label(last)}: ${last.body}`) : null,
    );
    if (entry.status === "question") {
      const answer = h("textarea", { placeholder: "Deine Antwort" });
      answer.addEventListener("keydown", (event) => event.stopPropagation());
      node.append(
        answer,
        h("div", { class: "actions" }, h("button", { onclick: () => post(entry.id, "answer", answer.value) }, "Antworten")),
      );
    } else if (entry.status === "done" || entry.status === "dismissed") {
      node.append(h("div", { class: "actions" }, h("button", { class: "quiet", onclick: () => post(entry.id, "reopen", "") }, "Wieder öffnen")));
    }
    return node;
  }

  function label(event) {
    return { question: "Rückfrage", answer: "Antwort", resolve: "Erledigt", dismiss: "Verworfen", reopen: "Wieder geöffnet", note: "Notiz", claim: "Übernommen" }[event.kind] ?? event.kind;
  }

  async function post(id, kind, body) {
    if (kind === "answer" && !body.trim()) return;
    try {
      await api("POST", `/v1/entries/${id}/events`, { kind, body });
    } catch (error) {
      if (error.message !== "unauthorized") toast(error.message);
    }
    refresh();
  }

  // Housekeeping

  let toastTimer = 0;
  function toast(text) {
    root.querySelector(".toast")?.remove();
    clearTimeout(toastTimer);
    const node = root.appendChild(h("div", { class: "toast", role: "status" }, text));
    toastTimer = setTimeout(() => node.remove(), 5000);
  }

  function disable(message) {
    try {
      localStorage.removeItem(KEY_NAME);
    } catch {}
    clearInterval(pollTimer);
    for (const child of [...root.children]) if (!child.classList.contains("toast")) child.remove();
    toast(message);
    setTimeout(() => host.remove(), 5000);
  }

  function clip(text, limit) {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  setInterval(reposition, 2000);
  refresh();
})();
