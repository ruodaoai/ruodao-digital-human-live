const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const base = location.origin;

const stage = $("stage");
const dBase = $("dBase");
const dMouth = $("dMouth");
const subtitle = $("subtitle");
const msgEl = $("msgs");
const form = $("form");
const input = $("q");
const gate = $("gate");
const gateBtn = $("gateBtn");
const quickEl = $("quick");
const micBtn = $("mic");
const endBtn = $("endBtn");
const statusDot = $("statusDot");
const statusText = $("statusText");
const typingEl = $("typing");

const audio = new Audio();
audio.crossOrigin = "anonymous";

let audioCtx = null;
let analyser = null;
let dataArray = null;
let speaking = false;
let speakingUntil = 0;
let subtitleTimer = 0;
let gateOpen = false;
let mouthGain = 0.6;
let mode = "live";
let welcome = "";
let speakReplies = true;
let session = null;
let seen = new Set();
let lastSpoken = "";
let pollTimer = 0;
let polling = false;
let recognizing = false;
let recognition = null;

let visitorId = "";
try { visitorId = localStorage.getItem("dh-visitor") || ""; } catch { visitorId = ""; }
if (!visitorId) {
  visitorId = (crypto.randomUUID?.() || `v_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  try { localStorage.setItem("dh-visitor", visitorId); } catch { /* ignore */ }
}

function addSystem(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.textContent = text;
  msgEl.appendChild(div);
  msgEl.scrollTop = msgEl.scrollHeight;
}

function addMessage(message) {
  if (!message || !message.id || seen.has(message.id)) return false;
  seen.add(message.id);
  const div = document.createElement("div");
  div.className = "msg " + (message.role === "assistant" ? "bot" : message.role === "user" ? "user" : "system");
  div.textContent = message.text;
  msgEl.appendChild(div);
  msgEl.scrollTop = msgEl.scrollHeight;
  return true;
}

async function api(path, init = {}) {
  const headers = { "x-dh-token": token, ...(init.headers || {}) };
  if (init.body) headers["content-type"] = "application/json";
  const res = await fetch(base + path, { ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

function setMouthClip(clip) {
  if (!clip) return;
  stage.style.setProperty("--mouth-top", clip.top + "%");
  stage.style.setProperty("--mouth-right", clip.right + "%");
  stage.style.setProperty("--mouth-bottom", clip.bottom + "%");
  stage.style.setProperty("--mouth-left", clip.left + "%");
}

function setAvatar(url) {
  if (!url) return;
  const full = url.startsWith("http") ? url : base + url;
  dBase.src = full;
  dMouth.src = full;
  dBase.addEventListener("load", () => stage.classList.add("has-avatar"), { once: true });
  dBase.addEventListener("error", () => addSystem("形象图片加载失败，请检查插件里的形象文件。"), { once: true });
}

function ensureAudioGraph() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    audioCtx = new Ctx();
    const src = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.55;
    dataArray = new Uint8Array(analyser.fftSize);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch {
    audioCtx = null;
  }
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

const startedAt = performance.now();
function frame(now) {
  const t = (now - startedAt) / 1000;
  const active = speaking && Date.now() < speakingUntil + 250;
  let open = 0;
  if (active) {
    open = energy();
    if (!open) open = 0.25 + 0.3 * Math.abs(Math.sin(t * 7));
  }
  const scale = 1 + open * mouthGain;
  dMouth.style.transform = `scaleY(${scale})`;
  dMouth.style.opacity = active || speaking ? "1" : "0";
  const breathe = 1 + Math.sin(t * 1.6) * 0.006;
  dBase.style.transform = `scale(${breathe})`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function showSubtitle(text) {
  subtitle.textContent = text;
  subtitle.classList.add("on");
  clearTimeout(subtitleTimer);
  subtitleTimer = setTimeout(() => subtitle.classList.remove("on"), 9000);
}

function speak(text, audioUrl) {
  if (!text) return;
  showSubtitle(text);
  speaking = true;
  speakingUntil = Date.now() + Math.max(2200, text.length * 260);
  if (audioUrl && gateOpen) {
    ensureAudioGraph();
    if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => undefined);
    audio.src = base + audioUrl + (audioUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    audio.play().catch(() => undefined);
  }
}

audio.addEventListener("ended", () => {
  speaking = false;
  speakingUntil = 0;
  dMouth.style.opacity = "0";
});
audio.addEventListener("error", () => {
  speaking = false;
  speakingUntil = 0;
});

function renderStatus(next) {
  const ended = next.status === "ended";
  statusDot.className = "dot " + (ended ? "off" : next.status === "waiting" ? "wait" : "on");
  if (ended) {
    statusText.textContent = "本次接待已结束，继续输入会自动重新排队";
  } else if (next.status === "waiting") {
    statusText.textContent = next.queueTip || `排队中 · 前面还有 ${next.position} 位访客`;
  } else {
    statusText.textContent = next.typing ? "数字人正在回答…" : "数字人正在接待你";
  }
  typingEl.hidden = !next.typing;
  endBtn.hidden = ended;
}

function renderSession(next) {
  if (!next) return;
  session = next;
  for (const message of next.messages || []) addMessage(message);
  renderStatus(next);

  const last = [...(next.messages || [])].reverse().find((message) => message.role === "assistant" && message.audioUrl);
  if (last && last.id !== lastSpoken) {
    lastSpoken = last.id;
    if (speakReplies) speak(last.text, last.audioUrl);
  }
}

async function ensureSession() {
  if (session && session.status !== "ended") return session;
  const data = await api("/api/agent/join", {
    method: "POST",
    body: JSON.stringify({ visitorId, name: "" }),
  });
  seen = new Set();
  msgEl.innerHTML = "";
  lastSpoken = "";
  renderSession(data.session);
  return data.session;
}

async function poll() {
  if (polling || !session) return;
  polling = true;
  try {
    const data = await api(`/api/agent/poll?sessionId=${encodeURIComponent(session.id)}`);
    if (data.session) renderSession(data.session);
    else {
      session = null;
      await ensureSession();
    }
  } catch {
    /* 网络抖动下一轮继续 */
  } finally {
    polling = false;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, document.hidden ? 3000 : 1200);
}

async function send(question) {
  const text = String(question || "").trim();
  if (!text) return;
  input.value = "";
  try {
    await ensureSession();
    const data = await api("/api/agent/message", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, question: text }),
    });
    renderSession(data.session);
    if (data.queued) addSystem("问题已收到，轮到你时数字人会马上回答。");
  } catch (error) {
    if (String(error.message).includes("已结束") || String(error.message).includes("不存在")) {
      session = null;
      try {
        await ensureSession();
        const retry = await api("/api/agent/message", {
          method: "POST",
          body: JSON.stringify({ sessionId: session.id, question: text }),
        });
        renderSession(retry.session);
      } catch (retryError) {
        addSystem("发送失败：" + retryError.message);
      }
      return;
    }
    addSystem("发送失败：" + error.message);
  }
}

function renderQuick(list) {
  quickEl.innerHTML = "";
  const items = Array.isArray(list) ? list.filter(Boolean).slice(0, 4) : [];
  items.forEach((text) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.addEventListener("click", () => send(text));
    quickEl.appendChild(btn);
  });
}

gateBtn.addEventListener("click", () => {
  gateOpen = true;
  gate.classList.add("hidden");
  ensureAudioGraph();
  if (audioCtx?.state === "suspended") audioCtx.resume().catch(() => undefined);
  // 空音频解锁媒体元素，避免第一次 TTS 被自动播放策略拦掉。
  audio.muted = true;
  audio.play().catch(() => undefined).finally(() => {
    try { audio.pause(); } catch { /* ignore */ }
    audio.muted = false;
  });
  if (welcome) speak(welcome, "");
});

micBtn.addEventListener("click", () => {
  if (recognizing) {
    try { recognition?.stop(); } catch { /* ignore */ }
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    addSystem("当前浏览器不支持语音输入，请直接打字。");
    return;
  }
  try {
    recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const text = String(event.results?.[0]?.[0]?.transcript || "").trim();
      if (text) send(text);
    };
    recognition.onerror = (event) => {
      addSystem("语音识别失败：" + (event.error || "请检查麦克风权限"));
    };
    recognition.onend = () => {
      recognizing = false;
      micBtn.classList.remove("on");
    };
    recognition.start();
    recognizing = true;
    micBtn.classList.add("on");
  } catch (error) {
    addSystem("无法启动语音输入：" + error.message);
  }
});

endBtn.addEventListener("click", async () => {
  if (!session) return;
  try {
    const data = await api("/api/agent/end", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id }),
    });
    renderSession(data.session);
    addSystem("接待已结束。继续输入会自动重新排队。");
  } catch (error) {
    addSystem("结束接待失败：" + error.message);
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  send(input.value);
});

document.addEventListener("visibilitychange", startPolling);

async function boot() {
  if (!token) {
    addSystem("缺少访问令牌，无法加载接待助手。");
    return;
  }
  try {
    const info = await api("/api/agent/config");
    const agent = info.agent || {};
    const w = info.widget || {};
    mode = agent.mode || "live";
    welcome = agent.welcome || "你好，我是数字人助手，有什么可以帮你？";
    speakReplies = agent.speakReplies !== false;
    mouthGain = (info.motion && Number(info.motion.mouthGain)) || 0.6;
    document.documentElement.style.setProperty("--accent", (info.widget && info.widget.accent) || "#7c5cff");
    $("pname").textContent = (info.persona && info.persona.name) || "数字人";
    const kind = (info.persona && info.persona.kind) || "real";
    $("ptag").textContent = kind === "cartoon" ? "数字人 · 在线" : "真人接待 · 在线";
    $("footer").textContent = `${agent.modeLabel || "数字人接待"} · Powered by 若道`;
    setMouthClip(info.motion && info.motion.mouthClip);
    setAvatar(info.persona && info.persona.avatarUrl ? info.persona.avatarUrl : "");
    renderQuick(info.quick || w.quick || []);
    await ensureSession();
    startPolling();
  } catch (error) {
    addSystem("接待助手加载失败：" + error.message);
  }
}

boot();
