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
2. Install the latest Ansible collections from ansible/requirements.yml:
   `ansible-galaxy collection install -r ansible/requirements.yml -p ansible/collections --upgrade`.
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
   sysctl hardening block, dedicated bridge per tenant, and private-egress
   tenant ACL. Treat hidepid=2 as a deliberate manual host change after
   confirming it won't break monitoring or service management.
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

## Multi-agent goal test prompt

Use this prompt to test a multi-agent workflow against a **disposable lab
VPS**. Replace every bracketed value before starting. The primary agent owns
the target and is the only agent allowed to run provisioning or cleanup
commands; supporting agents perform read-only validation unless explicitly
handed a safe, scoped command.

```
Goal: safely validate this repository's multi-tenant deployment, confirm
tenant isolation, and produce an evidence report without exposing credentials.

Repository: https://github.com/nelsudev/vps-multi-tenant-sovereign
Commit or branch: [COMMIT_OR_BRANCH]
Target: [SSH_HOST_OR_IP], user: [SSH_USER], root/sudo available
Tenants to validate: [tenant-a, tenant-b]

This is a disposable lab only. Do not use a production host, create cloud
resources without the operator's explicit cost approval, commit credentials,
or expose the target IP, inventory, keys, or tokens in evidence.

Read TEST_PLAN.md, GUIDE.md, SECURITY.md, CLAUDE.md, and
HETZNER_TEST_GUIDE.md before doing any work. Create the parent goal:
"Validate isolated multi-tenant deployment at [COMMIT_OR_BRANCH]".

Dispatch agents with these roles and model budgets:

- Luna — cheapest available general-purpose model, read-only. Maintain the
  checklist and evidence record. Do not modify code, inventories, credentials,
  or the VPS.
- Terra — cheapest available general-purpose model with shell access. Follow
  the TEST_PLAN.md steps in order: local checks, SSH preflight, apply twice,
  host validation, tenant validation, and the neighbor test. Terra may collect
  evidence and reproduce a failure, but may not change the repository or VPS
  without explicit primary-agent authorization.
- Sol — strongest available model with high reasoning effort, read-only by
  default. Do not start Sol for successful routine steps. Escalate to Sol only
  when Terra reports a `fail` or `blocked` result, conflicting evidence, an
  unexpected security-relevant result, or an unclear remediation. Sol must
  explain the likely cause from the evidence, identify the affected control,
  assess the security impact, and propose the smallest safe correction and
  exact retest commands. Sol must never suggest weakening isolation, disabling
  AppArmor, enabling privileged containers, removing mandatory limits, or
  bypassing ACL/firewall controls to obtain a pass.

The primary agent is the only agent allowed to authorize a correction, run a
mutating command against the VPS, or accept the final goal. Never allow two
agents to mutate the same VPS, inventory, or tenant state concurrently.

Execution protocol:

1. Luna creates a checklist from TEST_PLAN.md's Definition of done, recording
   owner, command, expected result, actual result, status, and evidence link
   for every item.
2. Terra runs all local checks. Any non-zero exit is `fail`; stop the dependent
   deployment step and hand Luna the output.
3. If local checks pass, Terra runs SSH preflight. Require `pong`, working
   privilege escalation, and `/sys/fs/cgroup`. Otherwise mark `blocked` or
   `fail` and escalate to Sol.
4. Only after a clean preflight, the primary agent authorizes Terra to run the
   playbook twice. A failed run, an unsupported environment, or an unexpected
   tenant restart on unchanged static netplan stops the run and triggers Sol.
5. Terra runs the TEST_PLAN.md host, tenant, and neighbor validations. A
   successful lateral ping, visible neighbour marker, privileged tenant,
   missing mandatory limit, missing private-egress ACL, or missing ZFS quota
   is a critical `fail`; do not continue to acceptance.
6. For any escalation, give Sol the failed command, exit code, relevant
   redacted output, commit, environment facts, previous successful checks,
   and recent diff. Sol returns: probable root cause; confidence and missing
   evidence; minimal safe remediation; files/host state affected; risks; and
   the exact failed and adjacent checks to rerun.
7. The primary agent either rejects Sol's recommendation or explicitly
   authorizes a narrow remediation. Terra applies only that authorized change,
   then reruns the failed check and all directly affected TEST_PLAN.md checks.
   Preserve the original failure and the retest result in the evidence record.
8. Luna marks every criterion `pass`, `fail`, or `blocked`. The primary agent
   accepts the parent goal only if all Definition-of-done criteria pass with
   evidence. A partial run is never a pass.

Report format for every handoff:

- agent role and model tier;
- assigned scope and commands run;
- expected result, actual result, status, and redacted evidence location;
- for failures: impact, probable cause, approved remediation, and retest;
- cleanup performed, including removal of temporary marker files, processes,
  and Docker containers.

Publish the consolidated report to [WIKI_PAGE_OR_REPORT_PATH]. It must include
the date, commit, lab environment, tenant scope, all handoffs, final decision,
remaining manual actions, and safe reproduction commands. It must not include
credentials, private inventory values, tokens, or target IP addresses.
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
