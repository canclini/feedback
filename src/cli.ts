// Manages site keys and agent tokens until the web UI does (step 4 of the
// plan). Runs inside the container: node src/cli.ts <command>
import { pathToFileURL } from "node:url";
import { openStore } from "./config.ts";
import { type Store, StoreError } from "./store.ts";

const USAGE = `usage: node src/cli.ts <command>

  apps                              list the registered apps
  site-key create <app> <label>     create a key for one site, e.g. "macbook"
  site-key list
  site-key revoke <id>
  agent-token create <name> [read|write]   default scope: write
  agent-token list
  agent-token revoke <id>`;

export function run(store: Store, args: string[], out: (line: string) => void): number {
  const [group, command, ...rest] = args;
  try {
    if (group === "apps" && command === undefined) {
      for (const app of store.listApps()) out(`${app.id}\t${app.repo}@${app.branch}\t${app.origins.join(" ")}`);
      return 0;
    }
    if (group === "site-key" && command === "create" && rest.length === 2) {
      const { id, key } = store.createSiteKey(rest[0], rest[1]);
      out(`site key ${id} for ${rest[0]} (${rest[1]}). Shown once:`);
      out(key);
      return 0;
    }
    if (group === "agent-token" && command === "create" && (rest.length === 1 || rest.length === 2)) {
      const scope = rest[1] ?? "write";
      if (scope !== "read" && scope !== "write") throw new StoreError("invalid", "scope must be read or write");
      const { id, token } = store.createAgentToken(rest[0], scope);
      out(`agent token ${id} for ${rest[0]} (${scope}). Shown once:`);
      out(token);
      return 0;
    }
    if (command === "list" && rest.length === 0) {
      if (group === "site-key") {
        for (const k of store.listSiteKeys()) out(`${k.id}\t${k.app_id}\t${k.label}\t${k.created_at}\t${k.revoked_at ? `revoked ${k.revoked_at}` : "active"}`);
        return 0;
      }
      if (group === "agent-token") {
        for (const t of store.listAgentTokens()) out(`${t.id}\t${t.name}\t${t.scope}\t${t.created_at}\t${t.revoked_at ? `revoked ${t.revoked_at}` : "active"}`);
        return 0;
      }
    }
    if (command === "revoke" && rest.length === 1 && /^\d+$/.test(rest[0])) {
      const id = Number(rest[0]);
      const revoked =
        group === "site-key" ? store.revokeSiteKey(id) : group === "agent-token" ? store.revokeAgentToken(id) : null;
      if (revoked !== null) {
        out(revoked ? `revoked ${group} ${id}` : `no active ${group} ${id}`);
        return revoked ? 0 : 1;
      }
    }
  } catch (error) {
    if (error instanceof StoreError) {
      out(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
  out(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(openStore(), process.argv.slice(2), (line) => console.log(line));
}
