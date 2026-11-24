import { DEFAULT_FAQS } from "./settings.mjs";

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？、,.!?;；:：""''（）()\-]/g, "");
}

function bigrams(text) {
  const set = new Set();
  const clean = normalize(text);
  for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
  if (clean.length === 1) set.add(clean);
  return set;
}

const SYN_GROUPS = [
  ["上班", "营业", "工作时间", "几点开门", "几点下班", "营业时间", "开门", "关门"],
  ["退款", "退货", "退钱", "退单", "退回"],
  ["价格", "价钱", "费用", "多少钱", "报价", "收费", "什么价"],
  ["发货", "物流", "快递", "多久到", "几天到", "送达", "配送"],
  ["联系", "电话", "客服", "微信", "怎么找", "联系电话", "联系方式"],
  ["定制", "定做", "个性化", "订制"],
  ["地址", "在哪", "位置", "公司地址", "哪里"],
  ["售后", "质保", "保修", "维保"]
];

function tokenSet(text) {
  const clean = normalize(text);
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
  if (clean.length === 1) set.add(clean);
  for (const group of SYN_GROUPS) {
    if (group.some((w) => clean.indexOf(normalize(w)) >= 0)) {
      for (const w of group) set.add(normalize(w));
    }
  }
  return set;
}

export function scoreFaq(question, faqQuestion) {
  const qn = normalize(question);
  const fn = normalize(faqQuestion);
  if (!qn || !fn) return 0;
  if (qn.indexOf(fn) >= 0 || fn.indexOf(qn) >= 0) return 1;
  const a = tokenSet(question);
  const b = tokenSet(faqQuestion);
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit += 1;
  const recall = hit / a.size;
  const precision = hit / b.size;
  return Math.max(recall, precision * 0.9);
}

export function matchFaq(faqs, question, minScore = 0.34) {
  const list = (Array.isArray(faqs) && faqs.length ? faqs : DEFAULT_FAQS).filter((item) => item && item.q && item.a);
  let best = null;
  for (const item of list) {
    const score = scoreFaq(question, item.q);
    if (!best || score > best.score) best = { answer: item.a, matched: item.q, score };
  }
  if (best && best.score >= minScore) return best;
  return null;
}

export function askFaqs(config, question) {
  const w = config?.widget || {};
  const hit = matchFaq(w.faqs, question);
  if (hit) return { answer: hit.answer, matched: hit.matched, score: Number(hit.score.toFixed(2)), fallback: false };
  return {
    answer: w.fallback || "这个问题我还不太确定，你可以换个说法，或者留下联系方式让真人同事联系你。",
    matched: "",
    score: 0,
    fallback: true,
  };
}

export async function chatLlm(config, history, question, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 15000;
  const llm = (config && config.widget && config.widget.llm) || {};
  if (!llm.enabled || !llm.baseUrl || !llm.model) return { ok: false, error: "llm-not-configured" };
  const personaName = (config.persona && config.persona.name) || "数字人";
  const sys = (llm.systemPrompt || "你是一位数字人客服。") + "\n你叫" + personaName + "。";
  const messages = [{ role: "system", content: sys }];
  if (options.context) messages.push({ role: "system", content: "可参考资料：\n" + String(options.context).slice(0, 2000) + "\n请优先依据资料回答，资料没有的不要编造。" });
  const hist = Array.isArray(history) ? history.slice(-10) : [];
  for (const h of hist) {
    if (!h || !h.content) continue;
    messages.push({ role: h.role === "user" ? "user" : "assistant", content: String(h.content).slice(0, 800) });
  }
  messages.push({ role: "user", content: String(question || "").slice(0, 800) });
  const url = llm.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (llm.apiKey) headers.authorization = "Bearer " + llm.apiKey;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: llm.model, messages, temperature: 0.6, max_tokens: 400, stream: false }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: "http-" + res.status };
    const choice = (data.choices && data.choices[0]) || {};
    const content = (choice.message && choice.message.content) || choice.text || "";
    const answer = String(content).trim();
    if (!answer) return { ok: false, error: "empty" };
    return { ok: true, answer: answer.slice(0, 800) };
  } catch (error) {
    return { ok: false, error: error && error.name === "AbortError" ? "timeout" : String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }
}


export function splitKnowledge(text) {
  const raw = String(text || "");
  const parts = raw.split(/[\r\n]+/).flatMap(function (line) {
    return line.split(/[。！？!?；;]/);
  });
  return parts.map(function (s) { return s.trim(); }).filter(function (s) { return s.length >= 4; }).slice(0, 500);
}

export function searchKnowledge(config, question, topK) {
  const k = Number(topK) || 3;
  const snippets = splitKnowledge(config && config.widget && config.widget.knowledge);
  if (!snippets.length) return [];
  const qg = tokenSet(question);
  if (!qg.size) return [];
  const qn = normalize(question);
  const scored = snippets.map(function (text) {
    const tg = tokenSet(text);
    let hit = 0;
    for (const g of qg) if (tg.has(g)) hit += 1;
    const phrase = normalize(text).indexOf(qn) >= 0 ? 1 : 0;
    const score = phrase ? 1 : hit / qg.size;
    return { text: text, score: score };
  }).filter(function (x) { return x.score > 0; });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, k);
}
