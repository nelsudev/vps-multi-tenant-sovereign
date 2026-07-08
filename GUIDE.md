# Uma VPS, N tenants que nem sabem que os vizinhos existem

Guia de arquitetura + runbook manual para montar uma VPS multi-tenant com
isolamento quase-VM: cada utilizador vive no seu próprio container Incus,
corre o seu Docker rootless lá dentro, tem storage ZFS persistente e sai para
a internet pelo seu próprio Cloudflare Tunnel. Um único IP público, zero
portas abertas, zero visibilidade lateral entre tenants.

O role Ansible que automatiza a maior parte disto vive em
`infra/multi-tenant-vps/ansible/` — este documento é o desenho e a
justificação; usa-o para entender o *porquê* de cada peça, ou para provisionar
à mão se preferires.

## 00 · Porquê este desenho

Permissões Unix (users + `chmod 700`) resolvem *acesso* mas não resolvem
*visibilidade*: um processo curioso ainda enumera `/proc`, vê o
`docker.sock` global e faz `docker ps` dos vizinhos. A regra deste guia é dar
a cada tenant uma **vista de kernel separada** via namespaces completos do
Incus. Dentro do container, o vizinho não é bloqueado — ele literalmente
**não existe**.

| O que o Claude do tenant-a tenta      | Só users Linux       | Este desenho        |
|----------------------------------------|-----------------------|----------------------|
| `ps aux` / ler `/proc` dos vizinhos    | vê tudo               | não existe           |
| `docker ps` de outros serviços         | vê o sock global      | daemon isolado       |
| `ss -tulpn` / scan da rede interna     | mesma rede            | bridge própria       |
| ler ficheiros de outro tenant          | bloqueado             | outro FS/dataset     |
| escapar via kernel bug                 | mesmo namespace root  | unprivileged + idmap |

## 01 · Host — base, ZFS e Incus

Ubuntu 24.04 LTS numa VPS com KVM (não OpenVZ — precisas de kernel próprio
para nesting confiável).

```bash
apt update && apt -y full-upgrade
apt -y install zfsutils-linux

# Incus a partir do repo oficial Zabbly (mais recente que o do Ubuntu)
curl -fsSL https://pkgs.zabbly.com/key.asc | tee /etc/apt/keyrings/zabbly.asc
sh -c 'echo "deb [signed-by=/etc/apt/keyrings/zabbly.asc] \
  https://pkgs.zabbly.com/incus/stable $(. /etc/os-release; echo $VERSION_CODENAME) main" \
  > /etc/apt/sources.list.d/zabbly-incus-stable.list'
apt update && apt -y install incus incus-client

incus admin init --minimal
# cria: pool ZFS "default", bridge "incusbr0" (NAT p/ saída), profile default
```

**Porquê ZFS**: cada container ganha o seu próprio dataset. Snapshots são
instantâneos e `zfs send/receive` dá backup incremental por tenant — copias o
tenant-a sem tocar nos outros. Os volumes Docker rootless de dentro do
container vivem nesse dataset, logo entram nos snapshots automaticamente.

## 02 · Criar um tenant — container com nesting

Cada tenant é um container **unprivileged** (o root de dentro mapeia para um
UID sem privilégios no host via idmap — a rede de segurança contra escapes)
com **nesting ligado** para poder correr Docker lá dentro.

```bash
incus launch images:ubuntu/24.04 tenant-a \
  -c security.nesting=true \
  -c security.privileged=false \
  -c limits.cpu=2 \
  -c limits.memory=4GiB

incus storage volume create default tenant-a-data
incus config device add tenant-a data disk \
  pool=default source=tenant-a-data path=/data
```

Repete por tenant (`tenant-b`, `tenant-c`…) mudando só o nome e os limites.
Cada um nasce na sua própria vista: PID 1 próprio, `/proc` próprio, rede
própria na bridge com NAT.

> **O limite que mais esquecem**: sem `limits.memory` / `limits.cpu`, um
> tenant pode consumir toda a RAM e derrubar os vizinhos por OOM —
> isolamento de visibilidade não é isolamento de recursos. Define ambos
> sempre.

## 03 · Dentro do tenant — user + Docker rootless

```bash
incus exec tenant-a -- bash
# --- agora dentro do container ---
apt update && apt -y install uidmap dbus-user-session \
  docker.io docker-compose-v2 openssh-server curl

useradd -m -s /bin/bash app
loginctl enable-linger app        # serviços do user sobrevivem ao logout
install -d -o app -g app /data    # dá o volume ZFS ao user
```

Arranca o Docker **rootless** como o user `app`. Sem daemon global, sem
`/var/run/docker.sock` — o socket vive em `$XDG_RUNTIME_DIR` do próprio user.

```bash
su - app

dockerd-rootless-setuptool.sh install
systemctl --user enable --now docker
echo 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock' >> ~/.bashrc

# armazenar dados do docker no volume ZFS persistente
mkdir -p /data/docker
systemctl --user stop docker
mkdir -p ~/.config/docker
echo '{ "data-root": "/data/docker" }' > ~/.config/docker/daemon.json
systemctl --user start docker

docker run --rm hello-world # nested + rootless a funcionar
```

**Dupla parede**: Incus isola o tenant do host e dos vizinhos. Docker
rootless isola os containers do próprio init do tenant. Um `docker ps` aqui
dentro só mostra os containers do `app` — os outros tenants nem sequer têm
daemon acessível.

## 04 · Cloudflare Tunnel — um por tenant

Sem reverse proxy no host, sem portas abertas. Cada container corre o seu
próprio `cloudflared`, que abre uma ligação outbound para a Cloudflare. O
tenant-a nunca toca na config de rede do tenant-b.

```bash
# instala o cloudflared dentro do container
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
# (repo apt cloudflared) → apt install cloudflared

cloudflared tunnel login
cloudflared tunnel create tenant-a
cloudflared tunnel route dns tenant-a app-a.dominio.tld
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: tenant-a
credentials-file: /home/app/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: app-a.dominio.tld
    service: http://localhost:8080
  - service: http_status:404
```

```bash
cloudflared service install   # ou um unit em ~/.config/systemd/user/
systemctl --user enable --now cloudflared
```

**Resultado de rede**: o host não expõe uma única porta de entrada. Firewall
do host pode ficar *default-deny inbound* completo — inclusive para
HTTP/HTTPS.

## 05 · SSH — acesso sem abrir o host

- **Opção A — SSH pelo próprio Cloudflare Tunnel** (recomendada): adiciona
  uma entrada `ingress` do tipo `ssh://localhost:22` no `cloudflared` do
  tenant e liga com `cloudflared access ssh`. Protegível com Cloudflare
  Access (Zero Trust), sem abrir portas no host.
- **Opção B — jump pelo host**: `sshd` do host escuta só na LAN/WireGuard, o
  admin faz `incus exec tenant-a -- su - app`. Mais simples, mas o admin
  "vê" que é máquina partilhada.

```yaml
ingress:
  - hostname: ssh-a.dominio.tld
    service: ssh://localhost:22
  - hostname: app-a.dominio.tld
    service: http://localhost:8080
  - service: http_status:404
```

```bash
ssh -o ProxyCommand="cloudflared access ssh --hostname %h" \
  app@ssh-a.dominio.tld
```

## 06 · Storage persistente & backups

```bash
# snapshot instantâneo do container inteiro (rootfs)
incus snapshot create tenant-a pre-update

# snapshot do volume de dados
incus storage volume snapshot default tenant-a-data daily-$(date +%F)

# backup incremental off-site, só deste tenant
zfs send -i default/... default/tenant-a-data@ontem \
  | ssh backup@offsite zfs recv tank/backups/tenant-a

# retenção automática, sem cron manual
incus config set tenant-a \
  snapshots.schedule="@daily" \
  snapshots.expiry="7d"
```

## 07 · Endurecer — o teste do vizinho

Corridos como `app` dentro de um tenant, estes comandos devem **falhar em
ver seja o que for do host ou dos vizinhos**:

```bash
ps aux              # → só processos deste container
docker ps           # → só os containers do app
ss -tulpn           # → só sockets deste tenant
ip addr             # → só a interface da bridge própria
cat /proc/1/cgroup   # → não revela paths do host
ls /               # → rootfs próprio; nenhum /data de outro tenant
```

Checklist final de endurecimento do host:

- **Firewall default-deny inbound** — com Cloudflare Tunnel não precisas de
  nenhuma porta aberta (nem 80/443). SSH do host só via WireGuard, se usares
  a Opção B.
- **Confirma unprivileged** — `incus config get tenant-a
  security.privileged` tem de dar `false`/vazio.
- **Sem sudo para o `app`** — depois do provisioning, tira o user de
  qualquer grupo `sudo`.
- **Updates do host = updates de todos os kernels** — automatiza
  `unattended-upgrades` e reboots agendados; snapshots dão-te rollback.
- **Cloudflare Access à frente dos túneis** — políticas Zero Trust por
  hostname.

> **O limite honesto deste desenho**: tudo partilha um kernel. Unprivileged +
> idmap torna um escape improvável e caro, mas não impossível como uma
> microVM (Firecracker) tornaria. Para 99% dos casos — inclusive "um agente
> não pode saber do vizinho" — isto chega e sobra. Se um dia precisares de
> garantia de hardware, trocas o Incus por microVMs mantendo o mesmo padrão
> de tunnel/storage por tenant.

## 08 · Limites de recursos por tenant

Isolamento de visibilidade não é isolamento de recursos — sem limites, um
tenant esfomeado derruba os vizinhos por contenção de CPU/RAM/IO. Os limites
vivem em **cgroups v2**, aplicados pelo Incus ao container inteiro.

```bash
incus config set tenant-a limits.cpu=2              # nº de vCPUs visíveis
incus config set tenant-a limits.cpu.allowance=50%  # alternativa: % de tempo de CPU
incus config set tenant-a limits.cpu.priority=5     # peso sob contenção (1-10)
incus config set tenant-a limits.memory=4GiB        # hard cap de RAM
incus config set tenant-a limits.memory.swap=false  # sem swap p/ este tenant
incus config set tenant-a limits.processes=500      # anti fork-bomb

# throttle de I/O no device de dados
incus config device set tenant-a data limits.read=50MB limits.write=30MB
incus config device set tenant-a data limits.max=20GiB    # quota de espaço (ZFS)

# largura de banda de rede
incus config device set tenant-a eth0 limits.ingress=100Mbit limits.egress=100Mbit
```

| Limite                       | O que faz                                   | Quando usar                                  |
|-------------------------------|----------------------------------------------|-----------------------------------------------|
| `limits.cpu`                  | Fixa nº de cores que o tenant vê             | Contas previsíveis, "quase VPS"               |
| `limits.cpu.allowance`        | Vê todos os cores, consome só X%             | Bursting ocasional sem fixar nº               |
| `limits.memory`               | Hard cap de RAM; OOM local ao estourar        | Sempre — nunca deixar por definir             |
| `limits.processes`            | Teto de PIDs no container                    | Sempre — barato, evita fork-bomb              |
| device `limits.read/write`    | Throttle de IOPS/débito de disco             | Vizinho a saturar o storage partilhado        |
| device `limits.ingress/egress`| Throttle de banda de rede                    | Tenant com tráfego pesado a afetar os outros  |

**Regra prática**: `limits.memory` é a que nunca podes esquecer — sem ela, um
tenant que rebente por memória arrisca levar o host a OOM global. Prefere
`limits.cpu=N` a `allowance` quando quiseres previsibilidade tipo "este
cliente tem 2 cores", e usa `processes` como rede de segurança barata contra
fork-bombs.

Muda-se a quente, sem reiniciar o container na maioria dos casos. Dentro do
próprio tenant, o Docker rootless ainda pode sub-limitar containers
individuais (`docker run --cpus --memory`), mas isso já é o tenant a
gerir-se a si próprio, não a fronteira entre tenants.

## 09 · Ciclo de vida — o dia-a-dia

```bash
incus list                              # estado de todos os tenants
incus exec tenant-a -- su - app          # entrar num tenant
incus stop|start|restart tenant-a        # ciclo de vida
incus copy tenant-a tenant-d             # clonar → novo tenant base
incus config device set tenant-a \
  data limits.max=20GiB                    # quota de disco
incus delete tenant-a --force            # remover (snapshot antes!)
```

Adicionar o tenant N+1 é literalmente repetir a secção 02 → 05 com outro
nome — ou correr o role Ansible em `infra/multi-tenant-vps/ansible/` depois
de adicionar a entrada em `group_vars/all.yml`.
