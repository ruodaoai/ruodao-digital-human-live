/**
 * 数字人接待队列（纯状态机，不直接碰网络/存储）。
 *
 * 三种模式：
 *  - live        一对多直播：所有访客都能随时提问，数字人按到达顺序逐条回答。
 *  - solo        一对一接待：同一时刻只有一位访客占用数字人，其余访客排队，
 *                当前访客结束接待后自动把队首提升为 active。
 *  - round-robin 一对多轮流接待：允许多位访客同时在线，但数字人一次只回答
 *                一条，并在访客之间轮转，保证每个人都能被挨着回答。
 *
 * 回答由外部注入的 answer(session, question) 生成；这样队列、公平性与
 * 存储/模型/TTS 解耦，测试可以完全离线跑。
 */

export const AGENT_MODES = ["live", "solo", "round-robin"];

export const AGENT_MODE_LABELS = {
  live: "一对多直播",
  solo: "一对一接待（其他访客排队）",
  "round-robin": "一对多轮流接待",
};

export const DEFAULT_AGENT_SETTINGS = {
  mode: "live",
  maxActive: 3,
  queueTip: "前面还有 {position} 位访客，接待完就轮到你，请稍候。",
  welcome: "你好，我是数字人助手，可以直接打字或说话，我会马上回答。",
  useHostLlm: true,
  speakReplies: true,
  idleSeconds: 90,
};

let sequence = 0;
function uid(prefix) {
  sequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export class AgentHub {
  constructor(options = {}) {
    this.getSettings = options.getSettings || (() => DEFAULT_AGENT_SETTINGS);
    this.answer = options.answer || (async () => ({ text: "" }));
    this.onChange = options.onChange || (() => {});
    this.now = options.now || (() => Date.now());
    this.sessions = new Map();
    this.byVisitor = new Map();
    this.draining = false;
    this.destroyed = false;
    this.serveTick = 0;
  }

  settings() {
    const raw = this.getSettings() || {};
    const mode = AGENT_MODES.includes(raw.mode) ? raw.mode : DEFAULT_AGENT_SETTINGS.mode;
    const maxActive = Math.min(20, Math.max(1, Math.round(Number(raw.maxActive) || DEFAULT_AGENT_SETTINGS.maxActive)));
    return {
      mode,
      maxActive,
      queueTip: String(raw.queueTip || DEFAULT_AGENT_SETTINGS.queueTip).slice(0, 300),
      welcome: String(raw.welcome || DEFAULT_AGENT_SETTINGS.welcome).slice(0, 300),
      useHostLlm: raw.useHostLlm !== false,
      speakReplies: raw.speakReplies !== false,
      idleSeconds: Math.min(3600, Math.max(15, Math.round(Number(raw.idleSeconds) || DEFAULT_AGENT_SETTINGS.idleSeconds))),
    };
  }

  join({ visitorId, name } = {}) {
    const vid = String(visitorId || "").trim().slice(0, 80) || uid("visitor");
    const existing = this.byVisitor.get(vid);
    if (existing && existing.status !== "ended") return this.view(existing);

    const settings = this.settings();
    const session = {
      id: uid("v"),
      visitorId: vid,
      name: String(name || "").trim().slice(0, 30) || `访客 ${this.sessions.size + 1}`,
      status: "waiting",
      mode: settings.mode,
      messages: [],
      pending: [],
      createdAt: this.now(),
      queueAt: this.now(),
      lastAt: this.now(),
      lastServedAt: 0,
      typing: false,
      turns: 0,
    };
    this.sessions.set(session.id, session);
    this.byVisitor.set(vid, session);
    this.assign(session, settings);
    this.pushSystem(session, settings.welcome);
    if (session.status === "waiting") {
      this.pushSystem(session, this.queueTip(session, settings));
    }
    this.touch();
    void this.drain();
    return this.view(session);
  }

  assign(session, settings) {
    const activeCount = this.activeSessions().length;
    if (settings.mode === "live") session.status = "active";
    else if (settings.mode === "solo") session.status = activeCount === 0 ? "active" : "waiting";
    else session.status = activeCount < settings.maxActive ? "active" : "waiting";
    if (session.status === "waiting") session.queueAt = this.now();
  }

  activeSessions() {
    return [...this.sessions.values()].filter((session) => session.status === "active");
  }

  waitingSessions() {
    return [...this.sessions.values()]
      .filter((session) => session.status === "waiting")
      .sort((a, b) => (a.queueAt || a.createdAt) - (b.queueAt || b.createdAt));
  }

  queueTip(session, settings = this.settings()) {
    const waiting = this.waitingSessions();
    const index = waiting.findIndex((item) => item.id === session.id);
    const position = index >= 0 ? index + 1 : 0;
    return settings.queueTip
      .replace(/\{position\}/g, String(position))
      .replace(/\{count\}/g, String(waiting.length));
  }

  get(sessionId) {
    return this.sessions.get(String(sessionId || "")) || null;
  }

  getByVisitor(visitorId) {
    return this.byVisitor.get(String(visitorId || "")) || null;
  }

  ask(sessionId, question) {
    const session = this.get(sessionId);
    if (!session || session.status === "ended") throw badRequest("接待会话不存在或已结束，请重新进入");
    const text = String(question || "").trim().slice(0, 500);
    if (!text) throw badRequest("请输入问题");

    session.lastAt = this.now();
    session.messages.push({ id: uid("m"), role: "user", text, at: this.now() });
    if (session.pending.length >= 5) {
      throw Object.assign(new Error("问题太多啦，等数字人回答完这一条再继续"), { statusCode: 429 });
    }
    session.pending.push({ id: uid("p"), text, at: this.now() });
    this.touch();
    if (session.status === "active") void this.drain();
    return { session: this.view(session), queued: session.status === "waiting" };
  }

  end(sessionId) {
    const session = this.get(sessionId);
    if (!session) return null;
    if (session.status !== "ended") {
      const wasActive = session.status === "active";
      session.status = "ended";
      session.pending = [];
      session.typing = false;
      session.lastAt = this.now();
      this.pushSystem(session, "本次接待已结束。需要继续咨询可以重新进入。");
      if (this.byVisitor.get(session.visitorId) === session) this.byVisitor.delete(session.visitorId);
      this.touch();
      if (wasActive) this.promoteNext();
    }
    return this.view(session);
  }

  promoteNext() {
    const settings = this.settings();
    if (settings.mode === "live") return;
    const activeCount = this.activeSessions().length;
    const capacity = settings.mode === "solo"
      ? Math.max(0, 1 - activeCount)
      : Math.max(0, settings.maxActive - activeCount);
    if (capacity <= 0) return;
    const waiting = this.waitingSessions().slice(0, capacity);
    for (const session of waiting) {
      session.status = "active";
      session.lastAt = this.now();
      this.pushSystem(session, "轮到你了，请直接输入问题，数字人会马上回答。");
    }
    if (waiting.length) {
      this.touch();
      void this.drain();
    }
  }

  /** 串行回答：同一时刻只生成一条，轮流模式在访客之间轮转。 */
  async drain() {
    if (this.draining || this.destroyed) return;
    this.draining = true;
    try {
      for (;;) {
        const next = this.pickNext();
        if (!next || this.destroyed) break;
        const { session, item } = next;
        session.typing = true;
        this.touch();
        let reply;
        try {
          reply = await this.answer(session, item.text);
        } catch (error) {
          reply = { text: `抱歉，刚才没答上来：${error?.message || error}`, source: "error" };
        }
        session.typing = false;
        session.turns += 1;
        // 单调递增的接待序号：同一毫秒内连续回答也能稳定轮转，
        // 不能用 Date.now() 排序，否则 A 可能连续抢答两次。
        session.lastServedAt = (this.serveTick += 1);
        session.lastAt = this.now();
        const text = String(reply?.text || "").trim() || "这个问题我还不太确定，可以换个说法吗？";
        session.messages.push({
          id: uid("m"),
          role: "assistant",
          text,
          at: this.now(),
          audioUrl: reply?.audioUrl || "",
          source: reply?.source || "",
        });
        this.touch();
      }
    } finally {
      this.draining = false;
    }
  }

  pickNext() {
    const settings = this.settings();
    const active = this.activeSessions().filter((session) => session.pending.length);
    if (!active.length) return null;
    if (settings.mode !== "solo") {
      active.sort((a, b) => a.lastServedAt - b.lastServedAt);
    }
    const session = active[0];
    return { session, item: session.pending.shift() };
  }

  /** 清理长期等待/空闲会话，并把空出来的名额让给排队访客。 */
  sweep() {
    const settings = this.settings();
    const now = this.now();
    const idleMs = settings.idleSeconds * 1000;
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.status === "waiting" && now - (session.queueAt || session.createdAt) > 10 * 60 * 1000) {
        session.status = "ended";
        session.pending = [];
        this.pushSystem(session, "等待时间过长，本次排队已结束，请重新进入。");
        if (this.byVisitor.get(session.visitorId) === session) this.byVisitor.delete(session.visitorId);
        changed = true;
      } else if (
        session.status === "active"
        && settings.mode !== "live"
        && !session.typing
        && !session.pending.length
        && now - session.lastAt > idleMs
      ) {
        session.status = "ended";
        session.pending = [];
        this.pushSystem(session, "长时间没有互动，本次接待已自动结束。");
        if (this.byVisitor.get(session.visitorId) === session) this.byVisitor.delete(session.visitorId);
        changed = true;
      }
    }
    // ended 会话保留 30 分钟供前端读取最后状态，再整体回收。
    for (const [id, session] of this.sessions) {
      if (session.status === "ended" && now - session.lastAt > 30 * 60 * 1000) this.sessions.delete(id);
    }
    if (changed) {
      this.promoteNext();
      this.touch();
    }
    return changed;
  }

  view(target) {
    const session = typeof target === "string" ? this.get(target) : target;
    if (!session) return null;
    const settings = this.settings();
    const waiting = this.waitingSessions();
    const index = waiting.findIndex((item) => item.id === session.id);
    return {
      id: session.id,
      visitorId: session.visitorId,
      name: session.name,
      status: session.status,
      mode: settings.mode,
      modeLabel: AGENT_MODE_LABELS[settings.mode],
      typing: session.typing,
      position: index >= 0 ? index + 1 : 0,
      waitingCount: waiting.length,
      maxActive: settings.maxActive,
      queueTip: this.queueTip(session, settings),
      speakReplies: settings.speakReplies,
      messages: session.messages.slice(-80),
      createdAt: session.createdAt,
      lastAt: session.lastAt,
      turns: session.turns,
    };
  }

  status() {
    const settings = this.settings();
    const all = [...this.sessions.values()];
    return {
      mode: settings.mode,
      modeLabel: AGENT_MODE_LABELS[settings.mode],
      maxActive: settings.maxActive,
      active: all.filter((session) => session.status === "active").length,
      waiting: all.filter((session) => session.status === "waiting").length,
      total: all.filter((session) => session.status !== "ended").length,
      sessions: all
        .filter((session) => session.status !== "ended")
        .map((session) => ({
          id: session.id,
          name: session.name,
          status: session.status,
          turns: session.turns,
          pending: session.pending.length,
          typing: session.typing,
          lastAt: session.lastAt,
        })),
    };
  }

  pushSystem(session, text) {
    const clean = String(text || "").trim();
    if (!clean) return;
    const last = session.messages[session.messages.length - 1];
    if (last && last.role === "system" && last.text === clean) return;
    session.messages.push({ id: uid("m"), role: "system", text: clean, at: this.now() });
  }

  touch() {
    try {
      this.onChange(this.status());
    } catch { /* 观察者失败不影响队列 */ }
  }

  destroy() {
    this.destroyed = true;
    this.sessions.clear();
    this.byVisitor.clear();
  }
}
