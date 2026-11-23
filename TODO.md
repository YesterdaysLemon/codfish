# To do

## Stripe: paid credit for the house model

The house model (Workers AI) is pay-as-you-go from prepaid credit, so Codfish never subsidizes it. Everything except the payment itself is in place:

- `users.credit_micro` holds each balance (millionths of a dollar), and `credit_ledger` records every change.
- Each call reserves $0.05, then charges what it actually cost (neurons × $0.011/1,000) × 1.3 + $0.01, and refunds the rest. The owner account (`ADMIN_EMAILS`) isn't metered.
- `HOUSE_DAILY_NEURONS_CAP` is a global kill switch across all users (300,000 neurons, about $3.30 a day).

Still to build:

- A "Buy credit" button that opens Stripe Checkout (minimum top-up of around $5, so Stripe's fixed fee doesn't eat the margin).
- A Stripe webhook route that verifies the signature and, on `checkout.session.completed`, adds the amount to `credit_micro` and writes a `credit_ledger` row with the Checkout session ID as `ref`. It has to be idempotent, so a session ID can only be credited once.
- Secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` set as Worker secrets.
- Check the markup against real Cloudflare invoices once there's traffic.

Users who bring their own API key (Anthropic, OpenAI, Google, xAI, DeepSeek, Moonshot, Zhipu, Qwen, or any OpenAI-compatible endpoint) don't touch credit at all.

## Engine hosting (blocked on the Windows side of Tome)

The board is a Cloudflare Worker, but the engine (Lean checks, counterexample search, model prover) needs a real server, which means the VPS via Deploy Manager. Until then nothing in the workspace can turn green: Lean files show `sorry` as yellow and everything else as grey (unchecked).

That deploy has to be run from the Windows side of Tome (for example a Codex session there), following the `vps-operations` and `credentials-access` skills. It needs the `vps-admin` SSH alias, the key in `~/.ssh`, and the Proton gateway, which is enrolled to the Windows user. A Claude session reaching Tome through the desktop app gets a sandboxed Linux VM instead, and can't use any of those.

## Smaller things

- **Sign-in email.** Codfish sends codes from `codfish@alirezaafshan.com` through Cloudflare Email Service. Confirm they arrive and aren't landing in spam. Email Sending is documented as a Workers Paid feature, so if codes stop arriving, check the plan and that the domain is onboarded for sending.
- **Workers AI on the free plan.** The account is on the Workers Free plan, which allows 10,000 neurons a day (about 100 sketch analyses) and blocks the bigger models. Upgrade before opening the house model to the public.
- **Deploys.** `npm run deploy` (`wrangler deploy`) needs a Cloudflare API token on the machine that runs it. Connecting the repo to Workers Builds in the dashboard would make every push to `main` deploy instead. Never rotate the `SECRET` Worker secret casually: rotating it makes every saved API key unreadable and signs everyone out.
- **Rate limits.** Sign-in codes are limited per email (1 a minute, 5 an hour) and per IP (20 an hour). A Cloudflare rate-limiting rule on `/api/auth/*` would be a sturdier second layer.

## Lemma of the Day, Blocks, variants

- The daily bank has 14 hand-checked puzzles and repeats after day 14 (6 Dec 2026). Add more, or generate them once the engine can check answers.
- Once Lean runs: check every daily answer and every Blocks proof with it, and only then let either page show green.
- Leaderboards for the daily (results are already stored per user in `daily_results`).
- Blocks: drag to reorder existing pieces (only arrows today), and import a Lean file back into blocks.
- Playbook: run every playbook proof through Lean (they're written, not checked) and fix any that fail; then they can turn green for real.
- Bonsai: group sketches by topic as well as structure (ask the model for a group label per step), and keep the moves list in step with what's folded.
- Variants: the Lean preamble for each rule set lives in both `src/llm.js` and `public/blocks.html`; move it to one place when the engine needs it.
