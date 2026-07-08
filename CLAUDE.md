# CLAUDE.md

Guidelines for Claude Code in this repository.

## Repo purpose

Design study + Ansible template for a single VPS hosting multiple isolated
tenants via Incus, rootless Docker, ZFS, and per-tenant Cloudflare Tunnels.
Personal self-hosted infrastructure — not a client project; never reference
client or employer names anywhere in this repo.

## How this repo came to be (provenance)

The architecture was worked out in a design conversation with **Claude
Fable** — starting from "many small VPSes vs. one big one with hard
walls?", through isolation levels (plain Linux hardening → LXC/Incus →
microVMs), down to the final pattern: unprivileged Incus containers with
nesting, rootless Docker inside, ZFS volumes, one Cloudflare Tunnel per
tenant, no open inbound ports. The conclusions were then distilled into the
docs and automation here with Claude Code.

This matters for maintenance: the documents are the **reasoning**, not just
instructions. When editing, preserve the *why* alongside the *how* — every
recommendation in the docs states its rationale and its honest limits (e.g.
the shared-kernel caveat). Keep that style.

## Organization — where knowledge lives

| File | Role | Derived from |
|------|------|--------------|
| `README.md` | Pitch + map of the repo | summary of everything below |
| `GUIDE.md` | The design doc: rationale + step-by-step runbook (§00–§09) | the Fable design conversation |
| `SECURITY.md` | Security & zero-downtime operations | extends GUIDE.md §07 |
| `FAQ.md` | Troubleshooting real problems, by area | field knowledge + guide edge cases |
| `ansible/` | Automation of GUIDE.md §01–§05 + limits (§08) | the guide, mechanized |
| `.claude/skills/` | Runbooks for recurring ops (new-tenant, migrate-tenant) | distilled from GUIDE.md/FAQ.md sections named in each skill's origin comment |

**The sync rule** (the most important rule here): `GUIDE.md`, the
`ansible/` role, and the skills describe the same system. A change in one
place propagates:

- Guide step changes → update the matching Ansible task, and vice versa.
- Migration/provisioning procedure changes → update the skill AND the FAQ
  answer it came from.
- Each skill carries an origin comment naming its source sections — use it
  to find what else to update, and keep it accurate.

## Language & style

- All docs in **English**. Conversational-technical tone: direct, honest
  about trade-offs, no marketing fluff inside technical docs (the README is
  the only place that sells).
- Section numbering in GUIDE.md (`§00–§09`) is load-bearing — other files
  cross-reference it. Don't renumber without updating every reference.
- Emoji as section markers in README/SECURITY/FAQ headers — keep the
  pattern, don't overdo it inside body text.
- Commands are always in fenced `bash`/`yaml` blocks with inline `#`
  comments explaining the non-obvious flag, not the obvious one.

## Commit message conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary, imperative mood, no trailing period>
```

- Allowed types: `feat`, `fix`, `docs`, `refactor`, `chore`, `ci`, `test`.
- Summary line ≤ 72 characters, imperative ("add", not "added"/"adds").
- Scope is optional but useful here: `ansible`, `guide`, `security`, `faq`,
  `readme`, `skills`.
- Body (if any) explains *why*, not *what* — the diff already shows what.
- Examples:
  - `docs(guide): add resource limits section`
  - `feat(ansible): add cloudflared config skeleton to tenant role`
  - `fix(ansible): correct idmap check in tenant role`

## Hard rules

- Never commit real Cloudflare tunnel credentials, VPS IPs, or an
  `inventory.ini` with real hosts — only `inventory.example.ini` with
  placeholder values.
- Never suggest `security.privileged=true` as a fix for anything — it
  defeats the entire design. Same for disabling AppArmor.
- `limits.memory` and `limits.processes` are mandatory on every tenant
  example and every Ansible default — never show a tenant without them.
