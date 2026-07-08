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

## 🚀 Quick start

```bash
cd ansible
cp inventory.example.ini inventory.ini   # point it at your VPS
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
- ⚙️ `ansible/` — a role that automates most of this: host prep (ZFS, Incus,
  default-deny firewall) and per-tenant provisioning (container, ZFS volume,
  resource limits, rootless Docker, Cloudflare Tunnel config skeleton). See
  `ansible/group_vars/all.yml` to define tenants and their limits.

## 🔐 Note on the Cloudflare Tunnel step

`cloudflared tunnel login` / `tunnel create` require interactive browser
auth against a Cloudflare account, so that step is intentionally left
manual (documented in the guide) rather than baked into Ansible.

## ✨ Made with Claude Fable

This design was explored and shaped in an architecture back-and-forth with
**[Fable](https://claude.ai)**, Anthropic's Claude model 🪄 — from "many
small VPSes vs. one big one?" all the way to the Incus + rootless Docker +
Cloudflare Tunnel pattern documented here — then detailed into the full
guide and Ansible template in this repo with Claude Code.
