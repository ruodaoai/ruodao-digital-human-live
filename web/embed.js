(function () {
  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName("script");
    script = all[all.length - 1];
  }
  var src = (script && script.src) || "";
  var url;
  try { url = new URL(src, location.href); } catch (e) { return; }
  var token = url.searchParams.get("token") || "";
  var base = url.origin;
  var pos = url.searchParams.get("pos") === "left" ? "left" : "right";
  if (document.getElementById("dh-embed-btn")) return;

  var btn = document.createElement("button");
  btn.id = "dh-embed-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", "打开数字人接待");
  btn.textContent = "💬";
  btn.style.cssText =
    "position:fixed;bottom:22px;" + (pos === "left" ? "left:22px;" : "right:22px;") +
    "z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;" +
    "font-size:26px;line-height:60px;text-align:center;color:#fff;" +
    "box-shadow:0 10px 30px rgba(108,76,255,.5);background:linear-gradient(135deg,#7c5cff,#4f8cff);";

  var frame = document.createElement("iframe");
  frame.id = "dh-embed-frame";
  frame.title = "数字人接待";
  frame.allow = "autoplay";
  frame.style.cssText =
    "position:fixed;bottom:92px;" + (pos === "left" ? "left:22px;" : "right:22px;") +
    "z-index:2147483000;width:380px;height:600px;max-width:calc(100vw - 32px);max-height:calc(100vh - 120px);" +
    "border:0;border-radius:18px;box-shadow:0 24px 70px rgba(0,0,0,.35);display:none;background:transparent;";
  frame.src = base + "/widget?token=" + encodeURIComponent(token) + "&embed=1";

  btn.addEventListener("click", function () {
    frame.style.display = frame.style.display === "none" ? "block" : "none";
  });

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(btn);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();