import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { Auth } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { createServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

export const TEST_APPS = [
  {
    id: "shop",
    name: "Shop",
    origins: ["https://www.shop.test"],
    repo: "example/shop",
    branch: "main",
    local_path: "~/Projects/shop",
  },
  {
    id: "blog",
    name: "Blog",
    origins: ["https://blog.test"],
    repo: "example/blog",
    branch: "master",
    local_path: null,
  },
];

// A store on a fresh database file in a temporary directory, removed after
// the test file has run. Call it (and testServer) at the top level of a test
// file or inside a test, not in a before hook: the cleanup is registered with
// whichever of those is running.
export function testStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "feedback-test-"));
  const db = openDatabase(join(dir, "feedback.db"));
  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(db);
  store.syncApps(TEST_APPS);
  return store;
}

export const TEST_PUBLIC_URL = "http://localhost:8080";

export async function testServer(store: Store, auth = new Auth(store.db, { publicUrl: TEST_PUBLIC_URL })): Promise<string> {
  const server = createServer({ commit: "abc1234", store, auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => {
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
