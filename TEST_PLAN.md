# Test plan

Validation has two levels:

1. Static checks that can run in this repository without touching a VPS.
2. SSH-backed validation against a target host after the playbook runs.

Do not run the playbook against a host that has irreplaceable Incus state
until the preflight checks are clean and you have a rollback path.

## 1. Local checks

From the repository root:

```bash
ansible-galaxy collection install \
  -r ansible/requirements.yml \
  -p ansible/collections \
  --upgrade
ansible-playbook -i ansible/inventory.example.ini ansible/site.yml --syntax-check
ansible-lint ansible/site.yml
yamllint ansible .claude
bash -n ansible/roles/tenant/templates/bootstrap-app-user.sh.j2
git diff --check
```

Expected result: every command exits `0`.

## 2. SSH preflight

After receiving SSH access, create `ansible/inventory.ini` from the example
and confirm the target is reachable:

```bash
cd ansible
ansible -i inventory.ini vps_host -m ping
ansible -i inventory.ini vps_host -b -m command -a "uname -a"
ansible -i inventory.ini vps_host -b -m command -a "test -d /sys/fs/cgroup"
```

Expected result: Ansible ping returns `pong`, privilege escalation works, and
the host exposes a normal cgroup-capable Linux environment. Use a KVM VPS, not
OpenVZ.

## 3. Apply

Install the latest collection version and run the playbook:

```bash
cd ansible
ansible-galaxy collection install -r requirements.yml -p collections --upgrade
ansible-playbook -i inventory.ini site.yml
```

Expected result: the play completes without failed tasks. Re-run it once:

```bash
ansible-playbook -i inventory.ini site.yml
```

Expected result: no failed tasks. Some infrastructure commands are reported as
unchanged by design because their state is asserted immediately afterwards.

## 4. Host validation

Run on the target host as root or through Ansible:

```bash
incus storage list --format csv -c n,d
incus network get incusbr0 ipv4.nat
incus network get incusbr0 ipv6.address
incus profile device get default root pool
incus profile device get default eth0 network
ufw status verbose
ufw status numbered
systemctl is-enabled unattended-upgrades
sysctl kernel.unprivileged_bpf_disabled kernel.kptr_restrict kernel.dmesg_restrict net.ipv4.conf.all.rp_filter
```

Expected result:

- `default,zfs` exists in the storage list.
- `incusbr0` has `ipv4.nat=true` and `ipv6.address=none`.
- The default profile root pool is `default`.
- The default profile `eth0` network is `incusbr0`.
- UFW is active with incoming denied and outgoing allowed.
- UFW has routed allow rules for each tenant bridge, while tenant ACLs still
  reject private lateral egress.
- unattended-upgrades is enabled.
- sysctl values are `1`, `2`, `1`, and `1`.

## 5. Tenant validation

For every tenant in `group_vars/all.yml`, run:

```bash
tenant=tenant-a
expected_net=net-tenant-a
expected_acl="${tenant}-deny-private"

incus config get "$tenant" security.nesting
incus config get "$tenant" security.privileged
incus config get "$tenant" limits.memory
incus config get "$tenant" limits.processes
incus config device get "$tenant" eth0 network
incus config device get "$tenant" eth0 security.acls
incus exec "$tenant" -- ip -4 -o addr show eth0
incus exec "$tenant" -- resolvectl dns
incus network acl show "$expected_acl"
incus storage volume get default "${tenant}-data" size
incus config device get "$tenant" data limits.read || true
incus config device get "$tenant" data limits.write || true
incus storage volume get default "${tenant}-data" snapshots.schedule
incus exec "$tenant" -- cloudflared --version
incus exec "$tenant" -- systemctl is-active ssh
incus exec "$tenant" -- systemctl is-active docker.service docker.socket || true
incus exec "$tenant" -- su - app -c 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker info --format "{{.DockerRootDir}}"'
```

Expected result:

- `security.nesting` is `true`.
- `security.privileged` is empty or `false`.
- memory and process limits are set.
- `eth0 network` matches the tenant bridge.
- `eth0` has the static IPv4 configured for the tenant.
- resolver DNS points at the configured public DNS servers.
- `eth0 security.acls` matches `<tenant>-deny-private` when private egress
  blocking is enabled.
- the ACL has egress `reject` rules for `10.0.0.0/8`, `172.16.0.0/12`,
  and `192.168.0.0/16`.
- the ACL allows TCP and UDP DNS to the tenant bridge gateway, so the tenant
  can resolve public package mirrors while private lateral traffic remains
  rejected.
- data volume `size` matches the tenant disk quota. Disk IO
  `limits.read/write` are best-effort because current Incus versions can
  reject them on filesystem-backed custom volumes.
- data volume snapshot schedule is `@daily`.
- `cloudflared` is installed.
- tenant `sshd` is active.
- rootful Docker is inactive or missing; rootless Docker reports `/data/docker`.

## 6. Neighbor test

This test requires at least two tenants. It proves isolation with active
markers, not just by visually inspecting empty output.

Create tenant-specific filesystem, process, and Docker markers:

```bash
tenant_a=tenant-a
tenant_b=tenant-b

incus exec "$tenant_a" -- su - app -c 'printf "%s\n" tenant-a-only > /data/tenant-a-proof.txt'
incus exec "$tenant_b" -- su - app -c 'printf "%s\n" tenant-b-only > /data/tenant-b-proof.txt'

incus exec "$tenant_a" -- su - app -c 'nohup bash -lc "exec -a tenant-a-process-marker sleep 3600" >/tmp/tenant-a-process.log 2>&1 &'
incus exec "$tenant_b" -- su - app -c 'nohup bash -lc "exec -a tenant-b-process-marker sleep 3600" >/tmp/tenant-b-process.log 2>&1 &'

incus exec "$tenant_a" -- su - app -c 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker rm -f tenant-a-docker-marker >/dev/null 2>&1 || true; docker run -d --name tenant-a-docker-marker alpine:3.20 sleep 3600'
incus exec "$tenant_b" -- su - app -c 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker rm -f tenant-b-docker-marker >/dev/null 2>&1 || true; docker run -d --name tenant-b-docker-marker alpine:3.20 sleep 3600'
```

Run from inside each tenant as `app`:

```bash
tenant=tenant-a
incus exec "$tenant" -- su - app -c 'ps aux'
incus exec "$tenant" -- su - app -c 'ss -tulpn'
incus exec "$tenant" -- su - app -c 'ip -o addr'
incus exec "$tenant" -- su - app -c 'cat /proc/1/cgroup'
incus exec "$tenant" -- su - app -c 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker ps'
```

Expected result: output only shows processes, sockets, interfaces, cgroups,
and Docker containers belonging to that tenant.

Assert tenant A cannot see tenant B's active markers, and tenant B cannot see
tenant A's active markers:

```bash
incus exec "$tenant_a" -- su - app -c 'test -f /data/tenant-a-proof.txt'
incus exec "$tenant_a" -- su - app -c 'test ! -f /data/tenant-b-proof.txt'
incus exec "$tenant_a" -- su - app -c 'ps -eo args | awk "$1 == \"tenant-a-process-marker\" { found = 1 } END { exit found ? 0 : 1 }"'
incus exec "$tenant_a" -- su - app -c '! ps -eo args | awk "$1 == \"tenant-b-process-marker\" { found = 1 } END { exit found ? 0 : 1 }"'
incus exec "$tenant_a" -- su - app -c 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker ps --format "{{.Names}}" | grep -Fx tenant-a-docker-marker'
incus exec "$tenant_a" -- su - app -c 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; ! docker ps --format "{{.Names}}" | grep -Fx tenant-b-docker-marker'

incus exec "$tenant_b" -- su - app -c 'test -f /data/tenant-b-proof.txt'
incus exec "$tenant_b" -- su - app -c 'test ! -f /data/tenant-a-proof.txt'
incus exec "$tenant_b" -- su - app -c 'ps -eo args | awk "$1 == \"tenant-b-process-marker\" { found = 1 } END { exit found ? 0 : 1 }"'
incus exec "$tenant_b" -- su - app -c '! ps -eo args | awk "$1 == \"tenant-a-process-marker\" { found = 1 } END { exit found ? 0 : 1 }"'
incus exec "$tenant_b" -- su - app -c 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker ps --format "{{.Names}}" | grep -Fx tenant-b-docker-marker'
incus exec "$tenant_b" -- su - app -c 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; ! docker ps --format "{{.Names}}" | grep -Fx tenant-a-docker-marker'
```

Resolve tenant IPs and test lateral blocking:

```bash
ip_b=$(incus list "$tenant_b" -c 4 --format csv | cut -d' ' -f1)
incus exec "$tenant_a" -- ping -c 2 -W 2 "$ip_b"
```

Expected result: ping from tenant A to tenant B fails. If it succeeds, do not
accept the deployment; inspect `security.acls` on the tenant NICs and host
forwarding/firewall state.

Clean up the active markers after the assertions:

```bash
incus exec "$tenant_a" -- su - app -c 'rm -f /data/tenant-a-proof.txt; pkill -f tenant-a-process-marker || true; export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker rm -f tenant-a-docker-marker'
incus exec "$tenant_b" -- su - app -c 'rm -f /data/tenant-b-proof.txt; pkill -f tenant-b-process-marker || true; export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker rm -f tenant-b-docker-marker'
```

## Definition of done

A deployment is done only when all of these checks pass:

- Static checks exit `0`: collection install, syntax check, `ansible-lint`,
  `yamllint`, shell syntax, and `git diff --check`.
- SSH preflight proves the target is reachable, privileged commands work, and
  the host has cgroups.
- The playbook completes successfully twice against the same inventory.
- At least two tenants from `group_vars/all.yml` exist.
- Every tenant has mandatory CPU, memory, process, disk, and network limits.
- Every tenant is unprivileged and has nesting enabled.
- Every tenant has its own network bridge and expected private-egress ACL.
- Every tenant has its own ZFS-backed data volume, enforced disk quota, and
  daily snapshot schedule.
- The `app` user exists inside each tenant and rootless Docker reports
  `/data/docker`.
- Tenant A's `/data` marker file is visible from tenant A and not visible from
  tenant B; tenant B's marker file is visible from tenant B and not visible
  from tenant A.
- Tenant A's process marker is visible from tenant A and not visible from
  tenant B; tenant B's process marker is visible from tenant B and not visible
  from tenant A.
- Tenant A's Docker marker container is visible from tenant A's rootless Docker
  daemon and not visible from tenant B's daemon; tenant B's Docker marker
  container has the opposite result.
- Tenant-to-tenant ping fails.
- The selected ingress path works:
  Cloudflare Tunnel for production, or temporary `nip.io` direct ingress for
  the Hetzner lab.
- Temporary test ingress and marker resources are removed after validation.

## 7. Cloudflare tunnel handoff

The playbook installs `cloudflared` and writes a config skeleton. Tunnel
authentication remains manual:

```bash
incus exec tenant-a -- su - app
cloudflared tunnel login
cloudflared tunnel create tenant-a
cloudflared tunnel route dns tenant-a app-a.example.com
systemctl --user enable --now cloudflared
```

Expected result: `cloudflared tunnel info tenant-a` reports connected, and the
hostname routes to the tenant service.

## 8. Hetzner direct-ingress lab path

For a disposable end-to-end test without Cloudflare credentials, use
`HETZNER_TEST_GUIDE.md`. That guide creates a temporary Hetzner Cloud VPS with
an API token, runs this test plan through host/tenant/neighbor validation, then
uses `nip.io` plus temporary public HTTP ingress to prove tenant reachability.

Expected result: the Hetzner lab passes sections 1-6 above, `nip.io` resolves
to the server's public IPv4, HTTP reaches the intended tenant, and the
temporary ingress plus server are removed afterwards.

This lab does not replace section 7 for production. It intentionally opens
inbound ports, so it cannot validate the Cloudflare Tunnel no-inbound property.

## References

- Incus network ACLs:
  <https://linuxcontainers.org/incus/docs/main/howto/network_acls/>
- Incus bridge networks:
  <https://linuxcontainers.org/incus/docs/main/reference/network_bridge/>
- Hetzner Cloud API:
  <https://docs.hetzner.cloud/reference/cloud>
- `nip.io` wildcard DNS:
  <https://nip.io/>
