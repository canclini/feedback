# Wiring a site

What a site needs so Marcel can give feedback on it. Ordinary visitors are not affected: the
loader only fetches the widget in a browser that holds a key for the site.

## 1. Register the app

Add the app to `apps.json` in this repo (id, name, origins, repo, deploy branch, local path) and
deploy the service. The origins must be exact (`https://www.akkordo.ch`, no trailing slash);
list every origin the site is served from.

## 2. The loader

Copy these lines into a JavaScript file the site already loads on every page, or into its own
file loaded with `<script src="...">` in the `<head>`. The canonical copy is
`dev/test-site/loader.js`.

```js
// Feedback loader (github.com/canclini/feedback). Loads the feedback widget
// only in a browser that holds a feedback key for this site, so ordinary
// visitors never contact the feedback service.
(function () {
  try {
    if (!/[#&]feedback-key=/.test(location.hash) && !localStorage.getItem("feedback-key")) return;
  } catch (e) {
    return;
  }
  var script = document.createElement("script");
  script.src = "https://feedback.canclini.dev/v1/feedback.js";
  document.head.appendChild(script);
})();
```

It must run before a client-side router rewrites the URL fragment, so the key handed over in
`#feedback-key=` is still there.

## 3. The deployed version

Each page carries the commit it was built from, so an agent sees which version Marcel looked at:

```html
<meta name="app-version" content="<commit sha>">
```

Vercel: `VERCEL_GIT_COMMIT_SHA` at build time. GitHub Actions: `github.sha`.

## 4. Content Security Policy

If the site sends a CSP, allow the service for scripts and requests. Styles need nothing: the
widget uses a constructed stylesheet inside its shadow root, which `style-src` does not govern.

```
script-src ... https://feedback.canclini.dev
connect-src ... https://feedback.canclini.dev
```

## 5. Activate

On feedback.canclini.dev → Zugänge → Websites: choose the site and the device, "Aktivieren".
The browser lands on the site with the key; the widget stores it in the site's `localStorage`
and removes it from the address bar. Alt+K or the button at the bottom right picks an element.

## Privacy

Visitors without a key load nothing from the service, so the site's privacy page needs no
change. The widget sends the page URL, the element's selector, text and HTML, the viewport and
the browser's user agent of the owner's own browser.

## Try it locally

```sh
APPS_PATH=dev/apps.json npm start            # service on :8080, test-site app registered
node dev/test-site.ts 8090                   # test site with a strict CSP on :8090
DATABASE_PATH=feedback.db APPS_PATH=dev/apps.json node src/cli.ts site-key create test-site laptop
# open http://localhost:8090/#feedback-key=<key>
```
