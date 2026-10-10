# Feedback: implementation plan

Drafted 2026-10-10 at the end of the session that built canclini-infra (www.canclini.dev,
Umami, Designate DNS). Status: step 1 done; the open decisions are settled in
`docs/DECISIONS.md`. A new session starts here: read this file, then `AGENTS.md`, then
`docs/DECISIONS.md`, then continue with the next step.

## The idea

Marcel looks at one of his sites, presses a key, clicks the element that is wrong and writes one
sentence. An agent picks the entry up, finds the repo, fixes it on a branch and reports back. The
status shows up on the page, on the element he pointed at: *in Arbeit*, *Rückfrage*, *erledigt*
with a one-sentence note.

It is the Alt+K loop of the Desk (`~/Projects/desk/web/js/feedback.js`, `AGENTS.md` "Feedback
loop"), lifted out of one local app into a service every site can use with one script tag.

**Agent first.** The main consumer of an entry is not a person reading a dashboard but an agent
that has to act on it without asking back. So:

- An entry carries everything an agent needs to find and change the right thing: app, page URL,
  the deployed commit, a CSS selector, the element's text and a trimmed `outerHTML`, viewport,
  browser, and the comment.
- Each app is registered with the repo and branch it deploys from, so "which code is this" is
  answered by data, not by guessing.
- The agent interface (MCP) is a first-class product surface, designed and tested like the
  widget, not an afterthought on top of a REST API.
- Status changes are the agent's report: claim (`in Arbeit`), ask (`Rückfrage` with a question
  Marcel answers on the page), resolve (`erledigt` with a note and the commit or PR).

This is also a showcase for canclini.dev's Werkstatt: a small tool built with and for an agent,
running on its own Swiss infrastructure. A Werkstatt card and a blog post can follow.

## What exists to build on

- **canclini-infra** (`~/Projects/canclini.dev/canclini-infra`, github.com/canclini/canclini-infra):
  VM `canclini-web-01` at Infomaniak (Ubuntu 24.04, 2 GB), Caddy in Docker Compose, data volume
  `canclini-data` on `/srv/data` (kept across VM rebuilds), DNS for canclini.dev in Designate
  (`infra/dns.tf`), deploy by GitHub Actions over ssh as user `deploy` (`platform/deploy.sh`),
  OpenTofu through `bin/tofu`, credentials in `~/.config/canclini-infra/env`. Read its
  `README.md` and `AGENTS.md` first.
- **Umami** on analytics.canclini.dev, websites described in `analytics/websites.json` and synced
  by `bin/umami-sync`: the pattern for "a registry in a repo, a script that syncs it".
- **The Desk's widget** (`~/Projects/desk/web/js/feedback.js`, 182 lines, Marcel's own code):
  element picking, selector, popover, status overlay. Start from it; its styles use the Desk's
  theme variables and must become self-contained.
- **ylah-services** (`~/Projects/ylah/ylah-services`): Node services with MCP (bexio-mcp,
  sbb-mcp) behind Caddy; the MCP-over-HTTP pattern Marcel already runs.
- **Sites to wire first:** www.canclini.dev (`canclini.web`, static, served by Caddy), Akkordo
  (`~/Projects/akkordo`, Vite, Vercel), Zahlenfuchs website and app
  (`~/Projects/zahlenfuchs/zahlenfuchs.web`, `zahlenfuchs.app`, static, Vercel).

## Architecture

### The service

- Node 22 + TypeScript, one process, one container. Dependencies (record each in
  `docs/DECISIONS.md` before adding it):
  - `@simplewebauthn/server` (and `@simplewebauthn/browser` for the sign-in page): passkeys.
  - `@modelcontextprotocol/sdk`: the MCP server, Streamable HTTP transport.
  - `better-sqlite3`: storage.
  - An HTTP framework only if it earns its place (Hono is small); plain `node:http` is fine.
- SQLite file on the data volume, `/srv/data/feedback/feedback.db`, WAL mode.
- Runs on canclini-web-01 next to Umami: a service in canclini-infra's `platform/compose.yaml`,
  a host block in the Caddyfile, A/AAAA records in `infra/dns.tf`. The image is built from this
  repo (see open decision 1 for how it gets to the VM).
- `/health` returns the commit, like the ylah-services.

### Data model

- `apps`: `id` (`akkordo`), `name`, `origins` (allowed page origins, e.g.
  `https://www.akkordo.ch`), `repo` (`canclini/akkordo`), `branch` (`master`), `local_path`
  hint for agents (`~/Projects/akkordo`). Described in a file in this repo (or canclini-infra)
  and synced like `analytics/websites.json`; not edited in a UI.
- `entries`: `id`, `app_id`, `created_at`, `url`, `version` (deployed commit), `selector`,
  `element_text`, `element_html` (trimmed, e.g. 2 KB), `viewport`, `user_agent`, `comment`,
  `status` (`neu`, `in Arbeit`, `Rückfrage`, `erledigt`, `verworfen`), `updated_at`.
- `events`: append-only history per entry: who (`marcel`, `agent:claude`, `agent:desk`), what
  (status change, note, question, answer, link to commit/PR), when. The page shows the latest;
  the agent reads the whole thread.
- `credentials` (passkeys), `site_keys` (per app, hashed, revocable), `agent_tokens` (hashed,
  named, revocable, with scopes: `read`, `write`).

### Identity

- **Marcel signs in on feedback.canclini.dev with a passkey.** One user. First passkey is
  registered with a one-time setup code printed by the container on first start (or set in an
  env file on the volume), then setup closes.
- **Site keys, not cookies.** A cookie of feedback.canclini.dev is third-party on akkordo.ch and
  Safari and Firefox block it. Instead: on feedback.canclini.dev, "enable on Akkordo" redirects
  to `https://www.akkordo.ch/#feedback-key=…`; the widget stores the key in that origin's
  `localStorage`, removes the fragment, and from then on sends it as a bearer token. A key can
  only create entries and read entries of its app. Revocable per site and device.
- **Agent tokens** for the MCP and the API: one for Claude Code, one for the Desk, created and
  revoked on feedback.canclini.dev. The token is shown once; it lives in the agent's own secret
  store (for Claude Code: an env file outside every repo, referenced from the MCP config).
- CORS on the API allows exactly the registered origins.

### The embed

Decided: a loader inside each site instead of this tag (decision 3 in `docs/DECISIONS.md`); the
loader adds the same tag only when a site key is in `localStorage`. The tag it adds:

```html
<script defer src="https://feedback.canclini.dev/v1/feedback.js" data-app="akkordo"></script>
```

- Without a site key in `localStorage` the script does nothing visible and makes no further
  request.
- With a key: a small button (and a shortcut, Alt+K like the Desk) to pick an element; a list of
  this page's entries with status; elements with open entries outlined.
- The version comes from `<meta name="app-version" content="<commit>">`, which each site's
  deploy sets (Vercel: `VERCEL_GIT_COMMIT_SHA`; canclini.web: the workflow's `github.sha`).
- Self-contained styles (a shadow root), so no site's CSS leaks in and the widget leaks nothing
  out. Works under each site's CSP once `script-src` and `connect-src` allow
  `https://feedback.canclini.dev`.
- Size budget: a few KB, no framework, no build step needed by the sites.

See open decision 3 on the request every visitor makes for the script.

### API (HTTP, JSON)

- `POST /v1/entries` (site key or agent token): create.
- `GET /v1/entries?app=&status=&url=` (site key: own app; agent token): list.
- `GET /v1/entries/:id` with its events.
- `POST /v1/entries/:id/events` (agent token, or Marcel's session for answers): status change,
  note, question, answer, link.
- `GET /v1/apps` (agent token): the registry, so an agent knows repo, branch and path.
- Auth: `Authorization: Bearer <site key | agent token>`; the web UI uses a session cookie on
  feedback.canclini.dev itself (first party there).

### MCP (`https://feedback.canclini.dev/mcp`, Streamable HTTP, bearer agent token)

Tools, named for what an agent does, each with a description written for a model:

- `list_open_feedback(app?, status?)`: open entries, newest first, with app, URL, comment and
  the element in one line each.
- `get_feedback(id)`: the full entry, its events, and the app's repo, branch and local path.
- `claim_feedback(id)`: status `in Arbeit` (the page greys the element out).
- `ask_about_feedback(id, question)`: status `Rückfrage`; Marcel answers on the page; the answer
  comes back as an event.
- `resolve_feedback(id, note, commit_or_pr?)`: status `erledigt` with a German one-sentence note
  for Marcel.
- `dismiss_feedback(id, reason)`: `verworfen`.

Resources or a prompt: "how to work through feedback" (the loop below), so any agent connected
to the server gets the rules with the tools.

### The agent loop

The same rules as the Desk's loop, written once here and served through MCP:

1. `list_open_feedback`, pick one, `claim_feedback`.
2. Open the app's repo (`get_feedback` names it), read its `AGENTS.md`, branch
   `feedback/<id>` from the deploy branch.
3. Fix, run the repo's checks, commit (repo conventions), push the branch.
4. `resolve_feedback` with the note and the branch or PR. Merging stays Marcel's until he gives
   standing approval per app.
5. If the entry is unclear: `ask_about_feedback` instead of guessing.

## Steps

Each step ends verified; the verification is part of the step.

1. **Repo skeleton and decisions.** `docs/DECISIONS.md` with the dependencies and the open
   decisions below as decided; `AGENTS.md` with build and test commands; CI running the tests.
2. **Store and API.** Schema, migrations, entries/events/apps, site keys and agent tokens
   (hashed), the HTTP API with tests against a temporary database. No auth UI yet: tokens
   created by a CLI inside the container.
3. **MCP.** The tools above on the same store, tested with the SDK's client in-process, then
   connected from Claude Code against a local container.
4. **Passkeys and the web UI.** Sign-in, first-passkey setup, the list of all entries per app,
   answering a Rückfrage, creating and revoking site keys and agent tokens, "enable on <app>".
5. **The widget.** `v1/feedback.js` from the Desk's code, shadow root, key pairing, picking,
   status overlay; a test page in this repo with a strict CSP to prove it works under one.
6. **Deploy.** Image, compose service, Caddy host, DNS record, volume path, backup (step 7) in
   canclini-infra; `feedback.canclini.dev` live with `/health`.
7. **Backups.** The data volume has none today. Nightly SQLite `.backup` (and Umami's Postgres
   dump) to the object storage bucket, as code in canclini-infra, with a restore drill.
8. **Wire the sites.** canclini.dev first, then Akkordo, Zahlenfuchs website and app: script
   tag, `app-version` meta, CSP, the privacy page if decision 3 needs it. One commit per repo.
9. **The full loop.** Marcel gives three real entries on three sites; an agent works them
   through MCP end to end; the statuses show on the pages.

## Open decisions (settled 2026-10-10, see docs/DECISIONS.md)

1. **Public or private repo, and how the image reaches the VM.** Public repo with a public image
   on GHCR is simplest (the VM pulls without credentials) and fits "a cool service" others could
   use; nothing secret lives in the code. Private needs a pull credential on the VM.
2. **Name and domain.** Working name `feedback`, served at feedback.canclini.dev. Marcel
   mentioned "feedback.ch"-style naming: a product name and an own domain only if it becomes
   something others use.
3. **The script request for every visitor.** With one script tag, every visitor's browser
   fetches `feedback.js` from feedback.canclini.dev (IP visible to the server, not stored), so
   each privacy page needs a sentence about it. Alternative: a two-line loader inside each site
   that only loads the widget when a key is in `localStorage`, so ordinary visitors never touch
   the service and no privacy text changes. Recommendation: the loader, served as a tiny
   snippet each site copies (CSP-friendly, no inline script needed where the site has a JS
   file).
4. **Screenshots.** A picture of the element helps an agent a lot. Browser-side capture needs a
   library (html-to-image, about 10 KB) or the Screen Capture permission prompt. Recommendation:
   not in the first cut; `element_html` plus selector plus version is enough to find the code.
5. **GitHub issues.** Not automatic. Possibly an MCP tool `open_issue(id)` later for entries that
   are bigger than a fix.
6. **Who merges.** Agents work on `feedback/<id>` branches; Marcel merges until he grants
   standing approval per app (the Desk has the same rule).

## Constraints (from the session that planned this)

- Infrastructure as code: nothing configured by hand in a web UI except the bootstrap steps a
  README lists. Sessions plan, Marcel runs `tofu apply`.
- No secret in any repo, in user data or in a chat: setup codes, tokens and keys are created on
  the machine that needs them and shown once.
- Data stays in Switzerland (Infomaniak). No US cloud for the service or its storage.
- Customer-visible copy follows Marcel's text rules (`~/.claude` text-style skill): Swiss
  spelling, no em dashes, no jargon on public pages.
- English in code and docs; the widget's and web UI's visible text is German (de-CH).
- Never touch Marcel's real mailboxes or a running daemon of his from a session (attache rule);
  this service has no reason to.
