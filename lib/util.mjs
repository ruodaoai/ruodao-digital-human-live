import fs from "node:fs";
import path from "node:path";

export function safeId(value, fallback = "") {
  const text = String(value || "").trim().toLowerCase();
  const cleaned = text.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || fallback;
}

export async function atomicWrite(filePath, text) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(temp, text, "utf8");
  try {
    await fs.promises.rename(temp, filePath);
  } catch {
    await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
    await fs.promises.rename(temp, filePath);
  }
}

export async function writeJson(filePath, value) {
  await atomicWrite(filePath, JSON.stringify(value, null, 2));
}

export async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function readJsonBody(req, limit = 24 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

export function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

export function nowIso() {
  return new Date().toISOString();
}