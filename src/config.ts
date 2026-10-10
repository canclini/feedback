import { loadApps } from "./apps.ts";
import { Auth } from "./auth.ts";
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

// PUBLIC_URL is where the web UI is reached; its hostname is the passkeys'
// relying party, so it must not change once a passkey is registered.
export function openAuth(store: Store): Auth {
  return new Auth(store.db, { publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8080" });
}
