import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, imageSize } from "../lib/store.mjs";
import { DEFAULT_CONFIG, normalizeConfig } from "../lib/settings.mjs";

function pngBuffer(width, height) {
  const buffer = Buffer.alloc(33);
  buffer.writeUInt8(0x89, 0);
  buffer.write("PNG", 1, "ascii");
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("imageSize 读取 PNG 尺寸", () => {
  const size = imageSize(pngBuffer(720, 1080));
  assert.deepEqual(size, { width: 720, height: 1080 });
});

test("imageSize 对损坏数据返回 0", () => {
  assert.deepEqual(imageSize(Buffer.from("nope")), { width: 0, height: 0 });
});

test("normalizeConfig 限制越界值并补齐默认话术", () => {
  const config = normalizeConfig({
    persona: { rate: 999, pitch: -999, name: "  主播  " },
    motion: { engine: "unknown", intensity: 5 },
    script: { intervalMs: 1, lines: [] },
  });
  assert.equal(config.persona.rate, 50);
  assert.equal(config.persona.pitch, -50);
  assert.equal(config.motion.engine, "still");
  assert.equal(config.motion.intensity, 1);
  assert.equal(config.script.intervalMs, 6000);
  assert.ok(config.script.lines.length > 0);
});

test("Store 保存形象并持久化配置", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dh-store-"));
  const store = await new Store(dir).init();
  const dataUrl = `data:image/png;base64,${Buffer.concat([pngBuffer(720, 1080), Buffer.alloc(200)]).toString("base64")}`;
  const persona = await store.addPersona({ name: "测试", dataUrl });
  assert.ok(persona.id.startsWith("p_"));
  assert.equal(persona.name, "测试");
  assert.equal(store.config.persona.avatarId, persona.id);
  assert.equal(store.listPersonas().length, 1);

  const reopened = await new Store(dir).init();
  assert.equal(reopened.listPersonas().length, 1);
  assert.equal(reopened.config.persona.avatarId, persona.id);

  await reopened.removePersona(persona.id);
  assert.equal(reopened.listPersonas().length, 0);
  assert.equal(reopened.config.persona.avatarId, "");
});

test("Store 拒绝非图片 dataUrl", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dh-store-"));
  const store = await new Store(dir).init();
  await assert.rejects(() => store.addPersona({ name: "x", dataUrl: "data:text/plain;base64,QQ==" }), /PNG/);
});

test("默认配置包含五个主播话术", () => {
  assert.ok(DEFAULT_CONFIG.script.lines.length >= 3);
});