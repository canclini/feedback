import { openAuth, openStore } from "./config.ts";
import { createServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8080);
const commit = (process.env.GIT_COMMIT ?? "unknown").slice(0, 7);
const store = openStore();
const auth = openAuth(store);

createServer({ commit, store, auth }).listen(port, () => {
  console.log(`feedback listening on :${port} (commit ${commit}), web UI at ${auth.origin}`);
  const setupCode = auth.issueSetupCode();
  if (setupCode) {
    console.log(`No passkey registered yet. Setup code, valid until the first passkey or the next restart: ${setupCode}`);
  }
});
