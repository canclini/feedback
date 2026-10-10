import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { run } from "../src/cli.ts";
import { testStore } from "./helpers.ts";

async function cli(store: ReturnType<typeof testStore>, ...args: string[]) {
  const lines: string[] = [];
  const code = await run(store, args, (line) => lines.push(line));
  return { code, lines };
}

test("creates a site key, shows it once, lists and revokes it", async () => {
  const store = testStore();
  const created = await cli(store, "site-key", "create", "shop", "laptop");
  assert.equal(created.code, 0);
  const key = created.lines[1];
  assert.match(key, /^fbs_/);
  assert.ok(store.authenticate(key));

  const listed = await cli(store, "site-key", "list");
  assert.match(listed.lines[0], /^1\tshop\tlaptop\t.*\tactive$/);
  assert.ok(!listed.lines.join("\n").includes(key));

  assert.equal((await cli(store, "site-key", "revoke", "1")).code, 0);
  assert.equal((await cli(store, "site-key", "revoke", "1")).code, 1);
  assert.equal(store.authenticate(key), null);
});

test("creates agent tokens with write as the default scope", async () => {
  const store = testStore();
  const token = (await cli(store, "agent-token", "create", "claude")).lines[1];
  assert.deepEqual(store.authenticate(token), { type: "agent", actor: "agent:claude", scope: "write" });
  const reader = (await cli(store, "agent-token", "create", "desk", "read")).lines[1];
  assert.deepEqual(store.authenticate(reader), { type: "agent", actor: "agent:desk", scope: "read" });
  assert.equal((await cli(store, "agent-token", "create", "desk", "admin")).code, 1);
  assert.match((await cli(store, "agent-token", "list")).lines[1], /^2\tdesk\tread\t/);
});

test("lists apps and explains usage on unknown commands", async () => {
  const store = testStore();
  assert.match((await cli(store, "apps")).lines[0], /^blog\texample\/blog@master\thttps:\/\/blog\.test$/);
  assert.equal((await cli(store, "site-key", "create", "nope", "x")).code, 1);
  const usage = await cli(store, "frobnicate");
  assert.equal(usage.code, 2);
  assert.match(usage.lines[0], /^usage:/);
});

test("backup writes a snapshot that opens on its own and holds the entries", async () => {
  const store = testStore();
  const owner = store.authenticate(store.createSiteKey("shop", "t").key)!;
  store.createEntry(owner, { url: "https://www.shop.test/", comment: "Preis fehlt" });
  const dir = mkdtempSync(join(tmpdir(), "feedback-backup-"));
  try {
    const target = join(dir, "snapshot.db");
    const result = await cli(store, "backup", target);
    assert.equal(result.code, 0);
    const copy = new DatabaseSync(target, { readOnly: true });
    assert.deepEqual({ ...copy.prepare("SELECT comment FROM entries").get() }, { comment: "Preis fehlt" });
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
