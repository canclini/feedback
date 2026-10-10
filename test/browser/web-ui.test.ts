// The web UI in a real browser with a virtual authenticator: setup with the
// code, sign-out, sign-in with the passkey, answering a question. Catches
// what the HTTP tests cannot, such as the Origin header a browser sends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Auth } from "../../src/auth.ts";
import { testServer, testStore } from "../helpers.ts";
import { Browser, findChrome } from "./cdp.ts";

const chrome = findChrome();
const skip = chrome ? false : "no Chromium or Chrome found (set CHROME_PATH)";

test("setup, sign-out, sign-in and answering a question", { skip, timeout: 60000 }, async () => {
  const store = testStore();
  // The RP ID is the hostname alone; the expected origin includes the port,
  // which is only known once the server listens.
  const auth = new Auth(store.db, { publicUrl: "http://localhost" });
  const base = await testServer(store, auth);
  const origin = base.replace("127.0.0.1", "localhost");
  auth.origin = origin;
  const code = auth.issueSetupCode()!;
  const owner = store.authenticate(store.createSiteKey("shop", "t").key)!;
  const { id } = store.createEntry(owner, { url: "https://www.shop.test/", comment: "Preis fehlt" });
  store.addEvent({ type: "agent", actor: "agent:claude", scope: "write" }, id, { kind: "question", body: "Welcher Preis?" });

  const browser = await Browser.launch(chrome!);
  try {
    await browser.send("WebAuthn.enable");
    await browser.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const h1 = (text: string) => `document.querySelector("h1")?.textContent.trim().startsWith(${JSON.stringify(text)})`;

    await browser.navigate(`${origin}/`);
    await browser.waitFor(h1("Einrichten"), "the setup page");
    await browser.evaluate(`document.querySelector("[name=code]").value = ${JSON.stringify(code)}; document.querySelector("form[data-passkey] button").click()`);
    await browser.waitFor(h1("Übersicht"), "the overview after setup", 10000);
    assert.equal(auth.listCredentials().length, 1);

    await browser.evaluate(`document.querySelector("form[action='/logout'] button").click()`);
    await browser.waitFor(h1("Anmelden"), "the sign-in page");
    await browser.evaluate(`document.querySelector("form[data-passkey] button").click()`);
    await browser.waitFor(h1("Übersicht"), "the overview after sign-in", 10000);

    await browser.navigate(`${origin}/entries/${id}`);
    await browser.evaluate(`document.querySelector("textarea[name=body]").value = "Der Gesamtpreis"; document.querySelector("form[action$='/events'] button").click()`);
    await browser.waitFor(`document.querySelector("h1 .status")?.textContent === "neu"`, "the answered entry");
    assert.equal(store.getEntry(owner, id).events.at(-1)?.body, "Der Gesamtpreis");

    const { cookies } = await browser.send<{ cookies: { name: string; httpOnly: boolean; secure: boolean; sameSite: string }[] }>("Network.getCookies");
    assert.deepEqual(
      cookies.map(({ name, httpOnly, secure, sameSite }) => ({ name, httpOnly, secure, sameSite })),
      [{ name: "__Host-session", httpOnly: true, secure: true, sameSite: "Strict" }],
    );
    assert.deepEqual(browser.console.filter((line) => /Refused to|exception/.test(line)), []);
  } finally {
    await browser.close();
  }
});
