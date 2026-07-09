# Hetzner lab test report

Date: 2026-07-09

Branch tested: `agent/hetzner-test-guide`

## Scope

This was a disposable Hetzner Cloud lab run to validate the repository on a
real KVM VPS without Cloudflare Tunnels.

Approved resources:

- Provider: Hetzner Cloud
- Server type: `cx33`
- Location: `fsn1`
- Image: Ubuntu 24.04
- Maximum approved lifetime: 3 hours
- Estimated gross price: about EUR 0.016728/hour

Actual cleanup result:

- Test server `vps-sovereign-test` was destroyed.
- Temporary Hetzner SSH key `sovereign-test-key` was deleted.
- `hcloud server list` returned no active servers after cleanup.
- Total runtime was about 1 hour, so the estimated gross cost stayed below
  EUR 0.05.

## Validation result

Overall result: passed after fixes applied during the lab.

Validated:

- Local static checks passed.
- Ansible preflight reached the VPS over SSH.
- The playbook completed successfully.
- The playbook completed successfully again on a second run.
- Two tenants were created: `tenant-a` and `tenant-b`.
- Each tenant had its own Incus bridge, data volume, static IPv4, ACL, rootless
  Docker daemon, and `app` user.
- Host firewalling, Incus NAT, unattended upgrades, and sysctl hardening were
  present.
- Direct public ingress was smoke-tested with `nip.io` and temporary ports.
- Temporary test artifacts were removed.
- The server was destroyed after validation.

## Isolation evidence

The test used active markers instead of relying on empty output.

### Files

- Created `/data/tenant-a-proof.txt` inside `tenant-a`.
- Created `/data/tenant-b-proof.txt` inside `tenant-b`.
- From `tenant-a`, tried to see the `tenant-b` file: did not work.
- From `tenant-b`, tried to see the `tenant-a` file: did not work.

Result: passed.

### Processes

- Started `tenant-a-process-marker` inside `tenant-a`.
- Started `tenant-b-process-marker` inside `tenant-b`.
- From `tenant-a`, tried to see the `tenant-b` process marker: did not work.
- From `tenant-b`, tried to see the `tenant-a` process marker: did not work.

Result: passed.

### Docker containers

- Started `tenant-a-docker-marker` in the rootless Docker daemon of `tenant-a`.
- Started `tenant-b-docker-marker` in the rootless Docker daemon of `tenant-b`.
- From `tenant-a`, tried to list the `tenant-b` Docker marker container: did
  not work.
- From `tenant-b`, tried to list the `tenant-a` Docker marker container: did
  not work.

Result: passed.

### Network

- From `tenant-a`, tried to ping the private IPv4 of `tenant-b`: did not work.
- The traffic was blocked by the tenant network isolation model.

Result: passed.

### Direct public ingress

- Started a temporary Nginx container in each tenant.
- Exposed each tenant through a temporary Incus proxy device and UFW rule.
- Resolved `tenant-a.<public-ip>.nip.io` to the VPS public IPv4.
- Resolved `tenant-b.<public-ip>.nip.io` to the VPS public IPv4.
- `tenant-a` returned HTTP `200 OK`.
- `tenant-b` returned HTTP `200 OK`.
- Removed the temporary proxy devices, UFW rules, and containers afterwards.

Result: passed.

## Failures found and fixed

These failures happened during the real Hetzner run and were fixed on the
branch.

### Incus disk IO limits rejected

Failure:

- Incus rejected direct `limits.read` and `limits.write` configuration for the
  filesystem-backed custom data volumes used in the lab.

Fix:

- The tenant role now tolerates unsupported disk IO limit keys.
- The test plan documents disk IO as best-effort for this backend.
- Disk quota remains enforced through the custom volume `size`.

Related commit:

- `a804a55 fix(ansible): tolerate unsupported disk io limits`

### Incus storage driver detection was wrong

Failure:

- The role initially read the storage driver from a command path that was not
  reliable for the active pool.

Fix:

- The role now reads the storage driver from `incus storage show`.

Related commit:

- `dda548e fix(ansible): read Incus storage driver from pool show`

### Dependent volume snapshots broke repeat runs

Failure:

- The playbook could trip over unchanged dependent volume snapshot state.

Fix:

- The role now skips unchanged dependent volume snapshots.

Related commit:

- `44e417a fix(ansible): skip unchanged dependent volume snapshots`

### Tenant storage quota was not asserted correctly

Failure:

- Tenant storage volume quota needed explicit configuration and validation.

Fix:

- The tenant role now sets the quota on each tenant storage volume.

Related commit:

- `6746824 fix(ansible): set quota on tenant storage volume`

### Tenant DNS was blocked by private egress ACLs

Failure:

- Private egress ACLs also blocked tenant DNS paths needed for package
  installation and public resolution.

Fix:

- Tenants use public DNS resolvers in the static network configuration.
- Tenant ACLs reject private CIDRs while public DNS remains reachable through
  the normal public egress path.

Related commits:

- `9073aec fix(ansible): allow tenant dns with private egress acl`
- `15cc155 fix(ansible): use public DNS for static tenant networking`

### Tenant networking needed stable static IPv4

Failure:

- Neighbor isolation and predictable validation needed stable per-tenant IPs.

Fix:

- The role now configures static tenant IPv4 addresses.

Related commit:

- `b70d802 fix(ansible): configure static tenant IPv4`

### Routed tenant bridge egress was blocked by host firewalling

Failure:

- Host UFW routed policy blocked expected outbound traffic from tenant bridges.

Fix:

- The host firewall now allows routed egress from the tenant bridges while the
  tenant ACLs still reject private lateral traffic.

Related commit:

- `968ba7d fix(ansible): allow routed tenant bridge egress`

### Routed UFW allow lacked defense in depth

Failure:

- The host UFW routed allow rule permitted egress from each tenant bridge
  broadly.
- Tenant-to-tenant isolation still depended on Incus ACL private-CIDR rejects,
  but UFW did not add a secondary block between tenant bridge subnets.

Fix:

- UFW now adds routed reject rules from each tenant bridge to peer tenant bridge
  subnets before the broad routed allow.
- Incus ACLs remain the primary tenant egress isolation control.

Related commit:

- `fix(ansible): avoid unnecessary tenant restarts`

### Static netplan restart was not truly idempotent

Failure:

- The tenant restart after static network configuration ran every playbook run.
- The task used `changed_when: false`, which hid the service interruption and
  made the second-run idempotency claim misleading.

Fix:

- The role now compares the rendered netplan content against the file inside
  the tenant.
- The netplan file is pushed only when the content differs.
- The tenant is restarted only when the netplan file changed.

Related commit:

- `fix(ansible): avoid unnecessary tenant restarts`

### Gateway DNS ACL was confusing

Failure:

- The tenant ACL allowed DNS to the tenant bridge gateway, while the netplan
  configuration used public resolvers.
- The rule was harmless in the lab but misleading for maintainers.

Fix:

- The gateway DNS allow rule was removed.
- DNS expectations now refer to the configured public resolvers.

Related commit:

- `fix(ansible): avoid unnecessary tenant restarts`

### Interrupted package configuration broke a rerun

Failure:

- An interrupted package configuration inside tenants caused later package
  tasks to fail.

Fix:

- The role now repairs interrupted package configuration before continuing.

Related commit:

- `b3f6d35 fix(ansible): repair interrupted tenant package config`

### Rootless Docker bootstrap was incomplete

Failure:

- Rootless Docker setup needed Docker CE rootless extras and a reliable systemd
  user unit path.

Fix:

- The role installs Docker CE rootless extras.
- The apt repository command was wrapped for lint-safe execution.
- The manual rootless unit was replaced with the upstream-supported setup
  path.

Related commits:

- `68ecefb fix(ansible): install Docker CE rootless extras`
- `56fd295 fix(ansible): wrap Docker apt repository command`
- `277519f fix(ansible): replace manual rootless docker unit`

### Process marker assertion had a false positive risk

Failure:

- The original process marker assertion could match its own `grep` command.

Fix:

- The test plan now uses process matching that avoids self-matching.

Related commit:

- `ddd1cd8 fix(test): avoid process marker grep self-match`

## Remaining limitations

This lab did not validate:

- Cloudflare Tunnel login, routing, reconnect behavior, or Access policies.
- The production zero-public-inbound-port property.
- HTTPS certificates for real customer domains.
- Long-running resource pressure over days or weeks.
- Backup restore drills.
- Kernel/container escape resistance beyond the configured Incus, UFW, sysctl,
  and unprivileged tenant model.

## Definition of done status

Done:

- Multiple users/tenants were created.
- Tenant A could not see tenant B files.
- Tenant A could not see tenant B processes.
- Tenant A could not see tenant B Docker containers.
- Tenant B could not see tenant A files.
- Tenant B could not see tenant A processes.
- Tenant B could not see tenant A Docker containers.
- Tenant-to-tenant private network traffic was blocked.
- Public direct ingress smoke test worked through `nip.io`.
- The disposable infrastructure was removed.

Not done in this lab:

- Cloudflare Tunnel production ingress validation.
- Restore-from-backup validation.
