import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { handleApi } from "./api.ts";
import type { Auth } from "./auth.ts";
import { createMcpRoute } from "./mcp.ts";
import type { Store } from "./store.ts";
import { createWebRoute } from "./web.ts";

export interface ServerOptions {
  // Short commit the running image was built from; /health reports it so a
  // deploy can be verified from outside.
  commit: string;
  store: Store;
  auth: Auth;
}

// The widget, loaded cross-origin by the sites. It is public: what it can do
// depends on the site key the browser holds, not on the script.
const WIDGET = readFileSync(new URL("./widget/feedback.js", import.meta.url));
const WIDGET_GZIP = gzipSync(WIDGET);

export function createServer(options: ServerOptions): Server {
  const mcp = createMcpRoute(options.store, options.commit);
  const web = createWebRoute(options.store, options.auth);
  return createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", commit: options.commit }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/feedback.js") {
      const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
        "cross-origin-resource-policy": "cross-origin",
        "x-content-type-options": "nosniff",
        vary: "accept-encoding",
        ...(gzip ? { "content-encoding": "gzip" } : {}),
      });
      res.end(gzip ? WIDGET_GZIP : WIDGET);
      return;
    }
    if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
      await mcp(req, res);
      return;
    }
    if (await handleApi(options.store, req, res)) return;
    if (await web(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
