import { createServer as createHttpServer, type Server } from "node:http";

export interface ServerOptions {
  // Short commit the running image was built from; /health reports it so a
  // deploy can be verified from outside.
  commit: string;
}

export function createServer(options: ServerOptions): Server {
  return createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", commit: options.commit }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
