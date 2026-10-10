import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { testServer, testStore } from "./helpers.ts";

const store = testStore();
const base = await testServer(store);
const writeToken = store.createAgentToken("claude", "write").token;
const { id: readTokenId, token: readToken } = store.createAgentToken("viewer", "read");
const siteKey = store.createSiteKey("shop", "laptop").key;
const owner = store.authenticate(siteKey)!;

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  after(() => client.close());
  return client;
}

function newEntry(comment = "Preis fehlt") {
  return store.createEntry(owner, {
    url: "https://www.shop.test/cart",
    comment,
    selector: "#price",
    element_text: "CHF",
    element_html: '<span id="price">CHF</span>',
    version: "abc1234",
  });
}

type Text = { type: string; text: string };
const text = (result: unknown) => ((result as { content: Text[] }).content[0]).text;

const agent = await connect(writeToken);

test("a write token sees all tools, a read token only the reading ones", async () => {
  const names = (await agent.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "ask_about_feedback",
    "claim_feedback",
    "dismiss_feedback",
    "get_feedback",
    "list_open_feedback",
    "resolve_feedback",
  ]);
  const viewer = await connect(readToken);
  assert.deepEqual((await viewer.listTools()).tools.map((t) => t.name).sort(), ["get_feedback", "list_open_feedback"]);
});

test("every tool has a description and every input a description for the model", async () => {
  for (const tool of (await agent.listTools()).tools) {
    assert.ok((tool.description ?? "").length > 80, `${tool.name} needs a description`);
    const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
    for (const [name, schema] of Object.entries(properties)) {
      assert.ok(schema.description, `${tool.name}.${name} needs a description`);
    }
  }
});

test("the working rules come as instructions and as a prompt", async () => {
  assert.match(agent.getInstructions() ?? "", /claim_feedback/);
  const prompt = await agent.getPrompt({ name: "work_through_feedback" });
  assert.match((prompt.messages[0].content as Text).text, /feedback\/<id>/);
});

test("an agent lists, claims, reads and resolves an entry", async () => {
  const { id } = newEntry();

  const listed = await agent.callTool({ name: "list_open_feedback", arguments: { app: "shop", status: "new" } });
  assert.match(text(listed), new RegExp(`#${id} \\[shop\\] new · https://www.shop.test/cart · #price "CHF" · Preis fehlt`));

  const claimed = await agent.callTool({ name: "claim_feedback", arguments: { id } });
  assert.equal(text(claimed), `Entry ${id} is now in_progress.`);

  const detail = await agent.callTool({ name: "get_feedback", arguments: { id } });
  assert.match(text(detail), /repo example\/shop, deploy branch main, local path ~\/Projects\/shop/);
  assert.match(text(detail), /Deployed commit: abc1234/);
  assert.match(text(detail), /agent:claude claim → in_progress/);
  assert.equal((detail.structuredContent as { app: { repo: string } }).app.repo, "example/shop");

  const resolved = await agent.callTool({
    name: "resolve_feedback",
    arguments: { id, note: "Der Preis steht jetzt da.", link: "https://github.com/example/shop/pull/3" },
  });
  assert.equal(text(resolved), `Entry ${id} is now done.`);
  assert.equal(store.getEntry(owner, id).events.at(-1)?.link, "https://github.com/example/shop/pull/3");
});

test("a question goes to Marcel and his answer returns the entry to the agents", async () => {
  const { id } = newEntry("Farbe passt nicht");
  await agent.callTool({ name: "ask_about_feedback", arguments: { id, question: "Welche Farbe soll es sein?" } });
  assert.equal(store.getEntry(owner, id).entry.status, "question");
  store.addEvent(owner, id, { kind: "answer", body: "Dunkelblau" });
  const detail = await agent.callTool({ name: "get_feedback", arguments: { id } });
  assert.match(text(detail), /marcel answer → new: Dunkelblau/);
});

test("a dismissed entry leaves the open list", async () => {
  const { id } = newEntry("Doppelt");
  await agent.callTool({ name: "dismiss_feedback", arguments: { id, reason: "Gleich wie ein anderer Eintrag." } });
  const listed = await agent.callTool({ name: "list_open_feedback", arguments: {} });
  assert.doesNotMatch(text(listed), new RegExp(`#${id} `));
});

test("a failed transition is a readable tool error, not a protocol error", async () => {
  const { id } = newEntry();
  await agent.callTool({ name: "claim_feedback", arguments: { id } });
  const again = await agent.callTool({ name: "claim_feedback", arguments: { id } });
  assert.equal(again.isError, true);
  assert.equal(text(again), "conflict: cannot claim an entry that is in_progress");
  const missing = await agent.callTool({ name: "get_feedback", arguments: { id: 999999 } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /^not_found/);
});

test("/mcp accepts only agent tokens and refuses browsers", async () => {
  const post = (headers: Record<string, string>) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  const anonymous = await post({});
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
  assert.equal((await post({ authorization: `Bearer ${siteKey}` })).status, 403);
  assert.equal((await post({ authorization: `Bearer ${writeToken}`, origin: "https://www.shop.test" })).status, 403);
  store.revokeAgentToken(readTokenId);
  assert.equal((await post({ authorization: `Bearer ${readToken}` })).status, 401);
});

test("a client on the 2025 protocol is served statelessly", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${writeToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "0" } },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /"protocolVersion":"2025-06-18"/);
  assert.match(body, /claim_feedback/);
});
