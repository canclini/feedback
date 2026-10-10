// Serves dev/test-site with a strict CSP that allows only itself and the
// feedback service, to show the widget works under such a policy.
// Usage: node dev/test-site.ts [port] [feedback origin]
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

export function createTestSite(feedbackOrigin: string): Server {
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${feedbackOrigin}`,
    `connect-src 'self' ${feedbackOrigin}`,
    "style-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!/^[\w-]+\.(html|css|js)$/.test(file)) {
      res.writeHead(404).end();
      return;
    }
    let body: string;
    try {
      body = readFileSync(new URL(`./test-site/${file}`, import.meta.url), "utf8");
    } catch {
      res.writeHead(404).end();
      return;
    }
    // The loader names the production service; point it at the one under test.
    if (file === "loader.js") body = body.replace("https://feedback.canclini.dev", feedbackOrigin);
    res.writeHead(200, { "content-type": TYPES[file.split(".").pop()!], "content-security-policy": csp, "cache-control": "no-store" });
    res.end(body);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8090);
  const feedback = process.argv[3] ?? "http://localhost:8080";
  createTestSite(feedback).listen(port, () => console.log(`test site on http://localhost:${port}, feedback at ${feedback}`));
}
