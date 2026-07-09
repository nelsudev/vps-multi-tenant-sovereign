# 🏰 vps-multi-tenant-sovereign

> **One VPS. Many tenants. Zero awareness of each other.**
> Turn a single cheap server into a fleet of "almost-VPSes" — each with its own
> kernel view, its own Docker, its own storage, its own tunnel to the world.

[![Made with Claude Fable](https://img.shields.io/badge/made%20with-Claude%20Fable-6ea8fe?style=flat-square&logo=anthropic&logoColor=white)](https://claude.ai)
![Incus](https://img.shields.io/badge/Incus-unprivileged-4cc9a4?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-rootless-2496ED?style=flat-square&logo=docker&logoColor=white)
![ZFS](https://img.shields.io/badge/storage-ZFS-f0a04b?style=flat-square)
![Cloudflare Tunnel](https://img.shields.io/badge/network-Cloudflare%20Tunnel-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Ansible](https://img.shields.io/badge/provisioning-Ansible-EE0000?style=flat-square&logo=ansible&logoColor=white)

Design study + ready-to-run Ansible template for a single VPS that hosts
multiple isolated tenants, each unaware the others exist.

## 🎯 Why you'd want this

- **You self-host a lot of stuff** and want hard walls between projects,
  clients, or experiments — without paying for N separate VPSes.
- **You run AI agents** (Claude, or any autonomous tooling) and want a
  guarantee they can't discover, probe, or infer what else lives on the box.
- **You want zero attack surface**: no reverse proxy to misconfigure, no
  inbound ports at all — every tenant reaches the internet through its own
  outbound Cloudflare Tunnel.
- **You want per-tenant everything**: CPU/RAM/disk/network budgets,
  snapshots, backups, SSH access — all scoped to one tenant, untouchable by
  the rest.

## 💡 The idea

One VPS, one public IP, several tenants. Each tenant is isolated to the
point of being "almost its own VPS":

- 📦 Its own **Incus container** (unprivileged, with nesting enabled) — its own
  PID namespace, its own `/proc`, its own network namespace. A process
  inside can't enumerate or see anything belonging to another tenant.
- 🐳 Its own **rootless Docker daemon** nested inside that container — no
  shared `docker.sock`, so `docker ps` only ever shows that tenant's own
  containers.
- 💾 Its own **ZFS-backed persistent volume**, snapshotted and backed up
  independently per tenant.
- ☁️ Its own **Cloudflare Tunnel** — no shared reverse proxy, no open inbound
  ports on the host at all. Each tenant's traffic goes out through its own
  tunnel.
- ⚖️ Per-tenant **cgroup resource limits** (CPU, memory, disk I/O, network
  bandwidth) so one tenant can't starve or crash the others.

The motivating example: if an AI agent (e.g. Claude) is running as one
tenant's user, it should not be able to discover, see, or infer the
existence of another tenant's services — not through `/proc`, not through
`docker ps`, not through the network. The neighbor isn't blocked; it
**doesn't exist**.

Full writeup with rationale, the isolation test checklist, and command-by-command
walkthrough: [`GUIDE.md`](./GUIDE.md).

Want to prove the Ansible path on a disposable VPS before wiring real
Cloudflare Tunnels? Use the Hetzner API + direct `nip.io` lab path in
[`HETZNER_TEST_GUIDE.md`](./HETZNER_TEST_GUIDE.md).

## 🤖 Let an agent do it

Have Claude Code, Codex, or OpenCode run the whole setup for you — clone
this repo, hand it the prompt in [`AGENT_SETUP_PROMPT.md`](./AGENT_SETUP_PROMPT.md)
with your host/domain/tenant list filled in, and it drives the Ansible run,
verifies isolation with the neighbor test after each tenant, and hands
control back to you only for the Cloudflare login step.

## 🚀 Quick start

```bash
cd ansible
cp inventory.example.ini inventory.ini   # point it at your VPS
ansible-galaxy collection install -r requirements.yml -p collections --upgrade
# edit group_vars/all.yml — define your tenants and their limits
ansible-playbook -i inventory.ini site.yml
```

Then finish each tenant's Cloudflare Tunnel (interactive auth, see the
guide) and you're live. Adding tenant N+1 is one YAML entry + one playbook
run.

## 🗂️ What's here

- 📖 `GUIDE.md` — the full design doc: why namespace isolation beats Unix
  permissions, host setup (ZFS + Incus), per-tenant container creation,
  nested rootless Docker, Cloudflare Tunnel per tenant, SSH access options,
  backups, resource limits, and a "neighbor test" to verify isolation
  actually holds.
- 🔒 `SECURITY.md` — security & zero-downtime operations: patching every
  layer without taking tenants offline (livepatch, planned reboot windows,
  snapshot-first), hardening beyond the base setup, detection, recovery,
  and a compromise playbook.
- ❓ `FAQ.md` — troubleshooting the problems you'll actually hit: nested
  Docker storage drivers, `systemctl --user` bus errors, tunnel 404/502s,
  headless `cloudflared` login, ZFS ARC memory, capacity planning, tenant
  migration, and accidental deletes.
- ✅ `TEST_PLAN.md` — static checks plus the SSH-backed validation plan for
  applying the role to a VPS and proving host, tenant, and neighbor isolation.
- 🧪 `HETZNER_TEST_GUIDE.md` — a disposable Hetzner Cloud lab flow: create a
  VPS with an API token, run the Ansible validation, expose temporary HTTP
  ingress through `nip.io`, and destroy the server afterwards.
- 🤖 `.claude/skills/` — Claude Code skills for the two recurring operations:
  `new-tenant` (provision + neighbor test) and `migrate-tenant` (move a
  tenant to another host with near-zero downtime). Each skill documents its
  origin (which doc sections it distills) so it can be kept in sync.
- ⚙️ `ansible/` — a role that automates most of this: host prep (explicit
  ZFS-backed Incus init, NAT bridge, UFW, unattended-upgrades, sysctl
  hardening), per-tenant dedicated bridges, private-egress ACLs, ZFS volumes,
  resource limits, rootless Docker, installed `cloudflared`, and a
  Cloudflare Tunnel config skeleton. See `ansible/group_vars/all.yml` to
  define tenants and limits.

## 🔐 Note on the Cloudflare Tunnel step

The Ansible role installs `cloudflared`, but `cloudflared tunnel login` /
`tunnel create` require interactive browser auth against a Cloudflare
account. That credential-bearing step is intentionally manual and documented
in the guide.

## ✨ Made with Claude Fable

This design was explored and shaped in an architecture back-and-forth with
**[Fable](https://claude.ai)**, Anthropic's Claude model 🪄 — from "many
small VPSes vs. one big one?" all the way to the Incus + rootless Docker +
Cloudflare Tunnel pattern documented here — then detailed into the full
guide and Ansible template in this repo with Claude Code.
