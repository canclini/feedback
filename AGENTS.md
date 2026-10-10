# feedback

Point-and-comment feedback for Marcel's websites, worked through by agents. A small service at
feedback.canclini.dev (Node, SQLite, passkeys, HTTP API and MCP) and one script tag per site.

Status: planned, nothing built. Start with `docs/PLAN.md`; its "Open decisions" come first.

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

To be filled in with step 1 of the plan.
