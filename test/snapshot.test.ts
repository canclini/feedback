import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { writeSnapshot } from "../src/snapshot.ts";
import { testStore } from "./helpers.ts";

const dir = mkdtempSync(join(tmpdir(), "feedback-snapshot-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("a snapshot replaces the previous one and leaves no temporary file", async () => {
  const store = testStore();
  const owner = store.authenticate(store.createSiteKey("shop", "t").key)!;
  const target = join(dir, "snapshot.db");
  store.createEntry(owner, { url: "https://www.shop.test/", comment: "eins" });
  await writeSnapshot(store.db, target);
  store.createEntry(owner, { url: "https://www.shop.test/", comment: "zwei" });
  await writeSnapshot(store.db, target);

  const copy = new DatabaseSync(target, { readOnly: true });
  const { count } = copy.prepare("SELECT COUNT(*) AS count FROM entries").get() as { count: number };
  const { user_version } = copy.prepare("PRAGMA user_version").get() as { user_version: number };
  copy.close();
  assert.equal(count, 2);
  assert.equal(user_version, 2);
  assert.equal(existsSync(`${target}.tmp`), false);
});
