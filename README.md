# Codfish

An analysis board for proofs, the way Stockfish is an analysis board for chess.

Paste a proof sketch and the engine splits it into steps, formalizes each one in Lean, and colours it:

- **Green:** Lean accepts the step.
- **Yellow:** no proof yet, and no counterexample either. Plausible, unproven.
- **Red:** a counterexample or contradiction was found. The step is wrong.

At the first red or yellow step it suggests a **best move**: a lemma that closes the gap, a weaker statement that is actually true, or a route around it. The whole proof is drawn as a Proof Bonsai tree, and an **eval bar** shows how much of it is verified.

## The name changes with the board

Like the splash text on Minecraft's title screen, the name follows the state of the proof:

| Name | When |
|---|---|
| **Codfish** | The default (for the codomain). |
| **Proofish** | Steps are still yellow: the proof is proof-ish. |
| **Lemmafish** | Every step is green. A finished proof is a lemma for the next one. |

## Status

Live at **[codfish.alirezaafshan.com](https://codfish.alirezaafshan.com)**:

- **Demo board** (`/`): three proofs with precomputed colours, notes and best moves.
- **Workspace** (`/app`): sign in with an emailed code, then drop in your own proofs:
  - **A Lean file.** Each theorem, lemma and `have` becomes a node in the tree. `sorry` shows as yellow; everything else is grey (unchecked) until the engine can run Lean.
  - **A sketch of an idea.** A model splits it into steps and writes each one as a Lean statement, flagging gaps as yellow. Model output is never marked green.
- **Models for sketches:** the house model (Workers AI, pay-as-you-go from prepaid credit at cost plus a margin, with a global daily cap), or your own key for Anthropic, OpenAI, Google, xAI, DeepSeek, Moonshot, Zhipu, Qwen or any OpenAI-compatible endpoint. Keys are encrypted at rest.
- **Accounts:** each user has their own proofs, settings and keys, and can delete their account and everything in it.

The live engine (Lean checks, counterexample search, best move) is not wired up yet, so nothing turns green outside the demo. See [TODO.md](TODO.md) for Stripe, engine hosting and the rest.

Next is the first milestone from the design doc: analysis mode end to end on short undergraduate proofs, running on an Afshan tropism grove (reflex tree, homeostat, Lean gate, blind judges).

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
public/index.html   demo board
public/app.html     workspace (sign-in, proofs, board, settings)
src/worker.js       Cloudflare Worker: pages and the API
src/lean.js         Lean file -> proof tree (no Lean run yet)
src/llm.js          sketch -> proof tree via a model; providers and house-model pricing
schema.sql          D1 database schema
test/api.test.js    end-to-end API tests (SQLite, faked email and models)
test/serve.js       local preview on http://localhost:8787, prints sign-in codes
wrangler.toml       bindings: D1, Workers AI, Email Service, vars
```

```
npm install
npm test                                  # build + API tests
npm run build && node test/serve.js       # local preview
npm run deploy                            # needs a Cloudflare API token
```

## License

[CC BY-SA 4.0](LICENSE) © Alireza Afshan.
