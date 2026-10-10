// The widget on a page with a strict CSP, in a real browser: key hand-over,
// picking an element, the status on the page, answering a question, and no
// request at all for a visitor without a key.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { createTestSite } from "../../dev/test-site.ts";
import { testServer, testStore } from "../helpers.ts";
import { Browser, findChrome } from "./cdp.ts";

const chrome = findChrome();
const skip = chrome ? false : "no Chromium or Chrome found (set CHROME_PATH)";

const store = testStore();
const service = await testServer(store);
// localhost, not 127.0.0.1: the site's origin must be the registered one.
const serviceOrigin = service.replace("127.0.0.1", "localhost");
const site = createTestSite(serviceOrigin);
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
after(() => {
  site.close();
});
const siteOrigin = `http://localhost:${(site.address() as AddressInfo).port}`;
store.syncApps([{ id: "test-site", name: "Testseite", origins: [siteOrigin], repo: "canclini/feedback", branch: "main", local_path: null }]);
const owner = store.authenticate(store.createSiteKey("test-site", "chromium").key)!;
const agent = { type: "agent", actor: "agent:claude", scope: "write" } as const;

const shadow = (selector: string) => `document.querySelector("feedback-widget")?.shadowRoot?.querySelector(${JSON.stringify(selector)})`;

test("a visitor without a key never loads the widget", { skip }, async () => {
  const browser = await Browser.launch(chrome!);
  try {
    const requests: string[] = [];
    browser.on("Network.requestWillBeSent", (p) => requests.push((p.request as { url: string }).url));
    await browser.navigate(`${siteOrigin}/`);
    assert.equal(await browser.evaluate("document.querySelector('feedback-widget')"), null);
    assert.deepEqual(requests.filter((url) => url.startsWith(serviceOrigin)), []);
  } finally {
    await browser.close();
  }
});

test("the owner gives feedback on an element and follows it on the page", { skip, timeout: 60000 }, async () => {
  const browser = await Browser.launch(chrome!);
  try {
    const key = store.createSiteKey("test-site", "chromium").key;
    await browser.navigate(`${siteOrigin}/#feedback-key=${key}`);
    await browser.waitFor(shadow(".pill"), "the widget");
    assert.equal(await browser.evaluate("location.hash"), "");
    assert.equal(await browser.evaluate("localStorage.getItem('feedback-key')"), key);

    // Alt+K, click the second card's heading, write, Enter.
    await browser.key("k", "KeyK", 75, 1);
    await browser.waitFor(`!${shadow(".banner")}.hidden`, "the picking banner");
    const [x, y] = await browser.evaluate<number[]>(
      "(() => { const r = document.querySelectorAll('.card h2')[1].getBoundingClientRect(); return [r.x + 5, r.y + 5]; })()",
    );
    await browser.click(x, y);
    await browser.waitFor(`${shadow("textarea")} === ${shadow("textarea")}.getRootNode().activeElement`, "the comment field");
    await browser.type("Titel ist zu klein");
    await browser.key("Enter", "Enter", 13);
    await browser.waitFor(`${shadow(".toast")}?.textContent === "Danke, ist erfasst."`, "the confirmation");

    const [entry] = store.listEntries(owner);
    assert.equal(entry.comment, "Titel ist zu klein");
    assert.equal(entry.url, `${siteOrigin}/`);
    assert.equal(entry.version, "0123abc");
    assert.equal(entry.element_text, "Zweite Karte");
    assert.equal(entry.element_html, "<h2>Zweite Karte</h2>");
    assert.match(entry.viewport ?? "", /^\d+x\d+$/);
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(entry.selector)}).textContent`), "Zweite Karte");

    // The open entry is outlined on the element, with its status.
    await browser.waitFor(`${shadow(".marker .tag")}?.textContent === "#${entry.id} neu"`, "the marker");
    store.addEvent(agent, entry.id, { kind: "claim" });
    store.addEvent(agent, entry.id, { kind: "question", body: "Wie gross soll er sein?" });
    await browser.navigate(`${siteOrigin}/`);
    await browser.waitFor(`${shadow(".marker .tag")}?.textContent === "#${entry.id} Rückfrage"`, "the question marker");

    // The marker opens the list, where the question is answered.
    await browser.evaluate(`${shadow(".marker .tag")}.click()`);
    await browser.waitFor(`${shadow(".panel")}?.textContent.includes("Wie gross soll er sein?")`, "the question in the panel");
    assert.equal(await browser.evaluate(`${shadow(".panel")}.textContent.includes("null")`), false);
    await browser.evaluate(`${shadow(".panel textarea")}.focus()`);
    await browser.type("Wie die anderen Titel");
    await browser.evaluate(`[...${shadow(".panel")}.querySelectorAll("button")].find((b) => b.textContent === "Antworten").click()`);
    await browser.waitFor(`${shadow(".marker .tag")}?.textContent === "#${entry.id} neu"`, "the entry back to new");
    const answer = store.getEntry(owner, entry.id).events.at(-1)!;
    assert.deepEqual([answer.kind, answer.actor, answer.body], ["answer", "marcel", "Wie die anderen Titel"]);

    // Done entries leave the page; the list keeps them with the note.
    store.addEvent(agent, entry.id, { kind: "resolve", body: "Der Titel ist jetzt gleich gross wie die anderen." });
    await browser.navigate(`${siteOrigin}/`);
    await browser.waitFor(`${shadow(".pill button + button")}?.textContent === "0"`, "the open count");
    assert.equal(await browser.evaluate(`${shadow(".marker")}`), null);

    const violations = browser.console.filter((line) => /Content Security Policy|Refused to/i.test(line));
    assert.deepEqual(violations, [], "no CSP violations");
    assert.deepEqual(browser.console.filter((line) => line.startsWith("exception")), [], "no exceptions");
  } finally {
    await browser.close();
  }
});

test("a revoked key removes the widget and the key from the browser", { skip, timeout: 30000 }, async () => {
  const browser = await Browser.launch(chrome!);
  try {
    const { id, key } = store.createSiteKey("test-site", "revoked");
    await browser.navigate(`${siteOrigin}/#feedback-key=${key}`);
    await browser.waitFor(shadow(".pill"), "the widget");
    store.revokeSiteKey(id);
    await browser.navigate(`${siteOrigin}/`);
    await browser.waitFor(`${shadow(".toast")}?.textContent.includes("gilt nicht mehr")`, "the notice");
    assert.equal(await browser.evaluate("localStorage.getItem('feedback-key')"), null);
  } finally {
    await browser.close();
  }
});
