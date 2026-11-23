// Local preview: runs the Worker on http://localhost:8787 with SQLite, and prints sign-in codes
// instead of emailing them. The house model is faked. `npm run build && node test/serve.js`
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import http from "node:http";
import worker from "../dist/worker.js";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => sqlite.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  _exec: () => sqlite.prepare(sql).run(...args),
});
const env = {
  DB: { prepare: sql => stmt(sql), batch: async l => { sqlite.exec("BEGIN"); l.forEach(s => s._exec()); sqlite.exec("COMMIT"); return []; } },
  SECRET: "local-preview-secret-not-for-production",
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || "",
  EMAIL: { send: async m => { console.log(`[email to ${m.to}] ${m.subject}`); return { messageId: "local" }; } },
  AI: { run: async () => ({ response: { title: "fake", steps: [
    { id: 1, parent: null, short: "main claim", text: "The main claim (fake house model).", lean: "theorem main : True", status: "unchecked" },
    { id: 2, parent: 1, short: "a gap", text: "A step the sketch skipped.", lean: "", status: "gap", note: "Say why." },
    { id: 3, parent: 1, short: "a fine step", text: "A step that looks fine.", lean: "lemma fine : 1 + 1 = 2", status: "unchecked" },
  ] }, usage: { neurons: 300 } }) },
};
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request("http://localhost:8787" + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env);
  const h = Object.fromEntries(r.headers); if (h["set-cookie"]) h["set-cookie"] = h["set-cookie"].replace("; Secure", "");
  res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, () => console.log("http://localhost:8787"));
