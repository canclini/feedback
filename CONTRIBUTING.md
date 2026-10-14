# Contributing

## Setup

Node 24 or newer. TypeScript runs directly through Node's type stripping (`node src/main.ts`);
there is no build step, so only erasable syntax: no enums, no namespaces, no parameter
properties.

```sh
git clone https://github.com/canclini/feedback.git
cd feedback
npm ci
```

## Run

```sh
APPS_PATH=dev/apps.json npm start     # service and web UI on http://localhost:8080
node dev/test-site.ts 8090            # test site with a strict CSP on http://localhost:8090
```

`npm start` reads the environment described in `README.md` (`PORT`, `DATABASE_PATH`,
`APPS_PATH`, `PUBLIC_URL`, `SNAPSHOT_PATH`, `GIT_COMMIT`). For a throwaway instance next to a
running one:

```sh
PORT=18080 PUBLIC_URL=http://localhost:18080 DATABASE_PATH=/tmp/feedback-try.db \
  APPS_PATH=dev/apps.json npm start
```

While no passkey exists, the log prints a one-time setup code on every start. Keys and tokens
for the same database: `DATABASE_PATH=... APPS_PATH=... node src/cli.ts` (run it without
arguments for the commands). `docs/EMBED.md` ("Try it locally") activates the widget on the test
site.

A local container, with the database in an anonymous volume that goes away with it:

```sh
docker build -t feedback:local .
docker run -d --rm --name feedback-local -p 127.0.0.1:18080:8080 \
  -e PUBLIC_URL=http://localhost:18080 feedback:local
docker exec feedback-local node src/cli.ts apps
docker stop feedback-local
```

## Checks

```sh
npm ci
npm run check   # typecheck and tests
```

Both run in CI on every push and pull request. CI also builds the Docker image.

- `npm run typecheck`: `tsc`, emits nothing.
- `npm test`: `node --test` over `test/**/*.test.ts`. One file: `node --test test/store.test.ts`.
- The browser tests in `test/browser/` drive headless Chrome or Chromium over the DevTools
  protocol: `web-ui.test.ts` runs the passkey flow with a virtual authenticator,
  `widget.test.ts` runs the widget on the strict-CSP test site. They look for `google-chrome`,
  `google-chrome-stable`, `chromium` and `chromium-browser` on `PATH`; `CHROME_PATH` picks a
  binary explicitly. Without a browser they are skipped, not failed, so check the summary for
  `skipped` before relying on a green run. CI runs them with
  `CHROME_PATH=/usr/bin/google-chrome`.

  ```sh
  CHROME_PATH=/usr/bin/chromium node --test --test-timeout=120000 --test-force-exit "test/browser/*.test.ts"
  ```

Tests never leave the machine: each one gets a store on a temporary database and a server on a
free port (`test/helpers.ts`), and `test/authenticator.ts` is a software passkey, so the WebAuthn
tests verify real signatures. Call the helpers at the top level of a test file or inside a test,
not in a `before` hook.

## Where things live

- `src/store.ts`: all rules (status machine, scoping, validation), shared by the HTTP API
  (`src/api.ts`), the CLI (`src/cli.ts`) and the MCP server (`src/mcp.ts`).
- `src/db.ts`: schema migrations. Append a new one; never edit a shipped one.
- `src/server.ts` routes, `src/main.ts` starts, `src/config.ts` reads the environment.
- `src/auth.ts`: passkeys (`@simplewebauthn/server`), the setup code, sessions.
  `src/tokens.ts`: site keys and agent tokens, generated and hashed.
- `src/web.ts`: the web UI, server-rendered with the escaping `html` tag from `src/html.ts`;
  never build HTML by string concatenation. `src/ui/`: CSS, the passkey script, the loader for
  the service's own pages and the icon, served as they are.
- `src/mcp.ts`: the MCP tools and the `/mcp` route. `src/loop.ts`: the working rules for agents,
  served as instructions and as a prompt.
- `src/widget/feedback.js`: the widget, plain browser JavaScript, served at `/v1/feedback.js`.
- `src/apps.ts`: reads and validates the registry. `src/snapshot.ts`: the backup snapshot.
- `dev/`: the strict-CSP test site (`dev/test-site.ts`, `dev/test-site/` with the canonical
  loader) and `dev/apps.json` registering it.
- `test/`: `*.test.ts`, one file per area; `test/browser/` for the browser tests.
- `bin/`: repo tooling, not shipped in the image.
- `apps.json`: the author's own registry, loaded by default. Not a place for your sites; see
  `README.md`.
- `docs/`: `EMBED.md` (wiring a site), `DECISIONS.md` (what is settled), `PLAN.md` (the plan).

## Rules for changes

- Dependencies are recorded in `docs/DECISIONS.md` before they are added.
- The MCP tools are part of the product: every tool has a description written for a model and a
  test in `test/mcp.test.ts`. Changing a tool means changing its description, its test, and
  `src/loop.ts` if the workflow changes.
- In the widget, build nodes with its `h()` helper, never `innerHTML`.

## Commits

Every commit of a pull request lands on `main` as written (rebase merge), so each one has to
stand on its own and follow these rules. CI checks them with `bin/check-commits.ts`.

- Subject: one imperative English sentence describing the effect of the change. Capitalized,
  no trailing period, no conventional-commit prefix (`feat:`, `fix:`), at most 72 characters.
  Example: `Report the deployed commit on /health`.
- Body, separated by a blank line: why. The problem, its cause, what the change buys. Prose,
  not a list of files. Skip it when the subject says everything.
- Do not restate the diff.
- Attribution only as `Co-authored-by:` trailers, for humans and AI alike (with the model
  name). No "Generated with" footers, no session links.

Check your commits before pushing:

```sh
node bin/check-commits.ts origin/main..HEAD
```

Fix a commit message with `git commit --amend` or `git rebase -i` before opening the PR.

## Pull requests

- Title: like a commit subject.
- Description: the problem, why this approach, how it was verified. Short.
- One topic per pull request.

## Language

Code, identifiers, comments, commits and docs are English. Visible text in the widget and the
web UI is German (de-CH), Swiss spelling, no em dashes.

## Secrets

No tokens, keys, setup codes or passkey material in the repo, not even in tests. Tests generate
their own.

## Security issues

Do not open a public issue for a vulnerability; see `SECURITY.md`.
