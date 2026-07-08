# 🔒 Security & zero-downtime operations

How to keep a multi-tenant Incus VPS patched, hardened, and monitored —
without taking tenants offline. Companion to [`GUIDE.md`](./GUIDE.md); this
document assumes the base setup from there is in place.

## The threat model, honestly

Three things can hurt you on this box:

1. **A tenant attacking the host or a neighbor** — mitigated by unprivileged
   containers (idmap), nesting without privilege, per-tenant networks, and
   the neighbor test in the guide. The residual risk is a kernel exploit.
2. **The internet attacking the host** — mostly eliminated by design: no
   inbound ports, everything rides outbound Cloudflare Tunnels. The residual
   risk is your Cloudflare account and tunnel credentials.
3. **You attacking yourself** — a bad update, a fat-fingered `incus delete`,
   a config drift. Mitigated by snapshots, staged rollouts, and automation.

Everything below maps to one of these three.

## 1 · Patching without downtime

### The layer cake

| Layer                     | Needs a reboot?     | Tenant downtime?                  |
|----------------------------|---------------------|------------------------------------|
| Host userspace (apt)       | no                  | none                               |
| Host kernel                | usually yes         | seconds–minutes, all tenants       |
| Incus itself               | no (daemon restart) | none — containers keep running     |
| Container userspace        | no                  | none                               |
| Tenant's Docker images     | no                  | per-service, controlled by tenant  |

The key fact that makes this design operable: **restarting the Incus daemon
does not restart the containers**. Same for Docker rootless inside a tenant
(`live-restore` semantics: upgrading the Docker packages doesn't kill
running containers in recent versions, but verify per version).

### Host userspace: automate it

```bash
apt -y install unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

In `/etc/apt/apt.conf.d/50unattended-upgrades`, enable security origins and
**disable automatic reboots** — you decide when kernels roll (see next
section):

```
Unattended-Upgrade::Automatic-Reboot "false";
```

### Kernel updates: the only real downtime, minimized

The kernel is shared — patching it is non-negotiable, and a reboot affects
every tenant. Your options, from best to simplest:

- **Livepatching (zero downtime)** — Canonical Livepatch (free for ≤5
  machines with Ubuntu Pro) applies critical kernel CVE fixes without
  rebooting. This turns "urgent 2am reboot" into "reboot at the next
  planned window." Strongly recommended:

  ```bash
  pro attach <token>          # free Ubuntu Pro token
  pro enable livepatch
  ```

- **Planned reboot windows** — livepatch covers criticals, so full reboots
  can happen monthly at a quiet hour. Before rebooting:

  ```bash
  # snapshot every tenant first — instant on ZFS
  for t in $(incus list -c n -f csv); do incus snapshot create "$t" pre-reboot; done
  reboot
  ```

  Incus autostarts containers on boot (`boot.autostart` defaults to
  restoring previous state). Set explicit ordering so dependencies come up
  first:

  ```bash
  incus config set tenant-a boot.autostart=true boot.autostart.priority=10
  ```

  Total tenant downtime = one reboot (typically 30–90s on a VPS). Cloudflare
  Tunnels reconnect automatically when `cloudflared` comes back — no DNS or
  config changes needed.

### Incus updates: no downtime

```bash
apt update && apt install --only-upgrade incus
# containers keep running; only the management daemon restarts
```

### Inside each tenant: their problem, made easy

Each tenant patches its own userspace (`unattended-upgrades` inside the
container too — the Ansible role can seed it). Docker image updates are
rolling by nature: `docker compose pull && docker compose up -d` recreates
only changed services. For truly zero-downtime app updates inside a tenant,
run two replicas behind the tunnel and update one at a time — but that's
tenant-level policy, not host policy.

## 2 · Hardening beyond the guide

### Host access

- **No public SSH, ever.** Admin access via WireGuard (or Cloudflare Access
  on a dedicated admin tunnel). If you must keep host sshd:
  `PasswordAuthentication no`, `PermitRootLogin no`, keys only.
- **2FA on the VPS provider panel and on Cloudflare.** The provider console
  and your Cloudflare account are the real keys to the kingdom — a stolen
  Cloudflare token can re-route every tenant's hostname.
- **Separate Cloudflare tunnel credentials per tenant** (already the
  design): a leaked credential exposes one tenant's ingress, not all.

### Kernel & container hardening

```bash
# hide other users' processes even on the host itself
mount -o remount,hidepid=2 /proc   # + fstab entry: proc /proc proc defaults,hidepid=2 0 0

# reduce kernel attack surface reachable from containers
cat > /etc/sysctl.d/90-hardening.conf <<'EOF'
kernel.unprivileged_bpf_disabled = 1
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
net.ipv4.conf.all.rp_filter = 1
EOF
sysctl --system
```

- Keep containers **unprivileged always** — audit with:

  ```bash
  incus list -c n,config:security.privileged -f csv | grep -v ',$' || echo "all unprivileged ✓"
  ```

- **Don't share devices or host paths into tenants** unless absolutely
  required; every shared mount is a hole in the wall.
- **AppArmor stays on** (Incus applies per-container profiles by default —
  don't set `security.apparmor=false` to "fix" something).

### Network

- ufw default-deny inbound (done by the Ansible role). Verify nothing crept
  in: `ss -tlnp` on the host should show *nothing* on the public interface.
- **Inter-tenant traffic**: on a shared bridge, tenants can technically
  reach each other's IPs if they learn them. The default Ansible variables
  use one NAT bridge per tenant, which is the clearer boundary:

  ```bash
  incus network create net-tenant-a ipv4.address=10.1.1.1/24 ipv4.nat=true
  incus config device override tenant-a eth0 network=net-tenant-a
  ```

  Incus ACLs can still be useful, but do not treat a single shared bridge as
  the primary isolation layer for a hostile multi-tenant setup. Keep the
  network topology simple enough that the neighbor test is easy to reason
  about and repeat.

## 3 · Detection: knowing something's wrong

- **Auditd on the host** for the events that matter:

  ```bash
  apt -y install auditd
  auditctl -w /var/lib/incus -p wa -k incus-tamper
  auditctl -w /etc/ssh/sshd_config -p wa -k ssh-config
  ```

- **fail2ban** only matters if you kept any inbound service; in the pure
  tunnel design there's nothing for it to watch — that's the point.
- **Per-tenant resource alerts**: a tenant suddenly pinned at its CPU or
  network limit is either compromised (cryptominer) or broken. A tiny cron
  on the host:

  ```bash
  incus query /1.0/instances/tenant-a/state | jq '.memory.usage, .cpu.usage'
  ```

  Feed it into whatever you already run (Uptime Kuma, Prometheus, a cron
  that pings you). Watch **egress bytes** especially — exfiltration and
  spam show up there first.
- **Cloudflare analytics per tunnel** give you per-tenant request patterns
  for free — anomalies are visible per hostname.

## 4 · Recovery: when something does go wrong

Downtime is minimized not just by avoiding failures but by making recovery
boring:

```bash
# roll a tenant back to before the bad thing — seconds, ZFS
incus restore tenant-a pre-update

# rebuild a tenant from scratch but keep its data
incus delete tenant-a --force
incus launch images:ubuntu/24.04 tenant-a -c security.nesting=true ...
incus config device add tenant-a data disk pool=default source=tenant-a-data path=/data
# (or just re-run the Ansible role — it's idempotent for existing volumes)
```

- **The data volume outlives the container** — that separation is your
  disaster-recovery primitive. Containers are cattle; volumes are pets.
- **Test a restore quarterly.** A backup you've never restored is a hope,
  not a backup.
- **Off-site**: `zfs send` incrementals per tenant (see GUIDE.md §06) to
  another box or an encrypted object store. The host dying entirely should
  cost you minutes of provisioning (Ansible) + one `zfs recv` per tenant.

## 5 · The compromise playbook

If you suspect a tenant is compromised:

```bash
incus snapshot create tenant-x forensics-$(date +%s)  # freeze evidence first
incus config device set tenant-x eth0 limits.egress=1kbit  # strangle exfiltration
# investigate from the HOST via incus exec — never trust tools inside the tenant
incus exec tenant-x -- ps aux
incus stop tenant-x        # when confirmed
```

Then: revoke that tenant's Cloudflare tunnel in the dashboard (its
credential is scoped to it alone), restore from the last clean snapshot or
rebuild, and rotate any secret that lived inside.

The design keeps the blast radius at one tenant — the playbook's job is
just to not enlarge it while you respond.

## TL;DR operational calendar

| Cadence   | Action                                                        | Downtime |
|-----------|----------------------------------------------------------------|----------|
| automatic | unattended-upgrades (host + tenants), livepatch, daily snapshots | none     |
| weekly    | glance at resource/egress metrics, `incus list` health          | none     |
| monthly   | planned reboot window (kernel), snapshot-first                  | ~1 min   |
| quarterly | restore test, audit `security.privileged`, rotate admin creds   | none     |
