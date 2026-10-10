import assert from "node:assert/strict";
import { test } from "node:test";
import { testServer, testStore } from "./helpers.ts";

const base = await testServer(testStore());

test("health reports ok and the commit", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", commit: "abc1234" });
});

test("unknown paths return 404", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
