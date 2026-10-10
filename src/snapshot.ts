import { rename, rm } from "node:fs/promises";
import { backup, type DatabaseSync } from "node:sqlite";

// A consistent copy of the live database, written through SQLite's backup API
// (safe while the service writes, WAL included) to a temporary file and then
// renamed, so a reader never sees a half-written snapshot. The nightly backup
// copies this file instead of the live database.
export async function writeSnapshot(db: DatabaseSync, target: string): Promise<void> {
  const temporary = `${target}.tmp`;
  await rm(temporary, { force: true });
  await backup(db, temporary);
  await rename(temporary, target);
}

// Writes a snapshot now and then every interval. Failures are logged, not
// thrown: a missed snapshot must not take the service down.
export function scheduleSnapshots(db: DatabaseSync, target: string, intervalMs = 60 * 60 * 1000): NodeJS.Timeout {
  const run = () =>
    writeSnapshot(db, target).catch((error: unknown) => console.error(`snapshot to ${target} failed:`, error));
  void run();
  return setInterval(run, intervalMs).unref();
}
