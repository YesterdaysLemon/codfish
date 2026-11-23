# Codfish

An analysis board for proofs, the way Stockfish is an analysis board for chess.

Paste a proof sketch and the engine splits it into steps, formalizes each one in Lean, and colours it:

- **Green:** Lean accepts the step.
- **Yellow:** no proof yet, and no counterexample either. Plausible, unproven.
- **Red:** a counterexample or contradiction was found. The step is wrong.

At the first red or yellow step it suggests a **best move**: a lemma that closes the gap, a weaker statement that is actually true, or a route around it. The whole proof is drawn as a [Proof Bonsai](https://github.com/YesterdaysLemon) tree, and an **eval bar** shows how much of it is verified.

## The name changes with the board

Like the splash text on Minecraft's title screen, the name follows the state of the proof:

| Name | When |
|---|---|
| **Codfish** | The default (for the codomain). |
| **Proofish** | Steps are still yellow: the proof is proof-ish. |
| **Lemmafish** | Every step is green. A finished proof is a lemma for the next one. |

## Status

v0 is a demo board at **[codfish.alirezaafshan.com](https://codfish.alirezaafshan.com)**: three proofs with precomputed colours, notes and best moves (√2 is irrational; Euclid's primes with yellow gaps; Euclid's primes with the classic "N is prime" slip). The live engine is not wired up yet, and the Lean statements on the board are illustrative.

Next is the first milestone from the design doc: analysis mode end to end on short undergraduate proofs, running on an [Afshan tropism](https://github.com/YesterdaysLemon) grove (reflex tree, homeostat, Lean gate, blind judges).

| Part | Job |
|---|---|
| Splitter | Turn a sketch into a tree of claims |
| Formalizer | Write each claim in Lean; check fidelity with a blind judge on another engine |
| Prover | Cheap tactics first, then a budgeted model prover |
| Refuter | Small-case search, Lean property testing, SAT/SMT |
| Evaluator | The eval bar |
| Book | Mathlib plus every node that has turned green before |

Milestone test: 30 short proofs (10 correct, 10 with a planted error, 10 with a gap). Pass means at least 8 of 10 planted errors caught on the right step, and **no wrong step ever marked green**.

## Layout

```
public/index.html   the board (single self-contained page)
src/worker.js       Cloudflare Worker that serves it
wrangler.toml       deploy config (custom domain codfish.alirezaafshan.com)
```

Deploy with `npx wrangler deploy`.

## License

[CC BY-SA 4.0](LICENSE) © Alireza Afshan.
