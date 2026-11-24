import test from "node:test";
import assert from "node:assert/strict";
import { AgentHub } from "../lib/agent-session.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(hub) {
  for (let i = 0; i < 60; i += 1) {
    const busy = [...hub.sessions.values()].some((session) => session.typing || session.pending.length);
    if (!busy) return;
    await sleep(10);
  }
}

function makeHub(settings, answer = async (_session, question) => ({ text: `答：${question}`, source: "test" })) {
  let current = { ...settings };
  const hub = new AgentHub({
    getSettings: () => current,
    answer,
  });
  return {
    hub,
    setSettings(next) { current = { ...current, ...next }; },
  };
}

test("一对一接待：第二人排队，结束当前接待后自动轮到下一位", async () => {
  const { hub } = makeHub({ mode: "solo", maxActive: 1, idleSeconds: 600 });
  const a = hub.join({ visitorId: "a", name: "甲方" });
  const b = hub.join({ visitorId: "b", name: "乙方" });
  assert.equal(a.status, "active");
  assert.equal(b.status, "waiting");
  assert.equal(b.position, 1);
  assert.match(b.queueTip, /1/);

  hub.ask(a.id, "第一个问题");
  await settle(hub);
  assert.equal(hub.view(a.id).messages.filter((m) => m.role === "assistant").length, 1);

  hub.ask(b.id, "排队时先问");
  await settle(hub);
  assert.equal(hub.view(b.id).messages.filter((m) => m.role === "user").length, 1);
  assert.equal(hub.view(b.id).messages.filter((m) => m.role === "assistant").length, 0, "排队时不应该回答");

  hub.end(a.id);
  const promoted = hub.view(b.id);
  assert.equal(promoted.status, "active");
  await settle(hub);
  assert.equal(hub.view(b.id).messages.filter((m) => m.role === "assistant").length, 1, "轮到时自动回答排队问题");
});

test("一对多轮流接待：多位访客之间轮流回答，不连续抢答", async () => {
  const served = [];
  const { hub } = makeHub({ mode: "round-robin", maxActive: 3, idleSeconds: 600 }, async (_session, question) => {
    served.push(question);
    return { text: `答：${question}` };
  });
  const a = hub.join({ visitorId: "a" });
  const b = hub.join({ visitorId: "b" });
  assert.equal(a.status, "active");
  assert.equal(b.status, "active");
  const c = hub.join({ visitorId: "c" });
  assert.equal(c.status, "active");

  hub.ask(a.id, "A1");
  hub.ask(a.id, "A2");
  hub.ask(b.id, "B1");
  hub.ask(b.id, "B2");
  hub.ask(c.id, "C1");
  await settle(hub);

  assert.deepEqual(served.slice(0, 5), ["A1", "B1", "C1", "A2", "B2"]);
});

test("一对多直播：所有访客可同时提问，各自拿到回答", async () => {
  const { hub } = makeHub({ mode: "live", idleSeconds: 600 });
  const a = hub.join({ visitorId: "a" });
  const b = hub.join({ visitorId: "b" });
  const c = hub.join({ visitorId: "c" });
  assert.ok([a, b, c].every((session) => session.status === "active"));
  hub.ask(a.id, "A 的问题");
  hub.ask(b.id, "B 的问题");
  hub.ask(c.id, "C 的问题");
  await settle(hub);
  for (const session of [a, b, c]) {
    const view = hub.view(session.id);
    assert.equal(view.messages.filter((m) => m.role === "assistant").length, 1);
  }
});

test("空闲清理会释放一对一接待名额", async () => {
  let now = 1_000_000;
  let current = { mode: "solo", maxActive: 1, idleSeconds: 15 };
  const hub = new AgentHub({
    getSettings: () => current,
    answer: async (_session, question) => ({ text: `答：${question}` }),
    now: () => now,
  });
  const a = hub.join({ visitorId: "a" });
  const b = hub.join({ visitorId: "b" });
  assert.equal(a.status, "active");
  assert.equal(b.status, "waiting");
  now += 16_000;
  hub.sweep();
  assert.equal(hub.get(a.id).status, "ended");
  assert.equal(hub.get(b.id).status, "active");
});
