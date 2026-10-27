# Review rules

What counts as a defect in a change to feedback. Read by an automated reviewer and by a person
reviewing a pull request. `CONTRIBUTING.md` says how to work here; this file says what to flag.

Every finding names `file:line`. `important` blocks the merge; `nit` and `pre-existing` never do.

## important: blocks the merge

- **HTML built by string concatenation or template literals** in `src/web.ts` instead of the
  escaping `html` tag from `src/html.ts`: an entry's comment or selector would run as markup.
- **`innerHTML` in the widget** (`src/widget/feedback.js`) instead of its `h()` helper.
- **A secret in the repo**: a token, key, setup code or passkey material, in code, tests or
  docs. A test fixture that looks like one also fails the secret scan; tests generate theirs.
- **Data crosses an app's boundary**: a query, API route or MCP tool that returns or changes
  entries of an app the caller's key or token is not scoped to. The rules live in
  `src/store.ts`; a rule decided anywhere else is this defect too.
- **A shipped migration edited** in `src/db.ts` instead of a new one appended.
- **An MCP tool changed** without its description, its test in `test/mcp.test.ts`, and
  `src/loop.ts` when the workflow changes.
- **A dependency** without an entry in `docs/DECISIONS.md`.
- **A commit message** that `node bin/check-commits.ts origin/main..HEAD` rejects: every commit
  lands on `main` as written.
- **Visible text** in the widget or the web UI that is not German (de-CH), has «ß» or an em dash.
- **Syntax Node cannot strip**: an enum, a namespace, a parameter property.

## nit: never blocks, goes into the pull request body

- Naming and comment wording.
- CSS in `src/ui/` that could reuse an existing rule.
- A test that could be shorter.

## pre-existing: never blocks, named once

A defect already on `main` that the change does not add or worsen.

## Ignore

- `apps.json`: the author's own registry, not part of the tool.
- `docs/PLAN.md` wording.
- `dev/` test site styling.

## Evidence the change must show

- `npm run check` output with its counts, and the number of skipped browser tests. A run
  without a browser skips them; then say so, it is not a green run for a widget or web UI change.
- A web UI change: screenshots at 1280x650 and 390x760 of the changed page.
- An API or MCP change: the test that covers the new behaviour.

## Recurring findings, fixed at the source

| Finding | Seen | Source fix |
|---|---|---|
| Browser tests skipped and the run reported green | `CONTRIBUTING.md`, "Checks" | evidence above names the skipped count; CI pins `CHROME_PATH` (done) |
| A web UI change ships without a test, because the line may not touch `test/*` | PR #29 | allow added test files on the line, keep existing ones protected (proposed) |
| HTML by concatenation | rule in `CONTRIBUTING.md` | a test that fails on `innerHTML` in the widget and on `+ "<` in `src/web.ts` (proposed) |
