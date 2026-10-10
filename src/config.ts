import { loadApps } from "./apps.ts";
import { openDatabase } from "./db.ts";
import { Store } from "./store.ts";

// Opens the database and brings the app registry up to date. Shared by the
// server and the CLI, so a site key can be created before the first start.
export function openStore(): Store {
  const databasePath = process.env.DATABASE_PATH ?? "feedback.db";
  const appsPath = process.env.APPS_PATH ?? new URL("../apps.json", import.meta.url);
  const store = new Store(openDatabase(databasePath));
  store.syncApps(loadApps(appsPath));
  return store;
}
