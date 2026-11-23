// End-to-end tests of the Worker against a real SQLite database, with email, Workers AI
// and outside model APIs faked. Run with `npm test`.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import worker from "../dist/worker.js";

// ---- a D1-shaped wrapper around node:sqlite ----
function d1(db) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _exec: () => db.prepare(sql).run(...args),
  });
  return {
    prepare: sql => stmt(sql),
    batch: async list => { db.exec("BEGIN"); try { list.forEach(s => s._exec()); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } return []; },
  };
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

const sent = [];
let aiCalls = 0, lastAI = null;
const env = {
  DB: d1(sqlite),
  SECRET: "test-secret-0123456789abcdef0123456789abcdef",
  ADMIN_EMAILS: "owner@example.com",
  HOUSE_DAILY_NEURONS_CAP: "1000",
  EMAIL: { send: async m => { sent.push(m); return { messageId: "m" + sent.length }; } },
  AI: { run: async (model, input) => { aiCalls++; lastAI = input; return { response: { title: "t", steps: [
    { id: 1, parent: null, short: "main", text: "Main claim", lean: "theorem x : True", status: "unchecked", note: "" },
    { id: 2, parent: 1, short: "gap", text: "Clearly", lean: "", status: "gap", note: "needs n > 0" },
  ] }, usage: { neurons: 400 } }; } },
};

const ORIGIN = "https://codfish.test";
async function req(method, path, data, cookie, extra = {}) {
  const headers = { ...(data ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { origin: ORIGIN } : {}), ...(cookie ? { cookie } : {}), ...extra };
  const r = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: data ? JSON.stringify(data) : undefined }), env);
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text(), headers: r.headers };
}
const lastCode = to => sent.filter(m => m.to === to).at(-1).text.match(/\b(\d{6})\b/)[1];

async function signIn(email, ip = "1.1.1.1") {
  const s = await req("POST", "/api/auth/start", { email }, null, { "cf-connecting-ip": ip });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const v = await req("POST", "/api/auth/verify", { email, code: lastCode(email) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  return v.headers.get("set-cookie").split(";")[0];
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("pages are served", async () => {
  assert.match((await req("GET", "/")).body, /Codfish/);
  assert.match((await req("GET", "/app")).body, /Sign in to Codfish/);
  assert.match((await req("GET", "/daily")).body, /Lemma of the Day/);
  assert.match((await req("GET", "/blocks")).body, /Blocks/);
  assert.equal((await req("GET", "/nope")).status, 404);
});

test("look files are served", async () => {
  const css = await req("GET", "/themes.css");
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  for (const t of ["heartwood-light", "heartwood-night", "proofruns", "paper", "chalk", "aquarium", "infoview"]) assert.match(css.body, new RegExp(`data-theme="${t}"`));
  const js = await req("GET", "/themes.js");
  assert.equal(js.status, 200);
  assert.match(js.body, /window\.CodfishTheme/);
  assert.match((await req("GET", "/")).headers.get("content-security-policy"), /fonts\.gstatic\.com/);
});

test("API needs a session and a same-origin request", async () => {
  assert.equal((await req("GET", "/api/me")).status, 401);
  const r = await worker.fetch(new Request(ORIGIN + "/api/auth/start", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.test" }, body: "{}" }), env);
  assert.equal(r.status, 403);
});

test("sign-in codes: limits, wrong codes, one use", async () => {
  await req("POST", "/api/auth/start", { email: "Ann@Example.com" }, null, { "cf-connecting-ip": "2.2.2.2" });
  assert.equal(sent.at(-1).to, "ann@example.com");
  assert.equal((await req("POST", "/api/auth/start", { email: "ann@example.com" }, null, { "cf-connecting-ip": "2.2.2.2" })).status, 429, "resend within a minute");
  assert.equal((await req("POST", "/api/auth/start", { email: "not an email" })).status, 400);
  const code = lastCode("ann@example.com");
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal((await req("POST", "/api/auth/verify", { email: "ann@example.com", code: wrong })).status, 400);
  const ok = await req("POST", "/api/auth/verify", { email: "ann@example.com", code });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await req("POST", "/api/auth/verify", { email: "ann@example.com", code })).status, 400, "code is single-use");
  assert.ok(!JSON.stringify(sqlite.prepare("SELECT * FROM login_codes").all()).includes(code), "code not stored in plain text");
});

test("five wrong codes lock the code", async () => {
  sqlite.exec("DELETE FROM login_codes");
  await req("POST", "/api/auth/start", { email: "bob@example.com" }, null, { "cf-connecting-ip": "3.3.3.3" });
  const code = lastCode("bob@example.com"), wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) await req("POST", "/api/auth/verify", { email: "bob@example.com", code: wrong });
  assert.equal((await req("POST", "/api/auth/verify", { email: "bob@example.com", code })).status, 429);
});

let alice, bobCookie, ownerCookie, aliceLean, aliceSketch;

test("Lean file → tree with sorry as yellow, nothing green", async () => {
  sqlite.exec("DELETE FROM login_codes");
  alice = await signIn("alice@example.com", "4.4.4.4");
  const me = await req("GET", "/api/me", null, alice);
  assert.equal(me.body.settings.provider, "house");
  assert.equal(me.body.creditMicro, 0);
  const src = readFileSync(new URL("./sample.lean", import.meta.url), "utf8");
  const p = await req("POST", "/api/proofs", { title: "Sample", kind: "lean", source: src }, alice);
  assert.equal(p.status, 201);
  aliceLean = p.body.id;
  const a = await req("POST", `/api/proofs/${aliceLean}/analyze`, null, alice);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const st = a.body.analysis.steps.map(s => s.status);
  assert.ok(st.includes("yellow") && !st.includes("green"));
  const bad = await req("POST", "/api/proofs", { title: "x", kind: "lean", source: "import Mathlib\n" }, alice);
  assert.equal((await req("POST", `/api/proofs/${bad.body.id}/analyze`, null, alice)).status, 422);
});

test("house model with no credit is refused, and nothing is charged", async () => {
  const p = await req("POST", "/api/proofs", { title: "Sketch", kind: "sketch", source: "Clearly true." }, alice);
  aliceSketch = p.body.id;
  const before = aiCalls;
  const a = await req("POST", `/api/proofs/${aliceSketch}/analyze`, null, alice);
  assert.equal(a.status, 402);
  assert.equal(aiCalls, before, "model not called");
});

test("house model with credit: charged at cost x markup + 1 cent, never green", async () => {
  sqlite.prepare("UPDATE users SET credit_micro = 100000 WHERE email = 'alice@example.com'").run();
  const a = await req("POST", `/api/proofs/${aliceSketch}/analyze`, null, alice);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // 400 neurons x 11 micro = 4,400 cost; x1.3 = 5,720; + 10,000 flat = 15,720.
  assert.equal(a.body.analysis.chargedMicro, 15720);
  const me = await req("GET", "/api/me", null, alice);
  assert.equal(me.body.creditMicro, 100000 - 15720);
  assert.deepEqual(a.body.analysis.steps.map(s => s.status), ["unchecked", "yellow"]);
  const ledger = sqlite.prepare("SELECT delta_micro FROM credit_ledger").all();
  assert.deepEqual(ledger.map(r => r.delta_micro), [-15720]);
});

test("variants: rules are stored, change clears the analysis, and reach the model", async () => {
  const me = await req("GET", "/api/me", null, alice);
  assert.deepEqual(Object.keys(me.body.variants), ["standard", "sheep", "trivial", "constructive"]);
  const p = await req("POST", "/api/proofs", { title: "1+1=3", kind: "sketch", source: "1 + 1 = 3 because two sheep make a lamb.", variant: "sheep" }, alice);
  assert.equal(p.status, 201);
  assert.equal(p.body.variant, "sheep");
  const a = await req("POST", `/api/proofs/${p.body.id}/analyze`, null, alice);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.analysis.variant, "sheep");
  assert.match(lastAI.messages[0].content, /RULES IN FORCE: Sheep/);
  assert.ok(!a.body.analysis.steps.some(s => s.status === "green"), "model output is never green, whatever the rules");
  // Keep the global neuron count where the cap test expects it.
  sqlite.prepare("UPDATE usage SET neurons = neurons - 400 WHERE user_id = '*'").run();
  const list = await req("GET", "/api/proofs", null, alice);
  assert.equal(list.body.find(x => x.id === p.body.id).variant, "sheep");
  // Switching rules keeps the source and title but drops the stale analysis.
  const u = await req("PUT", `/api/proofs/${p.body.id}`, { variant: "trivial" }, alice);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(u.body.variant, "trivial");
  assert.equal(u.body.title, "1+1=3");
  assert.equal(u.body.analysis, null);
  // Unknown rules fall back to standard; a title-only edit keeps the rules.
  assert.equal((await req("PUT", `/api/proofs/${p.body.id}`, { variant: "<script>" }, alice)).body.variant, "standard");
  await req("PUT", `/api/proofs/${p.body.id}`, { variant: "sheep" }, alice);
  assert.equal((await req("PUT", `/api/proofs/${p.body.id}`, { title: "renamed" }, alice)).body.variant, "sheep");
  assert.equal((await req("POST", "/api/proofs", { title: "x", kind: "lean", source: "theorem t : True := trivial" }, alice)).body.variant, "standard");
});

test("Lemma of the Day: results saved once per day, checked, private", async () => {
  assert.deepEqual((await req("GET", "/api/daily", null, alice)).body.results, []);
  assert.equal((await req("POST", "/api/daily", { day: 1, solved: true, tries: 2, seconds: 41 }, alice)).status, 200);
  // The first answer stands.
  await req("POST", "/api/daily", { day: 1, solved: true, tries: 1, seconds: 5 }, alice);
  assert.deepEqual((await req("GET", "/api/daily", null, alice)).body.results, [{ day: 1, solved: true, tries: 2, seconds: 41 }]);
  assert.equal((await req("POST", "/api/daily", { day: 0, solved: true, tries: 1, seconds: 1 }, alice)).status, 400);
  assert.equal((await req("POST", "/api/daily", { day: 9999, solved: true, tries: 1, seconds: 1 }, alice)).status, 400, "no future days");
  assert.equal((await req("POST", "/api/daily", { day: 1, solved: true, tries: 4, seconds: 1 }, alice)).status, 400);
  assert.equal((await req("GET", "/api/daily")).status, 401);
});

test("other users can't see or touch your proofs", async () => {
  bobCookie = await signIn("bob2@example.com", "5.5.5.5");
  assert.equal((await req("GET", `/api/proofs/${aliceLean}`, null, bobCookie)).status, 404);
  assert.equal((await req("DELETE", `/api/proofs/${aliceLean}`, null, bobCookie)).status, 404);
  assert.equal((await req("POST", `/api/proofs/${aliceLean}/analyze`, null, bobCookie)).status, 404);
  assert.deepEqual((await req("GET", "/api/proofs", null, bobCookie)).body, []);
  assert.deepEqual((await req("GET", "/api/daily", null, bobCookie)).body.results, []);
});

test("own API key: stored encrypted, used, never charged", async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","steps":[{"id":1,"parent":null,"short":"s","status":"unchecked"}]}' } }] }), { status: 200 });
  };
  try {
    assert.equal((await req("PUT", "/api/settings", { provider: "xai", models: { xai: "grok-test" } }, bobCookie)).status, 200);
    assert.equal((await req("POST", "/api/proofs", { title: "k", kind: "sketch", source: "idea" }, bobCookie)).status, 201);
    const id = (await req("GET", "/api/proofs", null, bobCookie)).body[0].id;
    assert.equal((await req("POST", `/api/proofs/${id}/analyze`, null, bobCookie)).status, 400, "no key yet");
    assert.equal((await req("PUT", "/api/keys/xai", { key: "xai-SECRETKEY-1234" }, bobCookie)).status, 200);
    assert.ok(!JSON.stringify(sqlite.prepare("SELECT * FROM api_keys").all()).includes("SECRETKEY"), "key encrypted at rest");
    const me = await req("GET", "/api/me", null, bobCookie);
    assert.deepEqual(me.body.keys, [{ provider: "xai", last4: "1234" }]);
    assert.ok(!JSON.stringify(me.body).includes("SECRETKEY"));
    const a = await req("POST", `/api/proofs/${id}/analyze`, null, bobCookie);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(seen.url, "https://api.x.ai/v1/chat/completions");
    assert.equal(seen.auth, "Bearer xai-SECRETKEY-1234");
    assert.equal(seen.body.model, "grok-test");
    assert.equal(a.body.analysis.chargedMicro, 0);
    assert.equal((await req("PUT", "/api/settings", { provider: "custom", baseUrl: "http://insecure" }, bobCookie)).status, 400);
    assert.equal((await req("PUT", "/api/settings", { provider: "xai", models: { xai: "grok-test" }, theme: "chalk" }, bobCookie)).status, 200);
    assert.equal((await req("GET", "/api/me", null, bobCookie)).body.settings.theme, "chalk");
    await req("PUT", "/api/settings", { provider: "xai", theme: "<script>" }, bobCookie);
    assert.equal((await req("GET", "/api/me", null, bobCookie)).body.settings.theme, "auto");
  } finally { globalThis.fetch = realFetch; }
});

test("owner is not metered; global daily cap stops the house model", async () => {
  ownerCookie = await signIn("owner@example.com", "6.6.6.6");
  const p = await req("POST", "/api/proofs", { title: "o", kind: "sketch", source: "idea" }, ownerCookie);
  const a = await req("POST", `/api/proofs/${p.body.id}/analyze`, null, ownerCookie);
  assert.equal(a.status, 200);
  assert.equal(a.body.analysis.chargedMicro, 0);
  // Cap is 1,000 neurons; alice (400) + owner (400) = 800, one more call takes it to 1,200.
  await req("POST", `/api/proofs/${p.body.id}/analyze`, null, ownerCookie);
  assert.equal((await req("POST", `/api/proofs/${p.body.id}/analyze`, null, ownerCookie)).status, 503);
});

test("sign out ends the session; deleting the account removes everything", async () => {
  assert.equal((await req("POST", "/api/auth/logout", null, bobCookie)).status, 200);
  assert.equal((await req("GET", "/api/me", null, bobCookie)).status, 401);
  assert.equal((await req("DELETE", "/api/me", null, alice)).status, 200);
  const left = sqlite.prepare("SELECT (SELECT COUNT(*) FROM proofs p JOIN users u ON u.id = p.user_id WHERE u.email = 'alice@example.com') + (SELECT COUNT(*) FROM users WHERE email = 'alice@example.com') AS n").get();
  assert.equal(left.n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM daily_results").get().n, 0);
  assert.equal((await req("GET", "/api/me", null, alice)).status, 401);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("ok   ", name); }
  catch (e) { failed++; console.log("FAIL ", name, "\n     ", e.message); }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
