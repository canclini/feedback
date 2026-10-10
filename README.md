# feedback

Point at any element of a website, say what is wrong, and let an agent fix it. The status comes
back to the page, on the element you pointed at.

- **For the site:** a few lines of loader. Visitors never contact the service; for the owner, a
  key to pick an element and a comment field.
- **For the owner:** sign-in with a passkey at feedback.canclini.dev; all entries per site.
- **For agents:** an MCP server and an HTTP API to list, claim, ask about and resolve entries,
  with the repo and deployed commit each entry belongs to.

Runs on Marcel Canclini's own server in Switzerland. Status: in development, see `docs/PLAN.md`.

MIT licensed.
