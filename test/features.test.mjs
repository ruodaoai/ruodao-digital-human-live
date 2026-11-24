import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeConfig, DEFAULT_FAQS } from "../lib/settings.mjs";
import { matchFaq, askFaqs } from "../lib/widget.mjs";
import { StreamController, detectStreamDeps, inspectMedia } from "../lib/stream.mjs";
import { Store } from "../lib/store.mjs";
import { ScriptRunner } from "../lib/script.mjs";
import { createServer, listen, newToken } from "../lib/server.mjs";

test("normalizeConfig 收敛 v0.2 新字段（形象类型/裁剪/推流/接待）", () => {
  const cfg = normalizeConfig({
    persona: { kind: "alien", cutout: "yes" },
    motion: { mouthClip: { top: -5, right: 200, bottom: 8, left: 24 }, mouthGain: 5, style: "crazy" },
    stream: { fps: 999, size: "1x1", platform: "zzz" },
    widget: { faqs: [{ q: "", a: "x" }, { q: "怎么联系", a: "留个电话" }] },
  });
  assert.equal(cfg.persona.kind, "real");
  assert.equal(cfg.persona.cutout, true);
  assert.equal(cfg.motion.mouthClip.top, 0);
  assert.equal(cfg.motion.mouthClip.right, 90);
  assert.equal(cfg.motion.mouthGain, 1);
  assert.equal(cfg.motion.style, "auto");
  assert.equal(cfg.stream.fps, 60);
  assert.equal(cfg.stream.size, "1080x1920");
  assert.equal(cfg.stream.platform, "custom");
  assert.equal(cfg.widget.faqs.length, 1);
  assert.equal(cfg.widget.faqs[0].q, "怎么联系");
});

test("FAQ 匹配命中与兜底", () => {
  assert.ok(matchFaq(DEFAULT_FAQS, "请问怎么联系你们呢"));
  assert.equal(matchFaq(DEFAULT_FAQS, "今天天气如何"), null);
  const hit = askFaqs({ widget: { faqs: [{ q: "价格", a: "一百元" }], fallback: "不清楚" } }, "价格是多少");
  assert.equal(hit.answer, "一百元");
  assert.equal(hit.fallback, false);
  const miss = askFaqs({ widget: { faqs: [{ q: "价格", a: "一百元" }], fallback: "不清楚" } }, "你好呀");
  assert.equal(miss.fallback, true);
  assert.equal(miss.answer, "不清楚");
});

test("推流参数：网络目标用 flv，本地目标用 mp4，分辨率正确", () => {
  const ctrl = new StreamController({ store: { config: { stream: {} }, personaFile: () => null }, log: () => {}, dataDir: os.tmpdir() });
  const net = ctrl.buildArgs({ avatarPath: "a.png", audioPath: "", fps: 25, size: "1080x1920", target: "rtmp://a/b", withAudio: false });
  assert.equal(net.network, true);
  assert.ok(net.args.includes("flv"));
  const vf = net.args[net.args.indexOf("-vf") + 1];
  assert.ok(vf.includes("scale=1080:1920"));
  const loc = ctrl.buildArgs({ avatarPath: "a.png", audioPath: "", fps: 25, size: "720x1280", target: "out.mp4", withAudio: false });
  assert.equal(loc.network, false);
  assert.ok(loc.args.includes("mp4"));
  assert.ok(loc.args.includes("-frames:v"));
});

test("推流真实编码：图片→本地 mp4，ffprobe 可读出时长与分辨率", async (t) => {
  const deps = detectStreamDeps();
  if (!deps.ready) { t.skip("本机无 ffmpeg，跳过真实编码"); return; }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dh-stream-"));
  const img = path.join(dir, "avatar.png");
  const gen = spawnSync(deps.ffmpeg, ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=720x1080:d=1", "-frames:v", "1", "-y", img], { windowsHide: true });
  assert.equal(gen.status, 0, "生成测试人像失败");
  const out = path.join(dir, "out.mp4");
  const store = {
    config: { stream: { platform: "custom", fps: 25, size: "1080x1920", withAudio: false, mode: "image" }, persona: { avatarId: "p1" } },
    personaFile: () => ({ path: img }),
  };
  const ctrl = new StreamController({ store, log: () => {}, dataDir: dir });
  await ctrl.start({ target: out, durationSec: 2, withAudio: false });
  const deadline = Date.now() + 25000;
  while (ctrl.status().running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
  }
  const info = await inspectMedia(out);
  assert.ok(info && Number(info.format?.duration) > 0.8, "生成的视频时长应大于 0.8s");
  const vs = (info.streams || []).find((s) => s.codec_type === "video");
  assert.equal(vs.width, 1080);
  assert.equal(vs.height, 1920);
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test("接待组件接口：配置可读、提问返回文字答复", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dh-widget-"));
  const store = await new Store(dir).init();
  await store.updateConfig({ widget: { faqs: [{ q: "怎么联系", a: "留下你的联系方式即可" }], fallback: "换个说法试试" } });
  const tts = { status: () => ({ available: false, engine: "none" }), detect: async () => ({ available: false }), synthesize: async () => { throw new Error("no tts"); } };
  const stub = { state() {}, cue() {}, control() {}, audio() {}, personas() {}, config() {}, log() {} };
  const script = new ScriptRunner({ store, tts, broadcast: stub });
  const ctx = createServer({ store, tts, scriptRunner: script });
  Object.assign(stub, ctx.broadcast);
  const token = newToken();
  ctx.setToken(token);
  const port = await listen(ctx.server, 0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const cfg = await fetch(`${base}/api/widget/config?token=${token}`).then((r) => r.json());
    assert.ok(cfg.widget && cfg.widget.title);
    assert.ok(cfg.persona && cfg.persona.kind, "接待配置应返回人物类型");
    assert.ok(cfg.motion && cfg.motion.mouthClip, "接待配置应返回口型参数");
    const ans = await fetch(`${base}/api/widget/ask?token=${token}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "我想问怎么联系你们" }),
    }).then((r) => r.json());
    assert.equal(ans.answer, "留下你的联系方式即可");
    const emb = await fetch(`${base}/embed.js`);
    assert.equal(emb.status, 200);
    const widget = await fetch(`${base}/widget?token=${token}`);
    assert.equal(widget.status, 200);
  } finally {
    await ctx.close();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});