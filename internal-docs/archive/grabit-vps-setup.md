# Grabit VPS Szerver Konfiguráció – Teljes Dokumentáció
> Verzió: 1.1 | Létrehozva: 2026-04-02 | Utoljára frissítve: 2026-04-21
> Cél: Következő deployment gyorsabb legyen, minden tanulság dokumentálva

## Változásnapló

| Dátum | Verzió | Változás |
|---|---|---|
| 2026-04-02 | 1.0 | Első teljes setup dokumentáció (Ubuntu 24, Caddy+Cloudflare DNS, PM2) |
| 2026-04-21 | 1.1 | **3.5 fail2ban** (brute force védelem) hozzáadva · **5.7 Caddyfile** frissítve (try_files `{path}.html`, `handle_errors` 404 fallback, trailing slash redirect, asset cache headers) · apt upgrade tanulság |

---

## 1. Szerver adatok

| Adat | Érték |
|---|---|
| Szolgáltató | Hetzner Cloud |
| Csomag | CX22 (2 vCPU, 4GB RAM, 40GB SSD) |
| OS | Ubuntu 24.04.4 LTS |
| IP | 204.168.223.30 |
| IPv6 | 2a01:4f9:c014:926f::1 |
| Hostname | grabit |
| Domain | grabit.hu |
| Wildcard | *.grabit.hu |
| DNS | Cloudflare |
| Swap | 2GB (Hetzner automatikusan létrehozta) |

---

## 2. SSH Kulcs beállítás

### 2.1 Kulcs generálás (Windows PowerShell – saját gépen)

```powershell
ssh-keygen -t ed25519 -C "grabit-vps"
# Enter → alapértelmezett hely: C:\Users\USERNAME\.ssh\id_ed25519
# Jelszó: üres (Enter)
```

Két fájl keletkezik:
```
C:\Users\USERNAME\.ssh\id_ed25519      ← PRIVÁT (soha ne add ki!)
C:\Users\USERNAME\.ssh\id_ed25519.pub  ← publikus (ez kerül a VPS-re)
```

### 2.2 Publikus kulcs megtekintése

```powershell
cat "C:\Users\USERNAME\.ssh\id_ed25519.pub"
```

### 2.3 Hetzner-en kulcs beállítás

Legjobb módszer: Hetzner Console-on a VPS rendelésekor add meg a publikus kulcsot.

Ha már fut a szerver:
```bash
ssh root@204.168.223.30  # jelszóval először
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys  # illeszd be a pub kulcsot
chmod 600 ~/.ssh/authorized_keys
```

### 2.4 Bejelentkezés

```powershell
ssh root@204.168.223.30
```

Az SSH kliens automatikusan megtalálja a kulcsot a `~\.ssh\` mappában.

---

## 3. Alap szerver setup

### 3.1 System update

```bash
apt update && apt upgrade -y
```

Rendszeres karbantartásnál (havonta ajánlott) a `DEBIAN_FRONTEND=noninteractive` biztosítja, hogy ne akadjon el kérdésnél:

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq \
  -o Dpkg::Options::='--force-confdef' \
  -o Dpkg::Options::='--force-confold'

# Reboot szükséges?
test -f /var/run/reboot-required && echo 'REBOOT NEEDED' || echo 'OK'

# Melyik service-ek használnak elavult bináris-t?
needrestart -b
```

> ⚠️ **Tanulság:** A `needrestart` output-ban `KSTA: 3` új kernel elérhetőt jelent — de ez NEM mindig azonos a `/var/run/reboot-required` flag-gel. Ha `KSTA: 3` van és `reboot-required` nincs, akkor biztonsági frissítést simán el lehet halasztani, csak a kernel lemarad. Production-ön legfeljebb havonta tervezett reboot ablakban újraindítás.

### 3.2 Alapcsomagok – ELŐSZÖR kell, mások előtt!

```bash
apt install -y curl git build-essential file
```

> ⚠️ **Tanulság:** A `file` parancs alapból nincs fent Ubuntu 24.04-en.
> A `build-essential` kell egyes npm csomagok natív fordításához.

### 3.3 Tűzfal (ufw)

```bash
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw enable          # 'y' a megerősítő kérdésnél
ufw status
```

Várt eredmény:
```
Status: active
To          Action  From
--          ------  ----
22/tcp      ALLOW   Anywhere
80/tcp      ALLOW   Anywhere
443/tcp     ALLOW   Anywhere
```

### 3.4 Swap ellenőrzés

```bash
free -h
```

> ⚠️ **Tanulság:** Hetzner CX22-n a swap automatikusan létrejön (2GB).
> Ne futtasd a `fallocate` parancsot, mert hibát ad ("Text file busy").
> Ha nincs swap:
> ```bash
> fallocate -l 2G /swapfile
> chmod 600 /swapfile
> mkswap /swapfile
> swapon /swapfile
> echo '/swapfile none swap sw 0 0' >> /etc/fstab
> ```

### 3.5 Brute force védelem (fail2ban)

> 📌 **Hozzáadva: 2026-04-21** — a `journalctl` ~5000 failed SSH login kísérletet mutatott naponta, 150+ egyedi IP-ről. A fail2ban automatikusan bannolja őket.

```bash
apt install -y fail2ban

# Saját konfig (a /etc/fail2ban/jail.conf-ot NE szerkeszd — a jail.local override-olja):
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 10m
findtime = 10m
maxretry = 5
ignoreip = 127.0.0.1/8 ::1

# SSH védelem (Ubuntu 24-en a logok journald-ben vannak — backend = systemd)
[sshd]
enabled  = true
backend  = systemd
port     = ssh
maxretry = 5
bantime  = 30m
findtime = 10m
EOF

systemctl enable --now fail2ban
systemctl restart fail2ban
```

Ellenőrzés:
```bash
fail2ban-client status              # aktív jail-ek listája
fail2ban-client status sshd         # SSH jail: aktuálisan bannolt IP-k
```

Várt kimenet induláskor (azonnal bannolja a már látható brute force IP-ket):
```
Status for the jail: sshd
|- Filter
|  |- Currently failed:  0
|  |- Total failed:      0
|  `- Journal matches:   _SYSTEMD_UNIT=sshd.service + _COMM=sshd
`- Actions
   |- Currently banned:  7
   |- Total banned:      7
   `- Banned IP list:    109.248.170.188 2.57.122.191 213.209.159.159 ...
```

> ⚠️ **Tanulság:** Ubuntu 24-en a fail2ban alapértelmezett `backend = auto` **NEM talál log fájlt**, mert az sshd logja a journald-be megy (nincs `/var/log/auth.log`). Explicit `backend = systemd` kell.

> ⚠️ **Tanulság:** A default `bantime = 10m` csak 10 percre tiltja az IP-t — a persistent attackerek visszajönnek. Az SSH jail-ben `bantime = 30m` jobb kompromisszum. Hosszabb (pl. `24h`) is OK, csak akkor a `/etc/fail2ban/paths-common.conf`-ban növelhető a ban-db méret.

Ha el akarsz tiltani egy IP-t kézzel:
```bash
fail2ban-client set sshd banip 1.2.3.4
fail2ban-client set sshd unbanip 1.2.3.4    # feloldás
```

---

## 4. Node.js + pnpm + PM2

### 4.1 Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version  # v20.x.x
```

### 4.2 pnpm + PM2

```bash
npm install -g pnpm pm2
pnpm --version  # 10.x.x
pm2 --version
```

> ⚠️ **Tanulság:** A `package.json`-ban `packageManager: pnpm@10.33.0` van.
> A GitHub Actions workflow-ban NE adj meg `version`-t a pnpm action-ben,
> mert konfliktus lesz. Helyes:
> ```yaml
> - uses: pnpm/action-setup@v4
>   # version sor NEM kell – package.json-ból veszi
> ```

---

## 5. Caddy telepítés – Cloudflare DNS plugin-nel

> ⚠️ **KRITIKUS TANULSÁG:** A wildcard SSL (`*.grabit.hu`) miatt
> DNS challenge kell. Az alap Caddy csomag csak HTTP challenge-t tud.
> Cloudflare DNS plugin-nel kell buildelni a Caddy-t.
> Az `apt install caddy` NEM elegendő wildcard SSL-hez!

### 5.1 Alap csomagok

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
```

### 5.2 Alap Caddy telepítés (először ez kell, majd lecseréljük)

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install caddy -y
```

### 5.3 Caddy lecserélése Cloudflare plugin-es verzióra

> ⚠️ **Tanulság:** A `curl` letöltés NEM megbízható (HTML-t tölt le
> bináris helyett). Az xcaddy build a megbízható módszer.

```bash
# Go telepítés (xcaddy-hoz kell)
apt install -y golang-go

# xcaddy telepítés
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest

# Caddy build Cloudflare plugin-nel (2-3 perc)
~/go/bin/xcaddy build \
  --with github.com/caddy-dns/cloudflare \
  --output /usr/bin/caddy

# Ellenőrzés – dns.providers.cloudflare-t kell látni
caddy list-modules | grep cloudflare
caddy version  # v2.x.x
```

### 5.4 Cloudflare API Token létrehozása

```
dash.cloudflare.com
→ Jobb felső sarok: profilkép → My Profile
→ Bal oldal: API Tokens
→ Create Token
→ "Edit zone DNS" template
→ Zone Resources: Include → Specific zone → grabit.hu
→ Continue to summary → Create Token
→ MÁSOLD KI (csak egyszer látható!)
```

> ⚠️ **Tanulság:** A Cloudflare domain kezelő oldalán (DNS zone)
> is van API menü – az NEM ez! A token a profilban van, nem a domainben.
> Token prefix: `cffut_...` vagy `cff_...`

### 5.5 Cloudflare token env fájl

```bash
mkdir -p /etc/caddy
nano /etc/caddy/env
```

Tartalom:
```
CLOUDFLARE_API_TOKEN=cffut_ideAteljesTokened
```

```bash
chmod 600 /etc/caddy/env
```

### 5.6 Systemd override – env fájl beolvasás

> ⚠️ **Tanulság:** Ez a lépés kritikus! Nélküle a Caddy nem látja
> a Cloudflare tokent és a wildcard SSL nem működik.

```bash
mkdir -p /etc/systemd/system/caddy.service.d
nano /etc/systemd/system/caddy.service.d/override.conf
```

Tartalom:
```
[Service]
EnvironmentFile=/etc/caddy/env
```

Ellenőrzés:
```bash
systemctl show caddy | grep EnvironmentFile
# → EnvironmentFiles=/etc/caddy/env (ignore_errors=no)
```

### 5.7 Caddyfile konfiguráció

> 📌 **Frissítve 2026-04-21** — try_files `{path}.html` próbálkozással, `handle_errors` 404 fallbackkel, trailing slash redirect-tel és asset cache header-ekkel.

```bash
nano /etc/caddy/Caddyfile
```

Tartalom (production-ben érvényes):
```
grabit.hu {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }

    # SvelteKit app route-ok: auth + API + kliens assets
    @app path /login* /register* /logout* /cancel/* /api/* /_app/* /superadmin*
    handle @app {
        reverse_proxy localhost:3000
    }

    # Trailing slash redirect: /kalkulatorok/ → /kalkulatorok (301)
    @trailing path_regexp trailing ^(.+)/$
    handle @trailing {
        redir {re.trailing.1} 301
    }

    # Astro immutable assets (1 év cache, hash-elt fájlnevek)
    handle /_astro/* {
        header Cache-Control "public, max-age=31536000, immutable"
        root * /var/www/grabit/apps/landing/dist
        file_server
    }

    # Fontok (1 év cache)
    handle /fonts/* {
        header Cache-Control "public, max-age=31536000, immutable"
        root * /var/www/grabit/apps/landing/dist
        file_server
    }

    # Minden más statikus oldal (Astro SSG `build.format: 'file'`)
    handle {
        rewrite /sitemap.xml /sitemap-index.xml
        root * /var/www/grabit/apps/landing/dist
        try_files {path} {path}.html {path}/index.html
        file_server
    }

    # 404 fallback: nem létező URL → custom /404.html, HTTP 404-gyel
    handle_errors {
        @404 expression {err.status_code} == 404
        handle @404 {
            root * /var/www/grabit/apps/landing/dist
            rewrite * /404.html
            file_server
        }
    }
}

# Minden tenant subdomain → SvelteKit app
*.grabit.hu {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    reverse_proxy localhost:3000
}
```

> ⚠️ **Tanulság:** Mindkét blokkban (`grabit.hu` és `*.grabit.hu`)
> kell a `tls { dns cloudflare ... }` blokk!
> Ha csak az egyikből hiányzik, a wildcard SSL nem működik.

#### 5.7.1 try_files logika

Astro `build.format: 'file'` miatt `src/pages/foo/index.astro` a `dist/foo.html`-ként generálódik (nem `dist/foo/index.html`). A try_files chain 3 próbálkozása:

| Próba | Példa: `/v2` | Példa: `/kalkulatorok` |
|---|---|---|
| `{path}` — pontos fájl | `/v2` ❌ | `/kalkulatorok` ❌ |
| `{path}.html` — Astro file format | `/v2.html` ✓ | `/kalkulatorok.html` ✓ |
| `{path}/index.html` — hagyományos | — | (fallback) |

Ha egyik sem létezik → `file_server` 404-et ad → `handle_errors` elkapja → `/404.html` 404-es státusszal.

> ⚠️ **Korábbi bug (2026-04-21 előtt):** a try_files végén `/index.html` volt fallback-ként. Minden nem létező URL `200` + főoldal HTML-t adott vissza. SEO szempontból katasztrófa (duplikált tartalom), és ügyfelek is panaszkodtak, hogy "a /v2 a főoldalt adja".

#### 5.7.2 Caddy validate + reload

```bash
# Konfig szintaktikai ellenőrzés (a DNS provider env.* validálás fail-elhet — ez OK, nem igazi hiba)
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Graceful reload (nincs kiesés)
systemctl reload caddy

# Logok
journalctl -u caddy --since '1 min ago' --no-pager | tail
```

#### 5.7.3 Tesztek deploy után

```bash
# Valódi oldal → 200
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://grabit.hu/v2
# → HTTP 200

# Nem létező URL → 404 (nem 200 + főoldal!)
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://grabit.hu/blablabla
# → HTTP 404
```

### 5.8 Caddy indítás

```bash
systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy
journalctl -u caddy -f
```

Sikeres SSL szerzés esetén a logban:
```
"msg":"certificate obtained successfully","identifier":"*.grabit.hu"
```

### 5.9 Wildcard SSL ellenőrzés

```bash
curl -I https://grabit.hu
# → HTTP/2 200 vagy 404 (ha nincs még app)

curl -I https://teszt.grabit.hu
# → HTTP/2 200 vagy 502 (ha app nem fut)
```

> ⚠️ **Tanulság:** `404` és `502` is HELYES fejlesztés közben –
> azt jelenti a HTTPS működik. `000` vagy connection refused = probléma.

---

## 6. DNS beállítás (Cloudflare)

```
dash.cloudflare.com → grabit.hu → DNS → Records

Típus  Név    Érték              Proxy
A      @      204.168.223.30     DNS only (szürke felhő!)
A      *      204.168.223.30     DNS only (szürke felhő!)
```

> ⚠️ **KRITIKUS:** A Cloudflare proxy (narancssárga felhő) KIKAPCSOLVA
> kell legyen! Ha be van kapcsolva, a Caddy nem tud
> Let's Encrypt tanúsítványt szerezni.
> TTL: fejlesztés közben 1-300 másodperc, élesítésnél 3600.

---

## 7. Git repo + alkalmazás

### 7.1 App könyvtár + klónozás

```bash
mkdir -p /var/www/grabit
cd /var/www/grabit
git clone https://github.com/monooleate/grabit.git .
```

> ⚠️ **Tanulság:** GitHub jelszó helyett Personal Access Token kell.
> ```
> github.com → Settings → Developer settings
> → Personal access tokens → Tokens (classic)
> → Generate new token (classic)
> → Scope: repo ✓
> → Token: ghp_... (csak egyszer látható!)
> ```
> Beillesztéskor a terminál nem mutat karaktereket – ez normális.
> Windows-on: jobb klikk → Paste a terminálban.

### 7.2 Környezeti változók

```bash
cp .env.example apps/app/.env
nano apps/app/.env
```

Kitöltendő értékek:
```bash
PUBLIC_APP_DOMAIN=grabit.hu
PUBLIC_APP_URL=https://grabit.hu

PUBLIC_SUPABASE_URL=https://xxx.supabase.co
PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SECRET_KEY=eyJ...

RESEND_API_KEY=re_xxx
RESEND_FROM_EMAIL=noreply@grabit.hu

BARION_POS_KEY=xxx
BARION_PIXEL_ID=xxx
BARION_API_URL=https://api.test.barion.com  # sandbox!

SZAMLAZZ_AGENT_KEY=xxx
```

> ⚠️ **Tanulság:** `PUBLIC_APP_DOMAIN` és `PUBLIC_APP_URL` fontos!
> Fejlesztésben `localhost`, prod-on `grabit.hu` kell.

### 7.3 pnpm install

```bash
pnpm install
```

Ha `sharp` figyelmeztetés jelenik meg:
```bash
pnpm approve-builds
# Válaszd ki a sharp-ot (space), majd Enter
pnpm install
```

### 7.4 Build

```bash
pnpm build
```

Sikeres build esetén:
```
Tasks:    2 successful, 2 total
Time:     ~12s
```

> ⚠️ **Tanulság:** A landing és az app egyszerre épül a turbo build-del.
> `pnpm --filter landing build` külön nem szükséges ha `pnpm build` lefut.

Landing build ellenőrzés:
```bash
ls apps/landing/dist
# → _astro  index.html  kalkulatorok  sitemap-0.xml  sitemap-index.xml  utmutatok
```

### 7.5 PM2 indítás

```bash
cd /var/www/grabit
pm2 start apps/app/build/index.js \
  --name grabit-app \
  --max-memory-restart 512M \
  -- --port 3000

pm2 save
pm2 startup
```

> ⚠️ **Tanulság:** Env változók frissítése után:
> ```bash
> pm2 restart grabit-app --update-env
> ```

PM2 státusz ellenőrzés:
```bash
pm2 status
pm2 logs grabit-app --lines 20
```

Sikeres indulás esetén:
```
0|grabit-app | Listening on http://0.0.0.0:3000
```

---

## 8. GitHub Actions CI/CD

### 8.1 GitHub Secrets beállítás

```
github.com → monooleate/grabit → Settings
→ Secrets and variables → Actions
→ New repository secret
```

| Secret | Érték |
|---|---|
| `VPS_HOST` | `204.168.223.30` |
| `VPS_USER` | `root` |
| `VPS_SSH_KEY` | Privát kulcs teljes tartalma |

Privát kulcs lekérése (Windows PowerShell):
```powershell
cat "C:\Users\USERNAME\.ssh\id_ed25519"
```
`-----BEGIN OPENSSH PRIVATE KEY-----`-tól `-----END OPENSSH PRIVATE KEY-----`-ig mindent.

### 8.2 deploy.yml

```yaml
name: Deploy to VPS

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to VPS
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /var/www/grabit
            git pull origin main
            pnpm install --frozen-lockfile
            pnpm build
            pm2 restart grabit-app || pm2 start apps/app/build/index.js --name grabit-app
            pm2 save
```

> ⚠️ **KRITIKUS TANULSÁGOK:**
>
> 1. A build NE a GitHub Actions runner-en fusson, hanem a VPS-en!
>    A runner nem ismeri a `.env` változókat → build hiba.
>
> 2. pnpm action-ben NE add meg a verziót ha `packageManager` van
>    a `package.json`-ban → konfliktus hiba:
>    ```yaml
>    # HELYES:
>    - uses: pnpm/action-setup@v4
>    # HELYTELEN:
>    - uses: pnpm/action-setup@v4
>      with:
>        version: 10  # ← NE add meg!
>    ```
>
> 3. Repo útvonalak grabit-ra igazítva (NEM bookly):
>    ```
>    cd /var/www/grabit
>    pm2 restart grabit-app
>    ```

---

## 9. Supabase

### 9.1 Séma futtatás

```
supabase.com → Dashboard → projekt → SQL Editor
→ New query → SCHEMA.sql tartalmát bemásolni → Run
```

### 9.2 Supabase adatok megkeresése

```
supabase.com → projekt → Settings → API
→ Project URL: PUBLIC_SUPABASE_URL
→ anon key: PUBLIC_SUPABASE_ANON_KEY
→ service_role key: SUPABASE_SECRET_KEY (NE expozáld!)
```

---

## 10. Hasznos parancsok

### App kezelés
```bash
pm2 status                      # státusz
pm2 logs grabit-app --lines 50  # logok
pm2 restart grabit-app          # újraindítás
pm2 restart grabit-app --update-env  # env változás után
pm2 monit                       # valós idejű CPU/RAM
```

### Caddy kezelés
```bash
systemctl status caddy
systemctl restart caddy
systemctl reload caddy           # konfig újratöltés (no downtime)
journalctl -u caddy -f          # valós idejű logok
journalctl -u caddy --since "1h ago"
caddy validate --config /etc/caddy/Caddyfile  # szintaxis ellenőrzés
```

### SSL ellenőrzés
```bash
curl -I https://grabit.hu
curl -I https://teszt.grabit.hu
caddy list-modules | grep cloudflare  # plugin ellenőrzés
```

### Rendszer
```bash
htop          # CPU, RAM
df -h         # lemez
free -h       # memória
ufw status    # tűzfal
```

### Biztonság (fail2ban)
```bash
fail2ban-client status              # aktív jail-ek
fail2ban-client status sshd         # SSH jail: bannolt IP-k
fail2ban-client set sshd unbanip X.X.X.X   # kézi feloldás

# Brute force volumene 24 órában
journalctl --since '24h ago' _SYSTEMD_UNIT=ssh.service | \
  grep -c 'Failed password\|Invalid user'

# Egyedi támadó IP-k (ma)
journalctl --since 'today' _SYSTEMD_UNIT=ssh.service | \
  grep -oE 'from [0-9.]+' | sort -u | wc -l
```

### Manuális deploy (ha CI/CD nem elérhető)
```bash
cd /var/www/grabit
git pull origin main
pnpm install --frozen-lockfile
pnpm build
pm2 restart grabit-app
```

---

## 11. Fontos fájlok helye

| Fájl | Elérési út |
|---|---|
| Caddyfile | `/etc/caddy/Caddyfile` |
| Caddy env (token) | `/etc/caddy/env` |
| Caddy systemd override | `/etc/systemd/system/caddy.service.d/override.conf` |
| App könyvtár | `/var/www/grabit/` |
| App env | `/var/www/grabit/apps/app/.env` |
| Landing dist | `/var/www/grabit/apps/landing/dist/` |
| PM2 konfig | `/root/.pm2/` |
| SSH kulcs | `~/.ssh/authorized_keys` |

---

## 12. Hibakeresési útmutató

### Caddy nem indul
```bash
caddy validate --config /etc/caddy/Caddyfile
journalctl -u caddy | tail -50
```

### Wildcard SSL nem működik
Ellenőrzőlista:
1. `caddy list-modules | grep cloudflare` → `dns.providers.cloudflare` kell
2. `cat /etc/caddy/env` → token megvan?
3. `cat /etc/systemd/system/caddy.service.d/override.conf` → EnvironmentFile sor megvan?
4. `systemctl show caddy | grep EnvironmentFile` → betöltődött?
5. Cloudflare DNS: proxy KI van-e kapcsolva? (szürke felhő)
6. Caddyfile: mindkét blokkban van `tls { dns cloudflare ... }`?

### App nem indul
```bash
pm2 logs grabit-app --lines 50
node apps/app/build/index.js  # direkt futtatás debug-hoz
```

### 502 Bad Gateway
```bash
pm2 status  # grabit-app online-e?
curl http://localhost:3000  # app fut-e?
```

### GitHub Actions build hiba
- `PUBLIC_SUPABASE_URL is not exported` → build a VPS-en kell futni, ne a runner-en
- `Multiple versions of pnpm` → töröld a `version:` sort a pnpm action-ből
- `bookly` hivatkozás → cseréld `grabit`-ra a deploy.yml-ben

---

## 13. Reboot teszt

```bash
reboot
# 30 másodperc várakozás
ssh root@204.168.223.30
pm2 status          # grabit-app online kell legyen
curl -I https://grabit.hu  # HTTP/2 200
```

---

## 14. Következő deployment – gyors checklist

```
[ ] Hetzner VPS rendelés (CX22, Ubuntu 24.04)
[ ] SSH kulcs generálás + beállítás
[ ] apt update && apt upgrade -y
[ ] apt install -y curl git build-essential file
[ ] ufw: 22, 80, 443 allow + enable
[ ] Node.js 20 + pnpm + PM2
[ ] apt install -y golang-go
[ ] xcaddy build --with github.com/caddy-dns/cloudflare
[ ] caddy list-modules | grep cloudflare ← ellenőrzés!
[ ] /etc/caddy/env létrehozás (Cloudflare token)
[ ] /etc/systemd/system/caddy.service.d/override.conf
[ ] systemctl show caddy | grep EnvironmentFile ← ellenőrzés!
[ ] Caddyfile – mindkét blokkban tls { dns cloudflare }
[ ] systemctl daemon-reload && enable && restart
[ ] DNS: A + wildcard A → VPS IP, Cloudflare proxy KI
[ ] curl -I https://DOMAIN.hu ← SSL ellenőrzés
[ ] git clone + .env kitöltés
[ ] pnpm approve-builds (sharp)
[ ] pnpm install && pnpm build
[ ] pm2 start + save + startup
[ ] GitHub Secrets: VPS_HOST, VPS_USER, VPS_SSH_KEY
[ ] deploy.yml: build a VPS-en, pnpm version NEM megadva
[ ] git push → GitHub Actions ← CI/CD teszt
[ ] Supabase SCHEMA.sql futtatás
[ ] reboot teszt
```

---

## 15. Időbecslés következő deploymentre

| Lépés | Idő |
|---|---|
| VPS rendelés + SSH | 5 perc |
| Alap setup (apt, ufw, Node) | 10 perc |
| xcaddy build | 5 perc |
| Caddy konfig + SSL | 10 perc |
| DNS beállítás | 5 perc |
| App telepítés + build | 10 perc |
| GitHub Actions + Supabase | 10 perc |
| **Összesen** | **~55 perc** |

Az első alkalommal 3+ óra volt a tanulással együtt.
A dokumentáció alapján következőre ~1 óra.
