import crypto from "node:crypto";

export class ScriptRunner {
  constructor({ store, tts, broadcast, log = () => {} }) {
    this.store = store;
    this.tts = tts;
    this.broadcast = broadcast;
    this.log = log;
    this.cursor = 0;
    this.timer = null;
    this.busy = false;
    this.current = null;
    this.history = [];
  }

  config() {
    return this.store.config.script;
  }

  start() {
    if (this.timer) return this.status();
    const interval = Math.max(6000, Number(this.config().intervalMs) || 22000);
    this.timer = setInterval(() => {
      this.advance({ manual: false }).catch((error) => this.log(`自动口播失败：${error?.message || error}`));
    }, interval);
    this.advance({ manual: false, silent: true }).catch(() => undefined);
    return this.status();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.status();
  }

  sync() {
    const auto = Boolean(this.config().auto);
    if (auto && !this.timer) return this.start();
    if (!auto && this.timer) return this.stop();
    return this.status();
  }

  status() {
    return {
      running: Boolean(this.timer),
      busy: this.busy,
      cursor: this.cursor,
      intervalMs: this.config().intervalMs,
      total: this.config().lines.length,
      current: this.current,
    };
  }

  async advance({ manual = false, silent = false } = {}) {
    if (this.busy) {
      if (manual) throw Object.assign(new Error("上一句还在合成，请稍候"), { statusCode: 429 });
      return null;
    }
    const lines = this.config().lines;
    if (!lines.length) return null;
    const text = lines[this.cursor % lines.length];
    this.cursor = (this.cursor + 1) % lines.length;
    return this.say(text, { manual, silent });
  }

  async say(text, { manual = false, silent = false } = {}) {
    const clean = String(text || "").trim().slice(0, 800);
    if (!clean) return null;
    this.busy = true;
    const cue = {
      id: `cue_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`,
      text: clean,
      at: Date.now(),
      source: manual ? "manual" : "auto",
      hasAudio: false,
      audioUrl: "",
      durationMs: Math.max(2200, Math.round(clean.length * 260)),
    };
    try {
      if (this.store.config.tts.enabled && this.tts.status().available && !silent) {
        const { buffer, mime } = await this.tts.synthesize({
          text: clean,
          voice: this.store.config.persona.voice,
          rate: this.store.config.persona.rate,
          pitch: this.store.config.persona.pitch,
        });
        this.broadcast.audio(cue.id, buffer, mime);
        cue.hasAudio = true;
        cue.audioUrl = `/api/audio/${cue.id}`;
        cue.durationMs = Math.max(1600, estimateDurationMs(buffer, mime));
      }
      this.current = cue;
      this.history.unshift(cue);
      this.history = this.history.slice(0, 40);
      this.broadcast.cue(cue);
      return cue;
    } finally {
      this.busy = false;
    }
  }

  stopSpeak() {
    this.current = null;
    this.broadcast.control({ action: "stop" });
  }
}

function estimateDurationMs(buffer, mime) {
  if (mime === "audio/wav" && buffer.length > 44) {
    const byteRate = buffer.readUInt32LE(28) || 32000;
    return Math.round(((buffer.length - 44) / byteRate) * 1000);
  }
  // MP3 没有可靠的时长头，按 48kbps 估算，前端会以真实 audio.duration 为准。
  return Math.round((buffer.length / 6000) * 1000);
}

export class AudioCache {
  constructor(limit = 12) {
    this.limit = limit;
    this.items = new Map();
  }

  put(id, buffer, mime) {
    this.items.set(id, { buffer, mime, at: Date.now() });
    while (this.items.size > this.limit) {
      const oldest = [...this.items.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!oldest) break;
      this.items.delete(oldest[0]);
    }
  }

  get(id) {
    return this.items.get(id) || null;
  }
}