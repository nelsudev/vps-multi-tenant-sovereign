# 🤖 Agent setup prompt

Paste this into Claude Code, Codex, or OpenCode with shell access to the
target VPS (root or sudo) to have it perform the full setup autonomously.
Fill in the bracketed values first.

---

```
You are provisioning a fresh Ubuntu 24.04 VPS to host multiple isolated
tenants, following the design in this repository:
https://github.com/nelsudev/vps-multi-tenant-sovereign

Clone it locally, then read GUIDE.md, SECURITY.md, and CLAUDE.md in full
before doing anything — they contain the reasoning behind every step, not
just the commands. The ansible/ directory automates most of it.

Target host: [SSH_HOST_OR_IP], user [SSH_USER], root/sudo available.
Tenants to create: [tenant-a, tenant-b, ...] — for each, decide sane
resource limits (cpu, memory, disk size, network bandwidth) based on what
it will run; never leave limits.memory or limits.processes unset.
Domain to use for Cloudflare Tunnel hostnames: [yourdomain.tld].

Do this:

1. Set up ansible/inventory.ini from inventory.example.ini pointing at the
   target host. Do not commit it.
2. Install the Ansible collections from ansible/requirements.yml.
3. Fill ansible/group_vars/all.yml with the tenant list above and your
   chosen limits — explain your reasoning for the limits you pick.
4. Run the incus_host role first, verify: ZFS pool exists, Incus is
   initialized, ufw is default-deny inbound with nothing listening on the
   public interface (ss -tlnp should show nothing exposed).
5. Run the tenant role for each tenant. After each one, run the neighbor
   test from GUIDE.md §07 (ps aux, docker ps, ss -tulpn, ip addr, cat
   /proc/1/cgroup, ls /) and confirm nothing leaks between tenants or to
   the host — show me the output.
6. For each tenant, stop and tell me: Cloudflare Tunnel login/creation
   needs interactive browser auth and cannot be automated. Give me the
   exact commands to run per tenant (or point me at the remotely-managed
   tunnel token flow from FAQ.md, whichever is simpler for me to execute),
   then wait for me to paste back the tunnel is live before continuing.
7. Verify the hardening from SECURITY.md §2: the Ansible defaults apply the
   sysctl hardening block and dedicated bridge per tenant. Treat hidepid=2
   as a deliberate manual host change after confirming it won't break
   monitoring or service management.
8. Verify unattended-upgrades are enabled on the host per SECURITY.md §1,
   and tell me whether this VPS is eligible for Ubuntu Pro's free tier so I
   can enable Livepatch.
9. Give me a final report: what's running, what each tenant's resource
   budget is, what still needs my manual action (tunnels, Livepatch
   token), and the exact verification commands I can re-run anytime to
   confirm isolation holds.

Follow CLAUDE.md's rules while you work if you touch the repo itself
(commit conventions, no real credentials committed, keep docs/ansible in
sync). Do not proceed past any step whose verification fails — stop and
report instead of continuing on a red check.
```

---

## Notes on using this

- **Claude Code** picks up `.claude/skills/new-tenant` and
  `.claude/skills/migrate-tenant` automatically once it's working inside a
  clone of this repo — the prompt above already points it at the repo, so
  the skills apply themselves to steps 3–4.
- **Codex / OpenCode** don't read `.claude/skills/`, but the same reasoning
  is in `GUIDE.md`/`FAQ.md` in plain prose — the prompt tells them to read
  those first, which gets you equivalent behavior without the skill
  format.
- Swap in real values for every `[bracket]` before pasting — an agent
  guessing your domain or host is how you get tunnels routed nowhere.
- The prompt deliberately makes the agent **stop and hand control back**
  for the Cloudflare login and for anything a verification step fails on —
  don't relax that if you're running this unattended.
