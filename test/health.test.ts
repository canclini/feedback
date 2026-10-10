import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createServer } from "../src/server.ts";

const server = createServer({ commit: "abc1234" });
let base = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

test("health reports ok and the commit", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", commit: "abc1234" });
});

test("unknown paths return 404", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
