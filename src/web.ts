import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Auth, AuthError } from "./auth.ts";
import { Html, html } from "./html.ts";
import { type App, type Entry, type Event, type Principal, type Status, type Store, StoreError } from "./store.ts";

const SESSION_COOKIE = "__Host-session";
// The ids of the site keys made in this browser, so the access page can tell
// them apart from the other devices' keys. Ids only, never a key.
const HERE_COOKIE = "__Host-site-keys-here";
const HERE_MAX_AGE = 400 * 24 * 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;
// The web UI is Marcel without an app restriction: he sees every app.
const OWNER: Principal = { type: "owner", actor: "marcel", appId: null };

const STATUS_LABELS: Record<Status, string> = {
  new: "neu",
  in_progress: "in Arbeit",
  question: "Rückfrage",
  done: "erledigt",
  dismissed: "verworfen",
};

const KIND_LABELS: Record<string, string> = {
  created: "erfasst",
  claim: "übernommen",
  question: "Rückfrage",
  answer: "Antwort",
  resolve: "erledigt",
  dismiss: "verworfen",
  reopen: "wieder geöffnet",
  note: "Notiz",
};

const STATIC: Record<string, { type: string; body: Buffer }> = {
  "/ui/style.css": { type: "text/css; charset=utf-8", body: readFileSync(new URL("./ui/style.css", import.meta.url)) },
  "/ui/icon.svg": { type: "image/svg+xml", body: readFileSync(new URL("./ui/icon.svg", import.meta.url)) },
  "/ui/loader.js": {
    type: "text/javascript; charset=utf-8",
    body: readFileSync(new URL("./ui/loader.js", import.meta.url)),
  },
  "/ui/passkey.js": {
    type: "text/javascript; charset=utf-8",
    body: readFileSync(new URL("./ui/passkey.js", import.meta.url)),
  },
};

const dateFormat = new Intl.DateTimeFormat("de-CH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Zurich",
});

class WebError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  signedIn: boolean;
  session: string | undefined;
}

// Serves the web UI on feedback.canclini.dev itself. Returns false for paths
// it does not own.
export function createWebRoute(store: Store, auth: Auth) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const asset = STATIC[url.pathname];
    if (asset && req.method === "GET") {
      res.writeHead(200, { "content-type": asset.type, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      res.end(asset.body);
      return true;
    }

    const session = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const ctx: Context = { req, res, url, session, signedIn: auth.isSession(session) };
    try {
      if (req.method === "POST" && req.headers.origin !== auth.origin) {
        throw new WebError(403, "Diese Anfrage kommt nicht von dieser Seite.");
      }
      const handled = await route(store, auth, ctx);
      return handled;
    } catch (error) {
      if (res.headersSent) throw error;
      const status =
        error instanceof WebError ? error.status
        : error instanceof AuthError ? 400
        : error instanceof StoreError ? { invalid: 400, not_found: 404, conflict: 409, forbidden: 403 }[error.code]
        : 500;
      if (status === 500) console.error(error);
      const message = status === 500 ? "Interner Fehler." : (error as Error).message;
      if (url.pathname.startsWith("/auth/")) {
        sendJson(res, status, { error: "failed", message });
      } else {
        sendPage(res, store, status, "Fehler", html`<h1>Das ging nicht</h1><p>${message}</p><p><a href="/">Zur Übersicht</a></p>`, ctx.signedIn);
      }
      return true;
    }
  };
}

async function route(store: Store, auth: Auth, ctx: Context): Promise<boolean> {
  const { req, res, url } = ctx;
  const path = url.pathname;
  const get = req.method === "GET";
  const post = req.method === "POST";

  // Passkey ceremonies, called by src/ui/passkey.js.
  if (post && path === "/auth/setup/options") {
    const { code } = await readBody(req);
    if (!auth.checkSetupCode(code)) throw new WebError(403, "Der Einrichtungscode stimmt nicht.");
    sendJson(res, 200, await auth.registrationOptions(true));
    return true;
  }
  if (post && path === "/auth/register/options") {
    requireSession(ctx);
    sendJson(res, 200, await auth.registrationOptions(false));
    return true;
  }
  if (post && path === "/auth/register/verify") {
    const { ceremony, response, name } = await readBody(req);
    const { setup } = await auth.verifyRegistration(ceremony, response, name, ctx.signedIn);
    if (setup) setSessionCookie(res, auth);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (post && path === "/auth/login/options") {
    sendJson(res, 200, await auth.authenticationOptions());
    return true;
  }
  if (post && path === "/auth/login/verify") {
    const { ceremony, response } = await readBody(req);
    await auth.verifyAuthentication(ceremony, response);
    setSessionCookie(res, auth);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (post && path === "/logout") {
    auth.endSession(ctx.session);
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    redirect(res, "/");
    return true;
  }

  if (get && path === "/") {
    if (ctx.signedIn) sendPage(res, store, 200, "Übersicht", overviewPage(store), true);
    else if (auth.needsSetup()) sendPage(res, store, 200, "Einrichten", setupPage(), false);
    else sendPage(res, store, 200, "Anmelden", signInPage(), false);
    return true;
  }

  // Everything below needs a session.
  const appMatch = /^\/apps\/([a-z0-9-]+)$/.exec(path);
  const entryMatch = /^\/entries\/(\d+)$/.exec(path);
  const eventMatch = /^\/entries\/(\d+)\/events$/.exec(path);
  const revokeMatch = /^\/access\/(site-keys|agent-tokens)\/(\d+)\/revoke$/.exec(path);
  const passkeyMatch = /^\/access\/passkeys\/([\w-]+)\/delete$/.exec(path);
  const known =
    appMatch || entryMatch || eventMatch || revokeMatch || passkeyMatch ||
    ["/access", "/access/site-keys", "/access/agent-tokens"].includes(path);
  if (!known) return false;
  if (!ctx.signedIn) {
    if (get) redirect(res, "/");
    else throw new WebError(401, "Bitte zuerst anmelden.");
    return true;
  }

  if (get && appMatch) {
    const app = store.getApp(appMatch[1]);
    if (!app) throw new WebError(404, "Diese Website gibt es nicht.");
    const all = url.searchParams.get("status") === "all";
    sendPage(res, store, 200, app.name, appPage(store, app, all), true);
    return true;
  }
  if (get && entryMatch) {
    const detail = store.getEntry(OWNER, Number(entryMatch[1]));
    sendPage(res, store, 200, `Eintrag #${detail.entry.id}`, entryPage(detail), true);
    return true;
  }
  if (post && eventMatch) {
    const id = Number(eventMatch[1]);
    const { kind, body } = await readBody(req);
    store.addEvent(OWNER, id, { kind: String(kind ?? ""), body: typeof body === "string" ? body : undefined });
    redirect(res, `/entries/${id}`);
    return true;
  }
  if (get && path === "/access") {
    sendPage(res, store, 200, "Zugänge", accessPage(store, auth, keysHere(req)), true);
    return true;
  }
  if (post && path === "/access/site-keys") {
    const { app: appId, label } = await readBody(req);
    const app = typeof appId === "string" ? store.getApp(appId) : null;
    if (!app) throw new WebError(400, "Bitte eine Website wählen.");
    const name = typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : deviceName(req.headers["user-agent"]);
    const { id, key } = store.createSiteKey(app.id, name);
    const here = [...keysHere(req), id].slice(-50);
    res.setHeader("set-cookie", `${HERE_COOKIE}=${here.join(".")}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${HERE_MAX_AGE}`);
    // The key travels in the fragment, which browsers never send to a server.
    redirect(res, `${app.origins[0]}/#feedback-key=${key}`);
    return true;
  }
  if (post && path === "/access/agent-tokens") {
    const { name, scope } = await readBody(req);
    if (scope !== "read" && scope !== "write") throw new WebError(400, "Bitte Lesen oder Schreiben wählen.");
    const { token } = store.createAgentToken(String(name ?? "").trim(), scope);
    sendPage(res, store, 200, "Neuer Agent-Zugang", tokenCreatedPage(auth, String(name), token), true);
    return true;
  }
  if (post && revokeMatch) {
    const id = Number(revokeMatch[2]);
    if (revokeMatch[1] === "site-keys") store.revokeSiteKey(id);
    else store.revokeAgentToken(id);
    redirect(res, "/access");
    return true;
  }
  if (post && passkeyMatch) {
    auth.deleteCredential(passkeyMatch[1]);
    redirect(res, "/access");
    return true;
  }
  throw new WebError(405, "Diese Aktion gibt es so nicht.");
}

function requireSession(ctx: Context): void {
  if (!ctx.signedIn) throw new WebError(401, "Bitte zuerst anmelden.");
}

// Pages

function setupPage(): Html {
  return html`
    <h1>Einrichten</h1>
    <p>Noch ist kein Passkey registriert. Den Einrichtungscode zeigt der Dienst beim Start in seinem Log.</p>
    <form class="stack" data-passkey="setup">
      <label>Einrichtungscode <input name="code" required autocomplete="off" spellcheck="false"></label>
      <label>Name des Geräts <input name="name" placeholder="z. B. MacBook" maxlength="60"></label>
      <button>Passkey einrichten</button>
      <p class="error" data-passkey-error role="alert"></p>
    </form>`;
}

function signInPage(): Html {
  return html`
    <h1>Anmelden</h1>
    <form class="stack" data-passkey="login">
      <button>Mit Passkey anmelden</button>
      <p class="error" data-passkey-error role="alert"></p>
    </form>`;
}

function overviewPage(store: Store): Html {
  const apps = store.listApps();
  const counts = new Map<string, Partial<Record<Status, number>>>();
  for (const row of store.countEntries()) {
    counts.set(row.app_id, { ...counts.get(row.app_id), [row.status]: row.count });
  }
  const waiting = store.listEntries(OWNER, { statuses: ["question"] });
  return html`
    <h1>Übersicht</h1>
    ${waiting.length > 0 && html`
      <section>
        <h2>Wartet auf dich</h2>
        ${entryList(waiting, apps)}
      </section>`}
    <section>
      <h2>Websites</h2>
      <table>
        <thead><tr><th>Website</th><th>neu</th><th>in Arbeit</th><th>Rückfrage</th><th>erledigt</th></tr></thead>
        <tbody>
          ${apps.map((app) => {
            const c = counts.get(app.id) ?? {};
            return html`<tr>
              <td><a href="/apps/${app.id}">${app.name}</a></td>
              <td>${c.new ?? 0}</td><td>${c.in_progress ?? 0}</td><td>${c.question ?? 0}</td><td>${c.done ?? 0}</td>
            </tr>`;
          })}
        </tbody>
      </table>
    </section>`;
}

function appPage(store: Store, app: App, all: boolean): Html {
  const entries = store.listEntries(OWNER, {
    app: app.id,
    statuses: all ? undefined : ["new", "in_progress", "question"],
    limit: 500,
  });
  return html`
    <p class="crumbs"><a href="/">Übersicht</a></p>
    <h1>${app.name}</h1>
    <p class="meta">${app.repo}, Branch ${app.branch} · ${app.origins.join(", ")}</p>
    <nav class="tabs">
      <a href="/apps/${app.id}" ${!all && new Html('aria-current="page"')}>Offen</a>
      <a href="/apps/${app.id}?status=all" ${all && new Html('aria-current="page"')}>Alle</a>
    </nav>
    ${entries.length > 0 ? entryList(entries) : html`<p>Keine Einträge.</p>`}`;
}

function entryList(entries: Entry[], apps?: App[]): Html {
  const names = new Map(apps?.map((app) => [app.id, app.name]));
  return html`<ul class="entries">
    ${entries.map((entry) => html`<li>
      <a href="/entries/${entry.id}">#${entry.id}</a>
      ${statusBadge(entry.status)}
      <span class="comment">${truncate(entry.comment, 160)}</span>
      <small>${apps ? `${names.get(entry.app) ?? entry.app} · ` : ""}${pagePath(entry.url)} · ${formatDate(entry.created_at)}</small>
    </li>`)}
  </ul>`;
}

function entryPage({ entry, events, app }: { entry: Entry; events: Event[]; app: App }): Html {
  return html`
    <p class="crumbs"><a href="/">Übersicht</a> · <a href="/apps/${app.id}">${app.name}</a></p>
    <h1>Eintrag #${entry.id} ${statusBadge(entry.status)}</h1>
    <blockquote>${entry.comment}</blockquote>
    <dl>
      <dt>Seite</dt><dd><a href="${entry.url}" rel="noopener noreferrer" target="_blank">${entry.url}</a></dd>
      <dt>Element</dt><dd><code>${entry.selector ?? "unbekannt"}</code>${entry.element_text && html`<br>«${truncate(entry.element_text, 200)}»`}</dd>
      <dt>Version</dt><dd><code>${entry.version ?? "unbekannt"}</code></dd>
      <dt>Ansicht</dt><dd>${entry.viewport ?? "unbekannt"}</dd>
      <dt>Browser</dt><dd>${entry.user_agent ?? "unbekannt"}</dd>
    </dl>
    ${entry.element_html && html`<details><summary>HTML des Elements</summary><pre><code>${entry.element_html}</code></pre></details>`}
    <h2>Verlauf</h2>
    <ol class="events">
      ${events.map((event) => html`<li>
        <strong>${KIND_LABELS[event.kind] ?? event.kind}</strong>
        <small>${actorLabel(event.actor)} · ${formatDate(event.created_at)}</small>
        ${event.body && html`<p>${event.body}</p>`}
        ${event.link && html`<p>${linkOrText(event.link)}</p>`}
      </li>`)}
    </ol>
    ${entryActions(entry)}`;
}

function entryActions(entry: Entry): Html {
  const form = (kind: string, label: string, button: string, required: boolean) => html`
    <form method="post" action="/entries/${entry.id}/events" class="stack">
      <input type="hidden" name="kind" value="${kind}">
      <label>${label} <textarea name="body" rows="3" maxlength="4000" ${required && new Html("required")}></textarea></label>
      <button>${button}</button>
    </form>`;
  if (entry.status === "question") {
    return html`<h2>Antworten</h2>${form("answer", "Deine Antwort", "Antworten", true)}
      <h2>Verwerfen</h2>${form("dismiss", "Grund", "Verwerfen", true)}`;
  }
  if (entry.status === "done" || entry.status === "dismissed") {
    return html`<h2>Wieder öffnen</h2>${form("reopen", "Was noch nicht stimmt (optional)", "Wieder öffnen", false)}`;
  }
  return html`<h2>Ergänzen</h2>${form("note", "Was noch dazugehört", "Ergänzen", true)}
    <h2>Verwerfen</h2>${form("dismiss", "Grund", "Verwerfen", true)}`;
}

function accessPage(store: Store, auth: Auth, here: number[]): Html {
  const apps = store.listApps();
  const names = new Map(apps.map((app) => [app.id, app.name]));
  const siteKeys = store.listSiteKeys().filter((key) => !key.revoked_at);
  const tokens = store.listAgentTokens().filter((token) => !token.revoked_at);
  const passkeys = auth.listCredentials();
  const revoke = (kind: string, id: number) => html`
    <form method="post" action="/access/${kind}/${id}/revoke" class="inline"><button class="quiet">Sperren</button></form>`;
  return html`
    <p class="crumbs"><a href="/">Übersicht</a></p>
    <h1>Zugänge</h1>

    <section>
      <h2>Websites</h2>
      <p>Aktiviert das Feedback auf einer Website, und zwar nur in diesem Browser auf diesem Gerät. Für das Handy oder einen anderen Browser dort bei feedback.canclini.dev anmelden und die Website nochmals aktivieren.</p>
      <form method="post" action="/access/site-keys" class="row">
        <label>Website <select name="app" required>
          ${apps.map((app) => html`<option value="${app.id}">${app.name}</option>`)}
        </select></label>
        <label>Gerät <input name="label" placeholder="z. B. MacBook Safari" maxlength="60"></label>
        <button>Aktivieren</button>
      </form>
      ${siteKeys.length > 0 && html`<table>
        <caption>Aktiviert auf allen Geräten</caption>
        <thead><tr><th>Website</th><th>Gerät</th><th>Erstellt</th><th></th></tr></thead>
        <tbody>${siteKeys.map((key) => html`<tr>
          <td>${names.get(key.app_id) ?? key.app_id}</td>
          <td>${key.label}${here.includes(key.id) && html` <span class="status status-here">dieser Browser</span>`}</td>
          <td>${formatDate(key.created_at)}</td>
          <td>${revoke("site-keys", key.id)}</td></tr>`)}</tbody>
      </table>`}
    </section>

    <section>
      <h2>Agenten</h2>
      <p>Zugang für einen Agenten über MCP oder die API. Der Schlüssel wird nur einmal angezeigt.</p>
      <form method="post" action="/access/agent-tokens" class="row">
        <label>Name <input name="name" required pattern="[a-z0-9-]+" placeholder="z. B. claude-code" maxlength="40"></label>
        <label>Rechte <select name="scope"><option value="write">Lesen und bearbeiten</option><option value="read">Nur lesen</option></select></label>
        <button>Erstellen</button>
      </form>
      ${tokens.length > 0 && html`<table>
        <thead><tr><th>Name</th><th>Rechte</th><th>Erstellt</th><th></th></tr></thead>
        <tbody>${tokens.map((token) => html`<tr>
          <td>${token.name}</td><td>${token.scope === "write" ? "Lesen und bearbeiten" : "Nur lesen"}</td>
          <td>${formatDate(token.created_at)}</td><td>${revoke("agent-tokens", token.id)}</td></tr>`)}</tbody>
      </table>`}
    </section>

    <section>
      <h2>Passkeys</h2>
      <table>
        <thead><tr><th>Name</th><th>Erstellt</th><th>Zuletzt benutzt</th><th></th></tr></thead>
        <tbody>${passkeys.map((passkey) => html`<tr>
          <td>${passkey.name}</td><td>${formatDate(passkey.created_at)}</td>
          <td>${passkey.last_used_at ? formatDate(passkey.last_used_at) : "noch nie"}</td>
          <td>${passkeys.length > 1 && html`<form method="post" action="/access/passkeys/${passkey.id}/delete" class="inline"><button class="quiet">Entfernen</button></form>`}</td>
        </tr>`)}</tbody>
      </table>
      <form class="row" data-passkey="register">
        <label>Name des Geräts <input name="name" placeholder="z. B. iPhone" maxlength="60"></label>
        <button>Passkey hinzufügen</button>
        <p class="error" data-passkey-error role="alert"></p>
      </form>
    </section>`;
}

function tokenCreatedPage(auth: Auth, name: string, token: string): Html {
  return html`
    <p class="crumbs"><a href="/access">Zugänge</a></p>
    <h1>Agent-Zugang «${name}»</h1>
    <p>Dieser Schlüssel wird nur jetzt angezeigt. Lege ihn im Geheimnisspeicher des Agenten ab, nie in einem Repository.</p>
    <pre class="secret"><code>${token}</code></pre>
    <dl>
      <dt>MCP</dt><dd><code>${auth.origin}/mcp</code></dd>
      <dt>Header</dt><dd><code>Authorization: Bearer &lt;Schlüssel&gt;</code></dd>
    </dl>
    <p><a href="/access">Zurück zu den Zugängen</a></p>`;
}

// Building blocks

// The commit this image was built from, as on every site (docs/EMBED.md), so Hex can tell when a
// merge is live and an entry on these pages names the version Marcel saw.
const VERSION = process.env.GIT_COMMIT ?? "dev";

function layout(title: string, content: Html, signedIn: boolean): Html {
  return html`<!doctype html>
<html lang="de-CH">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Feedback</title>
<meta name="description" content="Feedback: auf ein Element einer Website zeigen, kommentieren, und ein Agent behebt es. Der Status kommt auf die Seite zurück.">
<link rel="icon" href="/ui/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/ui/style.css">
<meta name="app-version" content="${VERSION}">
<script src="/ui/loader.js"></script>
<script type="module" src="/ui/passkey.js"></script>
</head>
<body>
<header>
  <a href="/" class="brand">Feedback</a>
  ${signedIn && html`<nav>
    <a href="/">Übersicht</a>
    <a href="/access">Zugänge</a>
    <form method="post" action="/logout" class="inline"><button class="quiet">Abmelden</button></form>
  </nav>`}
</header>
<main>
${content}
</main>
</body>
</html>`;
}

function statusBadge(status: Status): Html {
  return html`<span class="status status-${status}">${STATUS_LABELS[status]}</span>`;
}

function actorLabel(actor: string): string {
  if (actor === "marcel") return "Du";
  return actor.startsWith("agent:") ? `Agent ${actor.slice(6)}` : actor;
}

function linkOrText(link: string): Html {
  return /^https:\/\//.test(link)
    ? html`<a href="${link}" rel="noopener noreferrer" target="_blank">${link}</a>`
    : html`<code>${link}</code>`;
}

function pagePath(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

// HTTP helpers

function sendPage(res: ServerResponse, store: Store, status: number, title: string, content: Html, signedIn: boolean): void {
  // form-action lists the registered sites because "Aktivieren" redirects
  // there after the form is submitted.
  const formTargets = ["'self'", ...store.allOrigins()].join(" ");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; ` +
      `form-action ${formTargets}; frame-ancestors 'none'; base-uri 'none'`,
    "x-content-type-options": "nosniff",
    // same-origin, not no-referrer: under no-referrer Chrome sends
    // "Origin: null" with form posts, which the origin check refuses.
    "referrer-policy": "same-origin",
  });
  res.end(layout(title, content, signedIn).value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

function setSessionCookie(res: ServerResponse, auth: Auth): void {
  const { token, maxAge } = auth.createSession();
  // Lax, not Strict: a link from elsewhere (Hex's board, a mail) opens the page signed in. A
  // cross-site POST still goes without the cookie, and every POST must carry our Origin anyway.
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function keysHere(req: IncomingMessage): number[] {
  const value = parseCookies(req.headers.cookie)[HERE_COOKIE] ?? "";
  return value.split(".").filter((part) => /^\d{1,9}$/.test(part)).map(Number);
}

// A name for the device when none is given, such as "Chrome auf Android".
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : null;
  const system = /Android/.test(ua) ? "Android" : /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad"
    : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : null;
  if (browser && system) return `${browser} auf ${system}`;
  return browser ?? system ?? "Browser";
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

// Forms post urlencoded, the passkey script posts JSON.
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new WebError(413, "Die Anfrage ist zu gross.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] ?? "").startsWith("application/json")) {
    try {
      const data = JSON.parse(text);
      if (typeof data === "object" && data !== null && !Array.isArray(data)) return data;
    } catch {
      // fall through to the error below
    }
    throw new WebError(400, "Ungültige Anfrage.");
  }
  return Object.fromEntries(new URLSearchParams(text));
}
