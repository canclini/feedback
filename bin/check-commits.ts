// Checks commit messages against the repo's commit rules (CONTRIBUTING.md).
// Usage: node bin/check-commits.ts <base>..<head>
// Prints one line per violation and exits 1 if there is any.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_SUBJECT = 72;

export function checkMessage(message: string): string[] {
  const lines = message.replace(/\s+$/, "").split("\n");
  const subject = lines[0] ?? "";
  const problems: string[] = [];

  if (subject.trim() === "") return ["subject is empty"];
  if (/^[a-z]+(\([^)]*\))?!?:\s/.test(subject)) {
    problems.push("subject has a conventional-commit prefix");
  } else if (!/^[A-Z]/.test(subject)) {
    problems.push("subject does not start with a capital letter");
  }
  if (/[.!?]$/.test(subject)) problems.push("subject ends with punctuation");
  if (subject.length > MAX_SUBJECT) {
    problems.push(`subject is ${subject.length} characters, limit is ${MAX_SUBJECT}`);
  }
  if (lines.length > 1 && lines[1] !== "") {
    problems.push("second line is not blank");
  }
  if (lines.some((line) => /^Claude-Session:/i.test(line))) {
    problems.push("message has a Claude-Session trailer");
  }
  if (lines.some((line) => /generated with/i.test(line))) {
    problems.push('message has a "Generated with" line');
  }
  return problems;
}

function main(range: string | undefined): number {
  if (!range) {
    console.error("usage: node bin/check-commits.ts <base>..<head>");
    return 2;
  }
  const log = execFileSync("git", ["log", "--format=%H%x00%B%x00", range], {
    encoding: "utf8",
  });
  const fields = log.split("\0");
  let failed = 0;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = fields[i].trim().slice(0, 7);
    const message = fields[i + 1];
    for (const problem of checkMessage(message)) {
      console.log(`${sha} ${message.split("\n")[0]}: ${problem}`);
      failed++;
    }
  }
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv[2]);
}
