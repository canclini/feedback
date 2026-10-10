// Passkey setup, sign-in and adding a passkey. A form opts in with
// data-passkey="setup" | "login" | "register"; errors go to its
// [data-passkey-error] element.

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Das ging nicht.");
  return data;
}

async function register(form, setup) {
  const fields = new FormData(form);
  const start = setup
    ? await post("/auth/setup/options", { code: fields.get("code") })
    : await post("/auth/register/options", {});
  const credential = await navigator.credentials.create({
    publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(start.options),
  });
  await post("/auth/register/verify", {
    ceremony: start.ceremony,
    response: credential.toJSON(),
    name: fields.get("name"),
  });
}

async function signIn() {
  const start = await post("/auth/login/options", {});
  const credential = await navigator.credentials.get({
    publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(start.options),
  });
  await post("/auth/login/verify", { ceremony: start.ceremony, response: credential.toJSON() });
}

for (const form of document.querySelectorAll("[data-passkey]")) {
  const error = form.querySelector("[data-passkey-error]");
  const button = form.querySelector("button");
  if (!window.PublicKeyCredential?.parseCreationOptionsFromJSON) {
    error.textContent = "Dieser Browser unterstützt Passkeys nicht oder ist zu alt.";
    button.disabled = true;
    continue;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    button.disabled = true;
    try {
      const mode = form.dataset.passkey;
      if (mode === "login") await signIn();
      else await register(form, mode === "setup");
      location.href = mode === "register" ? "/access" : "/";
    } catch (err) {
      error.textContent = err.name === "NotAllowedError" ? "Abgebrochen oder nicht erlaubt." : err.message;
      button.disabled = false;
    }
  });
}
