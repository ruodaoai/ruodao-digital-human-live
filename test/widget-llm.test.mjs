import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { searchKnowledge, askFaqs } from "../lib/widget.mjs";
import { Store } from "../lib/store.mjs";
import { ScriptRunner } from "../lib/script.mjs";
import { createServer, listen, newToken } from "../lib/server.mjs";

function fakeWav() {
  const data = Buffer.alloc(800);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + 0, 4);
  data.write("WAVE", 8);
  data.write("fmt ", 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}

async function bootstrap() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dh-llm-"));
  const store = await new Store(dir).init();
  const tts = {
    status: () => ({ available: true, engine: "test" }),
    detect: async () => ({ available: true }),
    synthesize: async () => ({ buffer: fakeWav(), mime: "audio/wav" }),
  };
  const stub = { state() {}, cue() {}, control() {}, audio() {}, personas() {}, config() {}, log() {} };
  const script = new ScriptRunner({ store, tts, broadcast: stub });
  const ctx = createServer({ store, tts, scriptRunner: script });
  Object.assign(stub, ctx.broadcast);
  const token = newToken();
  ctx.setToken(token);
  const port = await listen(ctx.server, 0);
  return { dir, store, ctx, token, base: `http://127.0.0.1:${port}`, close: async () => { await ctx.close(); await fs.promises.rm(dir, { recursive: true, force: true }); } };
}

function startMockLlm() {
  const state = { last: null };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { state.last = JSON.parse(body); } catch (e) { state.last = null; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "这是大模型给出的接待回答。" } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, getLast: () => state.last }));
  });
}

test("接待走大模型：启用 LLM 时返回 llm 来源与音频", async () => {
  const env = await bootstrap();
  const llm = await startMockLlm();
  try {
    await env.store.updateConfig({ widget: { llm: { enabled: true, baseUrl: "http://127.0.0.1:" + llm.port + "/v1", model: "mock-model", apiKey: "x" } } });
    const r = await fetch(`${env.base}/api/widget/ask?token=${env.token}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "随便聊聊", history: [{ role: "user", content: "你好" }, { role: "assistant", content: "你好呀" }] }),
    }).then((x) => x.json());
    assert.equal(r.source, "llm");
    assert.equal(r.answer, "这是大模型给出的接待回答。");
    assert.ok(r.audioUrl && r.audioUrl.startsWith("/api/audio/"));
  } finally {
    llm.server.close();
    await env.close();
  }
});

test("接待回退 FAQ：未启用 LLM 时命中问答库", async () => {
  const env = await bootstrap();
  try {
    await env.store.updateConfig({ widget: { faqs: [{ q: "怎么联系", a: "留下联系方式即可" }], llm: { enabled: false } } });
    const r = await fetch(`${env.base}/api/widget/ask?token=${env.token}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "我想问怎么联系你们" }),
    }).then((x) => x.json());
    assert.equal(r.source, "faq");
    assert.equal(r.answer, "留下联系方式即可");
  } finally {
    await env.close();
  }
});

test("接待回退：LLM 不可达时自动退回 FAQ/兜底且不报错", async () => {
  const env = await bootstrap();
  try {
    await env.store.updateConfig({ widget: { faqs: [{ q: "价格", a: "一百元起" }], fallback: "换个说法试试", llm: { enabled: true, baseUrl: "http://127.0.0.1:1/v1", model: "x" } } });
    const r = await fetch(`${env.base}/api/widget/ask?token=${env.token}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "我想了解价格" }),
    }).then((x) => x.json());
    assert.ok(["faq", "fallback"].includes(r.source));
    assert.equal(r.answer, "一百元起");
  } finally {
    await env.close();
  }
});

test("/api/widget/speak 把任意文本转语音", async () => {
  const env = await bootstrap();
  try {
    const r = await fetch(`${env.base}/api/widget/speak?token=${env.token}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "欢迎光临，这里是数字人接待。" }),
    }).then((x) => x.json());
    assert.ok(r.audioUrl && r.audioUrl.startsWith("/api/audio/"));
  } finally {
    await env.close();
  }
});

test("接待配置返回快捷问题与问候开关", async () => {
  const env = await bootstrap();
  try {
    await env.store.updateConfig({ widget: { speakGreeting: false, faqs: [{ q: "甲", a: "1" }, { q: "乙", a: "2" }, { q: "丙", a: "3" }, { q: "丁", a: "4" }] } });
    const cfg = await fetch(`${env.base}/api/widget/config?token=${env.token}`).then((x) => x.json());
    assert.equal(cfg.widget.speakGreeting, false);
    assert.deepEqual(cfg.widget.quick, ["甲", "乙", "丙"]);
  } finally {
    await env.close();
  }
});

test("知识库检索：未写进问答库的问题也能从知识里命中", () => {
  const config = { widget: { knowledge: "我们支持 7 天无理由退款，退款请联系在线客服。\n全国大部分地区 48 小时发货。" } };
  const hits = searchKnowledge(config, "可以退款吗", 3);
  assert.ok(hits.length >= 1, "应检索到知识片段");
  assert.ok(hits[0].score >= 0.2);
  assert.ok(hits[0].text.includes("退款"));
});

test("接待走知识库：无 FAQ 命中时从知识库作答", async () => {
  const env = await bootstrap();
  try {
    await env.store.updateConfig({ widget: {
      faqs: [{ q: "营业时间", a: "早九晚六" }],
      knowledge: "我们支持 7 天无理由退款，退款请联系在线客服。",
      llm: { enabled: false },
    } });
    const r = await fetch(env.base + "/api/widget/ask?token=" + env.token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "可以退款吗" }),
    }).then((x) => x.json());
    assert.equal(r.source, "kb");
    assert.ok(r.answer.includes("退款"));
  } finally {
    await env.close();
  }
});

test("大模型回答时注入知识库检索上下文", async () => {
  const env = await bootstrap();
  const llm = await startMockLlm();
  try {
    await env.store.updateConfig({ widget: {
      knowledge: "退款政策：7 天无理由退款，联系客服即可。",
      llm: { enabled: true, baseUrl: "http://127.0.0.1:" + llm.port + "/v1", model: "m", apiKey: "x" },
    } });
    const r = await fetch(env.base + "/api/widget/ask?token=" + env.token, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "可以退款吗" }),
    }).then((x) => x.json());
    assert.equal(r.source, "llm");
    const last = llm.getLast();
    const sysText = (last.messages || []).filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.ok(sysText.includes("退款政策"), "系统提示应包含检索到的知识库内容");
  } finally {
    llm.server.close();
    await env.close();
  }
});


test("同义扩展：不同措辞也能命中问答库与知识库", () => {
  const cfg = { widget: { faqs: [{ q: "营业时间", a: "早九点到晚六点" }, { q: "退款政策", a: "7天无理由退款" }], knowledge: "我们支持 7 天无理由退款，联系客服办理。", fallback: "不懂" } };
  assert.equal(askFaqs(cfg, "你们几点上班").answer, "早九点到晚六点");
  assert.equal(askFaqs(cfg, "我想退货").answer, "7天无理由退款");
  assert.equal(askFaqs(cfg, "今天天气如何").fallback, true);
  const h = searchKnowledge(cfg, "能退钱吗", 3);
  assert.ok(h.length && h[0].score >= 0.3);
});


test("接待数据统计：访问与提问计数", async () => {
  const env = await bootstrap();
  try {
    await env.store.updateConfig({ widget: { faqs: [{ q: "价格", a: "一百元" }], llm: { enabled: false } } });
    await fetch(env.base + "/api/widget/config?token=" + env.token).then((r) => r.json());
    await fetch(env.base + "/api/widget/ask?token=" + env.token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "这个多少钱" }) }).then((r) => r.json());
    const st = await fetch(env.base + "/api/widget/stats?token=" + env.token).then((r) => r.json());
    assert.ok(st.opens >= 1, "访问计数");
    assert.ok(st.asks >= 1, "提问计数");
    const sum = st.bySource.faq + st.bySource.kb + st.bySource.llm + st.bySource.fallback;
    assert.equal(sum, st.asks);
  } finally { await env.close(); }
});
