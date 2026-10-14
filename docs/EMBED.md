# Wiring a site

What a site needs so its owner can give feedback on it. Ordinary visitors are not affected: the
loader only fetches the widget in a browser that holds a key for the site.

The examples use `https://feedback.example.com` for the service (your `PUBLIC_URL`) and
`https://www.example.com` for the site. The author's own instance is
`https://feedback.canclini.dev`, which is what the canonical loader in this repo names.

## 1. Register the app

Add the app to the registry the service reads (`APPS_PATH`, see "Self-hosting with Docker" in
`README.md` for the fields) and restart the service: the registry is read on start only.

```json
{
  "id": "my-site",
  "name": "My site",
  "origins": ["https://www.example.com"],
  "repo": "example/my-site",
  "branch": "main",
  "local_path": "~/src/my-site"
}
```

The origins must be exact (`https://www.example.com`, no trailing slash); list every origin the
site is served from, including preview or staging hosts you want to comment on. A site key is
accepted only from these origins, and an entry's `url` must be a page on one of them.

The `apps.json` at the root of this repo is the author's registry, not a template to extend:
keep your own file outside the repo, or anywhere `APPS_PATH` can point to.

Check what the service loaded:

```sh
node src/cli.ts apps          # or: docker exec feedback node src/cli.ts apps
```

## 2. The loader

Copy these lines into a JavaScript file the site already loads on every page, or into its own
file loaded with `<script src="...">` in the `<head>`. The canonical copy is
`dev/test-site/loader.js`. Replace `https://feedback.canclini.dev` with your service's
`PUBLIC_URL`; the widget finds the service from the address it was loaded from.

```js
// Feedback loader (github.com/canclini/feedback). Loads the feedback widget
// only in a browser that holds a feedback key for this site, so ordinary
// visitors never contact the feedback service. That browser is the owner's,
// so it also switches Umami off for this site: the owner's own visits, and the
// key in the address the activation lands on, never reach the statistics.
(function () {
  try {
    if (!/[#&]feedback-key=/.test(location.hash) && !localStorage.getItem("feedback-key")) return;
    localStorage.setItem("umami.disabled", "1");
  } catch (e) {
    return;
  }
  var script = document.createElement("script");
  script.src = "https://feedback.canclini.dev/v1/feedback.js";
  document.head.appendChild(script);
})();
```

It must run before a client-side router rewrites the URL fragment, so the key handed over in
`#feedback-key=` is still there. It must also run on the root page of the app's first origin:
activation lands there.

In the browser that holds a key it also sets `umami.disabled` in the site's `localStorage`,
which Umami's tracker checks before every send, so the owner's visits are not counted. It runs
before the tracker's first page view, so the address with `#feedback-key=` never reaches
Umami either. The flag stays when the key is removed; delete it in the browser's storage to be
counted again. A site without Umami can drop that line; it does nothing there.

If the site's analytics tool reports URL fragments and is not Umami, keep it from seeing the
activation address some other way: the fragment carries the site key.

## 3. The deployed version

Each page carries the commit it was built from, so an agent sees which version the owner looked
at:

```html
<meta name="app-version" content="<commit sha>">
```

Vercel: `VERCEL_GIT_COMMIT_SHA` at build time. GitHub Actions: `github.sha`. Without the tag the
entry's `version` is empty; everything else works.

## 4. Content Security Policy

If the site sends a CSP, allow the service for scripts and requests. Styles need nothing: the
widget uses a constructed stylesheet inside its shadow root, which `style-src` does not govern.

```
script-src ... https://feedback.example.com
connect-src ... https://feedback.example.com
```

`dev/test-site.ts` serves a page under exactly such a policy; the browser tests run the widget
on it.

## 5. Activate

In the web UI (`PUBLIC_URL`) → Zugänge → Websites: choose the site and name the device,
"Aktivieren". The browser lands on the app's first origin with the key in the fragment; the
widget stores it in the site's `localStorage` and removes it from the address bar. Alt+K or the
button at the bottom right picks an element.

A key is per site and per browser. For a phone or another browser, sign in to the web UI there
and activate again. Without the web UI, create a key with
`node src/cli.ts site-key create <app> <label>` and open `<origin>/#feedback-key=<key>` in that
browser. Revoke a key under Zugänge or with `site-key revoke <id>`; the widget removes a revoked
key from the browser on its next request. "In diesem Browser ausschalten" in the widget's panel
removes the key from the current browser only; on the service it stays valid until revoked.

## 6. Check it

1. Open the site in a private window: the browser's network tab shows no request to the
   service.
2. Activate the site, pick an element, write a comment: it appears in the web UI under the site.
3. With an agent token: `curl -s -H "Authorization: Bearer $FEEDBACK_TOKEN"
   "https://feedback.example.com/v1/entries?app=my-site"` lists it.

## Privacy

Visitors without a key load nothing from the service, so the site's privacy page needs no
change. The widget sends the page URL, the deployed commit, the element's selector, text and
HTML, the viewport and the browser's user agent of the owner's own browser, with the comment.
The loader turns Umami off only in that browser, so it changes nothing for visitors either.

## Try it locally

```sh
APPS_PATH=dev/apps.json npm start            # service on :8080, test-site app registered
node dev/test-site.ts 8090                   # test site with a strict CSP on :8090
APPS_PATH=dev/apps.json node src/cli.ts site-key create test-site laptop
# open http://localhost:8090/#feedback-key=<key>
```

The test site rewrites the loader's service address to `http://localhost:8080` (or the second
argument of `dev/test-site.ts`).
