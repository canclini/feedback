// Feedback loader for the service's own pages, the same as on every site (docs/EMBED.md): the
// widget loads only in a browser that holds a key for feedback.canclini.dev, so Marcel can point
// at this UI like at any other page. Same origin, so it comes from this server.
(function () {
  try {
    if (!/[#&]feedback-key=/.test(location.hash) && !localStorage.getItem("feedback-key")) return;
  } catch (e) {
    return;
  }
  var script = document.createElement("script");
  script.src = "/v1/feedback.js";
  document.head.appendChild(script);
})();
