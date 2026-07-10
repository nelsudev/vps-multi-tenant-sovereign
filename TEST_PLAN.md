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
- UFW has routed allow rules for each tenant bridge.
- UFW has routed reject rules from each tenant bridge to peer tenant bridge
  subnets as defense in depth, while tenant ACLs still reject private lateral
  egress.
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
- DNS uses the configured public resolvers, so tenants can resolve public
  package mirrors while private lateral traffic remains rejected.
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

## 7. Subagent execution procedure (Claude Code)

Use this procedure when validation is coordinated by a primary Claude Code
agent dispatching subagents via the `Agent` tool. The names are working
roles and can be assigned to different subagent invocations for each run.

### Prompt to start the goal

Give the primary agent this goal before starting validation:

```text
Goal: safely validate this repository's multi-tenant deployment, confirm
tenant isolation, and produce an evidence report without exposing
credentials.

Dispatch subagents (via the Agent tool) with these roles:
- Luna (general-purpose, read-only, standard model/effort): maintains the
  checklist and writes the evidence report. Does not change code,
  inventories, credentials, or the VPS.
- Terra (general-purpose, full tools, standard model/effort): runs local
  checks and preflight; reproduces failures, collects evidence, and proposes
  minimal fixes. Does not apply changes without the primary agent's explicit
  authorization.
- Sol (Explore or general-purpose, read-only, highest available model and
  effort): independently reviews changes and validates critical controls:
  syntax/lint, idempotency, firewall/ACL, tenant limits, and the neighbor
  test. Sol's findings gate deployment, so under-resourcing this role is not
  an acceptable cost saving.

The primary agent itself should also run on the strongest available model,
since it owns the stop/go call on Sol's findings.

The primary agent integrates the results. Stop immediately if a critical
control fails or is blocked; report the evidence, impact, and safe next
step. Only complete the goal after every criterion in this file's
"Definition of done" section passes.
```

1. The primary agent fixes the scope: commit or branch to validate, target
   inventory, tenant list, maintenance window, and stop criterion. Do not run
   playbooks on a VPS with irreplaceable Incus state without a backup and
   rollback plan.
2. **Luna — documentation and evidence:** turns this plan into a run
   checklist and records commands, time, target, and expected versus actual
   results. Luna does not change Ansible, the inventory, or the VPS. At the
   end, Luna produces a short report that marks every check `pass`, `fail`, or
   `blocked`.
3. **Terra — diagnosis and remediation:** runs local checks first and then the
   SSH preflight. On failure, Terra reproduces it, keeps the relevant output,
   identifies the likely cause, and proposes a minimal fix. Terra changes files
   or the host only when authorized by the primary agent; after each fix, Terra
   reruns the failed check and directly affected checks.
4. **Sol — independent review:** checks the plan, Ansible configuration, and
   Terra's outputs. Sol runs or requests a second validation of critical
   controls: syntax/lint, idempotency, firewall/ACL, tenant limits, and the
   neighbor test. Alternative solutions are acceptable only when they preserve
   the isolation requirements and are documented.
5. The primary agent integrates the results. A `fail` or `blocked` critical
   control stops the apply and is reported with evidence, impact, proposed
   remediation, and the next safe command. Do not mark the run complete based
   on an untested fix.
6. Only after Luna, Terra, and Sol agree on the evidence does the primary
   agent run the **Definition of done** section and archive the report.
   Credentials, private IP addresses, Cloudflare tokens, and real inventory
   contents must never enter the report or Git.

### Responsibility matrix

| Phase | Owner | Minimum evidence | Stop rule |
| --- | --- | --- | --- |
| Local checks | Terra | output from section 1 commands | any command exits other than `0` |
| Preflight and apply | Terra | `pong`, host details, playbook output, and second run | Ansible failure or unsupported environment |
| Isolation review | Sol | ACLs, UFW, limits, neighbor test, and expected negative results | any successful lateral communication |
| Recording and reporting | Luna | completed checklist with discrepancies identified | missing evidence or sensitive data |
| Acceptance | Primary agent | complete Definition of done | any critical `fail` or `blocked` |

### Model and effort per role

| Role | Model / effort | Rationale |
| --- | --- | --- |
| Primary agent | Strongest available model | Owns the final stop/go call on Sol's findings. |
| Luna | Standard model, standard effort | Mechanical checklist/report writing, low reasoning load. |
| Terra | Standard model, standard effort | Runs and reproduces checks; diagnosis is bounded by command output. |
| Sol | Strongest available model, high effort | Gatekeeps critical isolation controls; a missed false negative here ships a security hole. |

## Definition of done

A deployment is done only when all of these checks pass:

- Static checks exit `0`: collection install, syntax check, `ansible-lint`,
  `yamllint`, shell syntax, and `git diff --check`.
- SSH preflight proves the target is reachable, privileged commands work, and
  the host has cgroups.
- The playbook completes successfully twice against the same inventory.
- The second playbook run does not restart tenants when static netplan state is
  already unchanged; a restart task marked unchanged is not enough.
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

## 8. Cloudflare tunnel handoff

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

## 9. Hetzner direct-ingress lab path

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
