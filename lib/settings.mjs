export const TTS_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 · 女声 · 温柔自然" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊 · 女声 · 活泼甜美" },
  { id: "zh-CN-YunxiNeural", label: "云希 · 男声 · 阳光青年" },
  { id: "zh-CN-YunjianNeural", label: "云健 · 男声 · 沉稳磁性" },
  { id: "zh-CN-YunyangNeural", label: "云扬 · 男声 · 专业播报" },
  { id: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 · 女声 · 东北口音" },
  { id: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮 · 女声 · 陕西口音" },
  { id: "zh-HK-HiuMaanNeural", label: "曉曼 · 粤语女声" },
  { id: "zh-TW-HsiaoChenNeural", label: "曉臻 · 台湾女声" },
];

export const DEFAULT_LINES = [
  "欢迎来到直播间，我是你的 AI 数字人主播，点点关注不迷路。",
  "今天这场直播，我会一直陪着你，有问题直接打在公屏上。",
  "新进来的朋友，先点个关注，再看一眼下方的小黄车。",
  "觉得主播说得还行，帮我点个赞，让更多人看到。",
  "整点会有一波福利，别走开，马上就到。",
];

export const DEFAULT_FAQS = [
  { q: "怎么联系你们", a: "你可以在这里留言，或者点击页面上的联系方式，我们会尽快回复你。" },
  { q: "价格多少钱", a: "具体价格要看你的需求，告诉我你的场景，我可以帮你估算或者转接人工。" },
  { q: "支持定制吗", a: "支持的，我们可以按你的形象和话术做定制，欢迎留下联系方式详细沟通。" },
  { q: "你们在哪", a: "我们在线上提供服务，全国都可以远程对接，也支持上门实施。" },
];

export const STREAM_PLATFORMS = [
  { id: "douyin", name: "抖音" },
  { id: "kuaishou", name: "快手" },
  { id: "shipinhao", name: "微信视频号" },
  { id: "bilibili", name: "哔哩哔哩" },
  { id: "youtube", name: "YouTube" },
  { id: "custom", name: "自定义 RTMP / SRT" },
];

export const DEFAULT_CONFIG = {
  version: 2,
  persona: {
    avatarId: "",
    name: "小若",
    title: "AI 数字人主播",
    bio: "24 小时在线的数字人直播间，欢迎随时进来聊两句。",
    voice: "zh-CN-XiaoxiaoNeural",
    rate: 0,
    pitch: 0,
    volume: 0,
    kind: "real",
    fit: "auto",
    cutout: false,
  },
  motion: {
    engine: "still",
    localUrl: "http://127.0.0.1:8090",
    breath: true,
    blink: true,
    sway: true,
    mouth: true,
    head: true,
    gesture: false,
    style: "auto",
    intensity: 0.6,
    mouthGain: 0.6,
    mouthClip: { top: 56, right: 24, bottom: 8, left: 24 },
    eyeClip: { top: 30, right: 20, bottom: 54, left: 20 },
  },
  stage: {
    layout: "full",
    background: "#0b0d17",
    accent: "#7c5cff",
    subtitle: true,
    clock: true,
    badge: true,
    product: { enabled: false, name: "", price: "", image: "" },
    ticker: { enabled: true, text: "关注主播 · 点亮粉丝牌 · 每晚 20:00 开播" },
    source: { enabled: false, url: "", type: "auto", fit: "cover", muted: true },
  },
  script: {
    auto: false,
    intervalMs: 22000,
    lines: [...DEFAULT_LINES],
  },
  tts: {
    enabled: true,
    engine: "auto",
  },
  stream: {
    platform: "custom",
    rtmpUrl: "",
    streamKey: "",
    mode: "image",
    fps: 25,
    size: "1080x1920",
    withAudio: true,
  },
  widget: {
    enabled: true,
    title: "数字人接待",
    greeting: "你好，我是数字人助手，有什么可以帮你？",
    position: "right",
    accent: "#7c5cff",
    fallback: "这个问题我还不太确定，你可以换个说法，或者留下联系方式让真人同事联系你。",
    faqs: [...DEFAULT_FAQS],
    speakGreeting: true,
    llm: {
      enabled: false,
      baseUrl: "https://api.openai.com/v1",
      model: "",
      apiKey: "",
      systemPrompt: "你是一位专业、亲切的数字人客服，回答简洁、口语化，控制在两三句话内，不编造事实。",
    },
    knowledge: "",
    retrieval: true,
    // 接待队列：live=一对多直播，solo=一对一独占接待，round-robin=一对多轮流接待。
    agent: {
      mode: "live",
      maxActive: 3,
      queueTip: "前面还有 {position} 位访客，接待完就轮到你，请稍候。",
      welcome: "你好，我是数字人助手，可以直接打字或说话，我会马上回答。",
      useHostLlm: true,
      speakReplies: true,
      idleSeconds: 90,
    },
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig(base, patch) {
  if (!isPlainObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) {
      out[key] = mergeConfig(base[key], value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (typeof item === "string" ? item.slice(0, 500) : item));
    } else if (typeof value === "string") {
      out[key] = value.slice(0, 4000);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function clampNum(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function clamp01(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

function normalizeClip(raw, fallback) {
  const c = isPlainObject(raw) ? raw : {};
  return {
    top: clampNum(c.top, 0, 90, fallback.top),
    right: clampNum(c.right, 0, 90, fallback.right),
    bottom: clampNum(c.bottom, 0, 90, fallback.bottom),
    left: clampNum(c.left, 0, 90, fallback.left),
  };
}

export function normalizeConfig(raw) {
  const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), raw || {});
  const p = merged.persona;
  p.name = String(p.name || "小若").slice(0, 24);
  p.title = String(p.title || "").slice(0, 40);
  p.bio = String(p.bio || "").slice(0, 500);
  p.rate = clampNum(p.rate, -50, 50, 0);
  p.pitch = clampNum(p.pitch, -50, 50, 0);
  p.volume = clampNum(p.volume, -50, 50, 0);
  p.kind = ["real", "cartoon"].includes(p.kind) ? p.kind : "real";
  p.fit = ["auto", "cover", "contain"].includes(p.fit) ? p.fit : "auto";
  p.cutout = Boolean(p.cutout);

  const m = merged.motion;
  m.engine = ["still", "local", "cloud"].includes(m.engine) ? m.engine : "still";
  m.style = ["auto", "calm", "lively"].includes(m.style) ? m.style : "auto";
  m.intensity = clamp01(m.intensity, 0.6);
  m.mouthGain = clamp01(m.mouthGain, 0.6);
  m.breath = Boolean(m.breath);
  m.blink = Boolean(m.blink);
  m.sway = Boolean(m.sway);
  m.mouth = Boolean(m.mouth);
  m.head = Boolean(m.head);
  m.gesture = Boolean(m.gesture);
  m.mouthClip = normalizeClip(m.mouthClip, { top: 56, right: 24, bottom: 8, left: 24 });
  m.eyeClip = normalizeClip(m.eyeClip, { top: 30, right: 20, bottom: 54, left: 20 });

  merged.script.intervalMs = clampNum(merged.script.intervalMs, 6000, 600000, 22000);
  merged.script.lines = (merged.script.lines || [])
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .slice(0, 80);
  if (!merged.script.lines.length) merged.script.lines = [...DEFAULT_LINES];

  const s = merged.stage;
  s.layout = ["full", "split"].includes(s.layout) ? s.layout : "full";
  s.source = isPlainObject(s.source) ? s.source : {};
  s.source.enabled = Boolean(s.source.enabled);
  s.source.url = String(s.source.url || "").slice(0, 2000);
  s.source.type = ["auto", "hls", "mp4", "webm"].includes(s.source.type) ? s.source.type : "auto";
  s.source.fit = ["cover", "contain"].includes(s.source.fit) ? s.source.fit : "cover";
  s.source.muted = s.source.muted !== false;

  const st = merged.stream;
  st.platform = STREAM_PLATFORMS.some((item) => item.id === st.platform) ? st.platform : "custom";
  st.rtmpUrl = String(st.rtmpUrl || "").slice(0, 1000);
  st.streamKey = String(st.streamKey || "").slice(0, 500);
  st.mode = ["image", "page"].includes(st.mode) ? st.mode : "image";
  st.fps = clampNum(st.fps, 10, 60, 25);
  st.size = ["1080x1920", "720x1280", "1920x1080", "1280x720"].includes(st.size) ? st.size : "1080x1920";
  st.withAudio = st.withAudio !== false;

  const w = merged.widget;
  w.enabled = w.enabled !== false;
  w.title = String(w.title || "数字人接待").slice(0, 40);
  w.greeting = String(w.greeting || "").slice(0, 200);
  w.position = ["right", "left"].includes(w.position) ? w.position : "right";
  w.fallback = String(w.fallback || "").slice(0, 300);
  w.faqs = (Array.isArray(w.faqs) ? w.faqs : [])
    .map((item) => ({
      q: String(item && item.q ? item.q : "").trim().slice(0, 120),
      a: String(item && item.a ? item.a : "").trim().slice(0, 600),
    }))
    .filter((item) => item.q && item.a)
    .slice(0, 60);
  if (!w.faqs.length) w.faqs = DEFAULT_FAQS.map((item) => ({ ...item }));
  w.speakGreeting = w.speakGreeting !== false;
  const llm = isPlainObject(w.llm) ? w.llm : {};
  w.llm = {
    enabled: Boolean(llm.enabled),
    baseUrl: String(llm.baseUrl || "").trim().slice(0, 300),
    model: String(llm.model || "").trim().slice(0, 120),
    apiKey: String(llm.apiKey || "").slice(0, 500),
    systemPrompt: String(llm.systemPrompt || "").slice(0, 1000),
  };
  w.knowledge = String(w.knowledge || "").slice(0, 8000);
  w.retrieval = w.retrieval !== false;

  const agent = isPlainObject(w.agent) ? w.agent : {};
  w.agent = {
    mode: ["live", "solo", "round-robin"].includes(agent.mode) ? agent.mode : "live",
    maxActive: clampNum(agent.maxActive, 1, 20, 3),
    queueTip: String(agent.queueTip || "前面还有 {position} 位访客，接待完就轮到你，请稍候。").slice(0, 300),
    welcome: String(agent.welcome || "你好，我是数字人助手，可以直接打字或说话，我会马上回答。").slice(0, 300),
    useHostLlm: agent.useHostLlm !== false,
    speakReplies: agent.speakReplies !== false,
    idleSeconds: clampNum(agent.idleSeconds, 15, 3600, 90),
  };

  return merged;
}