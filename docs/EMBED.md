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
`#feedback-key=` is still there.

In the browser that holds a key it also sets `umami.disabled` in the site's `localStorage`,
which Umami's tracker checks before every send, so the owner's visits are not counted. It runs
before the tracker's first page view, so the address with `#feedback-key=` never reaches
Umami either. The flag stays when the key is removed; delete it in the browser's storage to be
counted again.

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
the browser's user agent of the owner's own browser. The loader turns Umami off only in that
browser, so it changes nothing for visitors either.

## Try it locally

```sh
APPS_PATH=dev/apps.json npm start            # service on :8080, test-site app registered
node dev/test-site.ts 8090                   # test site with a strict CSP on :8090
DATABASE_PATH=feedback.db APPS_PATH=dev/apps.json node src/cli.ts site-key create test-site laptop
# open http://localhost:8090/#feedback-key=<key>
```
