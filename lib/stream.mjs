import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const isWin = process.platform === "win32";

function resolveBinary(name, extra = []) {
  const fromEnv = name === "ffmpeg" ? process.env.FFMPEG_PATH : name === "ffprobe" ? process.env.FFPROBE_PATH : "";
  const candidates = [fromEnv, ...extra].filter(Boolean);
  const finder = isWin ? "where" : "which";
  try {
    const out = spawnSync(finder, [name], { encoding: "utf8" });
    if (out.status === 0) {
      const first = String(out.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) candidates.push(first);
    }
  } catch { /* ignore */ }
  // 若已在 PATH，直接用命令名
  candidates.push(name);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === name) return candidate;
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return "";
}

const FFMPEG = resolveBinary("ffmpeg");
const FFPROBE = resolveBinary("ffprobe");

export function detectStreamDeps() {
  let ffmpegVersion = "";
  if (FFMPEG) {
    try {
      const r = spawnSync(FFMPEG, ["-version"], { encoding: "utf8" });
      ffmpegVersion = String(r.stdout || "").split(/\r?\n/)[0] || "";
    } catch { /* ignore */ }
  }
  return {
    ready: Boolean(FFMPEG),
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    version: ffmpegVersion,
    hint: FFMPEG ? "" : "未检测到 ffmpeg，无法推流。网页直播（浏览器源）不受影响。",
  };
}

function parseSize(size) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(size || ""));
  if (!m) return { w: 1080, h: 1920 };
  return { w: Number(m[1]), h: Number(m[2]) };
}

function isNetworkTarget(target) {
  return /^(rtmp|rtmps|srt|rtsp):\/\//i.test(String(target || ""));
}

function redactTarget(target) {
  const text = String(target || "");
  if (!isNetworkTarget(text)) return text;
  try {
    const url = new URL(text.replace(/^rtmp:/i, "http:").replace(/^rtmps:/i, "https:"));
    return `${text.split("://")[0]}://${url.host}/***`;
  } catch {
    return text.replace(/([^/]*\/)[^/]*$/, "$1***");
  }
}

function buildTarget(stream) {
  const base = String(stream.rtmpUrl || "").trim();
  const key = String(stream.streamKey || "").trim();
  if (!base) return "";
  if (!key) return base;
  if (base.includes("%s")) return base.replace("%s", key);
  if (/\/$/.test(base)) return base + key;
  if (isNetworkTarget(base) && !/[?&]/.test(base) && base.split("/").length > 3) return base;
  return `${base.replace(/\/+$/, "")}/${key}`;
}

export class StreamController {
  constructor({ store, log = () => {}, dataDir }) {
    this.store = store;
    this.log = log;
    this.dataDir = dataDir;
    this.proc = null;
    this.since = 0;
    this.error = "";
    this.cfg = null;
    this.tail = [];
  }

  detect() {
    return detectStreamDeps();
  }

  status() {
    return {
      running: Boolean(this.proc),
      pid: this.proc ? this.proc.pid : 0,
      since: this.since || 0,
      elapsedMs: this.since ? Date.now() - this.since : 0,
      platform: this.cfg?.platform || this.store.config.stream.platform,
      mode: this.cfg?.mode || this.store.config.stream.mode,
      target: this.cfg ? redactTarget(this.cfg.target) : "",
      error: this.error,
      tail: this.tail.slice(-8),
      deps: detectStreamDeps(),
    };
  }

  resolveAvatarPath(avatarId) {
    const found = this.store.personaFile(avatarId || this.store.config.persona.avatarId);
    return found ? found.path : "";
  }

  buildArgs({ avatarPath, audioPath, fps, size, target, withAudio, durationSec }) {
    const dims = parseSize(size);
    const w = dims.w;
    const h = dims.h;
    const network = isNetworkTarget(target);
    const args = ["-nostdin", "-hide_banner", "-loglevel", "warning"];
    if (network) args.push("-re");
    args.push("-loop", "1", "-framerate", String(fps), "-i", avatarPath);
    const hasAudio = audioPath && withAudio && fs.existsSync(audioPath);
    if (hasAudio) {
      if (network) args.push("-stream_loop", "-1");
      args.push("-i", audioPath);
    }
    const vf = "scale=" + w + ":" + h + ":force_original_aspect_ratio=increase,crop=" + w + ":" + h + ",format=yuv420p";
    args.push(
      "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
      "-b:v", "3000k", "-maxrate", "3000k", "-bufsize", "6000k",
      "-g", String(fps * 2), "-pix_fmt", "yuv420p",
    );
    if (hasAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ar", "44100");
    if (network) {
      args.push("-f", "flv", "-flvflags", "no_duration_filesize", target);
    } else {
      const frames = Math.max(1, Math.round(fps * Math.max(1, Number(durationSec) || 3)));
      args.push("-frames:v", String(frames), "-f", "mp4", "-movflags", "+faststart", "-y", target);
    }
    return { args, network };
  }

  async start(input = {}) {
    if (this.proc) throw Object.assign(new Error("推流已在运行，请先停止"), { statusCode: 409 });
    if (!FFMPEG) throw Object.assign(new Error("未检测到 ffmpeg，无法推流；网页直播（浏览器源）仍可正常使用"), { statusCode: 400 });
    const cfg = { ...this.store.config.stream, ...input };
    const avatarPath = this.resolveAvatarPath(input.avatarId);
    if (!avatarPath) throw Object.assign(new Error("请先上传并选择一个形象"), { statusCode: 400 });
    const target = String(input.target || "").trim() || buildTarget(cfg);
    if (!target) throw Object.assign(new Error("请填写推流地址（RTMP/SRT）"), { statusCode: 400 });
    const fps = Math.max(10, Math.min(60, Number(cfg.fps) || 25));
    const withAudio = cfg.withAudio !== false;
    let audioPath = "";
    if (input.audioPath && fs.existsSync(input.audioPath)) audioPath = input.audioPath;

    const { args } = this.buildArgs({
      avatarPath,
      audioPath,
      fps,
      size: cfg.size,
      target,
      withAudio,
      durationSec: input.durationSec,
    });

    this.tail = [];
    this.error = "";
    this.cfg = { platform: cfg.platform, mode: cfg.mode, target };
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    this.proc = proc;
    this.since = Date.now();
    proc.stderr.on("data", (buf) => {
      const line = String(buf).trim();
      if (!line) return;
      this.tail.push(line.slice(0, 240));
      if (this.tail.length > 40) this.tail.shift();
      if (/error|failed|invalid|refused|denied|resolve/i.test(line)) this.error = line.slice(0, 240);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) {
        this.proc = null;
        if (code && code !== 0 && !this.error) this.error = `ffmpeg 退出码 ${code}${signal ? ` (${signal})` : ""}`;
        this.log(`推流结束：code=${code} ${this.error || ""}`);
      }
    });
    proc.on("error", (err) => {
      this.error = String(err?.message || err);
    });
    this.log(`推流启动：${cfg.platform} → ${redactTarget(target)} (${fps}fps ${cfg.size})`);
    return this.status();
  }

  stop() {
    if (!this.proc) return { ok: true, running: false };
    const proc = this.proc;
    try {
      if (isWin) spawnSync("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { windowsHide: true });
      else proc.kill("SIGTERM");
    } catch { try { proc.kill(); } catch { /* ignore */ } }
    this.proc = null;
    this.error = "";
    return { ok: true, running: false };
  }

  close() {
    try { this.stop(); } catch { /* ignore */ }
  }
}

export async function inspectMedia(file) {
  if (!FFPROBE || !fs.existsSync(file)) return null;
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE, ["-v", "error", "-show_entries", "format=duration,size:stream=width,height,codec_type", "-of", "json", file], { windowsHide: true });
    let out = "";
    proc.stdout.on("data", (b) => { out += b; });
    proc.on("close", () => {
      try { resolve(JSON.parse(out)); } catch { resolve(null); }
    });
    proc.on("error", () => resolve(null));
  });
}