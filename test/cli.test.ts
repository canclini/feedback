import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { testStore } from "./helpers.ts";

function cli(store: ReturnType<typeof testStore>, ...args: string[]) {
  const lines: string[] = [];
  const code = run(store, args, (line) => lines.push(line));
  return { code, lines };
}

test("creates a site key, shows it once, lists and revokes it", () => {
  const store = testStore();
  const created = cli(store, "site-key", "create", "shop", "laptop");
  assert.equal(created.code, 0);
  const key = created.lines[1];
  assert.match(key, /^fbs_/);
  assert.ok(store.authenticate(key));

  const listed = cli(store, "site-key", "list");
  assert.match(listed.lines[0], /^1\tshop\tlaptop\t.*\tactive$/);
  assert.ok(!listed.lines.join("\n").includes(key));

  assert.equal(cli(store, "site-key", "revoke", "1").code, 0);
  assert.equal(cli(store, "site-key", "revoke", "1").code, 1);
  assert.equal(store.authenticate(key), null);
});

test("creates agent tokens with write as the default scope", () => {
  const store = testStore();
  const token = cli(store, "agent-token", "create", "claude").lines[1];
  assert.deepEqual(store.authenticate(token), { type: "agent", actor: "agent:claude", scope: "write" });
  const reader = cli(store, "agent-token", "create", "desk", "read").lines[1];
  assert.deepEqual(store.authenticate(reader), { type: "agent", actor: "agent:desk", scope: "read" });
  assert.equal(cli(store, "agent-token", "create", "desk", "admin").code, 1);
  assert.match(cli(store, "agent-token", "list").lines[1], /^2\tdesk\tread\t/);
});

test("lists apps and explains usage on unknown commands", () => {
  const store = testStore();
  assert.match(cli(store, "apps").lines[0], /^blog\texample\/blog@master\thttps:\/\/blog\.test$/);
  assert.equal(cli(store, "site-key", "create", "nope", "x").code, 1);
  const usage = cli(store, "frobnicate");
  assert.equal(usage.code, 2);
  assert.match(usage.lines[0], /^usage:/);
});
