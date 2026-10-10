import assert from "node:assert/strict";
import { test } from "node:test";
import { openDatabase } from "../src/db.ts";
import { type Principal, Store, StoreError } from "../src/store.ts";
import { TEST_APPS, testStore } from "./helpers.ts";

const agent: Principal = { type: "agent", actor: "agent:claude", scope: "write" };
const reader: Principal = { type: "agent", actor: "agent:viewer", scope: "read" };
const shopOwner: Principal = { type: "owner", actor: "marcel", appId: "shop" };
const blogOwner: Principal = { type: "owner", actor: "marcel", appId: "blog" };

function newEntry(store: Store) {
  return store.createEntry(shopOwner, {
    url: "https://www.shop.test/cart?x=1",
    comment: "  Der Knopf ist zu klein  ",
    selector: "main > button.buy",
    element_html: "<button>" + "x".repeat(10_000) + "</button>",
    version: "abc1234",
  });
}

function rejects(work: () => unknown, code: string) {
  assert.throws(work, (error: unknown) => error instanceof StoreError && error.code === code);
}

test("migrations run once and leave the schema version set", () => {
  const store = testStore();
  const { user_version } = store.db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(user_version, 1);
  const { journal_mode } = store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(journal_mode, "wal");
});

test("migrating an up-to-date database again changes nothing", () => {
  const store = testStore();
  const path = (store.db.prepare("PRAGMA database_list").get() as { file: string }).file;
  newEntry(store);
  const again = new Store(openDatabase(path));
  assert.equal(again.listEntries(agent).length, 1);
  again.db.close();
});

test("an entry gets the site key's app, a trimmed comment and capped context", () => {
  const store = testStore();
  const entry = newEntry(store);
  assert.equal(entry.app, "shop");
  assert.equal(entry.status, "new");
  assert.equal(entry.comment, "Der Knopf ist zu klein");
  assert.equal(entry.element_html?.length, 4096);
  assert.equal(entry.viewport, null);
  const { events } = store.getEntry(agent, entry.id);
  assert.deepEqual(events.map((e) => [e.kind, e.actor, e.status]), [["created", "marcel", "new"]]);
});

test("an entry is refused for a page outside the app's origins or without a comment", () => {
  const store = testStore();
  rejects(() => store.createEntry(shopOwner, { url: "https://blog.test/", comment: "x" }), "invalid");
  rejects(() => store.createEntry(shopOwner, { url: "javascript:alert(1)", comment: "x" }), "invalid");
  rejects(() => store.createEntry(shopOwner, { url: "https://www.shop.test/", comment: " " }), "invalid");
  rejects(() => store.createEntry(shopOwner, { app: "blog", url: "https://blog.test/", comment: "x" }), "forbidden");
  rejects(() => store.createEntry(agent, { url: "https://www.shop.test/", comment: "x" }), "invalid");
  rejects(() => store.createEntry(reader, { app: "shop", url: "https://www.shop.test/", comment: "x" }), "forbidden");
  assert.equal(store.createEntry(agent, { app: "shop", url: "https://www.shop.test/", comment: "x" }).app, "shop");
});

test("an agent claims, asks, gets an answer and resolves", () => {
  const store = testStore();
  const { id } = newEntry(store);
  assert.equal(store.addEvent(agent, id, { kind: "claim" }).entry.status, "in_progress");
  assert.equal(store.addEvent(agent, id, { kind: "question", body: "Welcher Knopf?" }).entry.status, "question");
  assert.equal(store.addEvent(shopOwner, id, { kind: "answer", body: "Kaufen" }).entry.status, "new");
  store.addEvent(agent, id, { kind: "claim" });
  const { entry, event } = store.addEvent(agent, id, {
    kind: "resolve",
    body: "Der Knopf ist jetzt grösser.",
    link: "https://github.com/example/shop/pull/7",
  });
  assert.equal(entry.status, "done");
  assert.equal(event.link, "https://github.com/example/shop/pull/7");
  const kinds = store.getEntry(agent, id).events.map((e) => e.kind);
  assert.deepEqual(kinds, ["created", "claim", "question", "answer", "claim", "resolve"]);
});

test("transitions that do not fit the status are conflicts", () => {
  const store = testStore();
  const { id } = newEntry(store);
  store.addEvent(agent, id, { kind: "claim" });
  rejects(() => store.addEvent(agent, id, { kind: "claim" }), "conflict");
  rejects(() => store.addEvent(shopOwner, id, { kind: "answer", body: "x" }), "conflict");
  rejects(() => store.addEvent(shopOwner, id, { kind: "reopen" }), "conflict");
  store.addEvent(agent, id, { kind: "resolve", body: "Erledigt." });
  rejects(() => store.addEvent(agent, id, { kind: "resolve", body: "Nochmals." }), "conflict");
  assert.equal(store.addEvent(shopOwner, id, { kind: "reopen", body: "Noch nicht gut." }).entry.status, "new");
  assert.equal(store.addEvent(agent, id, { kind: "note", body: "Schaue ich an." }).entry.status, "new");
});

test("each side may only do its own transitions, and some need a body", () => {
  const store = testStore();
  const { id } = newEntry(store);
  rejects(() => store.addEvent(shopOwner, id, { kind: "claim" }), "forbidden");
  rejects(() => store.addEvent(reader, id, { kind: "claim" }), "forbidden");
  rejects(() => store.addEvent(agent, id, { kind: "question" }), "invalid");
  rejects(() => store.addEvent(agent, id, { kind: "resolve", body: " " }), "invalid");
  rejects(() => store.addEvent(agent, id, { kind: "toString" }), "invalid");
  assert.equal(store.addEvent(shopOwner, id, { kind: "dismiss", body: "Doch kein Problem." }).entry.status, "dismissed");
});

test("a site key sees only its own app's entries", () => {
  const store = testStore();
  const { id } = newEntry(store);
  store.createEntry(blogOwner, { url: "https://blog.test/post", comment: "Tippfehler" });
  assert.deepEqual(store.listEntries(blogOwner).map((e) => e.app), ["blog"]);
  assert.equal(store.listEntries(agent).length, 2);
  rejects(() => store.getEntry(blogOwner, id), "not_found");
  rejects(() => store.addEvent(blogOwner, id, { kind: "note", body: "x" }), "not_found");
  rejects(() => store.listEntries(blogOwner, { app: "shop" }), "forbidden");
});

test("entries filter by app, status and url, newest first", () => {
  const store = testStore();
  const first = newEntry(store);
  const second = newEntry(store);
  store.createEntry(blogOwner, { url: "https://blog.test/post", comment: "Tippfehler" });
  store.addEvent(agent, first.id, { kind: "resolve", body: "Erledigt." });
  assert.deepEqual(store.listEntries(agent, { app: "shop" }).map((e) => e.id), [second.id, first.id]);
  assert.deepEqual(store.listEntries(agent, { app: "shop", statuses: ["new"] }).map((e) => e.id), [second.id]);
  assert.equal(store.listEntries(agent, { url: "https://blog.test/post" }).length, 1);
  assert.equal(store.listEntries(agent, { limit: 1 }).length, 1);
});

test("secrets authenticate until they are revoked and are stored only as hashes", () => {
  const store = testStore();
  const { id: keyId, key } = store.createSiteKey("shop", "laptop");
  const { id: tokenId, token } = store.createAgentToken("claude", "read");
  assert.match(key, /^fbs_[\w-]{43}$/);
  assert.match(token, /^fba_[\w-]{43}$/);
  assert.deepEqual(store.authenticate(key), { type: "owner", actor: "marcel", appId: "shop" });
  assert.deepEqual(store.authenticate(token), { type: "agent", actor: "agent:claude", scope: "read" });
  assert.equal(store.authenticate("fbs_wrong"), null);
  assert.equal(store.authenticate(key.replace("fbs_", "fba_")), null);

  const dump = JSON.stringify([
    store.db.prepare("SELECT * FROM site_keys").all(),
    store.db.prepare("SELECT * FROM agent_tokens").all(),
  ]);
  assert.ok(!dump.includes(key) && !dump.includes(token));

  assert.equal(store.revokeSiteKey(keyId), true);
  assert.equal(store.revokeSiteKey(keyId), false);
  assert.equal(store.revokeAgentToken(tokenId), true);
  assert.equal(store.authenticate(key), null);
  assert.equal(store.authenticate(token), null);
  rejects(() => store.createSiteKey("nope", "x"), "invalid");
  rejects(() => store.createAgentToken("Claude Code", "write"), "invalid");
});

test("syncing apps updates them and keeps apps that left the file", () => {
  const store = testStore();
  store.syncApps([{ ...TEST_APPS[0], branch: "release" }]);
  assert.equal(store.getApp("shop")?.branch, "release");
  assert.ok(store.getApp("blog"));
});

