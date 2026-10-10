import { openStore } from "./config.ts";
import { createServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8080);
const commit = (process.env.GIT_COMMIT ?? "unknown").slice(0, 7);

createServer({ commit, store: openStore() }).listen(port, () => {
  console.log(`feedback listening on :${port} (commit ${commit})`);
});
