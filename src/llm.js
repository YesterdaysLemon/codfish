// Turning an informal sketch into a proof tree with a model.
//
// Two ways to pay for the model call:
//   house  - Workers AI on Codfish's Cloudflare account, metered and charged against the user's prepaid credit
//   own    - the user's own API key for one of the providers below; Codfish never pays for these

export const HOUSE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Workers AI bills per neuron. Charge = cost x markup + a flat fee, so every call earns at least a cent.
export const NEURON_PRICE_MICRO = 11;       // $0.011 per 1,000 neurons = 11 micro-dollars per neuron
export const MARKUP = 1.3;
export const FLAT_FEE_MICRO = 10_000;       // $0.01
export const MAX_CALL_MICRO = 50_000;       // a user needs at least $0.05 of credit before a house call

export function houseCharge(neurons) {
  const cost = neurons * NEURON_PRICE_MICRO; // micro-dollars
  return { costMicro: Math.ceil(cost), chargeMicro: Math.ceil(cost * MARKUP + FLAT_FEE_MICRO) };
}

// OpenAI-compatible chat endpoints. Anthropic has its own API shape.
export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", base: "https://api.anthropic.com/v1", defaultModel: "claude-sonnet-5-5", style: "anthropic" },
  openai:    { label: "OpenAI",             base: "https://api.openai.com/v1" },
  google:    { label: "Google (Gemini)",    base: "https://generativelanguage.googleapis.com/v1beta/openai" },
  xai:       { label: "xAI (Grok)",         base: "https://api.x.ai/v1" },
  deepseek:  { label: "DeepSeek",           base: "https://api.deepseek.com/v1" },
  moonshot:  { label: "Moonshot (Kimi)",    base: "https://api.moonshot.ai/v1" },
  zhipu:     { label: "Zhipu (GLM)",        base: "https://api.z.ai/api/paas/v4" },
  qwen:      { label: "Alibaba (Qwen)",     base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  custom:    { label: "Custom (OpenAI-compatible)", base: "" },
};

export const SYSTEM_PROMPT = `You turn an informal proof sketch into a proof tree for Codfish, an analysis board for proofs.
Reply with ONLY a JSON object, no prose and no code fences:
{"title": string, "steps": [{"id": number, "parent": number or null, "short": string, "text": string, "lean": string, "status": "unchecked" | "gap" | "counterexample", "note": string}]}

Rules:
- Step 1 is the main claim, with parent null. Every other step's parent is the id of the claim it directly supports.
- "short" is a label of at most 5 words. "text" is the step in plain English.
- "lean" is a Lean 4 + Mathlib statement of the step, without a proof. Use "" if the step can't be stated on its own.
- Use status "gap" when the sketch skips a justification (for example "clearly" or "obviously"), and say what is missing in "note".
- Use status "counterexample" only when the step is false and you give a concrete counterexample in "note".
- Otherwise use "unchecked". Never claim a step is verified: only Lean can do that.
- Keep the tree faithful to the sketch. Do not add a proof the author didn't give; flag missing pieces as gaps instead.`;

const STATUS = { unchecked: "unchecked", gap: "yellow", counterexample: "red" };

export function parseModelTree(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    const t = raw.replace(/```(?:json)?/g, "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("The model didn't return JSON.");
    obj = JSON.parse(t.slice(a, b + 1));
  }
  if (!obj || !Array.isArray(obj.steps) || !obj.steps.length) throw new Error("The model returned no steps.");
  const steps = obj.steps.slice(0, 80).map((s, i) => ({
    id: Number(s.id) || i + 1,
    parent: s.parent === null || s.parent === undefined || s.parent === "" ? null : Number(s.parent),
    short: String(s.short || `step ${i + 1}`).slice(0, 40),
    text: String(s.text || "").slice(0, 600),
    lean: String(s.lean || "").slice(0, 600),
    status: STATUS[s.status] || "unchecked",
    note: (s.status === "counterexample" ? "The model's claim, not checked: " : s.status === "gap" ? "" : "Formalized by a model. Not checked by Lean yet. ")
      + String(s.note || "").slice(0, 600),
  }));
  // Repair the tree: exactly one root, every parent must exist and come from a different step.
  const ids = new Set(steps.map(s => s.id));
  if (ids.size !== steps.length) steps.forEach((s, i) => (s.id = i + 1));
  const root = steps.find(s => s.parent === null) || steps[0];
  for (const s of steps) {
    if (s === root) s.parent = null;
    else if (s.parent === null || !steps.some(o => o.id === s.parent) || s.parent === s.id) s.parent = root.id;
  }
  // Break cycles by reattaching to the root.
  for (const s of steps) {
    const seen = new Set([s.id]);
    let p = s.parent;
    while (p !== null) {
      if (seen.has(p)) { s.parent = root.id; break; }
      seen.add(p);
      p = steps.find(o => o.id === p)?.parent ?? null;
    }
  }
  return { title: String(obj.title || "").slice(0, 120), steps };
}

export async function runHouse(env, sketch) {
  const res = await env.AI.run(HOUSE_MODEL, {
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: sketch }],
    max_tokens: 3000,
  });
  const out = res.response ?? res.choices?.[0]?.message?.content;
  return { output: out, neurons: Number(res.usage?.neurons) || 0, model: HOUSE_MODEL };
}

export async function runOwn(provider, apiKey, model, baseOverride, sketch) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("Unknown provider.");
  const base = provider === "custom" ? baseOverride : p.base;
  if (!/^https:\/\//.test(base || "")) throw new Error("This provider needs an https base URL in Settings.");
  const m = model || p.defaultModel;
  if (!m) throw new Error(`Set a model name for ${p.label} in Settings.`);
  let r, text;
  if (p.style === "anthropic") {
    r = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: m, max_tokens: 4000, system: SYSTEM_PROMPT, messages: [{ role: "user", content: sketch }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p.label}: ${j.error?.message || r.status}`);
    text = (j.content || []).map(c => c.text || "").join("");
  } else {
    r = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: m, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: sketch }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${p.label}: ${j.error?.message || j.message || r.status}`);
    text = j.choices?.[0]?.message?.content || "";
  }
  return { output: text, model: `${provider}/${m}` };
}
