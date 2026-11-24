import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJsonBody } from "./util.mjs";
import { engineGuide, ENGINE_PROTOCOL, probeEngine } from "./engine.mjs";
import { AudioCache } from "./script.mjs";
import { askFaqs, chatLlm, searchKnowledge } from "./widget.mjs";
import { WidgetStats } from "./widget-stats.mjs";
import { AgentHub, AGENT_MODE_LABELS } from "./agent-session.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..", "web");

const STATIC_FILE_EXT = new Set([".css", ".js", ".mjs", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff2"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
  "media-src 'self' blob: data: http://127.0.0.1:* http://localhost:*",
  "connect-src 'self' blob: data: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors * http: https: file: ruodao-plugin:",
].join("; ");

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-dh-token",
    "access-control-max-age": "600",
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...cors(),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendFile(res, filePath, { cache = false, contentType } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    sendJson(res, 404, { error: "文件不存在" });
    return;
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: "文件不存在" });
    return;
  }
  const type = contentType || MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const headers = {
    ...cors(),
    "content-type": type,
    "content-length": stat.size,
    "cache-control": cache ? "public, max-age=3600" : "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": CSP,
  };
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

export function createServer({
  store,
  tts,
  scriptRunner,
  log = () => {},
  getGpu = () => ({}),
  stream = null,
  hostCall = null,
}) {
  const widgetStats = new WidgetStats(store.dataDir);
  const audioCache = new AudioCache(16);
  const clients = new Set();
  let engineStatus = { online: false, error: "尚未探测" };
  let agentHub = null;

  /** 舞台一次只能合成一句，接待回答遇到 busy 时短暂等待，不丢问题。 */
  async function sayWhenFree(text) {
    let lastError = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        return await scriptRunner.say(text, { manual: true });
      } catch (error) {
        lastError = error;
        if (Number(error?.statusCode) !== 429) break;
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  function buildAgentSystem(knowledge) {
    const w = store.config.widget || {};
    const name = store.config.persona.name || "数字人";
    const base = (w.llm && w.llm.systemPrompt)
      || "你是一位专业、亲切的数字人客服，回答简洁、口语化，控制在两三句话内，不编造事实。";
    const parts = [
      base,
      `你叫${name}，正在通过语音和文字接待访客。`,
      "把答案说得像真人说话：先给结论，再补一句必要说明；不要用 markdown、列表或括号说明。",
    ];
    if (knowledge) parts.push(`可参考资料（优先依据资料，资料没有的不要编造）：\n${knowledge}`);
    return parts.join("\n");
  }

  function buildAgentUser(session, question) {
    const messages = session.messages.filter((item) => item.role !== "system");
    const lastUser = messages.map((item) => item.role).lastIndexOf("user");
    const history = messages
      .filter((item, index) => index !== lastUser)
      .slice(-8)
      .map((item) => `${item.role === "user" ? "访客" : "数字人"}：${item.text}`)
      .join("\n");
    return `${history ? `对话记录：\n${history}\n\n` : ""}访客最新问题：${question}`;
  }

  /** 接待回答链：精确 FAQ → 若道宿主模型 → 外部模型 → 知识库 → 兜底。 */
  async function answerAgent(session, question) {
    const w = store.config.widget || {};
    const settings = w.agent || {};
    const faqHit = askFaqs(store.config, question);
    const kbHits = w.retrieval !== false ? searchKnowledge(store.config, question, 4) : [];
    const knowledge = kbHits.map((item) => item.text).join("\n").slice(0, 2000);
    let result = null;

    // 价格、政策这类问题直接回配置里的原文，避免模型改数字。
    if (faqHit && !faqHit.fallback && faqHit.score >= 0.72) {
      result = { text: faqHit.answer, source: "faq" };
    }

    if (!result && settings.useHostLlm !== false && typeof hostCall === "function") {
      try {
        const reply = await hostCall("llm.chat", {
          system: buildAgentSystem(knowledge),
          user: buildAgentUser(session, question),
          temperature: 0.5,
          maxTokens: 500,
        });
        const text = String(reply?.content || "").trim();
        if (text) result = { text: text.slice(0, 800), source: "ruodao-llm" };
      } catch (error) {
        log(`接待模型调用失败：${error?.message || error}`);
      }
    }

    if (!result && w.llm && w.llm.enabled && w.llm.baseUrl && w.llm.model) {
      const historyMessages = session.messages
        .filter((item) => item.role === "user" || item.role === "assistant")
        .slice(-10)
        .map((item) => ({ role: item.role, content: item.text }));
      const llm = await chatLlm(store.config, historyMessages, question, { context: knowledge });
      if (llm.ok) result = { text: llm.answer, source: "llm" };
    }

    if (!result && faqHit && !faqHit.fallback) result = { text: faqHit.answer, source: "faq" };
    if (!result && kbHits.length && kbHits[0].score >= 0.2) {
      result = { text: kbHits[0].text, source: "kb" };
    }
    if (!result) {
      result = {
        text: w.fallback || "这个问题我还不太确定，你可以换个说法，或者留下联系方式让真人同事联系你。",
        source: "fallback",
      };
    }

    let audioUrl = "";
    if (settings.speakReplies !== false) {
      try {
        const cue = await sayWhenFree(result.text);
        audioUrl = cue?.audioUrl || "";
      } catch (error) {
        log(`接待语音播放失败：${error?.message || error}`);
      }
    }
    widgetStats.recordAsk(question, result.source);
    return { text: result.text, audioUrl, source: result.source };
  }

  function statePayload() {
    return {
      ...store.snapshot(),
      tts: tts.status(),
      engine: {
        ...engineStatus,
        mode: store.config.motion.engine,
        url: store.config.motion.localUrl,
        guide: engineGuide(getGpu()),
        protocol: ENGINE_PROTOCOL,
      },
      script: scriptRunner.status(),
      stream: stream ? stream.status() : null,
      widgetEnabled: store.config.widget.enabled,
      widgetStats: widgetStats.summary(),
      agent: agentHub ? agentHub.status() : null,
      now: Date.now(),
    };
  }

  function push(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  }

  const broadcast = {
    state: () => push("state", statePayload()),
    cue: (cue) => push("cue", cue),
    control: (payload) => push("control", payload),
    audio: (id, buffer, mime) => audioCache.put(id, buffer, mime),
    personas: () => push("personas", store.listPersonas()),
    config: () => push("config", store.config),
    agent: () => push("agent", agentHub ? agentHub.status() : null),
    log: (message) => push("log", { message, at: Date.now() }),
  };

  agentHub = new AgentHub({
    getSettings: () => store.config.widget.agent,
    answer: answerAgent,
    onChange: () => broadcast.agent(),
  });
  const agentSweep = setInterval(() => {
    try { agentHub.sweep(); } catch (error) { log(`接待队列清理失败：${error?.message || error}`); }
  }, 5000);
  agentSweep.unref?.();

  async function authorize(req, url) {
    const fromQuery = url.searchParams.get("token") || "";
    const fromHeader = String(req.headers["x-dh-token"] || "");
    const token = fromQuery || fromHeader;
    return Boolean(token) && token === serverToken;
  }

  let serverToken = "";

  async function route(req, res, url) {
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors());
      res.end();
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      sendFile(res, path.join(webRoot, "index.html"));
      return;
    }
    if (pathname === "/stage" || pathname === "/stage.html") {
      sendFile(res, path.join(webRoot, "stage.html"));
      return;
    }
    if (pathname === "/widget" || pathname === "/widget.html") {
      sendFile(res, path.join(webRoot, "widget.html"));
      return;
    }
    if (pathname === "/embed.js") {
      sendFile(res, path.join(webRoot, "embed.js"), { contentType: "text/javascript; charset=utf-8" });
      return;
    }
    if (pathname.startsWith("/assets/")) {
      const rel = pathname.slice("/assets/".length);
      const target = path.resolve(webRoot, rel);
      if (!target.startsWith(webRoot + path.sep)) {
        sendJson(res, 403, { error: "非法路径" });
        return;
      }
      sendFile(res, target);
      return;
    }
    // 宿主以 /web/index.html 作为文档地址，主界面相对引用会落到 /web/<file>；
    // 独立模式直接访问本地服务时，根级同名静态资源也要能取到，保证两种入口一致。
    const rootAsset = pathname.replace(/^\/+/, "");
    if (rootAsset && !rootAsset.includes("/") && STATIC_FILE_EXT.has(path.extname(rootAsset).toLowerCase())) {
      sendFile(res, path.join(webRoot, rootAsset));
      return;
    }
    if (pathname.startsWith("/media/persona/")) {
      const id = pathname.slice("/media/persona/".length);
      const found = store.personaFile(id);
      if (!found) {
        sendJson(res, 404, { error: "形象不存在" });
        return;
      }
      sendFile(res, found.path, { cache: true, contentType: found.mime });
      return;
    }
    if (pathname.startsWith("/api/audio/")) {
      const id = pathname.slice("/api/audio/".length);
      const item = audioCache.get(id);
      if (!item) {
        sendJson(res, 404, { error: "音频已过期，请重新生成" });
        return;
      }
      res.writeHead(200, {
        ...cors(),
        "content-type": item.mime,
        "content-length": item.buffer.length,
        "cache-control": "no-store",
      });
      res.end(item.buffer);
      return;
    }

    if (!pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "未找到" });
      return;
    }

    if (pathname === "/api/events") {
      if (!(await authorize(req, url))) {
        sendJson(res, 401, { error: "缺少访问令牌" });
        return;
      }
      res.writeHead(200, {
        ...cors(),
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(`retry: 2000\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(statePayload())}\n\n`);
      clients.add(res);
      const keepAlive = setInterval(() => {
        try { res.write(`: ping\n\n`); } catch { /* ignore */ }
      }, 20000);
      req.on("close", () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    if (!(await authorize(req, url))) {
      sendJson(res, 401, { error: "缺少访问令牌" });
      return;
    }

    if (pathname === "/api/state" && req.method === "GET") {
      sendJson(res, 200, statePayload());
      return;
    }

    if (pathname === "/api/config" && (req.method === "POST" || req.method === "PATCH")) {
      const body = await readJsonBody(req);
      await store.updateConfig(body);
      scriptRunner.sync();
      broadcast.state();
      sendJson(res, 200, { config: store.config, script: scriptRunner.status() });
      return;
    }

    if (pathname === "/api/persona" && req.method === "POST") {
      const body = await readJsonBody(req);
      const persona = await store.addPersona({ name: body.name, dataUrl: body.dataUrl, kind: body.kind });
      broadcast.state();
      sendJson(res, 200, { persona, personas: store.listPersonas() });
      return;
    }

    if (pathname.startsWith("/api/persona/") && req.method === "DELETE") {
      const id = pathname.slice("/api/persona/".length);
      await store.removePersona(id);
      broadcast.state();
      sendJson(res, 200, { ok: true, personas: store.listPersonas() });
      return;
    }

    if (pathname === "/api/say" && req.method === "POST") {
      const body = await readJsonBody(req);
      const cue = await scriptRunner.say(body.text, { manual: true });
      sendJson(res, 200, { cue, script: scriptRunner.status() });
      return;
    }

    if (pathname === "/api/script/next" && req.method === "POST") {
      const cue = await scriptRunner.advance({ manual: true });
      sendJson(res, 200, { cue, script: scriptRunner.status() });
      return;
    }

    if (pathname === "/api/script/stop" && req.method === "POST") {
      scriptRunner.stopSpeak();
      sendJson(res, 200, { ok: true, script: scriptRunner.status() });
      return;
    }

    if (pathname === "/api/tts/detect" && req.method === "POST") {
      const status = await tts.detect(true);
      broadcast.state();
      sendJson(res, 200, status);
      return;
    }

    if (pathname === "/api/tts/install" && req.method === "POST") {
      const result = await tts.installEdgeTts();
      broadcast.state();
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/engine/probe" && req.method === "POST") {
      const body = await readJsonBody(req);
      const url = body.url || store.config.motion.localUrl;
      engineStatus = { ...(await probeEngine(url)), checkedAt: Date.now() };
      broadcast.state();
      sendJson(res, 200, engineStatus);
      return;
    }

    if (pathname === "/api/engine/guide" && req.method === "GET") {
      sendJson(res, 200, { guide: engineGuide(getGpu()), protocol: ENGINE_PROTOCOL });
      return;
    }

    if (pathname === "/api/stream/detect" && req.method === "GET") {
      sendJson(res, 200, stream ? stream.detect() : { ready: false, hint: "推流未初始化" });
      return;
    }
    if (pathname === "/api/stream/status" && req.method === "GET") {
      sendJson(res, 200, stream ? stream.status() : { running: false });
      return;
    }
    if (pathname === "/api/stream/start" && req.method === "POST") {
      if (!stream) throw Object.assign(new Error("推流未初始化"), { statusCode: 500 });
      const body = await readJsonBody(req);
      const result = await stream.start(body);
      broadcast.state();
      sendJson(res, 200, result);
      return;
    }
    if (pathname === "/api/stream/stop" && req.method === "POST") {
      const result = stream ? stream.stop() : { ok: true };
      broadcast.state();
      sendJson(res, 200, result);
      return;
    }
    if (pathname === "/api/widget/config" && req.method === "GET") {
      const w = store.config.widget;
      const target = store.personas.find((item) => item.id === store.config.persona.avatarId);
      widgetStats.bumpOpen();
      sendJson(res, 200, {
        widget: {
          title: w.title,
          greeting: w.greeting,
          accent: w.accent,
          position: w.position,
          fallback: w.fallback,
          subtitle: store.config.stage.subtitle !== false,
          speakGreeting: w.speakGreeting !== false,
          quick: (w.faqs || []).slice(0, 3).map(function (f) { return f.q; }),
          agent: {
            mode: w.agent.mode,
            modeLabel: AGENT_MODE_LABELS[w.agent.mode],
            queueTip: w.agent.queueTip,
            welcome: w.agent.welcome,
            maxActive: w.agent.maxActive,
            speakReplies: w.agent.speakReplies,
            useHostLlm: w.agent.useHostLlm,
            ttsAvailable: Boolean(tts.status().available),
          },
        },
        persona: {
          name: store.config.persona.name,
          title: store.config.persona.title,
          kind: target ? target.kind || "real" : "real",
          avatarUrl: target ? `/media/persona/${target.id}` : "",
        },
        motion: {
          mouthClip: store.config.motion.mouthClip,
          mouthGain: store.config.motion.mouthGain,
        },
      });
      return;
    }
    if (pathname === "/api/agent/config" && req.method === "GET") {
      const w = store.config.widget;
      const target = store.personas.find((item) => item.id === store.config.persona.avatarId);
      sendJson(res, 200, {
        agent: {
          mode: w.agent.mode,
          modeLabel: AGENT_MODE_LABELS[w.agent.mode],
          queueTip: w.agent.queueTip,
          welcome: w.agent.welcome,
          maxActive: w.agent.maxActive,
          speakReplies: w.agent.speakReplies,
          useHostLlm: w.agent.useHostLlm,
          ttsAvailable: Boolean(tts.status().available),
        },
        persona: {
          name: store.config.persona.name,
          title: store.config.persona.title,
          kind: target ? target.kind || "real" : "real",
          avatarUrl: target ? `/media/persona/${target.id}` : "",
        },
        widget: {
          title: w.title,
          greeting: w.greeting,
          accent: w.accent,
          position: w.position,
        },
        quick: (w.faqs || []).slice(0, 3).map(function (f) { return f.q; }),
        now: Date.now(),
      });
      return;
    }
    if (pathname === "/api/agent/join" && req.method === "POST") {
      const body = await readJsonBody(req);
      const session = agentHub.join({ visitorId: body.visitorId, name: body.name });
      sendJson(res, 200, { session });
      return;
    }
    if (pathname === "/api/agent/poll" && req.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const visitorId = url.searchParams.get("visitorId") || "";
      const session = sessionId ? agentHub.get(sessionId) : agentHub.getByVisitor(visitorId);
      sendJson(res, 200, { session: session ? agentHub.view(session) : null });
      return;
    }
    if (pathname === "/api/agent/message" && req.method === "POST") {
      const body = await readJsonBody(req);
      const result = agentHub.ask(body.sessionId, body.question);
      sendJson(res, 200, result);
      return;
    }
    if (pathname === "/api/agent/end" && req.method === "POST") {
      const body = await readJsonBody(req);
      sendJson(res, 200, { session: agentHub.end(body.sessionId) });
      return;
    }
    if (pathname === "/api/agent/queue" && req.method === "GET") {
      sendJson(res, 200, agentHub.status());
      return;
    }

    if (pathname === "/api/widget/ask" && req.method === "POST") {
      const body = await readJsonBody(req);
      const question = String(body.question || "").trim().slice(0, 300);
      if (!question) throw Object.assign(new Error("请输入问题"), { statusCode: 400 });
      const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
      const faqHit = askFaqs(store.config, question);
      const kbHits = store.config.widget.retrieval !== false ? searchKnowledge(store.config, question, 3) : [];
      let result = null;
      const llmCfg = store.config.widget.llm || {};
      if (llmCfg.enabled && llmCfg.baseUrl && llmCfg.model) {
        let context = "";
        if (faqHit && !faqHit.fallback) context += "问答：" + faqHit.matched + " -> " + faqHit.answer + "\n";
        if (kbHits.length) context += kbHits.map(function (h) { return h.text; }).join("\n");
        const llm = await chatLlm(store.config, history, question, { context: context });
        if (llm.ok) result = { answer: llm.answer, matched: "", score: 0, fallback: false, source: "llm" };
      }
      if (!result && faqHit && !faqHit.fallback) {
        result = { answer: faqHit.answer, matched: faqHit.matched, score: faqHit.score, fallback: false, source: "faq" };
      }
      if (!result && kbHits.length && kbHits[0].score >= 0.2) {
        result = { answer: kbHits[0].text, matched: kbHits[0].text, score: Number(kbHits[0].score.toFixed(2)), fallback: false, source: "kb" };
      }
      if (!result) {
        result = { answer: faqHit ? faqHit.answer : store.config.widget.fallback, matched: "", score: 0, fallback: true, source: "fallback" };
      }
      let audioUrl = "";
      if (store.config.tts.enabled && tts.status().available) {
        try {
          const { buffer, mime } = await tts.synthesize({
            text: result.answer,
            voice: store.config.persona.voice,
            rate: store.config.persona.rate,
            pitch: store.config.persona.pitch,
          });
          const id = "w_" + Date.now().toString(36) + "_" + crypto.randomBytes(2).toString("hex");
          audioCache.put(id, buffer, mime);
          audioUrl = "/api/audio/" + id;
        } catch { /* 语音失败不影响文字回复 */ }
      }
      widgetStats.recordAsk(question, result.source);
      sendJson(res, 200, { ...result, question, audioUrl });
      return;
    }
    if (pathname === "/api/widget/speak" && req.method === "POST") {
      const body = await readJsonBody(req);
      const text = String(body.text || "").trim().slice(0, 400);
      if (!text) throw Object.assign(new Error("缺少文本"), { statusCode: 400 });
      let audioUrl = "";
      if (store.config.tts.enabled && tts.status().available) {
        try {
          const { buffer, mime } = await tts.synthesize({
            text,
            voice: store.config.persona.voice,
            rate: store.config.persona.rate,
            pitch: store.config.persona.pitch,
          });
          const id = "s_" + Date.now().toString(36) + "_" + crypto.randomBytes(2).toString("hex");
          audioCache.put(id, buffer, mime);
          audioUrl = "/api/audio/" + id;
        } catch { /* ignore */ }
      }
      sendJson(res, 200, { audioUrl });
      return;
    }

    if (pathname === "/api/widget/stats" && req.method === "GET") {
      sendJson(res, 200, widgetStats.summary());
      return;
    }

    sendJson(res, 404, { error: "接口不存在" });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    route(req, res, url).catch((error) => {
      const status = Number(error?.statusCode) || 500;
      if (status >= 500) log(`请求失败 ${req.method} ${url.pathname}: ${error?.stack || error}`);
      sendJson(res, status, { error: String(error?.message || error) });
    });
  });

  function setToken(token) {
    serverToken = token;
  }

  function close() {
    clearInterval(agentSweep);
    try { agentHub.destroy(); } catch { /* ignore */ }
    for (const res of clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    clients.clear();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, setToken, close, statePayload, broadcast, engineStatusOf: () => engineStatus };
}

export function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

export function newToken() {
  return crypto.randomBytes(16).toString("hex");
}
