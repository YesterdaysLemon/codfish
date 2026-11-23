# To do

## Engine hosting (blocked on the Windows side of Tome)

The board is a Cloudflare Worker, but the engine (Lean checks, counterexample search, model prover) needs a real server, which means the VPS via Deploy Manager.

That deploy has to be run from the Windows side of Tome (for example a Codex session there), following the `vps-operations` and `credentials-access` skills. It needs the `vps-admin` SSH alias, the key in `~/.ssh`, and the Proton gateway, which is enrolled to the Windows user. A Claude session reaching Tome through the desktop app gets a sandboxed Linux VM instead, and can't use any of those.
