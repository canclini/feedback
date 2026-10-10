# Contributing

## Checks

```sh
npm ci
npm run check   # typecheck and tests
```

Both run in CI on every push and pull request.

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
