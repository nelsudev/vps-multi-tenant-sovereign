# Hetzner throwaway test guide

This guide provisions a temporary Hetzner Cloud VPS with an API token, applies
the Ansible playbook, and validates the system without Cloudflare Tunnels by
using direct HTTP ingress and `nip.io` wildcard DNS.

This is a **lab path**, not the production ingress design. It proves the host,
tenant, Docker, storage, resource-limit, and neighbor-isolation pieces on a
real KVM VPS. It deliberately opens public inbound ports, so it does not prove
the "zero inbound ports" Cloudflare Tunnel property.

## 00 - What this validates

Validated:

- Hetzner Cloud can create a fresh Ubuntu 24.04 KVM VPS from an API token.
- Ansible can reach the host and provision ZFS, Incus, UFW, sysctl hardening,
  unattended upgrades, tenants, per-tenant bridges, ACLs, ZFS volumes, SSH, and
  rootless Docker.
- The playbook is idempotent when run twice.
- Each tenant only sees its own processes, sockets, interfaces, cgroups, and
  Docker daemon.
- Lateral tenant traffic is blocked by the dedicated bridge + private-egress
  ACL model.
- A tenant service can be reached from the public internet through a temporary
  direct-ingress path.

Not validated:

- Cloudflare Tunnel login, tunnel routing, or reconnect behavior.
- Cloudflare Access policies.
- The production "nothing listens publicly" model.
- HTTPS certificates for real tenant domains.

## 01 - Inputs and safety

You need:

- A Hetzner Cloud API token with read/write access to a throwaway project.
- `hcloud` installed locally.
- `jq` for reading `hcloud` JSON output.
- `dig` for checking `nip.io` DNS responses, usually from `dnsutils` or
  `bind9-dnsutils` depending on your workstation OS.
- An SSH public key already present locally, usually `~/.ssh/id_ed25519.pub`.
- Ansible and the linters from `TEST_PLAN.md`.

Keep secrets out of the repository:

```bash
export HCLOUD_TOKEN="paste-token-here"
```

Do not commit:

- `ansible/inventory.ini`
- real VPS IPs
- real SSH keys
- `.tfvars`, shell history, or notes containing `HCLOUD_TOKEN`

Use a fresh Hetzner project if possible. It makes cleanup obvious and keeps the
test away from production machines.

## 02 - Create the Hetzner VPS

List current images, locations, and server types first. Hetzner changes
offerings over time, so choose from the live lists instead of trusting an old
example.

```bash
hcloud image list --type system
hcloud location list
hcloud server-type list
```

Create or reuse an SSH key in Hetzner Cloud:

```bash
hcloud ssh-key describe sovereign-test-key >/dev/null 2>&1 || \
  hcloud ssh-key create \
  --name sovereign-test-key \
  --public-key-from-file ~/.ssh/id_ed25519.pub
```

If you use a different key name, set `TEST_SSH_KEY` to that name before server
creation.

Choose a server with enough room for Incus, ZFS, and two tenants. A 4 vCPU /
8 GiB RAM class is a practical minimum for the full two-tenant test. Smaller
instances can work for syntax and single-tenant smoke tests, but memory pressure
will make failures harder to interpret.

```bash
export TEST_SERVER_NAME="vps-sovereign-test"
export TEST_LOCATION="fsn1"
export TEST_SERVER_TYPE="cx32"
export TEST_IMAGE="ubuntu-24.04"
export TEST_SSH_KEY="sovereign-test-key"

hcloud server create \
  --name "$TEST_SERVER_NAME" \
  --type "$TEST_SERVER_TYPE" \
  --image "$TEST_IMAGE" \
  --location "$TEST_LOCATION" \
  --ssh-key "$TEST_SSH_KEY"
```

Read the public IPv4:

```bash
export PUBLIC_IPV4="$(
  hcloud server describe "$TEST_SERVER_NAME" \
    -o json | jq -r '.public_net.ipv4.ip'
)"

printf '%s\n' "$PUBLIC_IPV4"
```

Wait for SSH:

```bash
until ssh -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=5 root@"$PUBLIC_IPV4" true
do
  sleep 5
done
```

## 03 - Prepare the Ansible inventory

From the repository root:

```bash
cat > ansible/inventory.ini <<EOF
[vps_host]
vps ansible_host=${PUBLIC_IPV4} ansible_user=root
EOF
```

Review `ansible/group_vars/all.yml` before applying. For a first Hetzner test,
the checked-in two-tenant defaults are intentionally conservative:

- `tenant-a`: 2 vCPU, 4 GiB RAM, 500 processes, 20 GiB data quota
- `tenant-b`: 2 vCPU, 4 GiB RAM, 500 processes, 20 GiB data quota

If your test server has less than 8 GiB RAM, reduce the tenant memory limits
before running the playbook. Do not remove `limits.memory` or
`limits.processes`; the role intentionally refuses tenants without them.

## 04 - Run local checks

Run the repository-local checks before touching the VPS:

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

Every command should exit `0`.

## 05 - Preflight the VPS

```bash
cd ansible
ansible -i inventory.ini vps_host -m ping
ansible -i inventory.ini vps_host -b -m command -a "uname -a"
ansible -i inventory.ini vps_host -b -m command -a "test -d /sys/fs/cgroup"
cd ..
```

Expected result:

- Ansible ping returns `pong`.
- Privilege escalation works.
- The host has a normal cgroup-capable Linux environment.

Hetzner Cloud servers are KVM-backed, which is the right virtualization class
for this design.

## 06 - Apply the playbook

```bash
cd ansible
ansible-playbook -i inventory.ini site.yml
ansible-playbook -i inventory.ini site.yml
cd ..
```

Expected result:

- The first run completes without failed tasks.
- The second run completes without failed tasks.
- The second run may still report some asserted infrastructure commands as
  changed or unchanged depending on the command; failed tasks are the red line.

## 07 - Validate host and tenants

Run the full host, tenant, and neighbor validation from `TEST_PLAN.md` sections
4, 5, and 6.

At minimum:

```bash
ssh root@"$PUBLIC_IPV4" 'incus list'
ssh root@"$PUBLIC_IPV4" 'incus storage list --format csv -c n,d'
ssh root@"$PUBLIC_IPV4" 'ufw status verbose'
ssh root@"$PUBLIC_IPV4" 'sysctl kernel.unprivileged_bpf_disabled kernel.kptr_restrict kernel.dmesg_restrict net.ipv4.conf.all.rp_filter'
```

For each tenant:

```bash
tenant=tenant-a

ssh root@"$PUBLIC_IPV4" "incus config get $tenant security.nesting"
ssh root@"$PUBLIC_IPV4" "incus config get $tenant security.privileged"
ssh root@"$PUBLIC_IPV4" "incus config device get $tenant eth0 network"
ssh root@"$PUBLIC_IPV4" "incus config device get $tenant eth0 security.acls"
ssh root@"$PUBLIC_IPV4" "incus exec $tenant -- su - app -c 'export DOCKER_HOST=unix:///run/user/\$(id -u)/docker.sock; docker info --format \"{{.DockerRootDir}}\"'"
ssh root@"$PUBLIC_IPV4" "incus exec $tenant -- su - app -c 'ps aux'"
ssh root@"$PUBLIC_IPV4" "incus exec $tenant -- su - app -c 'ss -tulpn'"
ssh root@"$PUBLIC_IPV4" "incus exec $tenant -- su - app -c 'ip -o addr'"
ssh root@"$PUBLIC_IPV4" "incus exec $tenant -- su - app -c 'export DOCKER_HOST=unix:///run/user/\$(id -u)/docker.sock; docker ps'"
```

If two tenants exist, lateral traffic must fail:

```bash
tenant_a=tenant-a
tenant_b=tenant-b
ip_b="$(
  ssh root@"$PUBLIC_IPV4" \
    "incus list $tenant_b -c 4 --format csv | cut -d' ' -f1"
)"

ssh root@"$PUBLIC_IPV4" \
  "incus exec $tenant_a -- ping -c 2 -W 2 $ip_b"
```

Expected result: the ping fails. If it succeeds, stop and inspect tenant NIC
ACLs before accepting the deployment.

For the lab to count, the active-marker neighbor test from `TEST_PLAN.md`
section 6 must pass as written:

- tenant A's file marker is visible only inside tenant A.
- tenant B's file marker is visible only inside tenant B.
- tenant A's process marker is visible only from tenant A's `ps`.
- tenant B's process marker is visible only from tenant B's `ps`.
- tenant A's Docker marker container is visible only from tenant A's rootless
  Docker daemon.
- tenant B's Docker marker container is visible only from tenant B's rootless
  Docker daemon.
- tenant A cannot ping tenant B.

## 08 - Temporary direct ingress with public ports

This path is the fastest public smoke test. It opens one public port per
tenant and uses `nip.io` only as wildcard DNS.

Start a tiny HTTP service inside each tenant:

```bash
ssh root@"$PUBLIC_IPV4" "incus exec tenant-a -- su - app -lc '
  export DOCKER_HOST=unix:///run/user/\$(id -u)/docker.sock
  docker rm -f nip-smoke >/dev/null 2>&1 || true
  docker run -d --name nip-smoke --restart unless-stopped \
    -p 127.0.0.1:8080:80 nginx:alpine
'"

ssh root@"$PUBLIC_IPV4" "incus exec tenant-b -- su - app -lc '
  export DOCKER_HOST=unix:///run/user/\$(id -u)/docker.sock
  docker rm -f nip-smoke >/dev/null 2>&1 || true
  docker run -d --name nip-smoke --restart unless-stopped \
    -p 127.0.0.1:8080:80 nginx:alpine
'"
```

Expose each tenant through a host-side Incus proxy device:

```bash
ssh root@"$PUBLIC_IPV4" '
  incus config device add tenant-a public-http-18081 proxy \
    listen=tcp:0.0.0.0:18081 connect=tcp:127.0.0.1:8080 || true
  incus config device add tenant-b public-http-18082 proxy \
    listen=tcp:0.0.0.0:18082 connect=tcp:127.0.0.1:8080 || true
  ufw allow 18081/tcp
  ufw allow 18082/tcp
'
```

Validate DNS and HTTP:

```bash
dig +short "tenant-a.${PUBLIC_IPV4}.nip.io"
dig +short "tenant-b.${PUBLIC_IPV4}.nip.io"

curl -i "http://tenant-a.${PUBLIC_IPV4}.nip.io:18081/"
curl -i "http://tenant-b.${PUBLIC_IPV4}.nip.io:18082/"
```

Expected result:

- Both `dig` commands return the Hetzner public IPv4.
- Both `curl` commands return the Nginx welcome page from the correct tenant.

This proves public reachability through the host into a tenant service. It does
not preserve the production no-inbound guarantee.

## 09 - Optional host-based `nip.io` routing on port 80

If you want clean hostnames without per-tenant public ports, put Nginx on the
host and keep the Incus proxy devices bound to host loopback only.

Replace the public proxy devices:

```bash
ssh root@"$PUBLIC_IPV4" '
  incus config device remove tenant-a public-http-18081 || true
  incus config device remove tenant-b public-http-18082 || true

  incus config device add tenant-a loopback-http-18081 proxy \
    listen=tcp:127.0.0.1:18081 connect=tcp:127.0.0.1:8080 || true
  incus config device add tenant-b loopback-http-18082 proxy \
    listen=tcp:127.0.0.1:18082 connect=tcp:127.0.0.1:8080 || true

  apt-get update
  apt-get install -y nginx
  ufw allow 80/tcp
'
```

Create the temporary Nginx vhost:

```bash
ssh root@"$PUBLIC_IPV4" "cat > /etc/nginx/sites-available/sovereign-nip-test <<'EOF'
server {
    listen 80;
    server_name tenant-a.${PUBLIC_IPV4}.nip.io;

    location / {
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_pass http://127.0.0.1:18081;
    }
}

server {
    listen 80;
    server_name tenant-b.${PUBLIC_IPV4}.nip.io;

    location / {
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_pass http://127.0.0.1:18082;
    }
}
EOF
ln -sf /etc/nginx/sites-available/sovereign-nip-test /etc/nginx/sites-enabled/sovereign-nip-test
nginx -t
systemctl reload nginx"
```

Validate:

```bash
curl -i "http://tenant-a.${PUBLIC_IPV4}.nip.io/"
curl -i "http://tenant-b.${PUBLIC_IPV4}.nip.io/"
```

Expected result: each hostname reaches the matching tenant service over port
80. This is closer to a normal direct-IP deployment, but it introduces a shared
host reverse proxy that the production Cloudflare Tunnel design intentionally
avoids.

## 10 - Cleanup temporary ingress

Remove only the lab ingress path:

```bash
ssh root@"$PUBLIC_IPV4" '
  rm -f /etc/nginx/sites-enabled/sovereign-nip-test
  rm -f /etc/nginx/sites-available/sovereign-nip-test
  systemctl reload nginx || true

  ufw delete allow 80/tcp || true
  ufw delete allow 18081/tcp || true
  ufw delete allow 18082/tcp || true

  incus config device remove tenant-a public-http-18081 || true
  incus config device remove tenant-b public-http-18082 || true
  incus config device remove tenant-a loopback-http-18081 || true
  incus config device remove tenant-b loopback-http-18082 || true
'
```

Stop the demo containers:

```bash
ssh root@"$PUBLIC_IPV4" "incus exec tenant-a -- su - app -lc '
  export DOCKER_HOST=unix:///run/user/\$(id -u)/docker.sock
  docker rm -f nip-smoke
'"

ssh root@"$PUBLIC_IPV4" "incus exec tenant-b -- su - app -lc '
  export DOCKER_HOST=unix:///run/user/\$(id -u)/docker.sock
  docker rm -f nip-smoke
'"
```

Re-run the host firewall check:

```bash
ssh root@"$PUBLIC_IPV4" 'ufw status verbose'
ssh root@"$PUBLIC_IPV4" 'ss -tlnp'
```

Expected result: only the access path you deliberately kept, normally SSH for
the active Ansible session, remains publicly reachable.

## 11 - Destroy the Hetzner server

When the test is complete:

```bash
hcloud server delete "$TEST_SERVER_NAME"
```

Confirm it is gone:

```bash
hcloud server list
```

Then clean local untracked state:

```bash
rm -f ansible/inventory.ini
unset HCLOUD_TOKEN PUBLIC_IPV4 TEST_SERVER_NAME TEST_LOCATION TEST_SERVER_TYPE TEST_IMAGE TEST_SSH_KEY
```

## 12 - Acceptance criteria

Accept the lab run only when all of these are true:

- Local static checks exit `0`.
- SSH preflight exits `0`.
- The playbook exits `0` twice.
- Host validation from `TEST_PLAN.md` passes.
- Tenant validation from `TEST_PLAN.md` passes for every tenant.
- At least two tenants are provisioned.
- The active-marker neighbor test proves that files, processes, and Docker
  containers from tenant A are not visible from tenant B, and vice versa.
- Tenant-to-tenant ping fails.
- Temporary `nip.io` HTTP ingress reaches the intended tenant.
- Cleanup removes temporary public ingress.
- The Hetzner server is destroyed when the lab is no longer needed.

If any verification fails, keep the server alive only long enough to inspect
logs and state. Do not keep layering changes on top of a failed isolation test.

## References

- Hetzner Cloud API token creation:
  <https://docs.hetzner.cloud/reference/cloud>
- Hetzner `hcloud` CLI:
  <https://github.com/hetznercloud/cli>
- `nip.io` wildcard DNS:
  <https://nip.io/>
