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
