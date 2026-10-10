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
