import { createServer as createHttpServer, type Server } from "node:http";
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

export function createServer(options: ServerOptions): Server {
  const mcp = createMcpRoute(options.store, options.commit);
  const web = createWebRoute(options.store, options.auth);
  return createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", commit: options.commit }));
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
