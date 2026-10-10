# Decisions

Settled decisions, newest last. A dependency is recorded here before it is added.

## Settled with Marcel on 2026-10-10

The open decisions of `docs/PLAN.md`:

1. **Public repo, public image.** github.com/canclini/feedback is public under the MIT license.
   The image will be published on GHCR as a public package, so the VM pulls it without
   credentials. Nothing secret lives in the code.
2. **Name and domain.** `feedback`, served at feedback.canclini.dev. No product name or own
   domain until others use it.
3. **A loader inside each site, no script tag for every visitor.** Each site carries a few
   lines that load `feedback.js` from feedback.canclini.dev only when a site key is in
   `localStorage`. Ordinary visitors never contact the service, and no privacy page changes.
4. **No screenshots** in the first cut. Selector, trimmed `outerHTML`, element text and the
   deployed commit are enough to find the code.
5. **No automatic GitHub issues.** An MCP tool `open_issue(id)` may come later for entries
   bigger than a fix.
6. **Marcel merges.** Agents work on `feedback/<id>` branches and report the branch or PR.
   Standing approval to merge is granted per app, if ever.

## Runtime and tooling

- **Node 24**, the active LTS (the plan said 22, which is in maintenance). TypeScript runs
  directly through Node's type stripping: no build step, no `dist/`. Hence only erasable syntax
  (`erasableSyntaxOnly`): no enums, no namespaces, no parameter properties.
- **Tests with `node:test`**, no test framework dependency.
- **`node:http`**, no HTTP framework until one earns its place.

## Dependencies

| Package | Kind | Why |
|---|---|---|
| `typescript` | dev | `tsc` as the type checker (`npm run typecheck`); emits nothing. |
| `@types/node` | dev | Node's types for the type checker, pinned to the runtime's major (24). |

## Commits on a public repo

- Pull requests are merged with **rebase**, so each commit lands on main as written and the
  history stays linear. Every commit of a PR therefore has to stand on its own.
- `bin/check-commits.ts` checks every commit of a PR in CI against the rules in
  `CONTRIBUTING.md`; a violation fails the PR.
