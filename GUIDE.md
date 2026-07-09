# One VPS, N tenants that don't even know their neighbors exist

Architecture guide + manual runbook for building a multi-tenant VPS with
near-VM isolation: each tenant lives in its own Incus container, runs its own
rootless Docker inside it, has persistent ZFS-backed storage, and reaches the
internet through its own Cloudflare Tunnel. One public IP, zero open ports,
zero lateral visibility between tenants.

The Ansible role that automates most of this lives in `ansible/` — this
document is the design and the reasoning behind it; use it to understand
*why* each piece exists, or to provision by hand if you prefer.

## 00 · Why this design

Unix permissions (separate users + `chmod 700`) solve *access* but not
*visibility*: a curious process can still enumerate `/proc`, see the global
`docker.sock`, and run `docker ps` on its neighbors. The rule behind this
guide is to give each tenant a **separate kernel view** via full Incus
namespaces. Inside a container, the neighbor isn't blocked — it literally
**doesn't exist**.

| What tenant-a's process tries          | Plain Linux users     | This design          |
|------------------------------------------|-----------------------|------------------------|
| `ps aux` / read neighbors' `/proc`        | sees everything       | doesn't exist          |
| `docker ps` on other services              | sees the shared sock  | isolated daemon        |
| `ss -tulpn` / scan the internal network    | same network          | its own bridge         |
| read another tenant's files                | blocked               | different FS/dataset   |
| escape via a kernel bug                    | same root namespace   | unprivileged + idmap   |

## 01 · Host — base, ZFS and Incus

Ubuntu 24.04 LTS on a KVM-backed VPS (not OpenVZ — you need a real kernel for
reliable nesting).

```bash
apt update && apt -y full-upgrade
apt -y install zfsutils-linux

# Incus from the official Zabbly repo (more recent than Ubuntu's own package)
curl -fsSL https://pkgs.zabbly.com/key.asc | tee /etc/apt/keyrings/zabbly.asc
sh -c 'echo "deb [signed-by=/etc/apt/keyrings/zabbly.asc] \
  https://pkgs.zabbly.com/incus/stable $(. /etc/os-release; echo $VERSION_CODENAME) main" \
  > /etc/apt/sources.list.d/zabbly-incus-stable.list'
apt update && apt -y install incus incus-client

cat <<'EOF' | incus admin init --preseed
config: {}
networks:
  - name: incusbr0
    type: bridge
    config:
      ipv4.address: auto
      ipv4.nat: "true"
      ipv6.address: none
storage_pools:
  - name: default
    driver: zfs
    config:
      size: 100GiB
profiles:
  - name: default
    devices:
      eth0:
        name: eth0
        network: incusbr0
        type: nic
      root:
        path: /
        pool: default
        type: disk
projects: []
cluster: null
EOF
```

The preseed is explicit on purpose: `incus admin init --minimal` is convenient,
but it does not guarantee a ZFS pool. This design depends on ZFS semantics for
quotas, snapshots, and `zfs send/receive`, so the storage driver must be
declared.

**Why ZFS**: each container gets its own dataset. Snapshots are instant, and
`zfs send/receive` gives you incremental backups per tenant — you copy
tenant-a without touching the others. Rootless Docker volumes inside the
container live on that same dataset, so they're automatically covered by
snapshots.

## 02 · Creating a tenant — a container with nesting

Each tenant is an **unprivileged** container (root inside maps to an
unprivileged UID on the host via idmap — the safety net against escapes)
with **nesting enabled** so it can run Docker inside.

```bash
incus launch images:ubuntu/24.04 tenant-a \
  -c security.nesting=true \
  -c security.privileged=false \
  -c limits.cpu=2 \
  -c limits.memory=4GiB

incus storage volume create default tenant-a-data
incus config device add tenant-a data disk \
  pool=default source=tenant-a-data path=/data

# strongest tenant network isolation: one NAT bridge per tenant
incus network create net-tenant-a ipv4.address=10.201.1.1/24 \
  ipv4.nat=true ipv6.address=none
incus config device override tenant-a eth0 network=net-tenant-a
incus exec tenant-a -- sh -c 'cat > /etc/netplan/10-lxc.yaml <<EOF
network:
  version: 2
  ethernets:
    eth0:
      addresses: [10.201.1.10/24]
      routes:
        - to: default
          via: 10.201.1.1
      nameservers:
        addresses: [10.201.1.1]
EOF
netplan apply'
incus network acl create tenant-a-deny-private
incus network acl rule add tenant-a-deny-private egress action=allow \
  destination=10.201.1.1/32 protocol=udp destination_port=53
incus network acl rule add tenant-a-deny-private egress action=allow \
  destination=10.201.1.1/32 protocol=tcp destination_port=53
incus network acl rule add tenant-a-deny-private egress action=reject \
  destination=10.0.0.0/8
incus config device set tenant-a eth0 security.acls=tenant-a-deny-private \
  security.acls.default.ingress.action=allow \
  security.acls.default.egress.action=allow
```

Repeat per tenant (`tenant-b`, `tenant-c`…), changing only the name and the
limits and static IPv4. Each one is born with its own view: its own PID 1, its
own `/proc`, and, in the Ansible defaults, its own NAT bridge plus an ACL
rejecting private egress ranges used for lateral tenant traffic. DNS points to
that tenant's own bridge gateway, otherwise package installs inside the tenant
would not be able to resolve public mirrors.

> **The limit people forget most**: without `limits.memory` / `limits.cpu`, a
> tenant can consume all the RAM and OOM-crash its neighbors — visibility
> isolation is not resource isolation. Always set both.

## 03 · Inside the tenant — user + rootless Docker

```bash
incus exec tenant-a -- bash
# --- now inside the container ---
apt update && apt -y install uidmap dbus-user-session \
  docker.io docker-compose-v2 openssh-server curl fuse-overlayfs slirp4netns

# keep Docker rootless-only inside the tenant
systemctl disable --now docker.service docker.socket

useradd -m -s /bin/bash app
loginctl enable-linger app        # the user's services survive logout
install -d -o app -g app /data    # hand the ZFS volume to the user
```

Start Docker **rootless** as the `app` user. No global daemon, no
`/var/run/docker.sock` — the socket lives under the user's own
`$XDG_RUNTIME_DIR`.

```bash
su - app

dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
echo 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock' >> ~/.bashrc

# store docker data on the persistent ZFS volume
mkdir -p /data/docker
systemctl --user stop docker
mkdir -p ~/.config/docker
echo '{ "data-root": "/data/docker" }' > ~/.config/docker/daemon.json
systemctl --user start docker

docker run --rm hello-world # nested + rootless, working
```

**Double wall**: Incus isolates the tenant from the host and from its
neighbors. Rootless Docker isolates the containers from the tenant's own
init. A `docker ps` in here only shows `app`'s own containers — the other
tenants don't even have an accessible daemon.

## 04 · Cloudflare Tunnel — one per tenant

No reverse proxy on the host, no open ports. Each container runs its own
`cloudflared`, which opens an outbound connection to Cloudflare. tenant-a
never touches tenant-b's network config.

```bash
# install cloudflared inside the container
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  > /etc/apt/sources.list.d/cloudflared.list
apt update && apt -y install cloudflared

cloudflared tunnel login
cloudflared tunnel create tenant-a
cloudflared tunnel route dns tenant-a app-a.yourdomain.tld
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: tenant-a
credentials-file: /home/app/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: app-a.yourdomain.tld
    service: http://localhost:8080
  - service: http_status:404
```

```bash
cloudflared service install   # or a unit under ~/.config/systemd/user/
systemctl --user enable --now cloudflared
```

**Net result**: the host doesn't expose a single inbound port. The host
firewall can be fully *default-deny inbound* — including for HTTP/HTTPS.

## 05 · SSH — access without opening the host

- **Option A — SSH through the tenant's own Cloudflare Tunnel** (recommended):
  add an `ssh://localhost:22` `ingress` entry to the tenant's `cloudflared`
  config and connect with `cloudflared access ssh`. Can be protected with
  Cloudflare Access (Zero Trust), with no ports open on the host.
- **Option B — jump through the host**: the host's `sshd` listens only on
  the LAN/WireGuard, and the admin runs `incus exec tenant-a -- su - app`.
  Simpler, but the admin "sees" that it's a shared machine.

```yaml
ingress:
  - hostname: ssh-a.yourdomain.tld
    service: ssh://localhost:22
  - hostname: app-a.yourdomain.tld
    service: http://localhost:8080
  - service: http_status:404
```

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname %h" \
  app@ssh-a.yourdomain.tld
```

The Ansible defaults harden the tenant's `sshd` to disallow passwords and
root login. Add public keys under `tenant.ssh_authorized_keys` in
`ansible/group_vars/all.yml` if you want direct `app` SSH after the tunnel is
live.

## 06 · Persistent storage & backups

```bash
# instant snapshot of the whole container (rootfs)
incus snapshot create tenant-a pre-update

# snapshot of the data volume
incus storage volume snapshot default tenant-a-data daily-$(date +%F)

# incremental off-site backup, for this tenant only
zfs send -i default/... default/tenant-a-data@yesterday \
  | ssh backup@offsite zfs recv tank/backups/tenant-a

# automatic retention, no manual cron
incus config set tenant-a \
  snapshots.schedule="@daily" \
  snapshots.expiry="7d"
```

## 07 · Hardening — the neighbor test

Run as `app` inside a tenant, these commands should **fail to see anything
belonging to the host or to any neighbor**:

```bash
ps aux              # → only this container's processes
docker ps           # → only app's own containers
ss -tulpn           # → only this tenant's sockets
ip addr             # → only its own bridge interface
cat /proc/1/cgroup  # → doesn't reveal host paths
ls /                # → its own rootfs; no other tenant's /data
```

Final host hardening checklist:

- **Default-deny inbound firewall** — with a Cloudflare Tunnel you don't
  need any open port (not even 80/443). Host SSH only over WireGuard, if
  using Option B.
- **Host unattended-upgrades + sysctl hardening** — automated by the Ansible
  role defaults. `hidepid=2` remains a manual host decision because it can
  affect monitoring and service managers.
- **Confirm unprivileged** — `incus config get tenant-a
  security.privileged` must return `false`/empty.
- **No sudo for `app`** — after provisioning, remove the user from any
  `sudo` group.
- **Host updates = updates to every kernel** — automate
  `unattended-upgrades` and scheduled reboots; snapshots give you rollback.
- **Cloudflare Access in front of the tunnels** — Zero Trust policies per
  hostname.

> **The honest limit of this design**: everything shares one kernel.
> Unprivileged + idmap makes an escape unlikely and expensive, but not
> impossible the way a microVM (Firecracker) would make it. For 99% of
> cases — including "an agent can't know about the neighbor" — this is
> enough and then some. If you ever need hardware-level guarantees, swap
> Incus for microVMs while keeping the same tunnel/storage-per-tenant
> pattern.

## 08 · Per-tenant resource limits

Visibility isolation is not resource isolation — without limits, a starved
tenant crashes its neighbors through CPU/RAM/IO contention. Limits live in
**cgroups v2**, applied by Incus to the whole container.

```bash
incus config set tenant-a limits.cpu=2              # number of visible vCPUs
incus config set tenant-a limits.cpu.allowance=50%  # alternative: % of CPU time
incus config set tenant-a limits.cpu.priority=5     # weight under contention (1-10)
incus config set tenant-a limits.memory=4GiB        # hard RAM cap
incus config set tenant-a limits.memory.swap=false  # no swap for this tenant
incus config set tenant-a limits.processes=500      # anti fork-bomb

# enforce quota on the custom ZFS data volume before attaching it
incus storage volume set default tenant-a-data size=20GiB

# optional: throttle I/O when the backing device/storage driver supports it
incus config device set tenant-a data limits.read=50MB limits.write=30MB

# network bandwidth
incus config device set tenant-a eth0 limits.ingress=100Mbit limits.egress=100Mbit
```

| Limit                          | What it does                                | When to use it                                |
|----------------------------------|-----------------------------------------------|--------------------------------------------------|
| `limits.cpu`                     | Fixes the number of cores the tenant sees      | Predictable plans, "almost a VPS"                |
| `limits.cpu.allowance`           | Sees all cores, only consumes X%              | Occasional bursting without a fixed core count   |
| `limits.memory`                  | Hard RAM cap; local OOM when exceeded          | Always — never leave this unset                  |
| `limits.processes`               | PID ceiling in the container                  | Always — cheap, prevents fork-bombs              |
| device `limits.read/write`       | Best-effort disk IOPS/throughput throttling   | When the Incus device/storage driver supports it |
| device `limits.ingress/egress`   | Throttles network bandwidth                   | A tenant with heavy traffic affecting others      |

**Rule of thumb**: `limits.memory` is the one you can never forget — without
it, a tenant that blows up on memory risks taking the whole host into a
global OOM. Prefer `limits.cpu=N` over `allowance` when you want
predictability like "this customer gets 2 cores," and use `processes` as a
cheap safety net against fork-bombs.

These can be changed live, without restarting the container in most cases.
Inside the tenant itself, rootless Docker can still sub-limit individual
containers (`docker run --cpus --memory`), but that's the tenant managing
itself, not the boundary between tenants.

## 09 · Lifecycle — day to day

```bash
incus list                              # status of every tenant
incus exec tenant-a -- su - app          # enter a tenant
incus stop|start|restart tenant-a        # lifecycle
incus copy tenant-a tenant-d             # clone → new base tenant
incus storage volume set default tenant-a-data size=20GiB  # disk quota
incus delete tenant-a --force            # remove (snapshot first!)
```

Adding tenant N+1 is literally repeating sections 02 → 05 with a different
name — or running the Ansible role in `ansible/` after adding an entry to
`group_vars/all.yml`.
