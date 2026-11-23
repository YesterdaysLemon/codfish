// Turn a Lean 4 file into a Codfish proof tree, without running Lean.
//
// Each theorem/lemma becomes a node; a declaration that uses another one becomes its parent.
// Inside a tactic proof, the structure becomes child steps: induction and its cases, by_cases and
// its two arms, by_contra, constructor with bullets, have, obtain, use. Results in different
// namespaces are grouped under one node per namespace, so a big file can be zoomed out. Colours:
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
  const ns = []; // namespace / section stack
  lines.forEach((line, idx) => {
    if (/^\s/.test(line)) return; // only top-level declarations
    let n;
    if ((n = line.match(/^namespace\s+(\S+)/))) { ns.push({ kind: "namespace", name: n[1] }); return; }
    if ((n = line.match(/^(?:noncomputable\s+)?section\b\s*(\S*)/))) { ns.push({ kind: "section", name: n[1] }); return; }
    if (/^end\b/.test(line)) { ns.pop(); return; }
    const m = line.match(DECL);
    if (m) decls.push({ kind: m[1], name: m[2] || (m[1] === "example" ? `example ${decls.length + 1}` : m[1]), start: idx,
      ns: ns.filter(x => x.kind === "namespace").map(x => x.name).join(".") });
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
    d.tree = parseProof(body);
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
    steps.push({ id: nextId, parent: null, short: "this file", text: "Everything this file proves.", lean: "", status: "unchecked", group: true,
      note: `${roots.length} top-level results that don't depend on each other.` });
    rootParent = nextId++;
  }
  const WAIT = "Not checked by Lean yet; the engine isn't connected.";
  const addTree = (node, parent) => {
    const id = nextId++;
    steps.push({ id, parent, short: clip(node.short, 28), text: node.text, lean: node.lean || "", status: node.sorry ? "yellow" : "unchecked",
      note: node.sorry ? "Contains sorry: this part is still open." : WAIT });
    for (const c of node.children) addTree(c, id);
  };
  const visit = (d, parent) => {
    const id = nextId++;
    ids.set(d, id);
    steps.push({
      id, parent, short: clip(shortName(d.name), 28),
      text: d.doc || `${d.kind} ${d.name}`,
      lean: `${d.kind} ${d.name} ${d.statement}`.trim(),
      status: d.tree.sorry ? "yellow" : "unchecked",
      note: d.tree.sorry ? "Contains sorry: this part is still open." : d.sorry ? "A step inside is still open." : "No sorry. " + WAIT,
    });
    for (const c of d.tree.children) addTree(c, id);
    for (const child of proofs.filter(o => usedBy.get(o) === d)) visit(child, id);
  };
  // Group top-level results by namespace when the file has more than one.
  const spaces = [...new Set(roots.map(d => d.ns))];
  if (rootParent !== null && spaces.length > 1) {
    for (const sp of spaces) {
      const gid = nextId++;
      const inSpace = roots.filter(d => d.ns === sp);
      steps.push({ id: gid, parent: rootParent, short: sp || "top level", text: sp ? `namespace ${sp}` : "Outside any namespace.", lean: sp ? `namespace ${sp}` : "",
        status: "unchecked", group: true, note: `${inSpace.length} result${inSpace.length === 1 ? "" : "s"} here.` });
      for (const r of inSpace) visit(r, gid);
    }
  } else for (const r of roots) visit(r, rootParent);
  return { ok: true, source: "lean", steps };
}

// ---------- the structure of a tactic proof ----------

const node = (short, text, lean) => ({ short, text, lean, sorry: false, children: [] });

// body = everything after the declaration's `:=`. Returns a root node whose children are the proof's structure.
export function parseProof(body) {
  const root = node("", "", "");
  const m = body.match(/^\s*by\b([\s\S]*)$/);
  if (!m) { root.sorry = hasSorry(body); return root; } // term-mode proof: no structure to show
  const raw = m[1].split("\n");
  // The text right after `by` on the same line counts as the first tactic line.
  const L = raw.map((l, i) => ({ ind: i === 0 ? Infinity : l.match(/^\s*/)[0].length, t: l.trim() }))
    .filter((l, i) => i > 0 || l.t);
  if (L.length && L[0].ind === Infinity) L[0].ind = Math.min(...L.slice(1).filter(x => x.t).map(x => x.ind), 2);
  parseRange(L, 0, L.length, root);
  return root;
}

function blockEnd(L, i, to) {
  let j = i + 1;
  while (j < to && (!L[j].t || L[j].ind > L[i].ind)) j++;
  return j;
}

// Parse bullets `·` at the same indent as line i, starting at j. Each becomes an arm under `parent`.
function bullets(L, j, to, ind, parent, labels) {
  let k = 0;
  while (j < to && L[j].t.startsWith("·") && L[j].ind === ind && (!labels || k < labels.length)) {
    const end = blockEnd(L, j, to);
    const arm = node(labels ? labels[k] : `case ${k + 1}`, labels ? labels[k] : `Case ${k + 1}.`, "");
    const rest = L[j].t.replace(/^·\s*/, "");
    const sub = [{ ind: ind + 2, t: rest }, ...L.slice(j + 1, end)];
    parseRange(sub, 0, sub.length, arm);
    parent.children.push(arm);
    j = end; k++;
  }
  return j;
}

function parseRange(L, from, to, parent) {
  let i = from;
  while (i < to) {
    const { ind, t } = L[i];
    if (!t || t.startsWith("--")) { i++; continue; }
    const end = blockEnd(L, i, to);
    let m;
    if ((m = t.match(/^(induction|cases|rcases|match)\s+(.*?)\s+with\s*(?:--.*)?$/))) {
      const what = m[2].replace(/\s+using\s+.*/, "");
      const n = node(m[1] === "induction" ? `induction on ${what}` : `cases on ${what}`, `${t}`, t);
      let j = i + 1;
      // Alternatives can sit at the same indent as the tactic or deeper.
      while (j < to && (!L[j].t || (L[j].t.startsWith("|") && L[j].ind >= ind) || (L[j].ind > ind && !L[j].t.startsWith("|")))) {
        if (!L[j].t.startsWith("|")) { if (hasSorry(L[j].t)) n.sorry = true; j++; continue; }
        const aEnd = blockEnd(L, j, to);
        const alt = L[j].t.match(/^\|\s*([^\s=]+)([^=]*)=>\s*(.*)$/) || [null, L[j].t.slice(1).trim(), "", ""];
        const name = alt[1].replace(/^\./, "");
        const label = { zero: "base case", succ: "step", inl: "left case", inr: "right case", nil: "empty list", cons: "cons" }[name] || `case ${name}`;
        const arm = node(label, L[j].t, L[j].t);
        const sub = [{ ind: L[j].ind + 2, t: alt[3] || "" }, ...L.slice(j + 1, aEnd)];
        parseRange(sub, 0, sub.length, arm);
        n.children.push(arm);
        j = aEnd;
      }
      parent.children.push(n); i = j; continue;
    }
    if ((m = t.match(/^by_cases\s+(?:(\S+)\s*:\s*)?(.*)$/))) {
      const cond = m[2].replace(/\s*--.*$/, "");
      const n = node(`cases: ${cond}`, t, t);
      const j = bullets(L, end, to, ind, n, [`if ${cond}`, "otherwise"]);
      if (!n.children.length) parseRange(L, i + 1, end, n);
      parent.children.push(n); i = j; continue;
    }
    if (/^(constructor|refine\s+⟨\?_,\s*\?_⟩|apply\s+And\.intro|apply\s+Iff\.intro)\b/.test(t) && end < to && L[end].t.startsWith("·") && L[end].ind === ind) {
      const n = node("both parts", t, t);
      const j = bullets(L, end, to, ind, n, ["first part (→)", "second part (←)"]);
      parent.children.push(n); i = j; continue;
    }
    if ((m = t.match(/^by_contra!?\s*(\S*)/))) {
      const n = node("suppose not", t, t);
      if (hasSorry(t)) n.sorry = true;
      parseRange(L, i + 1, to, n); // everything after it in this block is the contradiction
      parent.children.push(n); i = to; continue;
    }
    if (t.startsWith("·")) {
      i = bullets(L, i, to, ind, parent, null); continue;
    }
    if ((m = t.match(/^have\s+([^\s:]*)\s*:(.*)$/))) {
      const joined = [m[2], ...L.slice(i + 1, end).map(x => x.t)].join("\n");
      const [stmt, proof] = splitStatement(joined);
      const n = node(m[1] || clip(squash(stmt), 28) || "have", `have ${m[1] ? m[1] + " " : ""}: ${clip(squash(stmt), 160)}`, `have ${m[1] ? m[1] + " " : ""}: ${squash(stmt)}`);
      const p = proof.trim();
      if (/^by\b/.test(p) && end > i + 1) {
        // A multi-line `have … := by` proof: its own structure goes under it.
        const first = L[i].t.split(":=")[1] || "";
        if (hasSorry(first)) n.sorry = true;
        parseRange(L, i + 1, end, n);
      } else if (hasSorry(proof)) n.sorry = true;
      parent.children.push(n); i = end; continue;
    }
    if ((m = t.match(/^obtain\s+(⟨[^⟩]*⟩|\S+)/))) {
      const n = node(`pick ${m[1]}`, t, t);
      if (hasSorry(L.slice(i, end).map(x => x.t).join(" "))) n.sorry = true;
      parent.children.push(n); i = end; continue;
    }
    if ((m = t.match(/^(?:use|exists|refine\s+⟨)\s*([^,⟩]*)/)) && !/^refine\s+⟨\?_/.test(t)) {
      const n = node(`use ${m[1].trim()}`, t, t);
      if (hasSorry(t)) n.sorry = true;
      parent.children.push(n); i = end; continue;
    }
    if (/^contrapose!?\b/.test(t)) { parent.children.push(node("contrapositive", t, t)); i = end; continue; }
    // Anything else (rw, simp, exact, …) belongs to the step that contains it.
    if (hasSorry(L.slice(i, end).map(x => x.t).join(" "))) parent.sorry = true;
    i = end;
  }
}
