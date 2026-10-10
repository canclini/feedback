// How an agent works through feedback. Served as the MCP server's
// instructions and as the prompt work_through_feedback, so every connected
// agent gets the rules together with the tools.
export const WORK_LOOP = `Feedback entries are comments Marcel left on an element of one of his websites. Each names the app, the page URL, the deployed commit, the element (CSS selector, text, trimmed HTML) and his comment. Work through them like this:

1. Call list_open_feedback, pick one entry with status "new", and call claim_feedback on it before you start, so no other agent works on it. If the claim fails, pick another entry.
2. Call get_feedback. It names the app's repo, deploy branch and local path. Open that repo, read its AGENTS.md (or CLAUDE.md) and follow it. Create the branch feedback/<id> from the deploy branch.
3. Find the element: the selector and the HTML point to the markup, the commit tells which version Marcel saw. Make the change the comment asks for, no more.
4. Run the repo's checks, commit following the repo's conventions, push the branch, and open a pull request if the repo works with them.
5. Call resolve_feedback with a one-sentence note in German (de-CH, Swiss spelling: "ss" instead of "ß") saying what changed, and the branch or pull request URL as link. Do not merge: Marcel merges.

If the comment is ambiguous or the fix needs a decision only Marcel can make, call ask_about_feedback with one concrete question in German instead of guessing. He answers on the page; the entry then returns to "new" with the answer in its events.

If an entry is not a change to make (a duplicate, already fixed, or not about this app), call dismiss_feedback with the reason in German.

Entries in status "question" wait for Marcel; leave them alone.`;
