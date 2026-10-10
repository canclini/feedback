import { readFileSync } from "node:fs";
import type { App } from "./store.ts";

// The registry of apps lives in apps.json in this repo, so which repo and
// branch an entry belongs to is reviewed like code. It is read on start.
export function loadApps(path: string | URL): App[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as { apps?: unknown };
  if (!Array.isArray(data.apps)) throw new Error(`${path}: "apps" must be an array`);
  const seen = new Set<string>();
  return data.apps.map((raw: Record<string, unknown>, index: number) => {
    const where = `${path}: apps[${index}]`;
    const { id, name, origins, repo, branch, local_path } = raw;
    if (typeof id !== "string" || !/^[a-z0-9-]+$/.test(id)) {
      throw new Error(`${where}: id must be lowercase letters, digits and dashes`);
    }
    if (seen.has(id)) throw new Error(`${where}: duplicate id ${id}`);
    seen.add(id);
    if (typeof name !== "string" || name === "") throw new Error(`${where}: name is required`);
    if (!Array.isArray(origins) || origins.length === 0 || !origins.every(isOrigin)) {
      throw new Error(`${where}: origins must be a non-empty list of origins like https://www.example.ch`);
    }
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`${where}: repo must be owner/name`);
    }
    if (typeof branch !== "string" || branch === "") throw new Error(`${where}: branch is required`);
    if (local_path !== undefined && typeof local_path !== "string") {
      throw new Error(`${where}: local_path must be a string`);
    }
    return { id, name, origins, repo, branch, local_path: local_path ?? null };
  });
}

function isOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}
