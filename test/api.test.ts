import assert from "node:assert/strict";
import { test } from "node:test";
import { testServer, testStore } from "./helpers.ts";

const store = testStore();
const base = await testServer(store);
const siteKey = store.createSiteKey("shop", "laptop").key;
const blogKey = store.createSiteKey("blog", "laptop").key;
const agentToken = store.createAgentToken("claude", "write").token;
const readToken = store.createAgentToken("viewer", "read").token;

async function call(method: string, path: string, secret?: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const page = { origin: "https://www.shop.test" };
const newEntry = { url: "https://www.shop.test/cart", comment: "Preis fehlt", selector: "#price" };

test("the widget creates an entry from a registered page and lists it", async () => {
  const created = await call("POST", "/v1/entries", siteKey, newEntry, page);
  assert.equal(created.status, 201);
  assert.equal(created.json.entry.app, "shop");
  assert.equal(created.headers.get("access-control-allow-origin"), "https://www.shop.test");

  const listed = await call("GET", `/v1/entries?url=${encodeURIComponent("https://www.shop.test/cart")}`, siteKey, undefined, page);
  assert.equal(listed.status, 200);
  assert.ok(listed.json.entries.some((e: { id: number }) => e.id === created.json.entry.id));
});

test("an agent works an entry through to done and sees the app's repo", async () => {
  const { json } = await call("POST", "/v1/entries", siteKey, newEntry, page);
  const id = json.entry.id;

  const open = await call("GET", "/v1/entries?status=open&app=shop", agentToken);
  assert.ok(open.json.entries.some((e: { id: number }) => e.id === id));

  const claim = await call("POST", `/v1/entries/${id}/events`, agentToken, { kind: "claim" });
  assert.equal(claim.status, 201);
  assert.equal(claim.json.entry.status, "in_progress");
  assert.equal(claim.json.event.actor, "agent:claude");

  const again = await call("POST", `/v1/entries/${id}/events`, agentToken, { kind: "claim" });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, "conflict");

  await call("POST", `/v1/entries/${id}/events`, agentToken, { kind: "resolve", body: "Preis ergänzt.", link: "feedback/1" });
  const detail = await call("GET", `/v1/entries/${id}`, agentToken);
  assert.equal(detail.json.entry.status, "done");
  assert.equal(detail.json.app.repo, "example/shop");
  assert.deepEqual(detail.json.events.map((e: { kind: string }) => e.kind), ["created", "claim", "resolve"]);

  const apps = await call("GET", "/v1/apps", agentToken);
  assert.deepEqual(apps.json.apps.map((a: { id: string }) => a.id), ["blog", "shop"]);
});

test("the owner answers a question from the page", async () => {
  const { json } = await call("POST", "/v1/entries", siteKey, newEntry, page);
  const id = json.entry.id;
  await call("POST", `/v1/entries/${id}/events`, agentToken, { kind: "question", body: "Welcher Preis?" });
  const answer = await call("POST", `/v1/entries/${id}/events`, siteKey, { kind: "answer", body: "Der Gesamtpreis" }, page);
  assert.equal(answer.status, 201);
  assert.equal(answer.json.entry.status, "new");
});

test("requests without a valid secret are refused", async () => {
  assert.equal((await call("GET", "/v1/entries")).status, 401);
  assert.equal((await call("GET", "/v1/entries", "fba_unknown")).status, 401);
  assert.equal((await call("GET", "/v1/entries", agentToken, undefined, { authorization: `Basic ${agentToken}` })).status, 401);
});

test("a site key works only from its own site and only for its own app", async () => {
  const foreign = await call("POST", "/v1/entries", siteKey, newEntry, { origin: "https://blog.test" });
  assert.equal(foreign.status, 403);
  const other = await call("GET", "/v1/entries?app=shop", blogKey);
  assert.equal(other.status, 403);
  const apps = await call("GET", "/v1/apps", siteKey);
  assert.equal(apps.status, 403);
  const claim = await call("POST", "/v1/entries/1/events", siteKey, { kind: "claim" });
  assert.equal(claim.status, 403);
});

test("agent tokens are refused from browsers and read tokens cannot write", async () => {
  assert.equal((await call("GET", "/v1/entries", agentToken, undefined, page)).status, 403);
  assert.equal((await call("POST", "/v1/entries/1/events", readToken, { kind: "claim" })).status, 403);
  assert.equal((await call("GET", "/v1/entries", readToken)).status, 200);
});

test("CORS preflight is answered only for registered origins", async () => {
  const allowed = await call("OPTIONS", "/v1/entries", undefined, undefined, {
    ...page,
    "access-control-request-method": "POST",
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://www.shop.test");
  assert.match(allowed.headers.get("access-control-allow-headers") ?? "", /authorization/);

  const denied = await call("OPTIONS", "/v1/entries", undefined, undefined, { origin: "https://evil.test" });
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("malformed requests get a 400 with a reason", async () => {
  const notJson = await call("POST", "/v1/entries", siteKey, "{", page);
  assert.equal(notJson.status, 400);
  assert.equal(notJson.json.error, "invalid");
  assert.equal((await call("POST", "/v1/entries", siteKey, [1], page)).status, 400);
  assert.equal((await call("GET", "/v1/entries?status=wip", agentToken)).status, 400);
  assert.equal((await call("GET", "/v1/entries?limit=0", agentToken)).status, 400);
  assert.equal((await call("POST", "/v1/entries/1/events", agentToken, { kind: "merge" })).status, 400);
  assert.equal((await call("GET", "/v1/entries/999999", agentToken)).status, 404);
  assert.equal((await call("DELETE", "/v1/entries/1", agentToken)).status, 404);
});

test("a body over 64 KB is refused", async () => {
  const res = await call("POST", "/v1/entries", siteKey, { ...newEntry, comment: "x".repeat(70_000) }, page);
  assert.equal(res.status, 413);
});
