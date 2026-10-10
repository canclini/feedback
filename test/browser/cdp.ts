// A minimal Chrome DevTools Protocol driver for the browser tests: launches
// headless Chromium or Chrome, opens one page, and sends commands. No
// dependency: Node has WebSocket built in.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Chrome first: on Ubuntu, chromium is a snap wrapper that starts slowly.
const CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

// CHROME_PATH wins; otherwise the first browser on PATH. Null when there is
// none, so the browser tests can skip instead of fail on such a machine.
export function findChrome(): string | null {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of CANDIDATES) {
    try {
      return execFileSync("which", [name], { encoding: "utf8" }).trim();
    } catch {
      // not installed under this name
    }
  }
  return null;
}

type Listener = (params: Record<string, unknown>) => void;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class Browser {
  process: ChildProcess;
  profile: string;
  socket: WebSocket;
  seq = 0;
  pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }>();
  listeners = new Map<string, Set<Listener>>();
  console: string[] = [];

  constructor(process: ChildProcess, profile: string, socket: WebSocket) {
    this.process = process;
    this.profile = profile;
    this.socket = socket;
    socket.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      if (data.id !== undefined) {
        const call = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) call?.reject(new Error(`${call.method}: ${data.error.message}`));
        else call?.resolve(data.result);
      } else {
        for (const listener of this.listeners.get(data.method) ?? []) listener(data.params);
      }
    });
    this.on("Runtime.consoleAPICalled", (p) => {
      const args = p.args as { value?: unknown; description?: string }[];
      this.console.push(`console.${p.type}: ${args.map((a) => a.value ?? a.description).join(" ")}`);
    });
    this.on("Runtime.exceptionThrown", (p) => {
      const details = p.exceptionDetails as { exception?: { description?: string }; text?: string };
      this.console.push(`exception: ${details.exception?.description ?? details.text}`);
    });
    this.on("Log.entryAdded", (p) => {
      const entry = p.entry as { level: string; text: string };
      this.console.push(`log.${entry.level}: ${entry.text}`);
    });
  }

  static async launch(chrome: string): Promise<Browser> {
    const profile = mkdtempSync(join(tmpdir(), "feedback-chrome-"));
    const args = [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1200,900",
      // CI runners on Ubuntu 24.04 block the sandbox's user namespaces.
      ...(process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ];
    const child = spawn(chrome, args, { stdio: "ignore" });
    // A test that times out never reaches close(); the browser must not
    // outlive the test process either way.
    process.once("exit", () => child.kill("SIGKILL"));
    let port = "";
    for (let i = 0; i < 100 && !port; i++) {
      try {
        port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
      } catch {
        await sleep(100);
      }
    }
    if (!port) throw new Error(`${chrome} did not start`);
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json()) as {
      type: string;
      webSocketDebuggerUrl: string;
    }[];
    const socket = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    await withTimeout(
      new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve);
        socket.addEventListener("error", reject);
      }),
      5000,
      "the DevTools connection",
    );
    const browser = new Browser(child, profile, socket);
    await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map((m) => browser.send(m)));
    return browser;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, listener: Listener): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return () => this.listeners.get(event)!.delete(listener);
  }

  async navigate(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
    });
    await this.send("Page.navigate", { url });
    await withTimeout(loaded, 15000, `loading ${url}`);
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    );
    if (result.exceptionDetails) {
      throw new Error(`evaluate: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  // Polls an expression until it is truthy; returns its value.
  async waitFor<T = unknown>(expression: string, label: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate<T>(expression).catch(() => undefined);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; browser log:\n${this.console.join("\n")}`);
      await sleep(100);
    }
  }

  async click(x: number, y: number): Promise<void> {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  }

  async key(key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }

  async type(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  // Never waits for an exit that already happened (a crashed browser), and
  // kills hard if the browser does not stop.
  async close(): Promise<void> {
    this.socket.close();
    const running = () => this.process.exitCode === null && this.process.signalCode === null;
    if (running()) {
      const exited = new Promise((resolve) => this.process.once("exit", resolve));
      this.process.kill();
      await Promise.race([exited, sleep(5000)]);
      if (running()) this.process.kill("SIGKILL");
    }
    // Chrome's helper processes may still write to the profile for a moment
    // after the main process exits; retry on ENOTEMPTY.
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
