const VOICES = [
  ["zh-CN-XiaoxiaoNeural", "晓晓 · 女声 · 温柔自然"],
  ["zh-CN-XiaoyiNeural", "晓伊 · 女声 · 活泼甜美"],
  ["zh-CN-YunxiNeural", "云希 · 男声 · 阳光青年"],
  ["zh-CN-YunjianNeural", "云健 · 男声 · 沉稳磁性"],
  ["zh-CN-YunyangNeural", "云扬 · 男声 · 专业播报"],
  ["zh-CN-liaoning-XiaobeiNeural", "晓北 · 女声 · 东北口音"],
  ["zh-CN-shaanxi-XiaoniNeural", "晓妮 · 女声 · 陕西口音"],
  ["zh-HK-HiuMaanNeural", "曉曼 · 粤语女声"],
  ["zh-TW-HsiaoChenNeural", "曉臻 · 台湾女声"],
];

const SAMPLE_LINES = [
  "欢迎来到直播间，我是你的 AI 数字人主播，点点关注不迷路。",
  "今天这场直播，我会一直陪着你，有问题直接打在公屏上。",
  "新进来的朋友，先点个关注，再看一眼下方的小黄车。",
  "觉得主播说得还行，帮我点个赞，让更多人看到。",
  "整点会有一波福利，别走开，马上就到。",
];

const PLATFORMS = [
  { id: "douyin", name: "抖音" },
  { id: "kuaishou", name: "快手" },
  { id: "shipinhao", name: "微信视频号" },
  { id: "bilibili", name: "哔哩哔哩" },
  { id: "youtube", name: "YouTube" },
  { id: "custom", name: "自定义 RTMP / SRT" },
];

const $ = (id) => document.getElementById(id);
const el = {
  app: $("app"),
  svc: $("svc-pill"),
  tts: $("tts-pill"),
  live: $("live-pill"),
  mode: $("mode-label"),
  personas: $("persona-list"),
  count: $("persona-count"),
  file: $("avatar-file"),
  zone: $("upload-zone"),
  frame: $("stage-frame"),
  empty: $("phone-empty"),
  cue: $("cue-label"),
  toast: $("toast"),
  drop: $("drop"),
  ttsHint: $("tts-hint"),
  ttsInstall: $("tts-install"),
  engineStatus: $("engine-status"),
  retryConnect: $("retry-connect"),
  savePill: $("save-pill"),
  phoneLoading: $("phone-loading"),
  scriptCount: $("script-count"),
};

let base = "";
let token = "";
let host = null;
let hostInfo = null;
let stageLoadTimer = 0;
let state = null;
let formReady = false;
let saveTimer = 0;
let toastTimer = 0;
let liveOn = false;
let stageWindow = null;
let saveChain = Promise.resolve();
let lastPersonas = "";

function toast(message, kind = "") {
  el.toast.textContent = message;
  el.toast.className = `toast ${kind}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function setPill(node, text, kind = "") {
  node.className = `pill ${kind}`;
  node.innerHTML = `<i></i><span>${text}</span>`;
}

async function api(path, init = {}) {
  const headers = { "x-dh-token": token, ...(init.headers || {}) };
  if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function connect() {
  host = window.ruodao && window.ruodao.service ? window.ruodao : null;
  if (host) {
    hostInfo = await host.ready;
    await host.service.start("main", { payload: {}, readyTimeoutMs: 30000 });
    const info = await host.service.call("main", "runtime");
    base = info.url;
    token = info.token;
    el.mode.textContent = "本地服务已连接";
  } else {
    base = location.origin;
    token = new URLSearchParams(location.search).get("token") || "";
    el.mode.textContent = base.includes("127.0.0.1") ? "独立模式" : "未连接插件宿主";
  }
  if (!token) throw new Error("缺少访问令牌：请从插件入口打开，或在地址后加 ?token=");
  setPill(el.svc, "服务正常", "ok");
}

async function loadState() {
  state = await api("/api/state");
  applyState(state, true);
}

function applyState(next, first = false) {
  state = next;
  setPill(el.svc, "服务正常", "ok");
  const tts = next.tts || {};
  if (tts.available) {
    setPill(el.tts, tts.engine === "edge-tts" ? "语音 · edge-tts" : "语音 · 系统", "ok");
    el.ttsInstall.hidden = true;
    el.ttsHint.textContent = tts.detail || "";
  } else {
    setPill(el.tts, "语音未安装", "err");
    el.ttsInstall.hidden = false;
    el.ttsHint.textContent = tts.hint || "未检测到本地语音合成";
  }
  renderPersonas(next.personas || []);
  renderEngine(next.engine || {});
  if (!formReady) fillForm(next.config);
  if (first) el.app.dataset.boot = "ready";
  renderCue(next.script?.current);
  const activeP = (next.personas || []).find(function (x) { return x.id === (next.config && next.config.persona ? next.config.persona.avatarId : ""); });
  const kindNow = activeP ? activeP.kind : "real";
  document.querySelectorAll("#kind-seg .seg-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.kind === kindNow); });
  renderStream(next.stream);
  renderWidgetStats(next.widgetStats);
  renderChecks(next);
  renderSteps(next);
  updateScriptCount();
}

/** 顶部开播流程步骤条：形象 → 声音 → 话术 → 开播，实时反映完成状态。 */
function renderSteps(next) {
  const active = (next.personas || []).find((item) => item.id === next.config?.persona?.avatarId);
  const tts = next.tts || {};
  const lines = (next.config?.script?.lines || []).filter(Boolean);
  const stepPersona = $("step-persona");
  const stepVoice = $("step-voice");
  const stepScript = $("step-script");
  const stepLive = $("step-live");
  if (stepPersona) stepPersona.textContent = active ? active.name || "已就绪" : "还没上传照片";
  if (stepVoice) stepVoice.textContent = tts.available ? (tts.engine === "edge-tts" ? "edge-tts 已就绪" : "系统语音已就绪") : "未安装语音";
  if (stepScript) stepScript.textContent = lines.length ? `${lines.length} 句` : "还没写话术";
  if (stepLive) stepLive.textContent = liveOn ? "直播进行中" : "浏览器源 / 推流";
  const done = { persona: Boolean(active), voice: Boolean(tts.available), script: lines.length > 0, live: liveOn };
  document.querySelectorAll("#flow-steps .step").forEach((node) => {
    const key = node.dataset.step;
    node.classList.toggle("done", Boolean(done[key]));
    node.classList.toggle("active", key === "live" && liveOn);
  });
}

function focusScriptDock() {
  const dock = document.querySelector(".dock");
  const area = $("script-lines");
  if (dock && dock.classList.contains("collapsed")) $("dock-toggle").click();
  if (area) { area.focus(); area.scrollIntoView({ behavior: "smooth", block: "center" }); }
}

function switchTab(tab) {
  document.querySelectorAll("#tab-nav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  document.querySelectorAll("#tab-panels .tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.tab === tab);
  });
}

function wireTabs() {
  $("tab-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    switchTab(button.dataset.tab);
  });
  $("flow-steps").addEventListener("click", (event) => {
    const button = event.target.closest("[data-step]");
    if (!button) return;
    const step = button.dataset.step;
    if (step === "persona") { switchTab("host"); el.zone.scrollIntoView({ behavior: "smooth", block: "center" }); el.zone.click(); }
    else if (step === "voice") { switchTab("host"); const voice = $("p-voice"); if (voice) { voice.focus(); voice.scrollIntoView({ behavior: "smooth", block: "center" }); } }
    else if (step === "script") { focusScriptDock(); }
    else if (step === "live") { $("go-live").click(); }
  });
}

function fillForm(config) {
  if (!config) return;
  const p = config.persona;
  const s = config.stage;
  const m = config.motion;
  const sc = config.script;

  $("p-fit").value = p.fit || "auto";

  $("p-name").value = p.name || "";
  $("p-bio").value = p.bio || "";
  $("p-voice").innerHTML = VOICES.map(([id, label]) =>
    `<option value="${id}"${id === p.voice ? " selected" : ""}>${label}</option>`).join("");
  $("p-rate").value = p.rate;
  $("pitch-val").textContent = p.pitch;
  $("rate-val").textContent = p.rate;
  $("p-pitch").value = p.pitch;

  $("s-accent").value = s.accent;
  $("s-bg").value = s.background;
  $("s-subtitle").checked = Boolean(s.subtitle);
  $("s-clock").checked = Boolean(s.clock);
  $("s-badge").checked = Boolean(s.badge);
  $("s-ticker").checked = Boolean(s.ticker?.enabled);
  $("s-ticker-text").value = s.ticker?.text || "";

  $("m-breath").checked = Boolean(m.breath);
  $("m-blink").checked = Boolean(m.blink);
  $("m-sway").checked = Boolean(m.sway);
  $("m-mouth").checked = Boolean(m.mouth);
  $("m-intensity").value = Math.round(m.intensity * 100);
  $("intensity-val").textContent = `${Math.round(m.intensity * 100)}%`;

  document.querySelectorAll('input[name="engine"]').forEach((input) => {
    input.checked = input.value === m.engine;
  });
  $("e-url").value = m.localUrl || "";
  $("e-url").disabled = m.engine !== "local";
  $("e-probe").disabled = m.engine !== "local";

  $("m-head").checked = m.head !== false;
  $("m-gesture").checked = Boolean(m.gesture);
  $("m-style").value = m.style || "auto";
  var mg = (m.mouthGain == null ? 0.6 : m.mouthGain);
  $("m-gain").value = Math.round(mg * 100);
  $("mgain-val").textContent = Math.round(mg * 100) + "%";
  var mc = m.mouthClip || { top: 56, bottom: 8 };
  var ec = m.eyeClip || { top: 30, bottom: 54 };
  $("mi-top").value = mc.top; $("mi-top-val").textContent = mc.top + "%";
  $("mi-bottom").value = mc.bottom; $("mi-bottom-val").textContent = mc.bottom + "%";
  $("ei-top").value = ec.top; $("ei-top-val").textContent = ec.top + "%";
  $("ei-bottom").value = ec.bottom; $("ei-bottom-val").textContent = ec.bottom + "%";

  var stf = config.stream || {};
  fillPlatforms(stf.platform || "custom");
  $("st-url").value = stf.rtmpUrl || "";
  $("st-key").value = stf.streamKey || "";
  $("st-fps").value = stf.fps || 25;
  $("st-size").value = stf.size || "1080x1920";
  $("st-audio").checked = stf.withAudio !== false;

  var wf = config.widget || {};
  $("w-enabled").checked = wf.enabled !== false;
  $("w-title").value = wf.title || "";
  $("w-greeting").value = wf.greeting || "";
  $("w-faqs").value = (wf.faqs || []).map(function (f) { return f.q + "|" + f.a; }).join(String.fromCharCode(10));
  $("w-knowledge").value = wf.knowledge || "";
  $("w-speak-greeting").checked = wf.speakGreeting !== false;
  var llm = wf.llm || {};
  $("w-llm-enabled").checked = Boolean(llm.enabled);
  $("w-llm-url").value = llm.baseUrl || "";
  $("w-llm-model").value = llm.model || "";
  $("w-llm-key").value = llm.apiKey || "";
  $("w-llm-prompt").value = llm.systemPrompt || "";
  var ag = wf.agent || {};
  $("a-mode").value = ["live", "solo", "round-robin"].includes(ag.mode) ? ag.mode : "live";
  $("a-max").value = String(ag.maxActive || 3);
  $("a-idle").value = String(ag.idleSeconds || 90);
  $("a-queue-tip").value = ag.queueTip || "";
  $("a-welcome").value = ag.welcome || "";
  $("a-host-llm").checked = ag.useHostLlm !== false;
  $("a-speak").checked = ag.speakReplies !== false;

  $("script-auto").checked = Boolean(sc.auto);
  $("script-interval").value = Math.round(sc.intervalMs / 1000);
  $("script-lines").value = (sc.lines || []).join("\n");
  if (s.accent) document.documentElement.style.setProperty("--accent", s.accent);
  updateScriptCount();

  formReady = true;
  refreshStage();
}

function renderPersonas(list) {
  el.count.textContent = String(list.length);
  const signature = list.map((item) => item.id).join(",");
  if (signature === lastPersonas) return;
  lastPersonas = signature;
  el.personas.innerHTML = list.map((item) => `
    <div class="persona${item.id === state?.config?.persona?.avatarId ? " active" : ""}" data-id="${item.id}">
      <img src="${base}${item.url}" alt="${escapeHtml(item.name)}" loading="lazy" />
      <span class="name">${escapeHtml(item.name)}</span>
      <button type="button" class="del" data-del="${item.id}" title="删除">×</button>
    </div>`).join("");
  el.empty.hidden = list.length > 0;
  const fallback = $("phone-fallback");
  if (fallback) {
    const active = list.find((item) => item.id === (state?.config?.persona?.avatarId || "")) || list[0];
    if (active) {
      fallback.src = `${base}${active.url}`;
      fallback.hidden = false;
    } else {
      fallback.removeAttribute("src");
      fallback.hidden = true;
    }
  }
  if (state) renderChecks(state);
}

function renderEngine(engine) {
  const mode = engine.mode || "still";
  document.querySelectorAll('input[name="engine"]').forEach((input) => {
    input.checked = input.value === mode;
  });
  $("e-url").disabled = mode !== "local";
  $("e-probe").disabled = mode !== "local";
  if (mode === "still") {
    el.engineStatus.textContent = "静态真人：照片 + 呼吸/眨眼/音频驱动口型，零依赖，立即可用。";
  } else if (engine.online) {
    el.engineStatus.textContent = `本地引擎在线 · ${engine.engine || "未知"}${engine.fps ? ` · ${engine.fps}fps` : ""}${engine.gpuName ? ` · ${engine.gpuName}` : ""}`;
  } else {
    el.engineStatus.textContent = `本地引擎未连接${engine.error ? `（${engine.error}）` : ""}。可运行 scripts/install-engine.ps1 安装。`;
  }
}

function renderWidgetStats(s) {
  var el = $("w-stats");
  if (!el) return;
  if (!s) { el.textContent = "接待数据：暂无"; return; }
  var src = s.bySource || {};
  el.textContent = "接待数据：访问 " + (s.opens || 0) + " · 提问 " + (s.asks || 0) + " · 命中率 " + (s.hitRate || 0) + "%（LLM " + (src.llm || 0) + " / 问答 " + (src.faq || 0) + " / 知识库 " + (src.kb || 0) + " / 兜底 " + (src.fallback || 0) + "）";
}

function renderStream(status) {
  if (!status) return;
  var deps = status.deps || {};
  var configured = Boolean(state && state.config && state.config.stream && state.config.stream.rtmpUrl);
  setCheck("stream",
    status.running ? "推流中" : status.error ? "推流失败" : deps.ready === false ? "缺 ffmpeg" : configured ? "已配置" : "网页源",
    status.running ? "ok" : status.error || deps.ready === false ? "warn" : configured ? "ok" : "");
  if (status.running) {
    var sec = Math.round((status.elapsedMs || 0) / 1000);
    $("st-status").textContent = "推流中 · " + (status.platform || "") + " · " + sec + "s" + (status.error ? " · " + status.error : "");
  } else if (status.error) {
    $("st-status").textContent = "推流失败：" + status.error;
  } else {
    $("st-status").textContent = deps.ready === false
      ? "未检测到 ffmpeg，无法推流；网页直播（浏览器源）仍可用。"
      : "未开始。网页直播请用顶部「一键开播」的浏览器源。";
  }
}

function fillPlatforms(selected) {
  var sel = $("st-platform");
  if (sel.dataset.ready) { if (selected) sel.value = selected; return; }
  sel.innerHTML = PLATFORMS.map(function (x) { return '<option value="' + x.id + '">' + x.name + "</option>"; }).join("");
  sel.dataset.ready = "1";
  if (selected) sel.value = selected;
}

function currentKind() {
  return document.querySelector("#kind-seg .seg-btn.active")?.dataset.kind || "real";
}

function parseFaqs(text) {
  return String(text || "").split(String.fromCharCode(10)).map(function (line) {
    var idx = line.indexOf("|");
    if (idx < 0) return null;
    return { q: line.slice(0, idx).trim(), a: line.slice(idx + 1).trim() };
  }).filter(function (x) { return x && x.q && x.a; }).slice(0, 60);
}

function renderCue(cue) {
  if (!cue) { el.cue.textContent = "待机"; return; }
  el.cue.textContent = cue.text.length > 34 ? `${cue.text.slice(0, 34)}…` : cue.text;
}

function stageSrc(force = false) {
  const query = new URLSearchParams({ token, preview: "1" });
  if (force) query.set("_r", String(Date.now()));
  // 预览始终从本地服务加载：iframe 与舞台 API 同源，图片、SSE 和音频
  // 都不需要跨协议请求；插件协议页只负责承载外层控制台。
  return `${base}/stage?${query.toString()}`;
}

function refreshStage(force = false) {
  const src = stageSrc(force);
  if (!force && el.frame.dataset.src === src) return;
  if (el.phoneLoading) el.phoneLoading.hidden = false;
  const error = $("phone-error");
  if (error) error.hidden = true;
  el.frame.dataset.src = src;
  el.frame.style.opacity = "0";
  el.frame.src = src;
  clearTimeout(stageLoadTimer);
  stageLoadTimer = setTimeout(() => {
    if (el.frame.style.opacity === "1") return;
    el.frame.style.opacity = "0.001";
    if (el.phoneLoading) el.phoneLoading.hidden = true;
    if (error) error.hidden = false;
  }, 12000);
}

function setSaveState(text, kind = "") {
  if (!el.savePill) return;
  el.savePill.textContent = text;
  el.savePill.className = `pill save ${kind}`.trim();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState("保存中…", "saving");
  saveTimer = setTimeout(() => { saveTimer = 0; void save(); }, 500);
}

async function save() {
  if (!state) return false;
  saveTimer = 0;
  saveChain = saveChain.then(async () => {
    try {
      const result = await api("/api/config", { method: "POST", body: JSON.stringify(gather()) });
      state.config = result.config;
      setSaveState("已保存", "saved");
      return true;
    } catch (error) {
      setSaveState("保存失败", "error");
      toast(`保存失败：${error.message}`, "err");
      return false;
    }
  });
  return saveChain;
}

/** 开播/打开舞台前强制落盘，避免舞台读到 500ms 防抖窗口里的旧配置。 */
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  return save();
}

function gather() {
  const lines = $("script-lines").value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 80);
  const engine = document.querySelector('input[name="engine"]:checked')?.value || "still";
  return {
    persona: {
      name: $("p-name").value.trim() || "小若",
      bio: $("p-bio").value.trim(),
      voice: $("p-voice").value,
      rate: Number($("p-rate").value),
      pitch: Number($("p-pitch").value),
      kind: currentKind(),
      fit: $("p-fit").value,
    },
    stage: {
      accent: $("s-accent").value,
      background: $("s-bg").value,
      subtitle: $("s-subtitle").checked,
      clock: $("s-clock").checked,
      badge: $("s-badge").checked,
      ticker: { enabled: $("s-ticker").checked, text: $("s-ticker-text").value },
    },
    motion: {
      engine,
      localUrl: $("e-url").value.trim() || "http://127.0.0.1:8090",
      breath: $("m-breath").checked,
      blink: $("m-blink").checked,
      sway: $("m-sway").checked,
      mouth: $("m-mouth").checked,
      head: $("m-head").checked,
      gesture: $("m-gesture").checked,
      style: $("m-style").value,
      mouthGain: Number($("m-gain").value) / 100,
      mouthClip: (function () { var c = (state && state.config && state.config.motion && state.config.motion.mouthClip) || {}; return { top: Number($("mi-top").value), right: (c.right == null ? 24 : c.right), bottom: Number($("mi-bottom").value), left: (c.left == null ? 24 : c.left) }; })(),
      eyeClip: (function () { var c = (state && state.config && state.config.motion && state.config.motion.eyeClip) || {}; return { top: Number($("ei-top").value), right: (c.right == null ? 20 : c.right), bottom: Number($("ei-bottom").value), left: (c.left == null ? 20 : c.left) }; })(),
      intensity: Number($("m-intensity").value) / 100,
    },
    script: {
      auto: $("script-auto").checked,
      intervalMs: Math.max(6, Math.min(600, Number($("script-interval").value) || 22)) * 1000,
      lines: lines.length ? lines : ["欢迎来到直播间。"],
    },
    stream: {
      platform: $("st-platform").value,
      rtmpUrl: $("st-url").value.trim(),
      streamKey: $("st-key").value.trim(),
      fps: Number($("st-fps").value) || 25,
      size: $("st-size").value,
      withAudio: $("st-audio").checked,
    },
    widget: {
      enabled: $("w-enabled").checked,
      title: $("w-title").value.trim(),
      greeting: $("w-greeting").value.trim(),
      faqs: parseFaqs($("w-faqs").value),
      knowledge: $("w-knowledge").value,
      agent: {
        mode: $("a-mode").value,
        maxActive: Number($("a-max").value),
        idleSeconds: Number($("a-idle").value),
        queueTip: $("a-queue-tip").value.trim(),
        welcome: $("a-welcome").value.trim(),
        useHostLlm: $("a-host-llm").checked,
        speakReplies: $("a-speak").checked,
      },
      speakGreeting: $("w-speak-greeting").checked,
      llm: {
        enabled: $("w-llm-enabled").checked,
        baseUrl: $("w-llm-url").value.trim(),
        model: $("w-llm-model").value.trim(),
        apiKey: $("w-llm-key").value,
        systemPrompt: $("w-llm-prompt").value,
      },
    },
  };
}

async function uploadFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    toast("只支持 PNG / JPG / WebP", "err");
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    toast("图片超过 12MB", "err");
    return;
  }
  setPill(el.svc, "正在保存形象…");
  if (el.phoneLoading) el.phoneLoading.hidden = false;
  try {
    const dataUrl = await optimizeImage(file);
    const result = await api("/api/persona", {
      method: "POST",
      body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, "").slice(0, 24), dataUrl, kind: currentKind() }),
    });
    state.personas = result.personas;
    state.config.persona.avatarId = result.persona.id;
    lastPersonas = "";
    renderPersonas(result.personas);
    refreshStage(true);
    setPill(el.svc, "服务正常", "ok");
    toast("形象已保存，舞台已更新");
  } catch (error) {
    if (el.phoneLoading) el.phoneLoading.hidden = true;
    setPill(el.svc, "服务正常", "ok");
    toast(`上传失败：${error.message}`, "err");
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片解析失败"));
    image.src = dataUrl;
  });
}

/** 大图先缩到 1920 长边再上传，舞台加载和口型驱动都更稳。 */
async function optimizeImage(file) {
  const raw = await readAsDataUrl(file);
  const image = await loadImage(raw);
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  if (longest <= 1920 && file.size <= 3 * 1024 * 1024) return raw;
  const scale = Math.min(1, 1920 / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return raw;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
  const optimized = canvas.toDataURL(mime, mime === "image/jpeg" ? 0.9 : undefined);
  if (optimized.length >= raw.length) return raw;
  toast("已自动压缩图片，上传更快");
  return optimized;
}

function formatSize(value) {
  return String(value || "1080x1920").replace(/x/i, " × ");
}

async function openUrl(url) {
  if (host && typeof host.openExternal === "function") {
    try {
      await host.openExternal(url);
      return true;
    } catch { /* 宿主不支持时回退到 window.open */ }
  }
  try { return Boolean(window.open(url, "_blank")); } catch { return false; }
}

async function openStage(url) {
  stageWindow = null;
  if (host && typeof host.openExternal === "function") {
    try {
      await host.openExternal(url);
      return true;
    } catch { /* 宿主不支持时回退到 window.open */ }
  }
  try {
    stageWindow = window.open(url, "dh-stage");
    return Boolean(stageWindow);
  } catch { return false; }
}

async function copyText(text) {
  if (host && host.clipboard && typeof host.clipboard.writeText === "function") {
    try {
      await host.clipboard.writeText(text);
      return true;
    } catch { /* 宿主剪贴板不可用时继续走浏览器路径 */ }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 沙箱 iframe 可能没有剪贴板权限，走兼容路径 */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch { return false; }
}

function setCheck(id, text, kind) {
  const node = $("check-" + id);
  if (!node) return;
  node.className = `check ${kind || ""}`.trim();
  const value = node.querySelector("b");
  if (value) value.textContent = text;
}

function renderChecks(next) {
  if (!next) return;
  const personas = next.personas || [];
  const activeId = next.config && next.config.persona ? next.config.persona.avatarId : "";
  const active = personas.find((item) => item.id === activeId);
  const tts = next.tts || {};
  const lines = (next.config && next.config.script && next.config.script.lines || []).filter(Boolean);
  const stream = next.stream || {};
  const streamConfig = next.config && next.config.stream || {};
  const widget = next.config && next.config.widget || {};
  setCheck("persona", active ? "已就绪" : "未上传", active ? "ok" : "warn");
  setCheck("voice", tts.available ? (tts.engine === "edge-tts" ? "edge-tts" : "系统语音") : "未安装", tts.available ? "ok" : "warn");
  setCheck("script", lines.length ? lines.length + " 句" : "0 句", lines.length ? "ok" : "warn");
  setCheck("stream", stream.running ? "推流中" : streamConfig.rtmpUrl ? "已配置" : "网页源", stream.running || streamConfig.rtmpUrl ? "ok" : "");
  setCheck("widget", widget.enabled ? "已启用" : "未启用", widget.enabled ? "ok" : "");
  const sizeLabel = $("stage-size-label");
  if (sizeLabel && next.config) sizeLabel.textContent = formatSize(next.config.stream && next.config.stream.size);
  const tip = $("side-tip");
  if (!tip) return;
  if (!active) tip.textContent = "上传一张正脸照片即可开播，其余配置会自动保存。";
  else if (!lines.length) tip.textContent = "再写几句直播话术，开播后可以自动轮播。";
  else if (!tts.available) tip.textContent = "未检测到语音合成，安装 edge-tts 后数字人才能开口。";
  else tip.textContent = "准备就绪。点击右上角「一键开播」，舞台地址会自动复制。";
}

function updateScriptCount() {
  const node = $("script-count");
  if (!node) return;
  const text = $("script-lines").value || "";
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const chars = text.replace(/\s/g, "").length;
  node.textContent = `${lines.length} 句 · ${chars} 字${lines.length > 80 ? "（仅前 80 句生效）" : ""}`;
  setCheck("script", lines.length ? lines.length + " 句" : "0 句", lines.length ? "ok" : "warn");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function wireEvents() {
  el.frame.addEventListener("load", () => {
    clearTimeout(stageLoadTimer);
    el.frame.style.opacity = "1";
    if (el.phoneLoading) el.phoneLoading.hidden = true;
    const error = $("phone-error");
    if (error) error.hidden = true;
  });

  el.zone.addEventListener("click", () => el.file.click());
  el.file.addEventListener("change", () => {
    uploadFile(el.file.files?.[0]);
    el.file.value = "";
  });

  el.personas.addEventListener("click", async (event) => {
    const del = event.target.closest("[data-del]");
    if (del) {
      event.stopPropagation();
      const id = del.dataset.del;
      if (!confirm("删除这个形象？")) return;
      try {
        const result = await api(`/api/persona/${id}`, { method: "DELETE" });
        state.personas = result.personas;
        lastPersonas = "";
        renderPersonas(result.personas);
        toast("已删除");
      } catch (error) {
        toast(`删除失败：${error.message}`, "err");
      }
      return;
    }
    const card = event.target.closest("[data-id]");
    if (!card) return;
    try {
      const result = await api("/api/config", {
        method: "POST",
        body: JSON.stringify({ persona: { avatarId: card.dataset.id } }),
      });
      state.config = result.config;
      lastPersonas = "";
      renderPersonas(state.personas);
      refreshStage();
    } catch (error) {
      toast(error.message, "err");
    }
  });

  document.addEventListener("dragenter", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      el.drop.hidden = false;
    }
  });
  el.drop.addEventListener("dragover", (event) => event.preventDefault());
  el.drop.addEventListener("dragleave", () => { el.drop.hidden = true; });
  el.drop.addEventListener("drop", (event) => {
    event.preventDefault();
    el.drop.hidden = true;
    uploadFile(event.dataTransfer?.files?.[0]);
  });

  const inputs = document.querySelectorAll(".settings input, .settings select, .settings textarea, .dock input, .dock textarea");
  inputs.forEach((input) => {
    input.addEventListener("input", () => {
      if (input.id === "p-rate") $("rate-val").textContent = input.value;
      if (input.id === "p-pitch") $("pitch-val").textContent = input.value;
      if (input.id === "m-intensity") $("intensity-val").textContent = `${input.value}%`;
      if (input.id === "s-accent") document.documentElement.style.setProperty("--accent", input.value);
      if (input.id === "st-size") {
        const label = $("stage-size-label");
        if (label) label.textContent = formatSize(input.value);
      }
      if (input.id === "script-lines") updateScriptCount();
      scheduleSave();
    });
    input.addEventListener("change", scheduleSave);
  });

  document.querySelectorAll('input[name="engine"]').forEach((input) => {
    input.addEventListener("change", () => {
      $("e-url").disabled = input.value !== "local";
      $("e-probe").disabled = input.value !== "local";
      scheduleSave();
    });
  });

  $("say-next").addEventListener("click", async () => {
    const saved = await flushSave();
    if (!saved) return;
    try {
      const result = await api("/api/script/next", { method: "POST", body: "{}" });
      renderCue(result.cue);
    } catch (error) {
      toast(error.message, "err");
    }
  });

  $("test-speak").addEventListener("click", async () => {
    const saved = await flushSave();
    if (!saved) return;
    const area = $("script-lines");
    const selected = area.value.slice(area.selectionStart, area.selectionEnd).trim();
    const text = selected || area.value.split("\n").map((line) => line.trim()).filter(Boolean)[0] || "你好，我是你的数字人主播。";
    try {
      const result = await api("/api/say", { method: "POST", body: JSON.stringify({ text }) });
      renderCue(result.cue);
    } catch (error) {
      toast(error.message, "err");
    }
  });

  $("stop-speak").addEventListener("click", async () => {
    try {
      await api("/api/script/stop", { method: "POST", body: "{}" });
      el.cue.textContent = "已停止";
    } catch (error) {
      toast(error.message, "err");
    }
  });

  $("e-probe").addEventListener("click", async () => {
    $("e-probe").disabled = true;
    el.engineStatus.textContent = "正在探测…";
    try {
      const status = await api("/api/engine/probe", {
        method: "POST",
        body: JSON.stringify({ url: $("e-url").value.trim() }),
      });
      el.engineStatus.textContent = status.online
        ? `在线 · ${status.engine || "未知引擎"} · ${status.latencyMs}ms`
        : `未连接：${status.error || "无响应"}`;
    } catch (error) {
      el.engineStatus.textContent = `探测失败：${error.message}`;
    } finally {
      $("e-probe").disabled = false;
    }
  });

  el.ttsInstall.addEventListener("click", async () => {
    el.ttsInstall.disabled = true;
    el.ttsInstall.textContent = "安装中，约 1-3 分钟…";
    try {
      const result = await api("/api/tts/install", { method: "POST", body: "{}" });
      if (result.ok) {
        toast("语音已安装");
        setPill(el.tts, "语音 · edge-tts", "ok");
        el.ttsInstall.hidden = true;
      } else {
        toast(`安装失败：${result.error || result.step}`, "err");
        el.ttsInstall.textContent = "重试安装语音";
      }
    } catch (error) {
      toast(`安装失败：${error.message}`, "err");
      el.ttsInstall.textContent = "重试安装语音";
    } finally {
      el.ttsInstall.disabled = false;
    }
  });

  document.querySelectorAll("#kind-seg .seg-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#kind-seg .seg-btn").forEach(function (b) { b.classList.toggle("active", b === btn); });
      scheduleSave();
    });
  });

  ["m-head", "m-gesture", "m-style", "m-gain", "mi-top", "mi-bottom", "ei-top", "ei-bottom"].forEach(function (id) {
    var node = $(id);
    var labels = { "m-gain": "mgain-val", "mi-top": "mi-top-val", "mi-bottom": "mi-bottom-val", "ei-top": "ei-top-val", "ei-bottom": "ei-bottom-val" };
    var onChange = function () {
      if (labels[id]) $(labels[id]).textContent = node.value + "%";
      scheduleSave();
    };
    node.addEventListener("input", onChange);
    node.addEventListener("change", onChange);
  });

  $("st-start").addEventListener("click", async function () {
    const saved = await flushSave();
    if (!saved) return;
    $("st-start").disabled = true;
    $("st-status").textContent = "正在启动推流…";
    try {
      var payload = gather().stream;
      var status = await api("/api/stream/start", { method: "POST", body: JSON.stringify(payload) });
      toast("推流已启动");
      renderStream({ running: true, platform: status.platform, mode: status.mode, elapsedMs: 0, deps: status.deps });
      await loadState();
    } catch (error) {
      toast("推流失败：" + error.message, "err");
      $("st-status").textContent = "推流失败：" + error.message;
    } finally {
      $("st-start").disabled = false;
    }
  });
  $("st-stop").addEventListener("click", async function () {
    try {
      await api("/api/stream/stop", { method: "POST", body: "{}" });
      renderStream({ running: false, deps: {} });
      await loadState();
      toast("推流已停止");
    } catch (error) { toast(error.message, "err"); }
  });
  ["st-platform", "st-url", "st-key", "st-fps", "st-size", "st-audio"].forEach(function (id) {
    $(id).addEventListener("change", scheduleSave);
    $(id).addEventListener("input", scheduleSave);
  });

  ["w-enabled", "w-title", "w-greeting", "w-faqs", "w-knowledge", "w-speak-greeting", "w-llm-enabled", "w-llm-url", "w-llm-model", "w-llm-key", "w-llm-prompt",
    "a-mode", "a-max", "a-idle", "a-queue-tip", "a-welcome", "a-host-llm", "a-speak"].forEach(function (id) {
    $(id).addEventListener("input", scheduleSave);
    $(id).addEventListener("change", scheduleSave);
  });
  $("w-copy").addEventListener("click", async function () {
    var code = '<script src="' + base + "/embed.js?token=" + token + '"></script>';
    var ok = await copyText(code);
    if (ok) toast("嵌入代码已复制，粘到产品页即可");
    else toast("复制失败，请检查剪贴板权限", "err");
  });
  $("w-open").addEventListener("click", async function () {
    const ok = await openUrl(base + "/widget?token=" + encodeURIComponent(token));
    if (!ok) toast("无法打开接待预览，请检查浏览器弹窗权限", "err");
  });

  const stageUrl = () => `${base}/stage?token=${encodeURIComponent(token)}`;
  $("copy-source").addEventListener("click", async () => {
    const ok = await copyText(stageUrl());
    toast(ok ? "浏览器源地址已复制，粘贴到直播伴侣「浏览器」源" : "复制失败，请检查剪贴板权限", ok ? "" : "err");
  });
  $("open-stage").addEventListener("click", async () => {
    const saved = await flushSave();
    if (!saved) return;
    const ok = await openStage(stageUrl());
    if (!ok) toast("无法打开舞台窗口，请检查浏览器弹窗权限", "err");
  });
  $("refresh-stage").addEventListener("click", async () => {
    await flushSave();
    refreshStage(true);
    toast("舞台已刷新");
  });
  $("go-live").addEventListener("click", async () => {
    if (liveOn) {
      if (stageWindow && !stageWindow.closed) {
        try { stageWindow.close(); } catch { /* 宿主可能拦截关闭 */ }
      }
      stageWindow = null;
      liveOn = false;
      el.live.hidden = true;
      $("go-live").textContent = "一键开播";
      $("go-live").classList.remove("danger");
      renderSteps(state);
      toast("已结束舞台窗口；若正在推流，请在推流设置里停止");
      return;
    }
    const saved = await flushSave();
    if (!saved) {
      toast("配置未保存成功，请检查本地服务后重试", "err");
      return;
    }
    const url = stageUrl();
    const copied = await copyText(url);
    const opened = await openStage(url);
    if (!opened) {
      toast("无法打开舞台窗口，请检查浏览器弹窗权限", "err");
      return;
    }
    liveOn = true;
    el.live.hidden = false;
    $("go-live").textContent = "结束直播";
    $("go-live").classList.add("danger");
    renderSteps(state);
    toast(copied ? "舞台已打开，浏览器源地址已复制" : "舞台已打开");
  });

  el.retryConnect.addEventListener("click", () => location.reload());

  const dock = document.querySelector(".dock");
  $("dock-toggle").addEventListener("click", () => {
    const collapsed = dock.classList.toggle("collapsed");
    $("dock-toggle").textContent = collapsed ? "展开" : "收起";
    $("dock-toggle").setAttribute("aria-expanded", String(!collapsed));
  });
  $("script-sample").addEventListener("click", () => {
    const area = $("script-lines");
    const used = area.value.split("\n").filter((line) => line.trim()).length;
    const line = SAMPLE_LINES[used % SAMPLE_LINES.length];
    area.value = area.value.trim() ? area.value.replace(/\s+$/, "") + "\n" + line : line;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    updateScriptCount();
    scheduleSave();
  });
  $("script-clear").addEventListener("click", () => {
    const area = $("script-lines");
    if (area.value.trim() && !confirm("恢复默认可播话术？当前内容会被替换。")) return;
    area.value = SAMPLE_LINES.join("\n");
    updateScriptCount();
    scheduleSave();
    toast("已恢复默认话术");
  });

  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    if (event.key === "Enter") {
      event.preventDefault();
      $("test-speak").click();
    } else if (event.key.toLowerCase() === "s") {
      event.preventDefault();
      flushSave().then((ok) => toast(ok ? "配置已保存" : "保存失败", ok ? "" : "err"));
    }
  });

  wireTabs();
}

function listenEvents() {
  const source = new EventSource(`${base}/api/events?token=${encodeURIComponent(token)}`);
  source.addEventListener("state", (event) => {
    try { applyState(JSON.parse(event.data)); } catch { /* ignore */ }
  });
  source.addEventListener("cue", (event) => {
    try { renderCue(JSON.parse(event.data)); } catch { /* ignore */ }
  });
  source.addEventListener("error", () => setPill(el.svc, "连接中断，重试中"));
  source.addEventListener("open", () => setPill(el.svc, "服务正常", "ok"));
}

async function main() {
  wireEvents();
  try {
    await connect();
    await loadState();
    listenEvents();
    el.retryConnect.hidden = true;
    el.app.dataset.boot = "ready";
  } catch (error) {
    if (el.retryConnect) el.retryConnect.hidden = false;
    if (el.phoneLoading) el.phoneLoading.hidden = true;
    setPill(el.svc, "连接失败", "err");
    el.mode.textContent = error.message;
    toast(error.message, "err");
  }
}

main();