import assert from "node:assert/strict";
import { test } from "node:test";
import { checkMessage } from "../bin/check-commits.ts";

test("accepts an imperative subject with a body and a co-author trailer", () => {
  const message =
    "Report the deployed commit on /health\n\nA deploy is verified from outside.\n\n" +
    "Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\n";
  assert.deepEqual(checkMessage(message), []);
});

test("rejects a conventional-commit prefix", () => {
  assert.deepEqual(checkMessage("feat: add health"), [
    "subject has a conventional-commit prefix",
  ]);
  assert.deepEqual(checkMessage("fix(api)!: drop field"), [
    "subject has a conventional-commit prefix",
  ]);
});

test("rejects a lowercase subject, a trailing period and an overlong subject", () => {
  assert.deepEqual(checkMessage("add health"), [
    "subject does not start with a capital letter",
  ]);
  assert.deepEqual(checkMessage("Add health."), ["subject ends with punctuation"]);
  assert.match(checkMessage(`Add ${"x".repeat(80)}`)[0], /limit is 72/);
});

test("rejects a body glued to the subject", () => {
  assert.deepEqual(checkMessage("Add health\nbecause"), ["second line is not blank"]);
});

test("rejects session links and generated-with footers", () => {
  assert.deepEqual(checkMessage("Add health\n\nClaude-Session: https://x"), [
    "message has a Claude-Session trailer",
  ]);
  assert.deepEqual(checkMessage("Add health\n\n🤖 Generated with Claude Code"), [
    'message has a "Generated with" line',
  ]);
});
