import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../lib/store.mjs";
import { TtsService } from "../lib/tts.mjs";
import { ScriptRunner, AudioCache } from "../lib/script.mjs";
import { createServer, listen, newToken } from "../lib/server.mjs";

async function bootstrap() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dh-srv-"));
  const store = await new Store(dir).init();
  const tts = { status: () => ({ available: false, engine: "none", detail: "test" }), detect: async () => ({ available: false }), synthesize: async () => { throw new Error("no tts"); } };
  const stub = { state() {}, cue() {}, control() {}, audio() {}, personas() {}, config() {}, log() {} };
  const script = new ScriptRunner({ store, tts, broadcast: stub });
  const ctx = createServer({ store, tts, scriptRunner: script });
  Object.assign(stub, ctx.broadcast);
  const token = newToken();
  ctx.setToken(token);
  const port = await listen(ctx.server, 0);
  return { dir, store, script, ctx, token, port, base: `http://127.0.0.1:${port}` };
}

test("无 token 的 API 返回 401，静态页可访问", async () => {
  const env = await bootstrap();
  try {
    const page = await fetch(`${env.base}/`);
    assert.equal(page.status, 200);
    const denied = await fetch(`${env.base}/api/state`);
    assert.equal(denied.status, 401);
  } finally {
    await env.ctx.close();
  }
});

test("带 token 可读取状态、更新配置并广播", async () => {
  const env = await bootstrap();
  try {
    const state = await fetch(`${env.base}/api/state?token=${env.token}`).then((r) => r.json());
    assert.equal(state.config.persona.name, "小若");
    assert.equal(state.script.total, 5);

    const updated = await fetch(`${env.base}/api/config?token=${env.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: { name: "阿若" }, script: { auto: false } }),
    }).then((r) => r.json());
    assert.equal(updated.config.persona.name, "阿若");
    assert.equal(env.store.config.persona.name, "阿若");
  } finally {
    await env.ctx.close();
  }
});

test("上传形象后 /media/persona 可读且状态包含它", async () => {
  const env = await bootstrap();
  try {
    const png = Buffer.alloc(400);
    png.writeUInt8(0x89, 0);
    png.write("PNG", 1, "ascii");
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(720, 16);
    png.writeUInt32BE(1080, 20);
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const result = await fetch(`${env.base}/api/persona?token=${env.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "测试", dataUrl }),
    }).then((r) => r.json());
    assert.equal(result.personas.length, 1);
    const media = await fetch(`${env.base}${result.persona.url}`);
    assert.equal(media.status, 200);
    assert.match(media.headers.get("content-type"), /image\/png/);
  } finally {
    await env.ctx.close();
  }
});

test("say 在语音不可用时仍下发字幕 cue", async () => {
  const env = await bootstrap();
  try {
    const result = await fetch(`${env.base}/api/say?token=${env.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    }).then((r) => r.json());
    assert.equal(result.cue.text, "你好");
    assert.equal(result.cue.hasAudio, false);
    assert.ok(result.cue.durationMs > 0);
  } finally {
    await env.ctx.close();
  }
});

test("AudioCache 淘汰最旧条目", () => {
  const cache = new AudioCache(2);
  cache.put("a", Buffer.from("1"), "audio/mpeg");
  cache.put("b", Buffer.from("2"), "audio/mpeg");
  cache.put("c", Buffer.from("3"), "audio/mpeg");
  assert.equal(cache.get("a"), null);
  assert.ok(cache.get("c"));
});