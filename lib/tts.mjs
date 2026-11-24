import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");

function run(command, args, { timeoutMs = 60000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: cwd || pluginRoot, windowsHide: true });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ ok: false, code: -2, stdout, stderr: `${stderr}\ntimeout` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString().slice(0, 4000); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: String(error?.message || error) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

function venvPython() {
  const base = path.join(pluginRoot, "engine", ".venv");
  const candidate = process.platform === "win32"
    ? path.join(base, "Scripts", "python.exe")
    : path.join(base, "bin", "python");
  return fs.existsSync(candidate) ? candidate : "";
}

function guessPython() {
  const explicit = String(process.env.RUODAO_DH_PYTHON || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const fromVenv = venvPython();
  if (fromVenv) return fromVenv;
  return process.platform === "win32" ? "python" : "python3";
}

export class TtsService {
  constructor(dataDir, log = () => {}) {
    this.dataDir = dataDir;
    this.cacheDir = path.join(dataDir, "tts-cache");
    this.log = log;
    this.mode = null;
    this.detail = "";
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.promises.mkdir(this.cacheDir, { recursive: true });
    await this.detect(true);
    return this;
  }

  status() {
    return {
      available: this.mode !== "none",
      engine: this.mode || "none",
      detail: this.detail,
      hint: this.mode === "none"
        ? "未检测到本地语音合成。运行「一键安装语音」安装 edge-tts，或让系统朗读兜底。"
        : "",
    };
  }

  async detect(force = false) {
    if (this.mode && !force) return this.status();
    const python = guessPython();
    const probe = await run(python, ["-c", "import edge_tts,sys;print('edge-tts ok')"], { timeoutMs: 15000 });
    if (probe.ok && probe.stdout.includes("edge-tts ok")) {
      this.mode = "edge-tts";
      this.detail = `${python} · edge-tts`;
      return this.status();
    }
    if (process.platform === "win32") {
      const sapi = await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }) -join ','",
      ], { timeoutMs: 15000 });
      if (sapi.ok && sapi.stdout.trim()) {
        this.mode = "sapi";
        this.detail = `系统语音 · ${sapi.stdout.trim().split(",")[0]}`;
        return this.status();
      }
    }
    this.mode = "none";
    this.detail = probe.stderr.split("\n").filter(Boolean).slice(-1)[0] || "edge-tts 未安装";
    return this.status();
  }

  async installEdgeTts() {
    const python = String(process.env.RUODAO_DH_PYTHON || "").trim() || "python";
    const base = path.join(pluginRoot, "engine", ".venv");
    const create = await run(python, ["-m", "venv", base], { timeoutMs: 120000 });
    if (!create.ok) {
      return { ok: false, step: "venv", error: (create.stderr || create.stdout || "").slice(-800) };
    }
    const venv = venvPython();
    const pip = await run(venv, ["-m", "pip", "install", "--upgrade", "pip"], { timeoutMs: 180000 });
    if (!pip.ok) return { ok: false, step: "pip", error: (pip.stderr || "").slice(-800) };
    const install = await run(venv, ["-m", "pip", "install", "edge-tts"], { timeoutMs: 600000 });
    if (!install.ok) return { ok: false, step: "edge-tts", error: (install.stderr || "").slice(-800) };
    this.mode = null;
    await this.detect(true);
    return { ok: this.mode === "edge-tts", status: this.status() };
  }

  cacheKey(text, voice, rate, pitch) {
    return crypto.createHash("sha1").update(`${voice}|${rate}|${pitch}|${text}`).digest("hex");
  }

  async synthesize({ text, voice, rate = 0, pitch = 0 }) {
    const clean = String(text || "").trim().slice(0, 800);
    if (!clean) throw Object.assign(new Error("文本为空"), { statusCode: 400 });
    await this.detect(false);
    if (this.mode === "none") {
      throw Object.assign(new Error("本地语音合成不可用，请先安装 edge-tts"), { statusCode: 503 });
    }
    const safeVoice = String(voice || "zh-CN-XiaoxiaoNeural").replace(/[^A-Za-z-]/g, "");
    const key = this.cacheKey(clean, safeVoice, rate, pitch);
    const ext = this.mode === "sapi" ? "wav" : "mp3";
    const cacheFile = path.join(this.cacheDir, `${key}.${ext}`);
    if (fs.existsSync(cacheFile)) {
      const stat = await fs.promises.stat(cacheFile);
      if (stat.size > 512) {
        return { buffer: await fs.promises.readFile(cacheFile), mime: ext === "wav" ? "audio/wav" : "audio/mpeg", cached: true };
      }
    }
    const job = async () => {
      if (this.mode === "edge-tts") {
        const python = guessPython();
        const tmp = path.join(this.cacheDir, `${key}.tmp.mp3`);
        const rateText = `${rate >= 0 ? "+" : ""}${Math.round(rate)}%`;
        const pitchText = `${pitch >= 0 ? "+" : ""}${Math.round(pitch)}Hz`;
        const result = await run(python, [
          "-m", "edge_tts",
          "--text", clean,
          "--voice", safeVoice,
          `--rate=${rateText}`,
          `--pitch=${pitchText}`,
          "--write-media", tmp,
        ], { timeoutMs: 90000 });
        if (!result.ok || !fs.existsSync(tmp)) {
          this.mode = null;
          await this.detect(true);
          throw Object.assign(new Error(`语音合成失败：${(result.stderr || "").slice(-300) || "未知错误"}`), { statusCode: 502 });
        }
        const buffer = await fs.promises.readFile(tmp);
        await fs.promises.rm(tmp, { force: true });
        await fs.promises.writeFile(cacheFile, buffer);
        return { buffer, mime: "audio/mpeg", cached: false };
      }
      const wav = path.join(this.cacheDir, `${key}.tmp.wav`);
      const escapedText = clean.replace(/"/g, "`\"");
      const script = [
        "Add-Type -AssemblyName System.Speech",
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer",
        `$s.Rate=[math]::Min(10,[math]::Max(-10,[int](${Math.round(rate / 5)})))`,
        `$s.SetOutputToWaveFile("${wav.replace(/\\/g, "\\\\")}")`,
        `$s.Speak("${escapedText}")`,
        "$s.Dispose()",
      ].join("; ");
      const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 90000 });
      if (!result.ok || !fs.existsSync(wav)) {
        throw Object.assign(new Error("系统语音合成失败"), { statusCode: 502 });
      }
      const buffer = await fs.promises.readFile(wav);
      await fs.promises.rm(wav, { force: true });
      await fs.promises.writeFile(cacheFile, buffer);
      return { buffer, mime: "audio/wav", cached: false };
    };
    const pending = this.queue.then(job, job);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}