# feedback

Point-and-comment feedback for Marcel's websites, worked through by agents. A small service at
feedback.canclini.dev (Node, SQLite, passkeys, HTTP API and MCP) and a small loader per site.

Status: step 1 of `docs/PLAN.md` (skeleton). Decisions taken are in `docs/DECISIONS.md`;
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
- `npm start`: the service on `PORT` (default 8080); `GIT_COMMIT` sets what `/health` reports.
- `node bin/check-commits.ts origin/main..HEAD`: commit messages against `CONTRIBUTING.md`.

## Layout

- `src/`: the service. `src/server.ts` builds the HTTP server, `src/main.ts` starts it.
- `test/`: `*.test.ts`, one file per area.
- `bin/`: repo tooling, not shipped in the image.
