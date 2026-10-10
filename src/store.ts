import type { DatabaseSync } from "node:sqlite";
import { AGENT_TOKEN_PREFIX, SITE_KEY_PREFIX, generateSecret, hashSecret } from "./tokens.ts";

export const STATUSES = ["new", "in_progress", "question", "done", "dismissed"] as const;
export type Status = (typeof STATUSES)[number];
export const OPEN_STATUSES: Status[] = ["new", "in_progress", "question"];

export interface App {
  id: string;
  name: string;
  origins: string[];
  repo: string;
  branch: string;
  local_path: string | null;
}

export interface Entry {
  id: number;
  app: string;
  created_at: string;
  updated_at: string;
  url: string;
  version: string | null;
  selector: string | null;
  element_text: string | null;
  element_html: string | null;
  viewport: string | null;
  user_agent: string | null;
  comment: string;
  status: Status;
}

export interface Event {
  id: number;
  created_at: string;
  actor: string;
  kind: string;
  status: Status | null;
  body: string | null;
  link: string | null;
}

// Who is acting. The owner is Marcel, on a page through a site key (bound to
// one app) or later through his session on the web UI. Agents act through a
// named token with a read or write scope.
export type Principal =
  | { type: "owner"; actor: "marcel"; appId: string | null }
  | { type: "agent"; actor: string; scope: "read" | "write" };

export type ErrorCode = "invalid" | "not_found" | "conflict" | "forbidden";

export class StoreError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface Transition {
  from: Status[] | "any";
  to: Status | null;
  body: "required" | "optional";
  by: Principal["type"][];
}

// The status machine. An answer hands the entry back to the agents as new,
// with the question and the answer in its events.
export const TRANSITIONS = {
  claim: { from: ["new"], to: "in_progress", body: "optional", by: ["agent"] },
  question: { from: ["new", "in_progress"], to: "question", body: "required", by: ["agent"] },
  answer: { from: ["question"], to: "new", body: "required", by: ["owner"] },
  resolve: { from: ["new", "in_progress"], to: "done", body: "required", by: ["agent"] },
  dismiss: {
    from: ["new", "in_progress", "question"],
    to: "dismissed",
    body: "required",
    by: ["agent", "owner"],
  },
  reopen: { from: ["done", "dismissed"], to: "new", body: "optional", by: ["owner"] },
  note: { from: "any", to: null, body: "required", by: ["agent", "owner"] },
} satisfies Record<string, Transition>;
export type EventKind = keyof typeof TRANSITIONS;

export interface NewEntry {
  app?: string;
  url: string;
  version?: string;
  selector?: string;
  element_text?: string;
  element_html?: string;
  viewport?: string;
  user_agent?: string;
  comment: string;
}

export interface NewEvent {
  kind: string;
  body?: string;
  link?: string;
}

export interface EntryFilter {
  app?: string;
  statuses?: Status[];
  url?: string;
  limit?: number;
}

// Context fields are cut, not refused: a long outerHTML must not lose the
// comment that came with it. The widget trims element_html to 2 KB itself.
const CONTEXT_LIMITS = {
  version: 64,
  selector: 1000,
  element_text: 1000,
  element_html: 4096,
  viewport: 32,
  user_agent: 512,
};
const MAX_COMMENT = 4000;
const MAX_BODY = 4000;
const MAX_LINK = 500;

interface EntryRow extends Omit<Entry, "app"> {
  app_id: string;
}

interface AppRow extends Omit<App, "origins"> {
  origins: string;
}

export class Store {
  db: DatabaseSync;
  now: () => string;

  constructor(db: DatabaseSync, now: () => string = () => new Date().toISOString()) {
    this.db = db;
    this.now = now;
  }

  // Apps come from apps.json and are upserted on start. An app that leaves the
  // file stays in the database, because its entries still point at it.
  syncApps(apps: App[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO apps (id, name, origins, repo, branch, local_path)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET name = excluded.name, origins = excluded.origins,
        repo = excluded.repo, branch = excluded.branch, local_path = excluded.local_path
    `);
    this.transaction(() => {
      for (const app of apps) {
        upsert.run(app.id, app.name, JSON.stringify(app.origins), app.repo, app.branch, app.local_path);
      }
    });
  }

  listApps(): App[] {
    const rows = this.db.prepare("SELECT * FROM apps ORDER BY id").all() as unknown as AppRow[];
    return rows.map(toApp);
  }

  getApp(id: string): App | null {
    const row = this.db.prepare("SELECT * FROM apps WHERE id = ?").get(id) as unknown as AppRow | undefined;
    return row ? toApp(row) : null;
  }

  // Every page origin of every app; the CORS preflight is answered against it.
  allOrigins(): Set<string> {
    return new Set(this.listApps().flatMap((app) => app.origins));
  }

  // Number of entries per app and status, for the overview.
  countEntries(): { app_id: string; status: Status; count: number }[] {
    return this.db
      .prepare("SELECT app_id, status, COUNT(*) AS count FROM entries GROUP BY app_id, status")
      .all() as never;
  }

  createEntry(principal: Principal, input: NewEntry): Entry {
    requireWrite(principal);
    const appId = principal.type === "owner" && principal.appId ? principal.appId : input.app;
    if (typeof appId !== "string" || appId === "") throw new StoreError("invalid", "app is required");
    if (principal.type === "owner" && principal.appId && input.app && input.app !== principal.appId) {
      throw new StoreError("forbidden", "this key belongs to another app");
    }
    const app = this.getApp(appId);
    if (!app) throw new StoreError("invalid", `unknown app ${appId}`);

    const url = parseUrl(input.url);
    if (!url || !app.origins.includes(url.origin)) {
      throw new StoreError("invalid", `url must be a page of ${app.id} (${app.origins.join(", ")})`);
    }
    const comment = typeof input.comment === "string" ? input.comment.trim() : "";
    if (comment === "") throw new StoreError("invalid", "comment is required");
    if (comment.length > MAX_COMMENT) {
      throw new StoreError("invalid", `comment is longer than ${MAX_COMMENT} characters`);
    }

    const now = this.now();
    const context = Object.fromEntries(
      Object.entries(CONTEXT_LIMITS).map(([field, limit]) => [
        field,
        cut(input[field as keyof typeof CONTEXT_LIMITS], limit),
      ]),
    ) as Record<keyof typeof CONTEXT_LIMITS, string | null>;

    return this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(`
          INSERT INTO entries (app_id, created_at, updated_at, url, version, selector, element_text,
            element_html, viewport, user_agent, comment, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
        `)
        .run(
          app.id, now, now, url.href, context.version, context.selector, context.element_text,
          context.element_html, context.viewport, context.user_agent, comment,
        );
      const id = Number(lastInsertRowid);
      this.insertEvent(id, now, principal.actor, "created", "new", null, null);
      return this.requireEntry(id);
    });
  }

  listEntries(principal: Principal, filter: EntryFilter = {}): Entry[] {
    const app = scopedApp(principal, filter.app);
    const where: string[] = [];
    const params: string[] = [];
    if (app) {
      where.push("app_id = ?");
      params.push(app);
    }
    if (filter.statuses && filter.statuses.length > 0) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      params.push(...filter.statuses);
    }
    if (filter.url) {
      where.push("url = ?");
      params.push(filter.url);
    }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(`
        SELECT * FROM entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY id DESC LIMIT ${limit}
      `)
      .all(...params) as unknown as EntryRow[];
    return rows.map(toEntry);
  }

  // The newest event of each entry, so a list can show the latest note or
  // question without a request per entry.
  lastEvents(ids: number[]): Map<number, Event> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .prepare(`
        SELECT entry_id, id, created_at, actor, kind, status, body, link FROM events
        WHERE id IN (SELECT MAX(id) FROM events WHERE entry_id IN (${ids.map(() => "?").join(", ")}) GROUP BY entry_id)
      `)
      .all(...ids) as unknown as (Event & { entry_id: number })[];
    return new Map(rows.map(({ entry_id, ...event }) => [entry_id, event]));
  }

  getEntry(principal: Principal, id: number): { entry: Entry; events: Event[]; app: App } {
    const entry = this.visibleEntry(principal, id);
    const events = this.db
      .prepare("SELECT id, created_at, actor, kind, status, body, link FROM events WHERE entry_id = ? ORDER BY id")
      .all(id) as unknown as Event[];
    return { entry, events, app: this.getApp(entry.app)! };
  }

  addEvent(principal: Principal, id: number, input: NewEvent): { entry: Entry; event: Event } {
    requireWrite(principal);
    const kind = input.kind as EventKind;
    if (!Object.hasOwn(TRANSITIONS, kind)) {
      throw new StoreError("invalid", `kind must be one of ${Object.keys(TRANSITIONS).join(", ")}`);
    }
    const transition: Transition = TRANSITIONS[kind];
    if (!transition.by.includes(principal.type)) {
      throw new StoreError("forbidden", `${principal.type} cannot ${kind}`);
    }
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (transition.body === "required" && body === "") {
      throw new StoreError("invalid", `${kind} needs a body`);
    }
    if (body.length > MAX_BODY) throw new StoreError("invalid", `body is longer than ${MAX_BODY} characters`);
    const link = typeof input.link === "string" ? input.link.trim() : "";
    if (link.length > MAX_LINK) throw new StoreError("invalid", `link is longer than ${MAX_LINK} characters`);

    return this.transaction(() => {
      const entry = this.visibleEntry(principal, id);
      if (transition.from !== "any" && !transition.from.includes(entry.status)) {
        throw new StoreError("conflict", `cannot ${kind} an entry that is ${entry.status}`);
      }
      const now = this.now();
      if (transition.to) {
        this.db.prepare("UPDATE entries SET status = ?, updated_at = ? WHERE id = ?").run(transition.to, now, id);
      } else {
        this.db.prepare("UPDATE entries SET updated_at = ? WHERE id = ?").run(now, id);
      }
      const eventId = this.insertEvent(id, now, principal.actor, kind, transition.to, body || null, link || null);
      return {
        entry: this.requireEntry(id),
        event: { id: eventId, created_at: now, actor: principal.actor, kind, status: transition.to, body: body || null, link: link || null },
      };
    });
  }

  createSiteKey(appId: string, label: string): { id: number; key: string } {
    if (!this.getApp(appId)) throw new StoreError("invalid", `unknown app ${appId}`);
    const key = generateSecret(SITE_KEY_PREFIX);
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO site_keys (app_id, label, hash, created_at) VALUES (?, ?, ?, ?)")
      .run(appId, label, hashSecret(key), this.now());
    return { id: Number(lastInsertRowid), key };
  }

  listSiteKeys(): { id: number; app_id: string; label: string; created_at: string; revoked_at: string | null }[] {
    return this.db
      .prepare("SELECT id, app_id, label, created_at, revoked_at FROM site_keys ORDER BY id")
      .all() as never;
  }

  revokeSiteKey(id: number): boolean {
    const { changes } = this.db
      .prepare("UPDATE site_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.now(), id);
    return changes > 0;
  }

  createAgentToken(name: string, scope: "read" | "write"): { id: number; token: string } {
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new StoreError("invalid", "name must be lowercase letters, digits and dashes");
    }
    const token = generateSecret(AGENT_TOKEN_PREFIX);
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO agent_tokens (name, scope, hash, created_at) VALUES (?, ?, ?, ?)")
      .run(name, scope, hashSecret(token), this.now());
    return { id: Number(lastInsertRowid), token };
  }

  listAgentTokens(): { id: number; name: string; scope: string; created_at: string; revoked_at: string | null }[] {
    return this.db
      .prepare("SELECT id, name, scope, created_at, revoked_at FROM agent_tokens ORDER BY id")
      .all() as never;
  }

  revokeAgentToken(id: number): boolean {
    const { changes } = this.db
      .prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.now(), id);
    return changes > 0;
  }

  authenticate(secret: string): Principal | null {
    const hash = hashSecret(secret);
    if (secret.startsWith(SITE_KEY_PREFIX)) {
      const row = this.db
        .prepare("SELECT app_id FROM site_keys WHERE hash = ? AND revoked_at IS NULL")
        .get(hash) as { app_id: string } | undefined;
      return row ? { type: "owner", actor: "marcel", appId: row.app_id } : null;
    }
    if (secret.startsWith(AGENT_TOKEN_PREFIX)) {
      const row = this.db
        .prepare("SELECT name, scope FROM agent_tokens WHERE hash = ? AND revoked_at IS NULL")
        .get(hash) as { name: string; scope: "read" | "write" } | undefined;
      return row ? { type: "agent", actor: `agent:${row.name}`, scope: row.scope } : null;
    }
    return null;
  }

  private visibleEntry(principal: Principal, id: number): Entry {
    const entry = this.findEntry(id);
    // An entry of another app is reported as missing, not as forbidden, so a
    // site key cannot probe which ids exist.
    if (!entry || (principal.type === "owner" && principal.appId && entry.app !== principal.appId)) {
      throw new StoreError("not_found", `no entry ${id}`);
    }
    return entry;
  }

  private findEntry(id: number): Entry | null {
    const row = this.db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as unknown as EntryRow | undefined;
    return row ? toEntry(row) : null;
  }

  private requireEntry(id: number): Entry {
    return this.findEntry(id)!;
  }

  private insertEvent(
    entryId: number, createdAt: string, actor: string, kind: string,
    status: Status | null, body: string | null, link: string | null,
  ): number {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO events (entry_id, created_at, actor, kind, status, body, link) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entryId, createdAt, actor, kind, status, body, link);
    return Number(lastInsertRowid);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function requireWrite(principal: Principal): void {
  if (principal.type === "agent" && principal.scope !== "write") {
    throw new StoreError("forbidden", "this token is read-only");
  }
}

function scopedApp(principal: Principal, requested: string | undefined): string | undefined {
  if (principal.type === "owner" && principal.appId) {
    if (requested && requested !== principal.appId) {
      throw new StoreError("forbidden", "this key belongs to another app");
    }
    return principal.appId;
  }
  return requested;
}

function parseUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function cut(value: unknown, limit: number): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.length > limit ? value.slice(0, limit) : value;
}

function toApp(row: AppRow): App {
  return { ...row, origins: JSON.parse(row.origins) as string[] };
}

function toEntry(row: EntryRow): Entry {
  const { id, app_id, ...rest } = row;
  return { id, app: app_id, ...rest };
}
