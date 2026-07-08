# vps-multi-tenant-sovereign

Design study + Ansible template for a single VPS that hosts multiple isolated
tenants, each unaware the others exist.

## The idea

One VPS, one public IP, several tenants. Each tenant should be isolated to
the point of being "almost its own VPS":

- Its own **Incus container** (unprivileged, with nesting enabled) — its own
  PID namespace, its own `/proc`, its own network namespace. A process
  inside can't enumerate or see anything belonging to another tenant.
- Its own **rootless Docker daemon** nested inside that container — no
  shared `docker.sock`, so `docker ps` only ever shows that tenant's own
  containers.
- Its own **ZFS-backed persistent volume**, snapshotted and backed up
  independently per tenant.
- Its own **Cloudflare Tunnel** — no shared reverse proxy, no open inbound
  ports on the host at all. Each tenant's traffic goes out through its own
  tunnel.
- Per-tenant **cgroup resource limits** (CPU, memory, disk I/O, network
  bandwidth) so one tenant can't starve or crash the others.

The motivating example: if an AI agent (e.g. Claude) is running as one
tenant's user, it should not be able to discover, see, or infer the
existence of another tenant's services — not through `/proc`, not through
`docker ps`, not through the network.

Full writeup with rationale, the isolation test checklist, and command-by-command
walkthrough: [`GUIDE.md`](./GUIDE.md).

## What's here

- `GUIDE.md` — the full design doc: why namespace isolation beats Unix
  permissions, host setup (ZFS + Incus), per-tenant container creation,
  nested rootless Docker, Cloudflare Tunnel per tenant, SSH access options,
  backups, resource limits, and a "neighbor test" to verify isolation
  actually holds.
- `ansible/` — a role that automates most of this: host prep (ZFS, Incus,
  default-deny firewall) and per-tenant provisioning (container, ZFS volume,
  resource limits, rootless Docker, Cloudflare Tunnel config skeleton). See
  `ansible/group_vars/all.yml` to define tenants and their limits.

## Note on the Cloudflare Tunnel step

`cloudflared tunnel login` / `tunnel create` require interactive browser
auth against a Cloudflare account, so that step is intentionally left
manual (documented in the guide) rather than baked into Ansible.

## Origin

This design was worked out and reviewed together with Claude, using the
**Fable** model for the exploratory/architecture discussion before settling
on the Incus + rootless Docker + Cloudflare Tunnel approach documented here.
