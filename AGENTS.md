# feedback

Point-and-comment feedback for Marcel's websites, worked through by agents. A small service at
feedback.canclini.dev (Node, SQLite, passkeys, HTTP API and MCP) and a small loader per site.

Status: steps 1 to 4 and 7 of `docs/PLAN.md` done; next is step 5 (the widget). Decisions taken are in `docs/DECISIONS.md`;
`CONTRIBUTING.md` has the checks and the commit rules, which CI enforces.

Global conventions (language, commits, PRs, reviews, co-authoring) come from
`~/.claude/CLAUDE.md` and are not repeated here.

## Rules

- The service runs on canclini-web-01 and is deployed through the canclini-infra repo
  (`~/Projects/canclini.dev/canclini-infra`): compose service, Caddy host, DNS. Read its
  `README.md` and `AGENTS.md` before touching deployment.
- No secret in this repo: no tokens, keys, setup codes or passkey material, not even in tests
  (tests generate their own).
- Dependencies are recorded in `docs/DECISIONS.md` before they are added.
- The MCP tools are part of the product: every tool has a description written for a model and a
  test.
- Visible text in the widget and web UI is German (de-CH), Swiss spelling, no em dashes.

## Build, test

- Node 24. TypeScript runs directly (`node src/main.ts`), no build step; only erasable syntax.
- `npm run check`: `tsc` type check and `node --test` over `test/**/*.test.ts`.
- `npm start`: the service on `PORT` (default 8080). `DATABASE_PATH` (default `feedback.db`),
  `APPS_PATH` (default `apps.json`), `GIT_COMMIT` (what `/health` reports), `PUBLIC_URL`
  (default `http://localhost:8080`; the passkeys' relying party, never change it in production).
  While no passkey exists, the log prints a one-time setup code on every start.
- `node src/cli.ts`: apps, site keys and agent tokens on the database in `DATABASE_PATH`.
  A created secret is printed once; never paste one into a file, commit or chat.
- `node bin/check-commits.ts origin/main..HEAD`: commit messages against `CONTRIBUTING.md`.
- Local container: `docker build -t feedback:local . && docker run -d --rm --name feedback-local
  -p 127.0.0.1:18080:8080 feedback:local`, then `docker exec feedback-local node src/cli.ts ...`
  for keys and tokens. The database is an anonymous volume and goes away with the container.
- Connect Claude Code to it without touching the user's config: write an MCP config with the
  token into the session scratchpad (`{"mcpServers":{"feedback":{"type":"http","url":
  "http://127.0.0.1:18080/mcp","headers":{"Authorization":"Bearer <token>"}}}}`) and run
  `claude -p "..." --mcp-config <file> --strict-mcp-config`. Delete the file afterwards.

## Layout

- `src/`: the service. `store.ts` holds all rules (status machine, scoping, validation) and is
  shared by the HTTP API (`api.ts`), the CLI (`cli.ts`) and the MCP server (`mcp.ts`). `db.ts`
  has the migrations: append, never edit a shipped one. `server.ts` routes, `main.ts` starts.
- `src/auth.ts`: passkeys (`@simplewebauthn/server`), setup code, sessions. `src/web.ts`: the web
  UI, server-rendered with the escaping `html` tag from `src/html.ts`; never build HTML by string
  concatenation. `src/ui/`: CSS, the passkey script and the icon, served as they are.
- `src/mcp.ts`: the MCP tools and the `/mcp` route. `src/loop.ts`: the working rules for agents,
  served as instructions and as a prompt. Changing a tool means changing its description, its
  test in `test/mcp.test.ts`, and `loop.ts` if the workflow changes.
- `apps.json`: the app registry (id, origins, repo, branch, local path), loaded on start.
- `test/`: `*.test.ts`, one file per area. `test/helpers.ts` gives each test a store on a
  temporary database and a server on a free port; call them at the top level of a test file or
  inside a test, not in a `before` hook. `test/authenticator.ts` is a software passkey, so the
  WebAuthn tests verify real signatures.
- Real browser check of the web UI: headless Chromium with a CDP virtual authenticator
  (`WebAuthn.addVirtualAuthenticator`) drives setup, sign-in and the pages. The unit tests cannot
  catch browser behaviour such as the `Origin: null` that `Referrer-Policy: no-referrer` causes.
- `bin/`: repo tooling, not shipped in the image.
