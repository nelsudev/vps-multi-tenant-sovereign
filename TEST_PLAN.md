# Test plan

Validation has two levels:

1. Static checks that can run in this repository without touching a VPS.
2. SSH-backed validation against a target host after the playbook runs.

Do not run the playbook against a host that has irreplaceable Incus state
until the preflight checks are clean and you have a rollback path.

## 1. Local checks

From the repository root:

```bash
cd ansible
ansible-galaxy collection install -r requirements.yml -p collections --upgrade
ansible-playbook -i inventory.example.ini site.yml --syntax-check
ansible-lint site.yml
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
systemctl is-enabled unattended-upgrades
sysctl kernel.unprivileged_bpf_disabled kernel.kptr_restrict kernel.dmesg_restrict net.ipv4.conf.all.rp_filter
```

Expected result:

- `default,zfs` exists in the storage list.
- `incusbr0` has `ipv4.nat=true` and `ipv6.address=none`.
- The default profile root pool is `default`.
- The default profile `eth0` network is `incusbr0`.
- UFW is active with incoming denied and outgoing allowed.
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
incus network acl show "$expected_acl"
incus config device get "$tenant" data limits.max
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
- `eth0 security.acls` matches `<tenant>-deny-private` when private egress
  blocking is enabled.
- the ACL has egress `reject` rules for `10.0.0.0/8`, `172.16.0.0/12`,
  and `192.168.0.0/16`.
- data volume snapshot schedule is `@daily`.
- `cloudflared` is installed.
- tenant `sshd` is active.
- rootful Docker is inactive or missing; rootless Docker reports `/data/docker`.

## 6. Neighbor test

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

If at least two tenants exist, resolve their IPs and test lateral blocking:

```bash
tenant_a=tenant-a
tenant_b=tenant-b
ip_b=$(incus list "$tenant_b" -c 4 --format csv | cut -d' ' -f1)
incus exec "$tenant_a" -- ping -c 2 -W 2 "$ip_b"
```

Expected result: ping from tenant A to tenant B fails. If it succeeds, do not
accept the deployment; inspect `security.acls` on the tenant NICs and host
forwarding/firewall state.

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
