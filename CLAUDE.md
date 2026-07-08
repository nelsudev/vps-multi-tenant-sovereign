# CLAUDE.md

Guidelines for Claude Code in this repository.

## Repo purpose

Design study + Ansible template for a single VPS hosting multiple isolated
tenants via Incus, rootless Docker, ZFS, and per-tenant Cloudflare Tunnels.
Not a Feedzai deliverable, not a client project — this is personal
self-hosted infrastructure.

## Commit message conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <short summary, imperative mood, no trailing period>
```

- Allowed types: `feat`, `fix`, `docs`, `refactor`, `chore`, `ci`, `test`.
- Summary line ≤ 72 characters, imperative ("add", not "added"/"adds").
- Scope is optional but useful here: `ansible`, `guide`, `readme`.
- Body (if any) explains *why*, not *what* — the diff already shows what.
- Examples:
  - `docs(guide): add resource limits section`
  - `feat(ansible): add cloudflared config skeleton to tenant role`
  - `fix(ansible): correct idmap check in tenant role`

## Rules

- Keep `GUIDE.md` and `README.md` in English.
- Keep `GUIDE.md` and the `ansible/` role in sync — if a step in the guide
  changes, update the corresponding Ansible task, and vice versa.
- Never commit real Cloudflare tunnel credentials, VPS IPs, or an
  `inventory.ini` with real hosts — only `inventory.example.ini` with
  placeholder values.
- No mention of client/employer names (e.g. Feedzai) anywhere in this repo —
  it documents personal self-hosted infrastructure only.
