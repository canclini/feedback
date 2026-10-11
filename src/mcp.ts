import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { WORK_LOOP } from "./loop.ts";
import { type App, type Entry, type Event, OPEN_STATUSES, type Principal, type Store, StoreError } from "./store.ts";

type AgentPrincipal = Extract<Principal, { type: "agent" }>;

const MAX_BODY_BYTES = 64 * 1024;

// The tools an agent sees. Descriptions are written for a model: what the tool
// is for, when to call it, and what comes back.
export function buildMcpServer(store: Store, principal: AgentPrincipal, version: string): McpServer {
  const server = new McpServer({ name: "feedback", version }, { instructions: WORK_LOOP });

  server.registerTool(
    "list_open_feedback",
    {
      title: "List open feedback",
      description:
        "List feedback entries that still need work, newest first. One line per entry: id, app, status, page URL, the element Marcel pointed at, and his comment. Status \"new\" is ready to claim, \"in_progress\" is being worked on by an agent, \"question\" waits for Marcel's answer. Use get_feedback for the full entry.",
      inputSchema: z.object({
        app: z.string().optional().describe("Only entries of this app id, e.g. \"akkordo\". Omit for all apps."),
        status: z
          .enum(["new", "in_progress", "question"])
          .optional()
          .describe("Only entries in this status. Omit for all open statuses."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ app, status }) =>
      run(() => {
        const entries = store.listEntries(principal, { app, statuses: status ? [status] : OPEN_STATUSES });
        const text = entries.length === 0 ? "No open feedback." : entries.map(summaryLine).join("\n");
        return { content: [{ type: "text", text }], structuredContent: { entries } };
      }),
  );

  server.registerTool(
    "get_feedback",
    {
      title: "Get a feedback entry",
      description:
        "Get one feedback entry in full: page URL, deployed commit (version), CSS selector, element text and trimmed HTML, viewport, Marcel's comment, the history of events (claims, questions, Marcel's answers, notes), and the app's GitHub repo, deploy branch and local path. Read this before changing any code.",
      inputSchema: z.object({ id: z.number().int().positive().describe("The entry id.") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      run(() => {
        const result = store.getEntry(principal, id);
        return { content: [{ type: "text", text: describeEntry(result) }], structuredContent: result };
      }),
  );

  if (principal.scope !== "write") return server;

  const transition = (
    name: string,
    title: string,
    description: string,
    kind: string,
    fields: z.ZodRawShape,
    toEvent: (args: Record<string, unknown>) => { body?: string; link?: string },
  ) =>
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: z.object({ id: z.number().int().positive().describe("The entry id."), ...fields }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args: Record<string, unknown>) =>
        run(() => {
          const { entry, event } = store.addEvent(principal, args.id as number, { kind, ...toEvent(args) });
          return {
            content: [{ type: "text", text: `Entry ${entry.id} is now ${entry.status}.` }],
            structuredContent: { entry, event },
          };
        }),
    );

  transition(
    "claim_feedback",
    "Claim a feedback entry",
    "Mark a \"new\" entry as in progress before you start working on it, so no other agent picks it up and Marcel sees on the page that it is being handled. Fails if the entry is not \"new\" (another agent may have claimed it); then pick another one.",
    "claim",
    {},
    () => ({}),
  );

  transition(
    "ask_about_feedback",
    "Ask Marcel about a feedback entry",
    "Ask Marcel one question when the comment is ambiguous or the change needs a decision only he can make. Sets the status to \"question\"; Marcel answers on the page, and the entry returns to \"new\" with his answer in the events. Ask instead of guessing.",
    "question",
    {
      question: z
        .string()
        .min(1)
        .describe("One concrete question in German (de-CH, Swiss spelling), as Marcel will read it on the page."),
    },
    (args) => ({ body: args.question as string }),
  );

  transition(
    "resolve_feedback",
    "Resolve a feedback entry",
    "Mark an entry as done after the change is committed and pushed. Also works on an entry that waits on your question, when Marcel settled it with you outside the page; say so in the note. Marcel reads the note on the page next to the element. Do not merge the branch: Marcel merges.",
    "resolve",
    {
      note: z
        .string()
        .min(1)
        .describe("One sentence in German (de-CH, Swiss spelling) saying what changed, e.g. \"Der Titel bricht jetzt um statt abgeschnitten zu werden.\""),
      link: z
        .string()
        .optional()
        .describe("The pull request URL, or the branch name (feedback/<id>) if the repo has no pull requests."),
    },
    (args) => ({ body: args.note as string, link: args.link as string | undefined }),
  );

  transition(
    "dismiss_feedback",
    "Dismiss a feedback entry",
    "Close an entry without a change: a duplicate, already fixed in a newer version, or not about this app. Marcel sees the reason on the page and can reopen the entry.",
    "dismiss",
    { reason: z.string().min(1).describe("Why no change is made, one sentence in German (de-CH, Swiss spelling).") },
    (args) => ({ body: args.reason as string }),
  );

  server.registerPrompt(
    "work_through_feedback",
    {
      title: "Work through feedback",
      description: "The rules for working through Marcel's feedback entries with these tools.",
    },
    async () => ({ messages: [{ role: "user", content: { type: "text", text: WORK_LOOP } }] }),
  );

  return server;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

// Store errors become tool results the model can read and act on.
function run(work: () => ToolResult): ToolResult {
  try {
    return work();
  } catch (error) {
    if (error instanceof StoreError) {
      return { content: [{ type: "text", text: `${error.code}: ${error.message}` }], isError: true };
    }
    throw error;
  }
}

function summaryLine(entry: Entry): string {
  const element = [entry.selector, entry.element_text && `"${oneLine(entry.element_text, 60)}"`].filter(Boolean).join(" ");
  return `#${entry.id} [${entry.app}] ${entry.status} · ${entry.url}${element ? ` · ${element}` : ""} · ${oneLine(entry.comment, 200)}`;
}

function describeEntry({ entry, events, app }: { entry: Entry; events: Event[]; app: App }): string {
  const lines = [
    `Feedback #${entry.id}, status ${entry.status}`,
    `Comment: ${entry.comment}`,
    `Page: ${entry.url}`,
    `App: ${app.name} (${app.id}), repo ${app.repo}, deploy branch ${app.branch}${app.local_path ? `, local path ${app.local_path}` : ""}`,
    `Deployed commit: ${entry.version ?? "unknown"}`,
    `Selector: ${entry.selector ?? "none"}`,
    `Element text: ${entry.element_text ?? "none"}`,
    `Element HTML: ${entry.element_html ?? "none"}`,
    `Viewport: ${entry.viewport ?? "unknown"}, browser: ${entry.user_agent ?? "unknown"}`,
    `Created ${entry.created_at}, updated ${entry.updated_at}`,
    "Events:",
    ...events.map(
      (e) => `- ${e.created_at} ${e.actor} ${e.kind}${e.status ? ` → ${e.status}` : ""}${e.body ? `: ${e.body}` : ""}${e.link ? ` (${e.link})` : ""}`,
    ),
  ];
  return lines.join("\n");
}

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

// Serves /mcp. Authenticates the agent token itself, then hands the request to
// the SDK's web-standard handler with a server built for that token.
export function createMcpRoute(store: Store, version: string) {
  const handler = createMcpHandler(
    (ctx) => buildMcpServer(store, ctx.authInfo?.extra?.principal as AgentPrincipal, version),
    { legacy: "stateless", maxRequestBodySize: MAX_BODY_BYTES },
  );

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    const principal = match ? store.authenticate(match[1]) : null;
    if (!principal) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "unauthorized", message: "an agent token is required" }));
      return;
    }
    if (principal.type !== "agent" || req.headers.origin) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden", message: "only agent tokens, and not from browsers" }));
      return;
    }
    try {
      const response = await handler.fetch(toWebRequest(req), {
        authInfo: { token: match![1], clientId: principal.actor, scopes: [principal.scope], extra: { principal } },
      });
      await writeWebResponse(res, response);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal", message: "internal error" }));
    }
  };
}

function toWebRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit);
}

// Streams the body through, so SSE responses reach the client as they come;
// a client that hangs up cancels the stream.
async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as never);
  res.on("close", () => body.destroy());
  for await (const chunk of body) res.write(chunk);
  res.end();
}
