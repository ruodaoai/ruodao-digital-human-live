#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store, resolveDataDir } from "../lib/store.mjs";
import { TtsService } from "../lib/tts.mjs";
import { ScriptRunner } from "../lib/script.mjs";
import { createServer, listen, newToken } from "../lib/server.mjs";
import { detectGpu, engineGuide, probeEngine } from "../lib/engine.mjs";
import { StreamController } from "../lib/stream.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const version = "0.9.0";

let booted = false;
let shuttingDown = false;
let hostMode = false;
let booting = null;
let store = null;
let tts = null;
let scriptRunner = null;
let serverCtx = null;
let streamCtl = null;
let cfg = { port: 43210, dataDir: "" };
let token = "";
let port = 0;
let gpu = { hasNvidia: false, name: "", vramGb: 0 };

function log(message) {
  try {
    process.stderr.write(`[digital-human-live] ${String(message).replace(/\s+/g, " ").slice(0, 1000)}\n`);
  } catch {
    /* stderr 已关闭 */
  }
}

function send(message) {
  try {
    if (!process.stdout.writable) return false;
    process.stdout.write(`${JSON.stringify(message)}\n`);
    return true;
  } catch {
    /* 宿主已断开 */
    return false;
  }
}

// 插件 → 宿主的反向调用（模型、宿主信息等）。宿主只放行 manifest
// services[].hostMethods 里声明过的方法。
let hostRequestSeq = 0;
const hostPending = new Map();

function callHost(method, params = {}, timeoutMs = 60000) {
  if (!hostMode) return Promise.reject(new Error("当前不在若道宿主中，无法调用宿主能力"));
  const id = `h_${Date.now().toString(36)}_${(hostRequestSeq += 1).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostPending.delete(id);
      reject(new Error(`宿主能力调用超时：${method}`));
    }, Math.max(1000, Number(timeoutMs) || 60000));
    hostPending.set(id, { resolve, reject, timer });
    const ok = send({ type: "request", id, method, params });
    if (!ok) {
      clearTimeout(timer);
      hostPending.delete(id);
      reject(new Error("宿主通道已断开"));
    }
  });
}

function rejectHostPending(error) {
  for (const [id, pending] of hostPending) {
    clearTimeout(pending.timer);
    pending.reject(error);
    hostPending.delete(id);
  }
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command: rest[0] || "serve", flags };
}

async function boot(payload = {}) {
  if (booted) return runtimeInfo();
  if (booting) return booting;
  booting = (async () => {
    cfg = {
      port: Number(payload.port || process.env.RUODAO_DH_PORT || 43210) || 43210,
      dataDir: resolveDataDir(payload.dataDir || process.env.RUODAO_PLUGIN_DATA_DIR || ""),
    };
    store = await new Store(cfg.dataDir).init();
    tts = await new TtsService(store.dataDir, log).init();
    const tokenFile = path.join(cfg.dataDir, "token");
    let savedToken = "";
    try { savedToken = (await fs.promises.readFile(tokenFile, "utf8")).trim(); } catch { savedToken = ""; }
    token = String(payload.token || "").trim() || (savedToken.length >= 16 ? savedToken : newToken());
    await fs.promises.mkdir(cfg.dataDir, { recursive: true });
    await fs.promises.writeFile(tokenFile, token, "utf8");
    const broadcastStub = {
      state() {},
      cue() {},
      control() {},
      audio() {},
      personas() {},
      config() {},
      log() {},
    };
    scriptRunner = new ScriptRunner({ store, tts, broadcast: broadcastStub, log });
    streamCtl = new StreamController({ store, log, dataDir: store.dataDir });
    serverCtx = createServer({
      store,
      tts,
      scriptRunner,
      log,
      getGpu: () => gpu,
      stream: streamCtl,
      hostCall: callHost,
    });
    Object.assign(broadcastStub, serverCtx.broadcast);
    serverCtx.setToken(token);
    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        port = await listen(serverCtx.server, cfg.port + attempt);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (String(error?.code) !== "EADDRINUSE") break;
      }
    }
    if (lastError) throw lastError;
    gpu = await detectGpu();
    const runtime = {
      port,
      token,
      url: `http://127.0.0.1:${port}`,
      stageUrl: `http://127.0.0.1:${port}/stage?token=${token}`,
      pid: process.pid,
      version,
      dataDir: store.dataDir,
      startedAt: new Date().toISOString(),
    };
    await fs.promises.mkdir(store.dataDir, { recursive: true });
    await fs.promises.writeFile(path.join(store.dataDir, "runtime.json"), JSON.stringify(runtime, null, 2), "utf8");
    store.onChange(() => serverCtx.broadcast.state());
    scriptRunner.sync();
    booted = true;
    return { ...runtime, gpu, tts: tts.status() };
  })();
  try {
    return await booting;
  } finally {
    booting = null;
  }
}

function runtimeInfo() {
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    stageUrl: `http://127.0.0.1:${port}/stage?token=${token}`,
    pid: process.pid,
    version,
    dataDir: store?.dataDir || "",
    gpu,
    tts: tts?.status() || null,
  };
}

function requireBooted() {
  if (!booted) throw new Error("服务尚未初始化");
}

async function handle(method, params = {}) {
  switch (method) {
    case "ping":
      return { ok: true, at: Date.now(), version };
    case "runtime":
      requireBooted();
      return runtimeInfo();
    case "state":
      requireBooted();
      return serverCtx.statePayload();
    case "say": {
      requireBooted();
      const cue = await scriptRunner.say(params.text, { manual: true });
      return { cue, script: scriptRunner.status() };
    }
    case "next":
      requireBooted();
      return { cue: await scriptRunner.advance({ manual: true }), script: scriptRunner.status() };
    case "stop":
      requireBooted();
      scriptRunner.stopSpeak();
      return { ok: true };
    case "probe-engine": {
      requireBooted();
      const status = await probeEngine(params.url || store.config.motion.localUrl);
      return status;
    }
    case "guide":
      return { guide: engineGuide(gpu), protocol: null, gpu };
    case "update-config": {
      requireBooted();
      await store.updateConfig(params.patch || {});
      scriptRunner.sync();
      return store.config;
    }
    case "agent-status":
      requireBooted();
      return serverCtx.statePayload().agent;
    case "agent-config":
      requireBooted();
      return store.config.widget.agent;
    case "agent-update": {
      requireBooted();
      await store.updateConfig({ widget: { agent: params.patch || {} } });
      return store.config.widget.agent;
    }
    case "shutdown":
      await shutdown(0);
      return { ok: true };
    default:
      throw new Error(`未知方法：${method}`);
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  rejectHostPending(new Error("插件服务正在关闭"));
  try { streamCtl?.close(); } catch { /* ignore */ }
  try {
    scriptRunner?.stop();
  } catch { /* ignore */ }
  try {
    await serverCtx?.close();
  } catch (error) {
    log(`关闭服务失败：${error?.message || error}`);
  }
  try {
    if (store?.dataDir) await fs.promises.rm(path.join(store.dataDir, "runtime.json"), { force: true });
  } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 40);
}

async function onMessage(message) {
  if (!message || typeof message !== "object") return;
  const type = String(message.type || "");
  if (type === "init") {
    hostMode = true;
    try {
      const info = await boot(message.payload || {});
      send({ type: "ready", payload: { ...info, webRoot: path.join(pluginRoot, "web") } });
      serverCtx.broadcast.state();
    } catch (error) {
      log(`init failed: ${error?.stack || error}`);
      send({ type: "event", event: "dh-error", payload: { message: String(error?.message || error) } });
      await shutdown(1);
    }
    return;
  }
  if (type === "response") {
    const id = String(message.id || "");
    const pending = hostPending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    hostPending.delete(id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(String(message.error || "宿主调用失败")));
    return;
  }
  if (type === "request") {
    const id = String(message.id || "");
    try {
      const result = await handle(String(message.method || ""), message.params || {});
      send({ type: "response", id, ok: true, result });
    } catch (error) {
      send({ type: "response", id, ok: false, error: String(error?.message || error).slice(0, 2000) });
    }
    return;
  }
  if (type === "shutdown") {
    await shutdown(0);
  }
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags["data-dir"]) process.env.RUODAO_PLUGIN_DATA_DIR = String(flags["data-dir"]);
  if (flags.port) process.env.RUODAO_DH_PORT = String(flags.port);

  if (command === "serve") {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        buffer = "";
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "").trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            void onMessage(JSON.parse(line));
          } catch (error) {
            log(`invalid message: ${error?.message || error}`);
          }
        }
        index = buffer.indexOf("\n");
      }
    });
    process.stdin.on("end", () => { if (hostMode) shutdown(0); });
    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    process.stdout.on("error", () => undefined);
    process.on("uncaughtException", (error) => log(`uncaught: ${error?.stack || error}`));
    process.on("unhandledRejection", (error) => log(`unhandled rejection: ${error?.stack || error}`));

    setTimeout(() => {
      if (booted || booting) return;
      boot({}).then((info) => {
        log(`standalone mode · ${info.url}`);
        log(`open: ${info.url}/?token=${info.token}`);
        process.stdout.write(`${JSON.stringify({ type: "ready", payload: { ...info, webRoot: path.join(pluginRoot, "web") } })}\n`);
      }).catch((error) => {
        log(`standalone boot failed: ${error?.stack || error}`);
        process.exit(1);
      });
    }, 2500).unref?.();
    return;
  }

  if (command === "status") {
    const dataDir = resolveDataDir(flags["data-dir"] || "");
    const file = path.join(dataDir, "runtime.json");
    const runtime = JSON.parse(await fs.promises.readFile(file, "utf8").catch(() => "null"));
    console.log(JSON.stringify(runtime || { running: false, dataDir }, null, 2));
    return;
  }

  if (command === "guide") {
    const info = await detectGpu();
    console.log(engineGuide(info));
    console.log(`\nGPU: ${info.hasNvidia ? `${info.name} · ${info.vramGb}GB` : "未检测到 NVIDIA"}`);
    return;
  }

  console.log(JSON.stringify({ ok: true, commands: ["serve", "status", "guide"], version }));
}

main().catch((error) => {
  log(error?.stack || error);
  process.exit(1);
});
