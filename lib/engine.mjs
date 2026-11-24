import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");

export const ENGINE_PROTOCOL = {
  version: 1,
  endpoints: {
    health: "GET /health -> { ok, engine, gpu, fps, avatarReady }",
    avatar: "POST /avatar { image: dataUrl } -> { avatarId }",
    say: "POST /say { avatarId, audio: dataUrl } -> { jobId }",
    stream: "GET /stream?avatarId=... -> multipart/x-mixed-replace (MJPEG, 1080x1920)",
    reset: "POST /reset {}",
  },
};

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

export async function probeEngine(baseUrl, timeoutMs = 2500) {
  const url = safeUrl(baseUrl);
  if (!url) return { online: false, error: "引擎地址不是合法的 http(s) URL" };
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(new URL("/health", url), { signal: controller.signal });
    clearTimeout(timer);
    const data = await response.json().catch(() => ({}));
    return {
      online: response.ok && data.ok !== false,
      engine: data.engine || "",
      gpu: Boolean(data.gpu),
      gpuName: data.gpuName || "",
      fps: Number(data.fps) || 0,
      avatarReady: Boolean(data.avatarReady),
      latencyMs: Date.now() - startedAt,
      url: url.origin,
    };
  } catch (error) {
    return {
      online: false,
      error: error?.name === "AbortError" ? "引擎无响应（超时）" : String(error?.message || error),
      url: url.origin,
    };
  }
}

export function engineGuide({ hasNvidia, vramGb } = {}) {
  const rows = [
    "本插件默认用零依赖静态真人模式，不需要显卡，传图即可开播。",
    "想要真正逐帧口型同步，再装本地开源引擎（可选）：",
    "",
    "· Wav2Lip：约 2GB 显存即可实时，兼容性最好，清晰度一般。",
    "· MuseTalk：口型质量明显更好，官方建议 8GB 显存；6GB 需 fp16 + 降分辨率。",
    "· 两者都只做口型，不做头部大动作；需要点头/摆头再叠加 LivePortrait。",
    "",
    "安装：插件目录执行 `powershell -ExecutionPolicy Bypass -File scripts/install-engine.ps1`",
    "装完后本页「引擎」选择 local，地址填 http://127.0.0.1:8090。",
  ];
  if (hasNvidia && vramGb && vramGb < 8) {
    rows.unshift(`检测到 NVIDIA 显卡但只有 ${vramGb}GB 显存：MuseTalk 会吃紧，建议先用 Wav2Lip。`);
  }
  if (hasNvidia === false) {
    rows.unshift("未检测到 NVIDIA 显卡：本地开源口型引擎跑不动，建议保持静态真人模式。");
  }
  return rows.join("\n");
}

export async function detectGpu() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("nvidia-smi", [
        "--query-gpu=name,memory.total",
        "--format=csv,noheader",
      ], { windowsHide: true });
    } catch {
      resolve({ hasNvidia: false, name: "", vramGb: 0 });
      return;
    }
    let out = "";
    child.stdout?.on("data", (chunk) => { out += chunk.toString(); });
    child.on("error", () => resolve({ hasNvidia: false, name: "", vramGb: 0 }));
    child.on("close", (code) => {
      if (code !== 0 || !out.trim()) {
        resolve({ hasNvidia: false, name: "", vramGb: 0 });
        return;
      }
      const first = out.trim().split("\n")[0];
      const [name, mem] = first.split(",").map((item) => item.trim());
      const mb = Number(String(mem || "").replace(/[^\d]/g, ""));
      resolve({ hasNvidia: true, name, vramGb: Math.round((mb / 1024) * 10) / 10 });
    });
  });
}

export function engineServerPath() {
  return path.join(pluginRoot, "engine", "server.py");
}

export function pythonPath() {
  const explicit = String(process.env.RUODAO_DH_PYTHON || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const venv = process.platform === "win32"
    ? path.join(pluginRoot, "engine", ".venv", "Scripts", "python.exe")
    : path.join(pluginRoot, "engine", ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}