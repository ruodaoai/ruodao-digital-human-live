import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_CONFIG, normalizeConfig } from "./settings.mjs";
import { readJson, safeId, writeJson } from "./util.mjs";

export function resolveDataDir(explicit) {
  const fromArg = String(explicit || "").trim();
  if (fromArg) return path.resolve(fromArg);
  const fromEnv = String(process.env.RUODAO_PLUGIN_DATA_DIR || "").trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".ruodao", "digital-human-live");
}

export function imageSize(buffer) {
  if (!buffer || buffer.length < 24) return { width: 0, height: 0 };
  if (buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { width: 0, height: 0 };
  }
  return { width: 0, height: 0 };
}

function decodeDataUrl(dataUrl) {
  const match = /^data:(image\/(png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!match) throw Object.assign(new Error("只支持 PNG / JPEG / WebP 图片"), { statusCode: 400 });
  const ext = match[2] === "jpg" ? "jpeg" : match[2];
  const buffer = Buffer.from(match[3].replace(/\s+/g, ""), "base64");
  if (!buffer.length) throw Object.assign(new Error("图片内容为空"), { statusCode: 400 });
  if (buffer.length > 12 * 1024 * 1024) throw Object.assign(new Error("图片超过 12MB"), { statusCode: 413 });
  return { ext, mime: `image/${ext}`, buffer };
}

function personaName(value, index) {
  const text = String(value || "")
    .trim()
    .replace(/[\u0000-\u001f<>"\\/:*?|]+/g, "")
    .slice(0, 24);
  return text || `形象 ${index}`;
}

export class Store {
  constructor(dataDir) {
    this.dataDir = resolveDataDir(dataDir);
    this.configFile = path.join(this.dataDir, "config.json");
    this.personaDir = path.join(this.dataDir, "personas");
    this.personaIndex = path.join(this.personaDir, "index.json");
    this.config = structuredClone(DEFAULT_CONFIG);
    this.personas = [];
    this.listeners = new Set();
    this.appendQueue = Promise.resolve();
  }

  async init() {
    await fs.promises.mkdir(this.personaDir, { recursive: true });
    const raw = await readJson(this.configFile, null);
    this.config = normalizeConfig(raw || DEFAULT_CONFIG);
    const index = await readJson(this.personaIndex, []);
    this.personas = Array.isArray(index) ? index.filter((item) => item && item.id) : [];
    const alive = [];
    for (const item of this.personas) {
      const file = path.join(this.personaDir, item.file || "");
      if (item.file && fs.existsSync(file)) alive.push(item);
    }
    if (alive.length !== this.personas.length) {
      this.personas = alive;
      await writeJson(this.personaIndex, this.personas);
    }
    if (this.config.persona.avatarId && !this.personas.some((item) => item.id === this.config.persona.avatarId)) {
      this.config.persona.avatarId = this.personas[0]?.id || "";
      await this.saveConfig();
    }
    return this;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload) {
    for (const fn of this.listeners) {
      try {
        fn({ type, payload });
      } catch {
        /* 单个订阅者异常不影响其它订阅 */
      }
    }
  }

  async saveConfig() {
    await writeJson(this.configFile, this.config);
  }

  async updateConfig(patch) {
    this.config = normalizeConfig(merge(this.config, patch));
    await this.saveConfig();
    this.emit("config", this.config);
    return this.config;
  }

  listPersonas() {
    return this.personas.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind || "real",
      width: item.width || 0,
      height: item.height || 0,
      createdAt: item.createdAt,
      url: `/media/persona/${item.id}`,
    }));
  }

  async addPersona({ name, dataUrl, kind }) {
    const { ext, mime, buffer } = decodeDataUrl(dataUrl);
    const { width, height } = imageSize(buffer);
    if (width && height && (width < 240 || height < 240)) {
      throw Object.assign(new Error("图片太小，建议至少 720×1080"), { statusCode: 400 });
    }
    if (this.personas.length >= 24) {
      throw Object.assign(new Error("形象库已满（最多 24 个），请先删除不用的"), { statusCode: 400 });
    }
    const id = `p_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
    const file = `${id}.${ext}`;
    await fs.promises.writeFile(path.join(this.personaDir, file), buffer);
    const item = {
      id,
      name: personaName(name, this.personas.length + 1),
      kind: kind === "cartoon" ? "cartoon" : "real",
      file,
      mime,
      width,
      height,
      createdAt: new Date().toISOString(),
    };
    this.personas.unshift(item);
    await writeJson(this.personaIndex, this.personas);
    this.config.persona.avatarId = id;
    await this.saveConfig();
    this.emit("personas", this.listPersonas());
    return this.listPersonas()[0];
  }

  async removePersona(id) {
    const target = this.personas.find((item) => item.id === id);
    if (!target) throw Object.assign(new Error("形象不存在"), { statusCode: 404 });
    await fs.promises.rm(path.join(this.personaDir, target.file), { force: true });
    this.personas = this.personas.filter((item) => item.id !== id);
    await writeJson(this.personaIndex, this.personas);
    if (this.config.persona.avatarId === id) {
      this.config.persona.avatarId = this.personas[0]?.id || "";
      await this.saveConfig();
    }
    this.emit("personas", this.listPersonas());
    return { ok: true };
  }

  personaFile(id) {
    const target = this.personas.find((item) => item.id === id);
    if (!target) return null;
    return {
      path: path.join(this.personaDir, target.file),
      mime: target.mime || "image/png",
    };
  }

  snapshot(extra = {}) {
    return {
      config: this.config,
      personas: this.listPersonas(),
      ...extra,
    };
  }
}

function merge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      out[key] = merge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}