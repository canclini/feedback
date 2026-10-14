# feedback

Point at any element of a website, say what is wrong, and let an agent fix it. The status comes
back to the page, on the element you pointed at.

It is for a site owner who works with coding agents: you leave a comment on the live page, an
agent picks it up through MCP or the HTTP API, changes the code on a branch and reports back on
the page. One instance serves one owner and any number of sites.

- **For the site:** a few lines of loader. Visitors never contact the service; only the owner's
  browser, which holds a key for the site, loads the widget: a button (and Alt+K) to pick an
  element and a comment field.
- **For the owner:** a small web UI with passkey sign-in: all entries per site, answering an
  agent's question, keys for sites and agents.
- **For agents:** an MCP server and an HTTP API to list, claim, ask about and resolve entries,
  with the repo, deploy branch and deployed commit each entry belongs to.

The service is one Node process with one SQLite file. The widget and the web UI speak German
(de-CH). MIT licensed. Status: in development, see `docs/PLAN.md`; settled decisions are in
`docs/DECISIONS.md`.

The author runs an instance at feedback.canclini.dev for his own sites. Everything below
works the same on your own host; that instance is only an example.

## How it fits together

1. You list your sites in a registry file (`apps.json`): id, origins, GitHub repo, deploy
   branch.
2. Each site carries a few lines of loader (`docs/EMBED.md`). The loader does nothing unless
   the browser holds a site key for that site.
3. You sign in to the web UI with a passkey and activate a site in your browser. The browser
   lands on the site with a key; from then on the widget appears there.
4. You comment on an element. An agent with an agent token lists the entry, claims it, fixes
   it and resolves it with a note, or asks a question you answer on the page.

## Quick start (local)

Node 24 or newer.

```sh
git clone https://github.com/canclini/feedback.git
cd feedback
npm ci
```

Start the service with the registry of the bundled test site (`dev/apps.json`, one app
`test-site` on `http://localhost:8090`). The database is `feedback.db` in the current
directory unless `DATABASE_PATH` says otherwise.

```sh
APPS_PATH=dev/apps.json npm start     # service and web UI on http://localhost:8080
```

In a second terminal, the test site, which sends a strict Content Security Policy and carries
the canonical loader:

```sh
node dev/test-site.ts 8090            # test site on http://localhost:8090
```

Activate the widget, either from the command line:

```sh
APPS_PATH=dev/apps.json node src/cli.ts site-key create test-site laptop
# prints the key once; open http://localhost:8090/#feedback-key=<key>
```

or through the web UI: open http://localhost:8080, enter the setup code the service printed to
its log, register a passkey, then Zugänge → Websites → Testseite → Aktivieren. Either way the
browser lands on the test site with the key in the address; the widget stores it in the site's
`localStorage` and removes it from the address bar. Press Alt+K or the button at the bottom
right, click an element, write a comment.

The CLI and the service must use the same `DATABASE_PATH` and `APPS_PATH`. To start over,
stop the service and delete `feedback.db*`.

To register a site of your own, see `docs/EMBED.md`.

## Self-hosting with Docker

CI publishes the image `ghcr.io/canclini/feedback` on every green commit to `main`, tagged
`:main` and `:<full commit sha>`. It is public; no login is needed to pull it. There are no
release tags yet: pin a commit sha if you want to choose when to upgrade.

### 1. Write your registry

The registry lists the sites the instance serves. The service reads it on every start and
upserts each app into the database.

```json
{
  "apps": [
    {
      "id": "my-site",
      "name": "My site",
      "origins": ["https://www.example.com", "https://example.com"],
      "repo": "example/my-site",
      "branch": "main",
      "local_path": "~/src/my-site"
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | lowercase letters, digits and dashes; unique |
| `name` | shown in the web UI |
| `origins` | every origin the site is served from, exact (`https://www.example.com`, no path, no trailing slash); the first one is where "Aktivieren" lands |
| `repo` | `owner/name` of the repository the site is built from |
| `branch` | the deploy branch agents branch from |
| `local_path` | optional; a hint for agents where the checkout lives on their machine |

The `apps.json` at the root of this repo is the author's own registry, shipped in the image as
the default. Do not use it: point `APPS_PATH` at your own file **before the first start**. An
app that leaves the registry stays in the database (its entries still point at it), and its
origins stay allowed for CORS and as form targets of the web UI; there is no command to remove
it.

### 2. Run the container

```sh
docker volume create feedback-data
docker run -d --name feedback --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -e PUBLIC_URL=https://feedback.example.com \
  -e APPS_PATH=/config/apps.json \
  -v "$PWD/apps.json:/config/apps.json:ro" \
  -v feedback-data:/data \
  ghcr.io/canclini/feedback:main
```

`/data` holds the database and the snapshot and must be writable by uid 1000 (`node` in the
image). A named volume as above gets that from the image; a bind-mounted host directory must
be `chown 1000:1000` first.

The service speaks plain HTTP. Put a reverse proxy with TLS in front of it; passkeys and the
`Secure` session cookie need HTTPS on any host but `localhost`. With Caddy:

```
feedback.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

### 3. Environment

| Variable | Default (image) | Default (`npm start`) | Meaning |
|---|---|---|---|
| `PORT` | `8080` | `8080` | Port the service listens on. Keep it at 8080 in the container (the image's health check calls `127.0.0.1:8080/health`) and map a different host port instead. |
| `PUBLIC_URL` | `http://localhost:8080` | `http://localhost:8080` | The origin the web UI is reached at. Its hostname is the passkeys' relying party ID, its origin the expected WebAuthn origin and the `Origin` every web UI POST must carry. |
| `DATABASE_PATH` | `/data/feedback.db` | `feedback.db` | The SQLite database (WAL mode). |
| `APPS_PATH` | `/app/apps.json` (the author's registry) | `apps.json` in the repo | Your registry, see above. |
| `SNAPSHOT_PATH` | `/data/snapshot.db` | unset | When set, a consistent snapshot of the database is written there on start and every hour. |
| `GIT_COMMIT` | the commit the image was built from (`unknown` in a local build without `--build-arg GIT_COMMIT=...`) | unset (`unknown`) | Reported, cut to 7 characters, by `GET /health` and as the MCP server's version. |

**`PUBLIC_URL` must never change once a passkey exists.** A passkey is bound to the hostname it
was registered for; after a change, no registered passkey signs in, and setup does not open
again because passkeys exist. Set it to the final public address before the first sign-in.

### 4. First sign-in

While no passkey is registered, the service prints a one-time setup code to its log on every
start:

```sh
docker logs feedback 2>&1 | grep 'Setup code'
```

Open `PUBLIC_URL`, enter the code, register a passkey. Setup then closes; further passkeys are
added from a signed-in session under Zugänge → Passkeys. The last passkey cannot be removed.
The sign-in page needs a browser with native WebAuthn JSON support
(`PublicKeyCredential.parseCreationOptionsFromJSON`), which current Chrome, Safari and Firefox
have.

### 5. Keys, tokens and backups from the command line

The CLI works on the same database as the service and is available in the container:

```sh
docker exec feedback node src/cli.ts
```

```
usage: node src/cli.ts <command>

  apps                              list the registered apps
  site-key create <app> <label>     create a key for one site, e.g. "macbook"
  site-key list
  site-key revoke <id>
  agent-token create <name> [read|write]   default scope: write
  agent-token list
  agent-token revoke <id>
  backup <file>                     write a consistent snapshot of the database
```

A created key or token is printed once and stored only as a hash. Put it straight into the
browser or the agent's secret store, never into a file in a repository.

Back up the snapshot (`SNAPSHOT_PATH`), never the live database file: the snapshot is written
through SQLite's backup API to a temporary file and renamed into place, so a copy of it is
always consistent. `node src/cli.ts backup <file>` writes one on demand. To restore, stop the
service, replace the database with the snapshot, delete the old `feedback.db-wal` and
`feedback.db-shm`, and start it again.

### Upgrading

Pull the new image and recreate the container with the same volume and environment. Migrations
run on start (`src/db.ts`).

## Wiring a site

`docs/EMBED.md`: the registry entry, the loader, the deployed version, the Content Security
Policy and activation, for any static or built site.

## Connecting an agent

Create an agent token, in the web UI (Zugänge → Agenten) or with the CLI:

```sh
node src/cli.ts agent-token create my-agent          # write: read and change entries
node src/cli.ts agent-token create my-reader read    # read: list and get only
```

An agent sends it as `Authorization: Bearer <token>`. A request that carries an `Origin`
header is refused with 403, so a token cannot be used from a web page; it belongs in the
agent's secret store.

### MCP

Streamable HTTP at `<PUBLIC_URL>/mcp`, stateless (2025-era clients are served too). The server
sends its working rules as `instructions` and as the prompt `work_through_feedback`.

| Tool | Scope | Does |
|---|---|---|
| `list_open_feedback(app?, status?)` | read | open entries, newest first, one line each |
| `get_feedback(id)` | read | the full entry, its events, the app's repo, branch and local path |
| `claim_feedback(id)` | write | `new` → `in_progress`; fails if another agent claimed it |
| `ask_about_feedback(id, question)` | write | → `question`; the owner answers on the page |
| `resolve_feedback(id, note, link?)` | write | → `done` with a note and the PR or branch |
| `dismiss_feedback(id, reason)` | write | → `dismissed` |

A read token is offered only the two reading tools. Any MCP client that speaks Streamable HTTP
and can send a header works. For Claude Code, a project `.mcp.json` that takes the token from
the environment:

```json
{
  "mcpServers": {
    "feedback": {
      "type": "http",
      "url": "https://feedback.example.com/mcp",
      "headers": { "Authorization": "Bearer ${FEEDBACK_TOKEN}" }
    }
  }
}
```

### HTTP API

JSON over HTTP under `/v1`, with a site key or an agent token as bearer. Errors are
`{"error": "<code>", "message": "..."}` with status 400, 401, 403, 404, 409, 413 or 500.
Request bodies are limited to 64 KB.

| Request | Who | Does |
|---|---|---|
| `GET /health` | anyone | `{"status":"ok","commit":"<7 chars>"}` |
| `GET /v1/feedback.js` | anyone | the widget script |
| `GET /v1/entries?app=&status=&url=&limit=` | site key (own app), agent | newest first, each with its `last_event`; `status` is a comma list or `open` (`new,in_progress,question`); `limit` 1 to 500, default 100 |
| `GET /v1/entries/:id` | site key (own app), agent | `{entry, events, app}` |
| `POST /v1/entries` | site key, write agent (with `app`) | create: `url` and `comment` required; `version`, `selector`, `element_text`, `element_html`, `viewport`, `user_agent` optional and cut to length |
| `POST /v1/entries/:id/events` | see below | `{kind, body?, link?}` |
| `GET /v1/apps` | agent | the registry |

An entry of another app answers 404 to a site key. Event kinds and the status they lead to
(`TRANSITIONS` in `src/store.ts`):

| Kind | From | To | Who | Body |
|---|---|---|---|---|
| `claim` | new | in_progress | agent | optional |
| `question` | new, in_progress | question | agent | required |
| `answer` | question | new | owner | required |
| `resolve` | new, in_progress, question | done | agent | required |
| `dismiss` | new, in_progress, question | dismissed | agent, owner | required |
| `reopen` | done, dismissed | new | owner | optional |
| `note` | any | unchanged | agent, owner | required |

"Owner" is the web UI session or a site key; a read-only agent token posts no events. A second
claim answers 409.

```sh
curl -s -H "Authorization: Bearer $FEEDBACK_TOKEN" "https://feedback.example.com/v1/entries?status=open"
```

## Privacy

- Visitors without a key load nothing from the service: the loader checks the URL fragment and
  `localStorage` and stops. The site's privacy page needs no change for them.
- Only the owner's browser, which holds a site key, loads the widget. When the owner submits a
  comment it sends the page URL, the deployed commit from `<meta name="app-version">`, the
  element's CSS selector, text (up to 400 characters) and trimmed HTML (up to 2 KB), the
  viewport size, the browser's user agent, and the comment. Nothing else is collected; there are
  no screenshots and no cookies on the sites.
- The service keeps entries, events, hashed keys and tokens, passkey public keys and hashed
  session tokens in its SQLite file, nowhere else.
- The canonical loader also sets `umami.disabled` in the owner's browser, so a site that uses
  Umami does not count the owner's visits or the activation address (`docs/EMBED.md`).

## More

- `docs/EMBED.md`: wiring a site.
- `CONTRIBUTING.md`: setup, tests, layout, commit rules.
- `SECURITY.md`: reporting a vulnerability, threat model.
- `docs/DECISIONS.md`: what is settled and why. `docs/PLAN.md`: the original plan and steps.
