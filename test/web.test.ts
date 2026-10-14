import assert from "node:assert/strict";
import { test } from "node:test";
import { Auth } from "../src/auth.ts";
import { deviceName } from "../src/web.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { TEST_PUBLIC_URL, testServer, testStore } from "./helpers.ts";

// Each test file gets one service; the tests below run in order and build on
// each other: setup, sign-in, then the pages.
const store = testStore();
const auth = new Auth(store.db, { publicUrl: TEST_PUBLIC_URL });
const base = await testServer(store, auth);
const setupCode = auth.issueSetupCode()!;
const owner = store.authenticate(store.createSiteKey("shop", "test").key)!;

class Browser {
  cookie = ""; // the session
  others = new Map<string, string>();
  async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const json = body !== undefined && !(body instanceof URLSearchParams);
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: "manual",
      headers: {
        ...(method === "POST" ? { origin: TEST_PUBLIC_URL } : {}),
        ...(this.cookie || this.others.size
          ? { cookie: [this.cookie, ...[...this.others].map(([name, value]) => `${name}=${value}`)].filter(Boolean).join("; ") }
          : {}),
        ...(json ? { "content-type": "application/json" } : {}),
        ...(body instanceof URLSearchParams ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : json ? JSON.stringify(body) : String(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const [pair] = setCookie.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      if (name === "__Host-session") this.cookie = pair.endsWith("=") ? "" : pair;
      else this.others.set(name, pair.slice(name.length + 1));
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  }
  get(path: string) {
    return this.request("GET", path);
  }
  post(path: string, body?: unknown, extra?: Record<string, string>) {
    return this.request("POST", path, body, extra);
  }
  form(path: string, fields: Record<string, string>) {
    return this.request("POST", path, new URLSearchParams(fields));
  }
  async register(authenticator: SoftAuthenticator, start: string, body: unknown = {}) {
    const { ceremony, options } = (await this.post(start, body)).json();
    return this.post("/auth/register/verify", { ceremony, response: authenticator.create(options), name: "Laptop" });
  }
  async signIn(authenticator: SoftAuthenticator) {
    const { ceremony, options } = (await this.post("/auth/login/options", {})).json();
    return this.post("/auth/login/verify", { ceremony, response: authenticator.get(options) });
  }
}

const passkey = new SoftAuthenticator(TEST_PUBLIC_URL);
const marcel = new Browser();

test("before setup the start page asks for the setup code", async () => {
  const page = await new Browser().get("/");
  assert.match(page.text, /<h1>Einrichten<\/h1>/);
  assert.match(page.text, /data-passkey="setup"/);
});

test("a wrong setup code is refused", async () => {
  const res = await new Browser().post("/auth/setup/options", { code: "AAAAA-AAAAA-AAAAA-AAAAA" });
  assert.equal(res.status, 403);
  assert.equal(res.json().message, "Der Einrichtungscode stimmt nicht.");
});

test("the setup code registers the first passkey and signs in", async () => {
  const res = await marcel.register(passkey, "/auth/setup/options", { code: setupCode.toLowerCase() });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /^__Host-session=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  const page = await marcel.get("/");
  assert.match(page.text, /<h1>Übersicht<\/h1>/);
  assert.equal(auth.listCredentials().length, 1);
});

test("after setup the code is spent and the start page signs in", async () => {
  assert.equal((await new Browser().post("/auth/setup/options", { code: setupCode })).status, 403);
  assert.match((await new Browser().get("/")).text, /Mit Passkey anmelden/);
});

test("signing out ends the session and the passkey signs in again", async () => {
  await marcel.form("/logout", {});
  assert.equal(marcel.cookie, "");
  const browser = new Browser();
  assert.equal((await browser.signIn(passkey)).status, 200);
  assert.match((await browser.get("/")).text, /<h1>Übersicht<\/h1>/);
  assert.ok(auth.listCredentials()[0].last_used_at);
  marcel.cookie = browser.cookie;
});

test("an unknown passkey, a forged signature and a replayed ceremony are refused", async () => {
  const stranger = new SoftAuthenticator(TEST_PUBLIC_URL);
  const unknown = await new Browser().signIn(stranger);
  assert.equal(unknown.status, 400);

  const browser = new Browser();
  const { ceremony, options } = (await browser.post("/auth/login/options", {})).json();
  const forged = passkey.get(options);
  forged.response.signature = stranger.get(options).response.signature;
  assert.equal((await browser.post("/auth/login/verify", { ceremony, response: forged })).status, 400);
  const replay = await browser.post("/auth/login/verify", { ceremony, response: passkey.get(options) });
  assert.equal(replay.status, 400);
  assert.match(replay.json().message, /abgelaufen/);
  assert.equal(browser.cookie, "");
});

test("a passkey for another origin is refused", async () => {
  const phished = new SoftAuthenticator("https://evil.test");
  phished.id = passkey.id;
  phished.privateKey = passkey.privateKey;
  const res = await new Browser().signIn(phished);
  assert.equal(res.status, 400);
});

test("pages and form posts need a session, form posts their own origin", async () => {
  const stranger = new Browser();
  const page = await stranger.get("/access");
  assert.equal(page.status, 303);
  assert.equal(page.headers.get("location"), "/");
  assert.equal((await stranger.form("/access/agent-tokens", { name: "x", scope: "read" })).status, 401);
  assert.equal((await stranger.post("/auth/register/options", {})).status, 401);
  const crossSite = await marcel.post("/access/agent-tokens", new URLSearchParams({ name: "x", scope: "read" }), {
    origin: "https://evil.test",
  });
  assert.equal(crossSite.status, 403);
});

test("a second passkey is added from the session, and only the last one cannot be removed", async () => {
  const phone = new SoftAuthenticator(TEST_PUBLIC_URL);
  assert.equal((await marcel.register(phone, "/auth/register/options")).status, 200);
  assert.equal(auth.listCredentials().length, 2);
  // The ceremony was started signed in; finishing it signed out is refused.
  const { ceremony, options } = (await marcel.post("/auth/register/options", {})).json();
  const anonymous = await new Browser().post("/auth/register/verify", {
    ceremony,
    response: new SoftAuthenticator(TEST_PUBLIC_URL).create(options),
  });
  assert.equal(anonymous.status, 400);

  await marcel.form(`/access/passkeys/${phone.credentialId}/delete`, {});
  assert.equal(auth.listCredentials().length, 1);
  const last = await marcel.form(`/access/passkeys/${passkey.credentialId}/delete`, {});
  assert.equal(last.status, 400);
  assert.match(last.text, /letzte Passkey/);
});

test("activating a site redirects there with the key in the fragment", async () => {
  const res = await marcel.form("/access/site-keys", { app: "shop", label: "MacBook" });
  assert.equal(res.status, 303);
  const location = res.headers.get("location")!;
  assert.match(location, /^https:\/\/www\.shop\.test\/#feedback-key=fbs_[\w-]{43}$/);
  const key = location.split("=")[1];
  assert.deepEqual(store.authenticate(key), { type: "owner", actor: "marcel", appId: "shop" });
  const access = await marcel.get("/access");
  assert.match(access.text, /<td>Shop<\/td>\s*<td>MacBook <span class="status status-here">dieser Browser<\/span><\/td>/);
  assert.doesNotMatch(access.text, new RegExp(key));
});

test("the access page tells this browser's activations from the other devices'", async () => {
  const phone = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
  const res = await marcel.post("/access/site-keys", new URLSearchParams({ app: "shop", label: "" }), { "user-agent": phone });
  assert.match(res.headers.get("set-cookie") ?? "",
    /^__Host-site-keys-here=\d+\.\d+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=34560000$/);
  const mine = (await marcel.get("/access")).text;
  assert.match(mine, /nur in diesem Browser auf diesem Gerät/);
  assert.match(mine, /<td>Chrome auf Android <span class="status status-here">dieser Browser<\/span><\/td>/);

  const laptop = new Browser();
  assert.equal((await laptop.signIn(passkey)).status, 200);
  const theirs = (await laptop.get("/access")).text;
  assert.match(theirs, /<td>Chrome auf Android<\/td>/);
  assert.doesNotMatch(theirs, /dieser Browser/);
  laptop.others.set("__Host-site-keys-here", "x.<b>.99999999999");
  assert.doesNotMatch((await laptop.get("/access")).text, /dieser Browser/);
});

test("a device without a name is named after its browser and system", () => {
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), "Safari auf iPhone");
  assert.equal(deviceName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), "Chrome auf Linux");
  assert.equal(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"), "Edge auf Windows");
  assert.equal(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 15.0; rv:143.0) Gecko/20100101 Firefox/143.0"), "Firefox auf Mac");
  assert.equal(deviceName(undefined), "Browser");
});

test("an agent token is shown once and can be revoked", async () => {
  const created = await marcel.form("/access/agent-tokens", { name: "claude-code", scope: "write" });
  const token = /<code>(fba_[\w-]{43})<\/code>/.exec(created.text)?.[1];
  assert.ok(token);
  assert.match(created.text, /http:\/\/localhost:8080\/mcp/);
  assert.equal(store.authenticate(token)?.type, "agent");
  assert.doesNotMatch((await marcel.get("/access")).text, new RegExp(token));

  const id = store.listAgentTokens().find((t) => t.name === "claude-code")!.id;
  await marcel.form(`/access/agent-tokens/${id}/revoke`, {});
  assert.equal(store.authenticate(token), null);
  const invalid = await marcel.form("/access/agent-tokens", { name: "Claude Code", scope: "write" });
  assert.equal(invalid.status, 400);
});

test("a question waits on the overview and is answered from the entry page", async () => {
  const agent = { type: "agent", actor: "agent:claude", scope: "write" } as const;
  const { id } = store.createEntry(owner, { url: "https://www.shop.test/cart", comment: "Preis fehlt" });
  store.addEvent(agent, id, { kind: "question", body: "Welcher Preis?" });

  const overview = await marcel.get("/");
  assert.match(overview.text, /Wartet auf dich/);
  assert.match(overview.text, new RegExp(`href="/entries/${id}">#${id}</a>`));

  const page = await marcel.get(`/entries/${id}`);
  assert.match(page.text, /Rückfrage<\/span>/);
  assert.match(page.text, /Agent claude/);
  assert.match(page.text, /name="kind" value="answer"/);

  const answer = await marcel.form(`/entries/${id}/events`, { kind: "answer", body: "Der Gesamtpreis" });
  assert.equal(answer.status, 303);
  assert.equal(store.getEntry(owner, id).entry.status, "new");

  store.addEvent(agent, id, { kind: "resolve", body: "Erledigt.", link: "https://github.com/example/shop/pull/1" });
  const done = await marcel.get(`/entries/${id}`);
  assert.match(done.text, /href="https:\/\/github.com\/example\/shop\/pull\/1"/);
  await marcel.form(`/entries/${id}/events`, { kind: "reopen", body: "" });
  assert.equal(store.getEntry(owner, id).entry.status, "new");
  const claim = await marcel.form(`/entries/${id}/events`, { kind: "claim" });
  assert.equal(claim.status, 403);
});

test("an open entry takes an addition from the entry page and stays where it is", async () => {
  const agent = { type: "agent", actor: "agent:claude", scope: "write" } as const;
  const { id } = store.createEntry(owner, { url: "https://www.shop.test/", comment: "Titel kürzen" });
  for (const status of ["new", "in_progress"]) {
    if (status === "in_progress") store.addEvent(agent, id, { kind: "claim" });
    const page = await marcel.get(`/entries/${id}`);
    assert.match(page.text, /name="kind" value="note"/);
    const added = await marcel.form(`/entries/${id}/events`, { kind: "note", body: `Auch den Untertitel (${status})` });
    assert.equal(added.status, 303);
    const { entry, events } = store.getEntry(owner, id);
    assert.equal(entry.status, status);
    assert.deepEqual([events.at(-1)!.kind, events.at(-1)!.actor], ["note", "marcel"]);
  }
});

test("the app page lists open entries, or all of them", async () => {
  const { id } = store.createEntry(owner, { url: "https://www.shop.test/", comment: "Logo zu klein" });
  store.addEvent(owner, id, { kind: "dismiss", body: "Doch gut so." });
  assert.doesNotMatch((await marcel.get("/apps/shop")).text, /Logo zu klein/);
  assert.match((await marcel.get("/apps/shop?status=all")).text, /Logo zu klein/);
  assert.equal((await marcel.get("/apps/nope")).status, 404);
});

test("user content is escaped and pages carry a strict policy", async () => {
  const { id } = store.createEntry(owner, {
    url: "https://www.shop.test/",
    comment: '<script>alert("x")</script>',
    element_html: "<img src=x onerror=alert(1)>",
  });
  const page = await marcel.get(`/entries/${id}`);
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.match(page.text, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(page.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'; script-src 'self'/);
  assert.match(csp, /form-action 'self' https:\/\/blog\.test https:\/\/www\.shop\.test/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
});

test("the page assets are served", async () => {
  const css = await fetch(`${base}/ui/style.css`);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  const js = await fetch(`${base}/ui/passkey.js`);
  assert.match(await js.text(), /parseCreationOptionsFromJSON/);
  assert.equal((await fetch(`${base}/ui/icon.svg`)).headers.get("content-type"), "image/svg+xml");
});
