---
name: new-tenant
description: Use when adding a new isolated tenant to the multi-tenant VPS — creates the Incus container with limits, ZFS volume, rootless Docker, and cloudflared skeleton, either via the Ansible role or manually, then runs the isolation neighbor test.
---

<!-- Origin: distilled from GUIDE.md §02–§05 and §07 in this repo, designed
     with Claude Fable and detailed with Claude Code. Keep in sync with the
     guide and the ansible/ role. -->

# Add a new tenant

## Preferred path: Ansible (idempotent)

1. Add an entry to `ansible/group_vars/all.yml` under `tenants:` — copy an
   existing block, change `name`, give it a unique `network.bridge` and
   `network.bridge_ipv4`, and adjust limits. Never omit `limits.memory` or
   `limits.processes`.
2. Run: `ansible-galaxy collection install -r ansible/requirements.yml -p ansible/collections --upgrade`
   to install the latest collections.
3. Run: `ansible-playbook -i inventory.ini site.yml` (existing tenants are
   detected and skipped).

## Manual path (or when debugging the role)

Follow GUIDE.md §02 → §05 in order: launch (unprivileged + nesting +
limits), ZFS volume attach at `/data`, `app` user with linger, rootless
Docker with `data-root` on `/data/docker`, install `cloudflared`, and lay
down the tunnel config skeleton. If private egress blocking is enabled, add
the tenant NIC ACL and verify it rejects RFC1918 lateral traffic.

## Always-manual step: the Cloudflare Tunnel

The package is installed by Ansible, but tunnel creation needs interactive
auth and cannot be in Ansible:

```bash
incus exec <tenant> -- su - app
cloudflared tunnel login          # or use a remotely-managed tunnel token (see FAQ)
cloudflared tunnel create <tenant>
cloudflared tunnel route dns <tenant> <hostname>
# fill tunnel id into ~/.cloudflared/config.yml, then:
systemctl --user enable --now cloudflared
```

## Verify: the neighbor test (GUIDE.md §07)

Run as `app` inside the new tenant — every one of these must show ONLY the
tenant's own resources, nothing from the host or other tenants:

```bash
ps aux; docker ps; ss -tulpn; ip addr; cat /proc/1/cgroup
```

Also confirm on the host:

```bash
incus config get <tenant> security.privileged   # must be empty/false
incus config get <tenant> limits.memory          # must be set
```

If any check fails, stop and fix before handing over the tenant — do not
skip the neighbor test because "the role always works."
