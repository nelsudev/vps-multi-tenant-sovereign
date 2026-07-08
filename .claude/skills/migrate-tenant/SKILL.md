---
name: migrate-tenant
description: Use when moving a tenant (Incus container + its data volume) from one VPS host to another with minimal downtime — covers pre-seeding the volume with incremental zfs send, incus move, volume re-attach, and post-move verification.
---

<!-- Origin: distilled from GUIDE.md + FAQ.md ("How do I move a tenant to a
     new/bigger VPS?") in this repo, designed with Claude Fable and detailed
     with Claude Code. Keep in sync with those docs. -->

# Migrate a tenant to another host

## Preconditions — verify before touching anything

1. New host has the base setup: run the `incus_host` Ansible role
   (`ansible/site.yml`) against it. Confirm: `incus storage list` shows the
   `default` pool, `ufw status` shows default-deny inbound.
2. Old host can reach new host: `incus remote add newbox <ip-or-name>` and
   `incus remote list` shows it.
3. Snapshot first: `incus snapshot create <tenant> pre-migration`.

## Procedure

### 1. Pre-seed the data volume (tenant still running — no downtime yet)

The volume copy dominates the outage window, so seed it live:

```bash
# find the exact dataset name first
zfs list | grep <tenant>-data
zfs snapshot <pool>/<tenant>-data@seed
zfs send <pool>/<tenant>-data@seed | ssh newbox zfs recv <pool>/<tenant>-data
```

### 2. The cutover (downtime starts here)

```bash
incus stop <tenant>
# final delta — seconds, regardless of volume size
zfs snapshot <pool>/<tenant>-data@final
zfs send -i @seed <pool>/<tenant>-data@final | ssh newbox zfs recv <pool>/<tenant>-data
# move the container: rootfs, config, snapshots, everything inside
incus move <tenant> newbox:<tenant>
```

### 3. On the new host: re-attach and start

```bash
incus config device add <tenant> data disk \
  pool=default source=<tenant>-data path=/data
incus start <tenant>
```

## Verification — do not declare success without these

```bash
incus exec <tenant> -- su - app -c "docker ps"       # tenant's services up
incus exec <tenant> -- systemctl --user -M app@ status cloudflared
curl -sI https://<tenant-hostname>                    # tunnel reconnected
incus config get <tenant> security.privileged         # still empty/false
```

The Cloudflare Tunnel reconnects automatically (outbound, credentials live
inside the container) — if the hostname doesn't respond within ~1 minute,
check `cloudflared` logs inside the tenant, not DNS.

## Rollback

The old host still has everything until you delete it. If the new host
misbehaves: `incus stop newbox:<tenant>`, restart the tenant on the old
host (`incus start <tenant>` — it was only stopped, then moved; if moved,
move it back). Only delete from the old host after verification passes.
