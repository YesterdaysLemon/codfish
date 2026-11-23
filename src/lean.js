// Turn a Lean 4 file into a Codfish proof tree, without running Lean.
//
// Each theorem/lemma becomes a node; a declaration that uses another one becomes its parent.
// Each `have` inside a proof becomes a child step. Colours:
//   yellow    - the declaration or step contains `sorry` / `admit`
//   unchecked - no sorry, but Lean hasn't been run on it yet (the engine isn't connected)
// Nothing is ever green here: green means Lean accepted it, and only the engine can say that.

const DECL = /^(?:@\[[^\]]*\]\s*)?(?:(?:private|protected|noncomputable|nonrec|partial|unsafe)\s+)*(theorem|lemma|example|def|abbrev|instance)\b\s*([^\s:({\[]*)/;

function stripComments(src) {
  // Replace comments with spaces so line/column positions survive.
  let out = "", i = 0, depth = 0;
  while (i < src.length) {
    if (src.startsWith("/-", i)) { depth++; out += "  "; i += 2; continue; }
    if (depth > 0) {
      if (src.startsWith("-/", i)) { depth--; out += "  "; i += 2; continue; }
      out += src[i] === "\n" ? "\n" : " "; i++; continue;
    }
    if (src.startsWith("--", i)) { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
    out += src[i++];
  }
  return out;
}

function docBefore(raw, lines, lineIdx) {
  // The /-- docstring -/ that ends right above a declaration, if any.
  const before = raw.split("\n").slice(0, lineIdx).join("\n");
  const start = before.lastIndexOf("/--");
  if (start < 0) return "";
  const m = before.slice(start).match(/^\/--([\s\S]*?)-\/\s*(?:@\[[^\]]*\]\s*)?$/);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function splitStatement(text) {
  // Statement = everything up to the first top-level `:=` (or `where` / `|` for pattern-matching defs).
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("([{⟨".includes(c)) depth++;
    else if (")]}⟩".includes(c)) depth--;
    else if (depth === 0 && text.startsWith(":=", i)) return [text.slice(0, i), text.slice(i + 2)];
  }
  return [text, ""];
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const squash = s => s.replace(/\s+/g, " ").trim();
const hasSorry = s => /\b(sorry|admit)\b/.test(s);
const shortName = n => n.split(".").pop();

export function parseLean(raw) {
  const clean = stripComments(raw);
  const lines = clean.split("\n"), rawLines = raw.split("\n");
  const decls = [];
  lines.forEach((line, idx) => {
    if (/^\s/.test(line)) return; // only top-level declarations
    const m = line.match(DECL);
    if (m) decls.push({ kind: m[1], name: m[2] || (m[1] === "example" ? `example ${decls.length + 1}` : m[1]), start: idx });
  });
  decls.forEach((d, i) => {
    const end = i + 1 < decls.length ? decls[i + 1].start : lines.length;
    const block = lines.slice(d.start, end).join("\n");
    const header = block.replace(DECL, "");
    const [stmt, body] = splitStatement(header);
    d.statement = squash(stmt);
    d.body = body;
    d.sorry = hasSorry(body);
    d.doc = docBefore(raw, rawLines, d.start);
    d.haves = parseHaves(lines.slice(d.start, end));
  });

  const proofs = decls.filter(d => d.kind === "theorem" || d.kind === "lemma" || d.kind === "example");
  if (!proofs.length) {
    return { ok: false, error: "No theorem, lemma or example found in this file." };
  }

  // Dependencies: B uses A if A's name appears in B's body.
  const byShort = new Map(proofs.map(d => [shortName(d.name), d]));
  const usedBy = new Map();
  for (const d of proofs) {
    for (const [name, other] of byShort) {
      if (other === d || !name) continue;
      const re = new RegExp(`(^|[^\\w.'])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w'])`);
      if (re.test(d.body) && !usedBy.has(other)) usedBy.set(other, d);
    }
  }

  const steps = [];
  let nextId = 1;
  const ids = new Map();
  const roots = proofs.filter(d => !usedBy.has(d));
  let rootParent = null;
  if (roots.length > 1) {
    steps.push({ id: nextId, parent: null, short: "this file", text: "Everything this file proves.", lean: "", status: "unchecked",
      note: `${roots.length} top-level results that don't depend on each other.` });
    rootParent = nextId++;
  }
  const visit = (d, parent) => {
    const id = nextId++;
    ids.set(d, id);
    const status = d.sorry ? "yellow" : "unchecked";
    steps.push({
      id, parent, short: clip(shortName(d.name), 28),
      text: d.doc || `${d.kind} ${d.name}`,
      lean: `${d.kind} ${d.name} ${d.statement}`.trim(),
      status,
      note: d.sorry ? "Contains sorry: this part is still open." : "No sorry. Not checked by Lean yet; the engine isn't connected.",
    });
    for (const h of d.haves) {
      steps.push({ id: nextId++, parent: id, short: clip(h.name || "have", 28), text: `have ${h.name ? h.name + " " : ""}: ${clip(h.stmt, 160)}`,
        lean: `have ${h.name ? h.name + " " : ""}: ${h.stmt}`, status: h.sorry ? "yellow" : "unchecked",
        note: h.sorry ? "This step is proved by sorry." : "Not checked by Lean yet." });
    }
    for (const child of proofs.filter(o => usedBy.get(o) === d)) visit(child, id);
  };
  for (const r of roots) visit(r, rootParent);
  return { ok: true, source: "lean", steps };
}

function parseHaves(blockLines) {
  const haves = [];
  blockLines.forEach((line, i) => {
    const m = line.match(/^(\s*)(?:·\s*)?have\s+([^\s:]*)\s*:(.*)$/);
    if (!m) return;
    const indent = m[1].length;
    const rest = [m[3]];
    let j = i + 1;
    while (j < blockLines.length && (blockLines[j].trim() === "" || blockLines[j].match(/^\s*/)[0].length > indent)) rest.push(blockLines[j++]);
    const [stmt, proof] = splitStatement(rest.join("\n"));
    haves.push({ name: m[2], stmt: squash(stmt), sorry: hasSorry(proof) });
  });
  return haves;
}
