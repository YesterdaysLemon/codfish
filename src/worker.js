// Codfish: the demo board, the workspace, and its API.
import DEMO_HTML from "../public/index.html";
import APP_HTML from "../public/app.html";
import THEMES_CSS from "../public/themes.css";
import THEMES_JS from "../public/themes.js.txt";
import DAILY_HTML from "../public/daily.html";
import BLOCKS_HTML from "../public/blocks.html";
import BLOCKS_JS from "../public/blocks.js.txt";
import BONSAI_JS from "../public/bonsai.js.txt";
import PLAYBOOK_JS from "../public/playbook.js.txt";
import { parseLean } from "./lean.js";
import { PROVIDERS, VARIANTS, variantOf, HOUSE_MODEL, MAX_CALL_MICRO, houseCharge, parseModelTree, runHouse, runOwn } from "./llm.js";

const DAY_MS = 86_400_000;
const SESSION_DAYS = 30;
const CODE_TTL_MS = 10 * 60_000;
const MAX_SOURCE = 100_000;
const MAX_PROOFS = 200;
const COOKIE = "codfish_session";
const THEMES = ["auto", "heartwood-light", "heartwood-night", "proofruns", "paper", "chalk", "aquarium", "infoview"];

// ---------- small helpers ----------

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randomToken = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const newId = () => randomToken(12);
const today = () => new Date().toISOString().slice(0, 10);

async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

async function aesKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(env.SECRET + ":api-keys"));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plain));
  return b64(iv) + "." + b64(ct);
}
async function unseal(env, sealed) {
  const [iv, ct] = sealed.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await aesKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

async function body(request) {
  if (!(request.headers.get("content-type") || "").includes("application/json")) throw new HttpError(415, "Send JSON.");
  const text = await request.text();
  if (text.length > MAX_SOURCE + 10_000) throw new HttpError(413, "That's too large.");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "Bad JSON."); }
}

function cookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const isAdmin = (env, email) => (env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).includes(email);

// ---------- auth ----------

async function currentUser(request, env) {
  const token = cookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email, u.settings, u.credit_micro FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256(token), Date.now()).first();
  return row || null;
}

async function requireUser(request, env) {
  const u = await currentUser(request, env);
  if (!u) throw new HttpError(401, "Sign in first.");
  return u;
}

async function limitSend(env, key, now) {
  const row = await env.DB.prepare("SELECT sent_at, hour_start, hour_sends FROM login_codes WHERE email = ?").bind(key).first();
  const perHour = key.startsWith("ip:") ? 20 : 5;
  if (row) {
    if (!key.startsWith("ip:") && now - row.sent_at < 60_000) throw new HttpError(429, "Wait a minute before asking for another code.");
    if (now - row.hour_start < 3_600_000 && row.hour_sends >= perHour) throw new HttpError(429, "Too many codes requested. Try again in an hour.");
  }
  return row;
}

async function authStart(request, env) {
  const { email: rawEmail } = await body(request);
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) throw new HttpError(400, "That doesn't look like an email address.");
  const now = Date.now();
  const ip = "ip:" + (request.headers.get("cf-connecting-ip") || "unknown");
  const ipRow = await limitSend(env, ip, now);
  const row = await limitSend(env, email, now);

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const codeHash = await hmac(env, `login:${email}:${code}`);
  const hourStart = row && now - row.hour_start < 3_600_000 ? row.hour_start : now;
  const hourSends = row && now - row.hour_start < 3_600_000 ? row.hour_sends + 1 : 1;
  const ipHourStart = ipRow && now - ipRow.hour_start < 3_600_000 ? ipRow.hour_start : now;
  const ipHourSends = ipRow && now - ipRow.hour_start < 3_600_000 ? ipRow.hour_sends + 1 : 1;

  try {
    await env.EMAIL.send({
      from: { email: env.MAIL_FROM || "codfish@alirezaafshan.com", name: "Codfish" },
      to: email,
      subject: `Your Codfish code: ${code}`,
      text: `Your Codfish sign-in code is ${code}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
      html: `<p>Your Codfish sign-in code is</p><p style="font:700 28px monospace;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>`,
    });
  } catch (e) {
    console.error("email send failed", e && e.message);
    throw new HttpError(503, "Couldn't send the sign-in email right now.");
  }

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at, hour_start, hour_sends) VALUES (?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
      sent_at = excluded.sent_at, hour_start = excluded.hour_start, hour_sends = excluded.hour_sends`)
      .bind(email, codeHash, now + CODE_TTL_MS, now, hourStart, hourSends),
    env.DB.prepare(`INSERT INTO login_codes (email, code_hash, expires_at, attempts, sent_at, hour_start, hour_sends) VALUES (?, '-', 0, 0, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET sent_at = excluded.sent_at, hour_start = excluded.hour_start, hour_sends = excluded.hour_sends`)
      .bind(ip, now, ipHourStart, ipHourSends),
  ]);
  return json({ ok: true });
}

async function authVerify(request, env) {
  const b = await body(request);
  const email = String(b.email || "").trim().toLowerCase();
  const code = String(b.code || "").replace(/\D/g, "");
  const now = Date.now();
  const row = await env.DB.prepare("SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?").bind(email).first();
  if (!row || row.code_hash === "-" || row.expires_at < now) throw new HttpError(400, "That code has expired. Ask for a new one.");
  if (row.attempts >= 5) throw new HttpError(429, "Too many wrong codes. Ask for a new one.");
  const expected = await hmac(env, `login:${email}:${code}`);
  if (code.length !== 6 || expected !== row.code_hash) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    throw new HttpError(400, "That code isn't right.");
  }
  // One use only: expire the code but keep the row so send limits still apply.
  await env.DB.prepare("UPDATE login_codes SET code_hash = '-', expires_at = 0 WHERE email = ?").bind(email).run();

  let user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (!user) {
    user = { id: newId() };
    await env.DB.prepare("INSERT INTO users (id, email, settings, created_at) VALUES (?, ?, '{}', ?)").bind(user.id, email, now).run();
  }
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), user.id, now, now + SESSION_DAYS * DAY_MS).run();
  return json({ ok: true }, 200, {
    "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`,
  });
}

async function authLogout(request, env) {
  const token = cookie(request, COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}

// ---------- account and settings ----------

function settingsOf(user) {
  let s = {};
  try { s = JSON.parse(user.settings || "{}"); } catch {}
  return { provider: s.provider || "house", models: s.models || {}, baseUrl: s.baseUrl || "", theme: THEMES.includes(s.theme) ? s.theme : "auto" };
}

async function me(user, env) {
  const keys = await env.DB.prepare("SELECT provider, last4 FROM api_keys WHERE user_id = ?").bind(user.id).all();
  const use = await env.DB.prepare("SELECT calls, charged_micro FROM usage WHERE user_id = ? AND day = ?").bind(user.id, today()).first();
  return json({
    email: user.email,
    admin: isAdmin(env, user.email),
    settings: settingsOf(user),
    keys: keys.results,
    creditMicro: user.credit_micro,
    today: { calls: use?.calls || 0, chargedMicro: use?.charged_micro || 0 },
    house: { model: HOUSE_MODEL, minCreditMicro: MAX_CALL_MICRO },
    variants: Object.fromEntries(Object.entries(VARIANTS).map(([k, v]) => [k, { label: v.label, blurb: v.blurb }])),
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, defaultModel: v.defaultModel || "" }])),
  });
}

async function putSettings(request, user, env) {
  const b = await body(request);
  const provider = b.provider === "house" || PROVIDERS[b.provider] ? b.provider : "house";
  const models = {};
  for (const k of Object.keys(PROVIDERS)) if (typeof b.models?.[k] === "string" && b.models[k].trim()) models[k] = b.models[k].trim().slice(0, 100);
  const baseUrl = typeof b.baseUrl === "string" ? b.baseUrl.trim().slice(0, 200) : "";
  if (baseUrl && !/^https:\/\/[^\s]+$/.test(baseUrl)) throw new HttpError(400, "The base URL must start with https://");
  const theme = THEMES.includes(b.theme) ? b.theme : "auto";
  await env.DB.prepare("UPDATE users SET settings = ? WHERE id = ?").bind(JSON.stringify({ provider, models, baseUrl, theme }), user.id).run();
  return json({ ok: true });
}

async function putKey(request, user, env, provider) {
  if (!PROVIDERS[provider]) throw new HttpError(404, "Unknown provider.");
  const { key } = await body(request);
  const k = String(key || "").trim();
  if (k.length < 8 || k.length > 500) throw new HttpError(400, "That doesn't look like an API key.");
  await env.DB.prepare(`INSERT INTO api_keys (user_id, provider, enc, last4, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET enc = excluded.enc, last4 = excluded.last4, updated_at = excluded.updated_at`)
    .bind(user.id, provider, await seal(env, k), k.slice(-4), Date.now()).run();
  return json({ ok: true });
}

async function deleteAccount(user, env) {
  await env.DB.batch(["proofs", "api_keys", "sessions", "usage", "credit_ledger", "daily_results"].map(t =>
    env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(user.id)).concat([
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]));
  return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}

// ---------- proofs ----------

const parseJSON = t => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
const proofOut = r => ({ id: r.id, title: r.title, kind: r.kind, variant: variantOf(r.variant), blocks: parseJSON(r.blocks), source: r.source, analysis: r.analysis ? JSON.parse(r.analysis) : null, createdAt: r.created_at, updatedAt: r.updated_at });

async function listProofs(user, env) {
  const r = await env.DB.prepare("SELECT id, title, kind, variant, blocks IS NOT NULL AS has_blocks, analysis, updated_at FROM proofs WHERE user_id = ? ORDER BY updated_at DESC").bind(user.id).all();
  return json(r.results.map(p => {
    const steps = p.analysis ? JSON.parse(p.analysis).steps || [] : [];
    const count = c => steps.filter(s => s.status === c).length;
    return { id: p.id, title: p.title, kind: p.kind, blocks: !!p.has_blocks, variant: variantOf(p.variant), updatedAt: p.updated_at, tally: { green: count("green"), yellow: count("yellow"), red: count("red"), unchecked: count("unchecked"), total: steps.length } };
  }));
}

function validProof(b) {
  const title = String(b.title || "").trim().slice(0, 120) || "Untitled proof";
  const kind = b.kind === "lean" ? "lean" : b.kind === "sketch" ? "sketch" : null;
  if (!kind) throw new HttpError(400, "Choose a Lean file or a sketch.");
  const source = String(b.source || "");
  if (!source.trim()) throw new HttpError(400, "The proof is empty.");
  if (source.length > MAX_SOURCE) throw new HttpError(413, "That proof is over 100 KB.");
  const variant = b.variant === undefined ? undefined : variantOf(b.variant);
  // Blocks proofs are Lean proofs that also keep the blocks they were built from.
  let blocks;
  if (b.blocks !== undefined && b.blocks !== null) {
    if (kind !== "lean" || typeof b.blocks !== "object" || !Array.isArray(b.blocks.body)) throw new HttpError(400, "Those blocks don't look right.");
    blocks = JSON.stringify(b.blocks);
    if (blocks.length > 50_000) throw new HttpError(413, "That's too many blocks.");
  }
  return { title, kind, source, variant, blocks };
}

async function createProof(request, user, env) {
  const p = validProof(await body(request));
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM proofs WHERE user_id = ?").bind(user.id).first();
  if (n.n >= MAX_PROOFS) throw new HttpError(403, `You can keep up to ${MAX_PROOFS} proofs. Delete some first.`);
  const id = newId(), now = Date.now();
  await env.DB.prepare("INSERT INTO proofs (id, user_id, title, kind, source, variant, blocks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, user.id, p.title, p.kind, p.source, p.variant || "standard", p.blocks || null, now, now).run();
  return getProof(user, env, id, 201);
}

async function getProof(user, env, id, status = 200) {
  const r = await env.DB.prepare("SELECT * FROM proofs WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!r) throw new HttpError(404, "No such proof.");
  return json(proofOut(r), status);
}

async function updateProof(request, user, env, id) {
  const b = await body(request);
  const old = await env.DB.prepare("SELECT kind, source, title, variant, blocks FROM proofs WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!old) throw new HttpError(404, "No such proof.");
  const p = validProof({ kind: old.kind, title: old.title, source: old.source, ...b });
  const variant = p.variant || variantOf(old.variant);
  // New source or new rules make the old analysis stale.
  const changed = p.source !== old.source || variant !== variantOf(old.variant);
  // Editing the Lean by hand drops the blocks (they'd no longer match); sending blocks keeps them.
  const blocks = p.blocks !== undefined ? p.blocks : p.source === old.source ? old.blocks : null;
  await env.DB.prepare(`UPDATE proofs SET title = ?, kind = ?, source = ?, variant = ?, blocks = ?, updated_at = ?${changed ? ", analysis = NULL" : ""} WHERE id = ? AND user_id = ?`)
    .bind(p.title, p.kind, p.source, variant, blocks, Date.now(), id, user.id).run();
  return getProof(user, env, id);
}

async function deleteProof(user, env, id) {
  const r = await env.DB.prepare("DELETE FROM proofs WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  if (!r.meta.changes) throw new HttpError(404, "No such proof.");
  return json({ ok: true });
}

// Reserve the maximum charge up front so concurrent calls can't overdraw, then refund the difference.
async function reserveCredit(env, user) {
  const r = await env.DB.prepare("UPDATE users SET credit_micro = credit_micro - ? WHERE id = ? AND credit_micro >= ?")
    .bind(MAX_CALL_MICRO, user.id, MAX_CALL_MICRO).run();
  return r.meta.changes === 1;
}

async function analyze(user, env, id) {
  const p = await env.DB.prepare("SELECT * FROM proofs WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!p) throw new HttpError(404, "No such proof.");
  let analysis;

  if (p.kind === "lean") {
    const r = parseLean(p.source);
    if (!r.ok) throw new HttpError(422, r.error);
    analysis = { source: "lean", variant: variantOf(p.variant), steps: r.steps, at: Date.now() };
  } else {
    const s = settingsOf(user);
    if (s.provider === "house") {
      const admin = isAdmin(env, user.email);
      const cap = Number(env.HOUSE_DAILY_NEURONS_CAP || 300_000);
      const global = await env.DB.prepare("SELECT neurons FROM usage WHERE user_id = '*' AND day = ?").bind(today()).first();
      if ((global?.neurons || 0) >= cap) throw new HttpError(503, "The house model has hit today's spending cap. Use your own API key in Settings, or try tomorrow.");
      if (!admin && !(await reserveCredit(env, user))) {
        throw new HttpError(402, "The house model is pay-as-you-go and your credit is too low. Add your own API key in Settings to use Codfish for free. (Buying credit isn't available yet.)");
      }
      let out;
      try {
        out = await runHouse(env, p.source, p.variant);
      } catch (e) {
        if (!admin) await env.DB.prepare("UPDATE users SET credit_micro = credit_micro + ? WHERE id = ?").bind(MAX_CALL_MICRO, user.id).run();
        throw new HttpError(502, "The house model failed. You weren't charged.");
      }
      const { costMicro, chargeMicro } = houseCharge(out.neurons);
      const charged = admin ? 0 : Math.min(chargeMicro, MAX_CALL_MICRO);
      const stmts = [
        env.DB.prepare(`INSERT INTO usage (user_id, day, calls, neurons, charged_micro) VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1, neurons = neurons + excluded.neurons, charged_micro = charged_micro + excluded.charged_micro`)
          .bind(user.id, today(), out.neurons, charged),
        env.DB.prepare(`INSERT INTO usage (user_id, day, calls, neurons, charged_micro) VALUES ('*', ?, 1, ?, ?)
          ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1, neurons = neurons + excluded.neurons, charged_micro = charged_micro + excluded.charged_micro`)
          .bind(today(), out.neurons, charged),
      ];
      if (!admin) stmts.push(
        env.DB.prepare("UPDATE users SET credit_micro = credit_micro + ? WHERE id = ?").bind(MAX_CALL_MICRO - charged, user.id),
        env.DB.prepare("INSERT INTO credit_ledger (user_id, delta_micro, reason, ref, created_at) VALUES (?, ?, 'house-model', ?, ?)")
          .bind(user.id, -charged, `${id}:${out.neurons.toFixed(1)}n:cost${costMicro}`, Date.now()));
      await env.DB.batch(stmts);
      let tree;
      try { tree = parseModelTree(out.output); } catch (e) { throw new HttpError(502, `The model's answer couldn't be read: ${e.message}`); }
      analysis = { source: "model", variant: variantOf(p.variant), model: out.model, chargedMicro: charged, steps: tree.steps, at: Date.now() };
    } else {
      const k = await env.DB.prepare("SELECT enc FROM api_keys WHERE user_id = ? AND provider = ?").bind(user.id, s.provider).first();
      if (!k) throw new HttpError(400, `Add your ${PROVIDERS[s.provider].label} API key in Settings first.`);
      let out, tree;
      try {
        out = await runOwn(s.provider, await unseal(env, k.enc), s.models[s.provider], s.baseUrl, p.source, p.variant);
        tree = parseModelTree(out.output);
      } catch (e) {
        throw new HttpError(502, String(e.message || e).slice(0, 300));
      }
      analysis = { source: "model", variant: variantOf(p.variant), model: out.model, chargedMicro: 0, steps: tree.steps, at: Date.now() };
    }
  }

  await env.DB.prepare("UPDATE proofs SET analysis = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(JSON.stringify(analysis), Date.now(), id, user.id).run();
  return getProof(user, env, id);
}

// ---------- Lemma of the Day ----------

async function dailyList(user, env) {
  const r = await env.DB.prepare("SELECT day, solved, tries, seconds FROM daily_results WHERE user_id = ? ORDER BY day DESC LIMIT 400").bind(user.id).all();
  return json({ results: r.results.map(x => ({ ...x, solved: !!x.solved })) });
}

async function dailyPost(request, user, env) {
  const b = await body(request);
  const day = Math.floor(Number(b.day)), tries = Math.floor(Number(b.tries)), seconds = Math.floor(Number(b.seconds));
  // Day 1 is 23 Nov 2026; allow a day of slack for time zones.
  const maxDay = Math.floor((Date.now() - Date.UTC(2026, 10, 23)) / DAY_MS) + 2;
  if (!(day >= 1 && day <= maxDay)) throw new HttpError(400, "That isn't a puzzle day.");
  if (!(tries >= 1 && tries <= 3)) throw new HttpError(400, "Tries must be 1 to 3.");
  if (!(seconds >= 0 && seconds < 86_400 * 2)) throw new HttpError(400, "Bad time.");
  // First result for a day stands: no retrying for a better score.
  await env.DB.prepare("INSERT OR IGNORE INTO daily_results (user_id, day, solved, tries, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(user.id, day, b.solved ? 1 : 0, tries, seconds, Date.now()).run();
  return json({ ok: true });
}

// ---------- router ----------

async function api(request, env, url) {
  const m = request.method, path = url.pathname;
  if (m !== "GET" && m !== "HEAD") {
    const origin = request.headers.get("origin");
    if (!origin || origin !== url.origin) throw new HttpError(403, "Cross-site request refused.");
  }
  if (path === "/api/auth/start" && m === "POST") return authStart(request, env);
  if (path === "/api/auth/verify" && m === "POST") return authVerify(request, env);
  if (path === "/api/auth/logout" && m === "POST") return authLogout(request, env);

  const user = await requireUser(request, env);
  if (path === "/api/me" && m === "GET") return me(user, env);
  if (path === "/api/me" && m === "DELETE") return deleteAccount(user, env);
  if (path === "/api/settings" && m === "PUT") return putSettings(request, user, env);
  let r;
  if ((r = path.match(/^\/api\/keys\/([a-z]+)$/))) {
    if (m === "PUT") return putKey(request, user, env, r[1]);
    if (m === "DELETE") { await env.DB.prepare("DELETE FROM api_keys WHERE user_id = ? AND provider = ?").bind(user.id, r[1]).run(); return json({ ok: true }); }
  }
  if (path === "/api/daily" && m === "GET") return dailyList(user, env);
  if (path === "/api/daily" && m === "POST") return dailyPost(request, user, env);
  if (path === "/api/proofs" && m === "GET") return listProofs(user, env);
  if (path === "/api/proofs" && m === "POST") return createProof(request, user, env);
  if ((r = path.match(/^\/api\/proofs\/([0-9a-f]{24})$/))) {
    if (m === "GET") return getProof(user, env, r[1]);
    if (m === "PUT") return updateProof(request, user, env, r[1]);
    if (m === "DELETE") return deleteProof(user, env, r[1]);
  }
  if ((r = path.match(/^\/api\/proofs\/([0-9a-f]{24})\/analyze$/)) && m === "POST") return analyze(user, env, r[1]);
  throw new HttpError(404, "Not found.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      if (url.pathname === "/" || url.pathname === "/index.html") return new Response(DEMO_HTML, { headers: HTML_HEADERS });
      if (url.pathname === "/app" || url.pathname === "/app/") return new Response(APP_HTML, { headers: HTML_HEADERS });
      if (url.pathname === "/daily" || url.pathname === "/daily/") return new Response(DAILY_HTML, { headers: HTML_HEADERS });
      if (url.pathname === "/blocks" || url.pathname === "/blocks/") return new Response(BLOCKS_HTML, { headers: HTML_HEADERS });
      const js = { "/blocks.js": BLOCKS_JS, "/bonsai.js": BONSAI_JS, "/playbook.js": PLAYBOOK_JS }[url.pathname];
      if (js) return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
      if (url.pathname === "/themes.css") return new Response(THEMES_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
      if (url.pathname === "/themes.js") return new Response(THEMES_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
      return new Response("Not found", { status: 404 });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e && (e.stack || e.message));
      return json({ error: "Something went wrong." }, 500);
    }
  },
};
