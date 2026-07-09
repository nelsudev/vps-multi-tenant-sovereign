# ❓ FAQ & Troubleshooting

The problems you'll actually hit setting this up, and how to fix them.
Companion to [`GUIDE.md`](./GUIDE.md) and [`SECURITY.md`](./SECURITY.md).

## Setup issues

### Docker inside the container fails with overlayfs / storage driver errors

The most common nested-Docker problem. Check in this order:

1. **Nesting is on**: `incus config get tenant-a security.nesting` must be
   `true`. Without it, Docker can't create the namespaces it needs.
2. **Storage driver fell back to `vfs`**: run `docker info | grep Storage`
   inside the tenant. If it says `vfs`, every image layer is being fully
   copied — disk fills up fast and everything is slow. On ZFS-backed Incus,
   rootless Docker inside the container generally can't use `overlay2`
   directly on the ZFS dataset. Fixes, best first:
   - Use `fuse-overlayfs` (rootless Docker picks it up automatically if
     installed): `apt install fuse-overlayfs`, then restart the user's
     docker service.
   - Or give the tenant a dedicated volume formatted with a filesystem
     overlay2 likes (ext4) for `data-root`:
     `incus storage volume create default tenant-a-docker size=20GiB
     block.filesystem=ext4 --type=block` and attach it at `/data/docker`.

### `dockerd-rootless-setuptool.sh: command not found`

Install Docker from Docker's official apt repository and include
`docker-ce-rootless-extras`. Ubuntu's `docker.io` package may not include the
rootless setup helper and has shown rootless daemon crashes in this lab.

### `systemctl --user` fails with "Failed to connect to bus"

You're in a session without the user's D-Bus (classic after `su app` or
`incus exec ... -- su - app`). Fixes:

- Use `machinectl shell app@` instead of `su` (needs `systemd-container`), or
- Export the runtime dir first:
  `export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus`
- And make sure lingering is on: `loginctl enable-linger app` (as root).

### Rootless Docker dies when the user logs out

`loginctl enable-linger app` was never run (or was run inside a session
that couldn't reach logind). Verify with `loginctl show-user app | grep
Linger` — must say `Linger=yes`.

### Container has no network / `apt update` hangs inside a new tenant

- Check the bridge exists and NAT is on:
  `incus network show incusbr0` → `ipv4.nat: "true"`.
- If the VPS provider filters unknown MAC addresses (some do on shared
  networking), Incus NAT still works because traffic leaves with the host's
  MAC — but a custom bridge with `ipv4.nat=false` won't. Keep NAT on.
- Docker-in-Incus iptables clash: if the tenant has no outbound network
  *after* Docker starts, rootless Docker's slirp4netns may conflict with a
  proxy env var. Check `~/.config/systemd/user/docker.service.d/` overrides.

### The ZFS pool is loop-backed and too small

The Ansible role initializes Incus with an explicit ZFS preseed. If you use
the default loop-backed pool and outgrow it, increase its size:

```bash
incus storage set default size=100GiB   # grows the loop file
```

or better, if you have a spare disk/partition, create a real pool and move
tenants to it (`incus move --storage`). Loop-backed ZFS is fine for getting
started, measurably slower for heavy I/O.

## Cloudflare Tunnel issues

### Tunnel connects but the hostname 404s / 502s

Work down the `ingress` chain:

1. `cloudflared tunnel info tenant-a` — is the tunnel actually connected?
2. Does the hostname have a DNS route? `cloudflared tunnel route dns
   tenant-a app-a.example.com` must have been run (it creates the CNAME).
3. Is the local service actually listening? From inside the tenant:
   `curl -v http://localhost:8080`. Remember: rootless Docker ports bind on
   the tenant's localhost only if you published them (`-p 8080:80`).
4. 502 with TLS backends: add `originRequest: {noTLSVerify: true}` for
   self-signed local services, or point at the HTTP port instead.

### `cloudflared tunnel login` fails in a headless container

The login flow wants a browser. Run it anywhere (your laptop), then copy
`~/.cloudflared/cert.pem` into the tenant. Or skip legacy mode entirely and
use a **remotely-managed tunnel** (Cloudflare dashboard → Zero Trust →
Tunnels → create → copy the token) — then the tenant only needs:

```bash
cloudflared service install <TOKEN>
```

No cert, no browser, and the ingress rules live in the dashboard. For this
repo's "one tunnel per tenant" model, remotely-managed is honestly the
smoother path — the config.yml approach in the guide is the portable/
GitOps-friendly one.

### cloudflared won't start on boot inside the tenant

If you used `cloudflared service install` as root inside the container it
made a *system* unit, but the config lives in the `app` user's home. Pick
one consistently: either a system unit pointing at
`/home/app/.cloudflared/config.yml`, or a user unit
(`systemctl --user enable cloudflared`) plus lingering.

### Ports 80/443 unreachable — is something broken?

No — that's the design working. Nothing listens publicly; all ingress rides
the tunnels. If you *need* a raw TCP port exposed (game server, mail),
Cloudflare Tunnel only proxies HTTP(S) and a few TCP protocols via
`cloudflared access` — for arbitrary TCP you'd add a targeted `ufw allow` +
Incus proxy device for just that port, accepting the tradeoff.

## Isolation & security questions

### A tenant can ping another tenant's IP — is the isolation broken?

Visibility isolation (can't *discover* the neighbor) is intact, but on a
shared bridge, tenants that somehow *learn* another tenant's IP can reach
it. If that matters for your threat model, block lateral traffic — Incus
network ACLs or one bridge per tenant (see `SECURITY.md` §2 Network).

### Can the root user inside a tenant harm the host?

Root inside an unprivileged container is idmapped to a high, unprivileged
UID on the host (check `incus config get tenant-a security.privileged` is
not `true`). It can trash *its own* container — which you restore from a
snapshot — but reaching the host requires a kernel or Incus vulnerability.
That's the residual risk livepatch + updates exist for.

### Is nesting (`security.nesting=true`) a security hole?

It relaxes some restrictions (allows mounting proc/sys inside, needed by
Docker) but the container stays unprivileged and idmapped. It's a modest,
well-understood widening, not a bypass. Do **not** combine it with
`security.privileged=true` — that combination is effectively host root.

### Why not just use Docker with userns-remap on the host, no Incus?

One shared Docker daemon means one shared view: any tenant with the socket
sees all containers, and `/proc` on the host still exposes every process.
You'd rebuild half of what Incus namespaces give you for free — and still
end up with weaker walls.

## Performance & resources

### A tenant is at 100% CPU constantly

Working as intended if it's within `limits.cpu` — that's its budget, and
neighbors are unaffected. If it's *unexpected*, treat it as a possible
compromise (cryptominer) — see the playbook in `SECURITY.md` §5.

### ZFS is eating all the host RAM

Normal: the ZFS ARC cache grows into free memory and yields it back under
pressure. But on a small VPS, cap it so tenant OOM headroom is predictable:

```bash
echo "options zfs zfs_arc_max=$((2*1024*1024*1024))" > /etc/modprobe.d/zfs.conf  # 2GiB
update-initramfs -u && reboot   # or write to /sys/module/zfs/parameters/zfs_arc_max live
```

Rule of thumb: ARC cap ≈ total RAM − sum of tenant `limits.memory` − 1–2GiB
for the host.

### Snapshots are consuming lots of disk

ZFS snapshots are copy-on-write — they only grow as data churns. Heavy
churn (databases, logs) makes 7 days of dailies expensive. Options: shorten
`snapshots.expiry` on churny tenants, exclude scratch paths from `/data`,
or move high-churn data to a volume with its own (shorter) snapshot policy.

### How many tenants fit on one VPS?

Budget backwards from RAM: each idle tenant (Ubuntu + rootless dockerd +
cloudflared) idles around 200–400MiB before its actual services. So a 16GiB
VPS realistically hosts ~4–6 tenants with 2–3GiB `limits.memory` each,
after reserving for the host and ZFS ARC. CPU oversubscribes gracefully
(cgroup weights); memory does not — never promise more total
`limits.memory` than physically exists minus host reserve.

## Operations

### How do I move a tenant to a new/bigger VPS?

`incus copy` carries the whole container — rootfs, config (limits, nesting,
devices), snapshots, and everything inside it (the `app` user, rootless
Docker, `cloudflared` with its tunnel credentials). Two things it does
**not** cover:

- The **data volume** is a separate object — copy it explicitly.
- The **new host** needs the base setup first (Incus + ZFS + firewall) —
  that's exactly the `incus_host` Ansible role: one playbook run and it's
  ready to receive tenants.

```bash
# new host: ansible-playbook site.yml (incus_host role only)
# old host:
incus remote add newbox <ip-or-name>
incus stop tenant-a
incus copy tenant-a newbox:tenant-a
incus storage volume copy default/tenant-a-data newbox:default/tenant-a-data
# new host: re-attach the volume, then start
incus config device add tenant-a data disk \
  pool=default source=tenant-a-data path=/data
incus start tenant-a
```

**Minimizing downtime**: the volume copy dominates the window. Pre-seed it
with an incremental `zfs send | ssh newbox zfs recv` while the tenant is
still running, then stop the tenant and send only the final delta — the
outage shrinks to seconds regardless of volume size.

After start, the Cloudflare Tunnel reconnects from the new box
automatically — no DNS changes, no IP reconfiguration, since tunnels are
outbound and the credentials traveled inside the container. The tenant
never knows it moved. And because it's per-tenant, you can upgrade servers
one tenant at a time — no big-bang migration.

Keep the stopped tenant on the old host until verification passes. That is
your rollback path; delete it only after the new host is serving traffic.

### Ansible run fails halfway — is it safe to re-run?

Yes. Existing containers, volumes, tenant networks, and users are detected,
and tenant limits are re-applied on every run. Re-run `site.yml` freely, but
keep reading task output: infrastructure commands can still fail if the host
was manually changed into a contradictory state, for example if the `default`
Incus pool already exists with a non-ZFS driver.

### I deleted a tenant by accident

If you snapshotted (daily schedule is on by default): the *container*
snapshots died with it, but the **data volume survives** unless you
explicitly deleted `tenant-a-data`. Recreate the container (one Ansible
entry or GUIDE.md §02) and re-attach the volume. This is why volumes and
containers are separate on purpose.
