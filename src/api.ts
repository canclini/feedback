import type { IncomingMessage, ServerResponse } from "node:http";
import { OPEN_STATUSES, STATUSES, type Principal, type Status, type Store, StoreError } from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024;

const ERROR_STATUS: Record<string, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
};

class HttpError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Handles everything under /v1. Returns false for paths it does not own.
export async function handleApi(store: Store, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/v1/")) return false;

  const origin = req.headers.origin;
  if (origin && store.allOrigins().has(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("access-control-allow-methods", "GET, POST");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-max-age", "600");
    res.writeHead(204).end();
    return true;
  }

  try {
    const principal = authenticate(store, req);
    const [status, body] = await route(store, principal, req, url);
    send(res, status, body);
  } catch (error) {
    if (error instanceof StoreError || error instanceof HttpError) {
      send(res, ERROR_STATUS[error.code] ?? 400, { error: error.code, message: error.message });
    } else {
      console.error(error);
      send(res, 500, { error: "internal", message: "internal error" });
    }
  }
  return true;
}

async function route(
  store: Store,
  principal: Principal,
  req: IncomingMessage,
  url: URL,
): Promise<[number, unknown]> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/v1/entries" && method === "POST") {
    return [201, { entry: store.createEntry(principal, (await readJson(req)) as never) }];
  }
  if (path === "/v1/entries" && method === "GET") {
    const entries = store.listEntries(principal, {
      app: url.searchParams.get("app") ?? undefined,
      statuses: parseStatuses(url.searchParams.get("status")),
      url: url.searchParams.get("url") ?? undefined,
      limit: parseLimit(url.searchParams.get("limit")),
    });
    return [200, { entries }];
  }
  const entryMatch = /^\/v1\/entries\/(\d+)(\/events)?$/.exec(path);
  if (entryMatch && !entryMatch[2] && method === "GET") {
    return [200, store.getEntry(principal, Number(entryMatch[1]))];
  }
  if (entryMatch && entryMatch[2] && method === "POST") {
    return [201, store.addEvent(principal, Number(entryMatch[1]), (await readJson(req)) as never)];
  }
  if (path === "/v1/apps" && method === "GET") {
    if (principal.type !== "agent") throw new HttpError("forbidden", "the registry is for agents");
    return [200, { apps: store.listApps() }];
  }
  throw new HttpError("not_found", `no route ${method} ${path}`);
}

function authenticate(store: Store, req: IncomingMessage): Principal {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  const principal = match ? store.authenticate(match[1]) : null;
  if (!principal) throw new HttpError("unauthorized", "a valid site key or agent token is required");

  const origin = req.headers.origin;
  if (origin && principal.type === "owner" && principal.appId) {
    const app = store.getApp(principal.appId);
    if (!app?.origins.includes(origin)) throw new HttpError("forbidden", "this key belongs to another site");
  }
  // Agent tokens belong in an agent's secret store, never in a page. A browser
  // request carrying one is refused so a leaked token cannot be used from a site.
  if (origin && principal.type === "agent") {
    throw new HttpError("forbidden", "agent tokens are not accepted from browsers");
  }
  return principal;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError("too_large", `body is larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError("invalid", "body must be JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new HttpError("invalid", "body must be a JSON object");
  }
  return data as Record<string, unknown>;
}

// status=open is shorthand for every status that still needs work.
function parseStatuses(value: string | null): Status[] | undefined {
  if (!value) return undefined;
  const statuses = value.split(",").flatMap((part) => (part === "open" ? OPEN_STATUSES : [part]));
  for (const status of statuses) {
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new HttpError("invalid", `status must be open or one of ${STATUSES.join(", ")}`);
    }
  }
  return statuses as Status[];
}

function parseLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw new HttpError("invalid", "limit must be a positive integer");
  return limit;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
