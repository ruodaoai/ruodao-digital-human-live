import fs from "node:fs";
import path from "node:path";

const SOURCES = ["llm", "faq", "kb", "fallback"];

export class WidgetStats {
  constructor(dataDir) {
    this.dataDir = dataDir || "";
    this.file = dataDir ? path.join(dataDir, "widget-stats.json") : "";
    this.data = { since: new Date().toISOString(), opens: 0, asks: 0, bySource: { llm: 0, faq: 0, kb: 0, fallback: 0 }, recent: [] };
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (j && typeof j === "object") {
        this.data = {
          since: j.since || this.data.since,
          opens: Number(j.opens) || 0,
          asks: Number(j.asks) || 0,
          bySource: { ...this.data.bySource, ...(j.bySource || {}) },
          recent: Array.isArray(j.recent) ? j.recent.slice(0, 20) : [],
        };
      }
    } catch { /* ignore */ }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch { /* ignore */ }
  }

  bumpOpen() {
    this.data.opens = (this.data.opens || 0) + 1;
    this.save();
  }

  recordAsk(question, source) {
    const src = SOURCES.includes(source) ? source : "fallback";
    this.data.asks = (this.data.asks || 0) + 1;
    this.data.bySource[src] = (this.data.bySource[src] || 0) + 1;
    this.data.recent.unshift({ q: String(question || "").slice(0, 60), source: src, at: Date.now() });
    this.data.recent = this.data.recent.slice(0, 20);
    this.save();
  }

  summary() {
    const asks = this.data.asks || 0;
    const fb = this.data.bySource.fallback || 0;
    const hitRate = asks ? Math.round(((asks - fb) / asks) * 100) : 0;
    return {
      since: this.data.since,
      opens: this.data.opens || 0,
      asks,
      hitRate,
      bySource: { ...this.data.bySource },
      recent: this.data.recent.slice(0, 5),
    };
  }
}
