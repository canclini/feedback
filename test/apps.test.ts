import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadApps } from "../src/apps.ts";

const dir = mkdtempSync(join(tmpdir(), "feedback-apps-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function load(apps: unknown) {
  const path = join(dir, "apps.json");
  writeFileSync(path, JSON.stringify({ apps }));
  return loadApps(path);
}

const valid = { id: "shop", name: "Shop", origins: ["https://www.shop.test"], repo: "example/shop", branch: "main" };

test("the repo's apps.json is valid", () => {
  const apps = loadApps(new URL("../apps.json", import.meta.url));
  assert.ok(apps.length > 0);
});

test("a valid app loads with local_path defaulting to null", () => {
  assert.deepEqual(load([valid]), [{ ...valid, local_path: null }]);
});

test("invalid apps are refused with the offending field", () => {
  assert.throws(() => load([{ ...valid, id: "Shop" }]), /id must be/);
  assert.throws(() => load([valid, valid]), /duplicate id/);
  assert.throws(() => load([{ ...valid, origins: ["https://www.shop.test/"] }]), /origins/);
  assert.throws(() => load([{ ...valid, origins: [] }]), /origins/);
  assert.throws(() => load([{ ...valid, repo: "shop" }]), /repo must be/);
  assert.throws(() => load([{ ...valid, branch: "" }]), /branch/);
});
