import { DatabaseSync } from "node:sqlite";

// Each migration runs once, in order; PRAGMA user_version records how many
// have run. Append new migrations, never edit one that has shipped.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    origins TEXT NOT NULL,      -- JSON array of page origins
    repo TEXT NOT NULL,         -- owner/name on GitHub
    branch TEXT NOT NULL,       -- the branch the app deploys from
    local_path TEXT             -- hint for agents, e.g. ~/Projects/akkordo
  ) STRICT;

  CREATE TABLE entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL REFERENCES apps(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    url TEXT NOT NULL,
    version TEXT,
    selector TEXT,
    element_text TEXT,
    element_html TEXT,
    viewport TEXT,
    user_agent TEXT,
    comment TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('new', 'in_progress', 'question', 'done', 'dismissed'))
  ) STRICT;
  CREATE INDEX entries_app_status ON entries (app_id, status);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES entries(id),
    created_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT,                -- the status the event moved the entry to, if any
    body TEXT,
    link TEXT
  ) STRICT;
  CREATE INDEX events_entry ON events (entry_id);

  CREATE TABLE site_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL REFERENCES apps(id),
    label TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;

  CREATE TABLE agent_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;
  `,
  `
  CREATE TABLE credentials (
    id TEXT PRIMARY KEY,        -- WebAuthn credential id, base64url
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT,            -- JSON array, as the browser reported it
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  ) STRICT;

  CREATE TABLE sessions (
    hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  `,
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let version = user_version; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
