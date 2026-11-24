const $ = (id) => document.getElementById(id);
const stage = $("stage");
const bg = $("bg");
const avBase = $("av-base");
const avMouth = $("av-mouth");
const avatarWrap = $("avatar-wrap");
const subtitle = $("subtitle");
const subtitleText = $("subtitle-text");
const ticker = $("ticker");
const tickerText = $("ticker-text");
const clock = $("clock");
const nameEl = $("name");
const badgeEl = $("badge");
const gate = $("gate");
const standby = $("standby");
const srcvideo = $("srcvideo");

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const preview = params.get("preview") === "1";
const base = params.get("api") || location.origin;

let config = null;
let avatarUrl = "";
let audioCtx = null;
let analyser = null;
let audioSource = null;
let dataArray = null;
let freqArray = null;
let speakingUntil = 0;
let speaking = false;
let gateOpen = false;
let subtitleTimer = 0;
let blinkAt = 0;
let blinkPhase = 0;

const audio = new Audio();
audio.crossOrigin = "anonymous";
audio.preload = "auto";

/* 眨眼层：与人像同图重合，闭眼时压缩 */
const avEyes = document.createElement("div");
avEyes.className = "av-eyes";
avatarWrap.insertBefore(avEyes, avMouth);

function fit() {
  const scale = Math.min(window.innerWidth / 1080, window.innerHeight / 1920);
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
window.addEventListener("resize", fit);
fit();

function api(path, init = {}) {
  const headers = { "x-dh-token": token, ...(init.headers || {}) };
  if (init.body) headers["content-type"] = "application/json";
  return fetch(`${base}${path}`, { ...init, headers }).then(async (response) => {
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  });
}

function applyState(state) {
  config = state.config;
  const p = config.persona;
  const s = config.stage;

  document.documentElement.style.setProperty("--accent", s.accent || "#7c5cff");
  document.documentElement.style.setProperty("--bg", s.background || "#08090f");
  stage.style.background = s.background || "#08090f";
  stage.classList.toggle("cutout", Boolean(p.cutout));
  const mclip = config.motion.mouthClip || { top: 56, right: 24, bottom: 8, left: 24 };
  const eclip = config.motion.eyeClip || { top: 30, right: 20, bottom: 54, left: 20 };
  stage.style.setProperty("--mouth-top", mclip.top + "%");
  stage.style.setProperty("--mouth-right", mclip.right + "%");
  stage.style.setProperty("--mouth-bottom", mclip.bottom + "%");
  stage.style.setProperty("--mouth-left", mclip.left + "%");
  stage.style.setProperty("--eye-top", eclip.top + "%");
  stage.style.setProperty("--eye-right", eclip.right + "%");
  stage.style.setProperty("--eye-bottom", eclip.bottom + "%");
  stage.style.setProperty("--eye-left", eclip.left + "%");
  applySource(s);

  nameEl.textContent = p.name || "数字人主播";
  badgeEl.hidden = !s.badge;
  badgeEl.textContent = p.title || "AI 数字人";
  clock.style.display = s.clock ? "" : "none";

  subtitle.style.display = s.subtitle ? "" : "none";
  ticker.classList.toggle("on", Boolean(s.ticker?.enabled));
  tickerText.textContent = s.ticker?.text || "";
  ticker.style.display = s.ticker?.enabled ? "" : "none";

  const target = state.personas.find((item) => item.id === p.avatarId);
  const nextUrl = target ? `${base}${target.url}` : "";
  // 竖图铺满、横图完整显示：横图直接 cover 会把人像裁成一条，
  // 这是用户反馈「图片看不全 / 预览白板」的主要原因。
  const ratio = target && target.width && target.height ? target.width / target.height : 0.75;
  const fit = p.fit === "cover" || p.fit === "contain" ? p.fit : (ratio >= 0.8 ? "contain" : "cover");
  stage.style.setProperty("--avatar-fit", fit);
  stage.classList.toggle("avatar-contain", fit === "contain");
  if (nextUrl && nextUrl !== avatarUrl) setAvatar(nextUrl);
  if (!nextUrl) clearAvatar();

  standby.hidden = Boolean(target);
  if (state.script?.current) showSubtitle(state.script.current.text);
}

function setAvatar(url) {
  avatarUrl = url;
  // 用真实 <img> 而不是 div 背景图：背景图在 transform/will-change 合成层里
  // 偶发不重绘，表现为舞台一片空白；img 有 load/error，能给出可诊断的反馈。
  avBase.src = url;
  avMouth.src = url;
  bg.src = url;
  avEyes.style.backgroundImage = `url("${url}")`;
  avBase.classList.remove("on");
  avMouth.classList.remove("on");
  bg.classList.remove("on");
  avEyes.classList.remove("on");
}

avBase.addEventListener("load", () => {
  avBase.classList.add("on");
  avMouth.classList.add("on");
  bg.classList.add("on");
  avEyes.classList.add("on");
  standby.hidden = true;
});
avBase.addEventListener("error", () => {
  standby.hidden = false;
  standby.textContent = "形象图片加载失败，请重新上传";
});

bg.addEventListener("error", () => {
  bg.classList.remove("on");
});

function applySource(s) {
  const src = (s && s.source) || {};
  if (!src.enabled || !src.url) {
    try { srcvideo.pause(); } catch { /* ignore */ }
    srcvideo.style.display = "none";
    return;
  }
  if (srcvideo.dataset.src !== src.url) {
    srcvideo.dataset.src = src.url;
    srcvideo.src = src.url;
  }
  srcvideo.style.display = "";
  srcvideo.classList.toggle("contain", src.fit === "contain");
  srcvideo.muted = src.muted !== false;
  srcvideo.loop = true;
  srcvideo.play().catch(() => undefined);
}

function clearAvatar() {
  avatarUrl = "";
  avBase.removeAttribute("src");
  avMouth.removeAttribute("src");
  bg.removeAttribute("src");
  avEyes.style.backgroundImage = "";
  avBase.classList.remove("on");
  avMouth.classList.remove("on");
  avEyes.classList.remove("on");
  bg.classList.remove("on");
}

function showSubtitle(text) {
  subtitleText.textContent = text;
  subtitleText.style.fontSize = text.length > 46 ? "30px" : text.length > 30 ? "34px" : "40px";
  subtitle.classList.add("on");
  clearTimeout(subtitleTimer);
  subtitleTimer = setTimeout(() => subtitle.classList.remove("on"), 9000);
}

function ensureAudioGraph() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    audioCtx = new Ctx();
    audioSource = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.5;
    dataArray = new Uint8Array(analyser.fftSize);
    freqArray = new Uint8Array(analyser.frequencyBinCount);
    audioSource.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch {
    audioCtx = null;
  }
}

async function unlockAudio() {
  ensureAudioGraph();
  const hint = document.getElementById("gate-hint");
  try {
    if (audioCtx?.state === "suspended") await audioCtx.resume();
    // 用 1 帧静音缓冲解锁 AudioContext，避免拿空 src 调 audio.play() 被拒绝。
    if (audioCtx) {
      const buffer = audioCtx.createBuffer(1, 1, 22050);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start(0);
    }
  } catch { /* 浏览器不支持 WebAudio 时继续走 audio 元素 */ }
  gateOpen = true;
  gate.classList.add("hidden");
  if (hint) hint.textContent = "声音已启用，正在播放当前话术…";
  // 用户点「启用声音」期待立刻有反应：直接让主播说下一句，字幕/口型/语音一起走。
  try {
    await api("/api/script/next", { method: "POST", body: "{}" });
  } catch (error) {
    if (hint) hint.textContent = `声音已启用，但话术播放失败：${error.message}`;
  }
}

gate.addEventListener("click", () => {
  unlockAudio().catch(() => undefined);
});

audio.addEventListener("error", () => {
  const hint = document.getElementById("gate-hint");
  if (hint) hint.textContent = "语音音频加载失败，请检查本地语音是否可用";
});

audio.addEventListener("ended", () => {
  speaking = false;
  speakingUntil = 0;
  avMouth.classList.remove("speaking");
});

function playCue(cue) {
  showSubtitle(cue.text);
  avMouth.classList.add("speaking");
  speaking = true;
  const duration = Number(cue.durationMs) || Math.max(2200, cue.text.length * 260);
  speakingUntil = Date.now() + duration + 400;

  if (cue.hasAudio && cue.audioUrl) {
    ensureAudioGraph();
    if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => undefined);
    audio.src = `${base}${cue.audioUrl}?token=${encodeURIComponent(token)}&t=${Date.now()}`;
    audio.play().then(() => {
      gateOpen = true;
      gate.classList.add("hidden");
      audio.muted = false;
    }).catch((error) => {
      const hint = document.getElementById("gate-hint");
      if (hint) hint.textContent = `语音播放失败：${error?.message || "请再点一次启用声音"}`;
      if (!gateOpen) gate.classList.remove("hidden");
    });
  } else {
    audio.pause();
  }
  clearTimeout(subtitleTimer);
  subtitleTimer = setTimeout(() => subtitle.classList.remove("on"), duration + 2600);
}

function energy() {
  if (!analyser || !dataArray) return 0;
  analyser.getByteTimeDomainData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i += 1) {
    const value = (dataArray[i] - 128) / 128;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / dataArray.length) * 3.4);
}

function bandLevels() {
  if (!analyser || !freqArray) return { low: 0, mid: 0, high: 0 };
  analyser.getByteFrequencyData(freqArray);
  const n = freqArray.length;
  let low = 0, mid = 0, high = 0;
  for (let i = 0; i < n; i += 1) {
    const v = freqArray[i] / 255;
    if (i < n * 0.18) low += v;
    else if (i < n * 0.5) mid += v;
    else high += v;
  }
  const norm = (sum, count) => Math.min(1, (sum / Math.max(1, count)) * 2.4);
  return { low: norm(low, n * 0.18), mid: norm(mid, n * 0.32), high: norm(high, n * 0.5) };
}

let start = performance.now();
function frame(now) {
  const t = (now - start) / 1000;
  const m = config?.motion || {};
  const amount = Number(m.intensity ?? 0.6);
  const lively = (m.style === "lively") || (m.style !== "calm" && config?.persona?.kind === "cartoon");
  const scale = lively ? 1.55 : 1;

  const breath = m.breath ? Math.sin(t * 1.5) * 0.004 * amount * scale : 0;
  const sway = m.sway ? Math.sin(t * 0.42) * 0.55 * amount * scale : 0;
  const bob = m.breath ? Math.sin(t * 1.5 + 0.6) * 0.28 * amount * scale : 0;
  const active = speaking && Date.now() < speakingUntil + 200;

  let headY = 0, headTilt = 0;
  if (m.head) {
    const speed = lively ? 1.7 : 0.9;
    headY = Math.sin(t * speed + 0.3) * (lively ? 3.4 : 1.6) * amount;
    headTilt = Math.sin(t * speed * 0.7) * (lively ? 0.5 : 0.22) * amount;
  }
  let gestureY = 0;
  if (m.gesture && active) gestureY = -Math.abs(Math.sin(t * 4.2)) * (lively ? 10 : 5) * amount;

  avatarWrap.style.transform =
    "translateY(" + (bob + headY + gestureY).toFixed(2) + "px) rotate(" + (sway + headTilt).toFixed(2) + "deg) " +
    "scale(" + (1 + breath).toFixed(4) + "," + (1 + breath * 0.6).toFixed(4) + ")";

  const gain = Number(m.mouthGain ?? 0.6);
  let open = 0, width = 0;
  if (active && m.mouth) {
    const bands = bandLevels();
    open = bands.low * 0.6 + bands.mid * 0.5;
    width = bands.high * 0.5 + bands.mid * 0.3;
    if (!open && !width) {
      const f = Math.abs(Math.sin(t * 7.5));
      open = 0.3 + 0.35 * f; width = 0.2 + 0.3 * f;
    }
    open = Math.min(1, open * (0.7 + gain));
    width = Math.min(1, width * (0.7 + gain));
  } else if (speaking && !active) {
    speaking = false;
    avMouth.classList.remove("speaking");
  }
  const sy = (1 + open * 0.16 * gain).toFixed(3);
  const sx = (1 + width * 0.07 * gain).toFixed(3);
  const dy = (-open * 5 * amount).toFixed(2);
  avMouth.style.transform = "translateY(" + dy + "px) scale(" + sx + "," + sy + ")";

  if (m.blink) {
    const cycle = 2.6 + (Math.sin(t * 0.7) + 1) * 1.7;
    const phase = t % cycle;
    const closing = phase < 0.12;
    avEyes.style.opacity = closing ? "1" : "0";
    avEyes.style.transform = closing ? "scaleY(0.05)" : "scaleY(1)";
  } else {
    avEyes.style.opacity = "0";
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function tickClock() {
  const now = new Date();
  clock.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}
tickClock();
setInterval(tickClock, 15000);

function listen() {
  const source = new EventSource(`${base}/api/events?token=${encodeURIComponent(token)}`);
  source.addEventListener("state", (event) => {
    try { applyState(JSON.parse(event.data)); } catch { /* ignore */ }
  });
  source.addEventListener("cue", (event) => {
    try { playCue(JSON.parse(event.data)); } catch { /* ignore */ }
  });
  source.addEventListener("control", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.action === "stop") {
        audio.pause();
        speaking = false;
        avMouth.classList.remove("speaking");
        subtitle.classList.remove("on");
      }
    } catch { /* ignore */ }
  });
  source.addEventListener("error", () => {
    setTimeout(listen, 2000);
    source.close();
  });
}

async function boot() {
  if (preview) {
    // 预览不是独立演出页：闸门不能整屏遮挡人像，否则用户只看到一块白板。
    // 保留底部一颗「启用声音」按钮，点击后仍在 iframe 内获得用户手势，
    // 预览里的口型/字幕/语音才能同步动起来。
    gate.classList.add("preview-mode");
    const hint = document.getElementById("gate-hint");
    if (hint) hint.textContent = "点击后数字人立即开口，声音与口型同步";
  }
  if (!token) {
    standby.textContent = "缺少访问令牌";
    return;
  }
  try {
    applyState(await api("/api/state"));
    listen();
  } catch (error) {
    standby.textContent = `舞台加载失败：${error.message}`;
  }
}

boot();