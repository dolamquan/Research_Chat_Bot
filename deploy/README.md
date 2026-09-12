# Self-hosting Zoetrope on a separate computer

This is a deliberately conventional, small deployment: Ubuntu, systemd,
Caddy, Qdrant in Docker, and a Git checkout. It does not use Vercel, Railway,
Render, Kubernetes, a PaaS, or a deployment framework.

```text
Internet -> Caddy (:443, TLS) -> static React files
                             -> /api/* -> FastAPI (127.0.0.1:8002)
FastAPI -> Qdrant (127.0.0.1:6333)
FastAPI -> SQLite and uploaded files (/opt/zoetrope/app/backend/app/data)
```

The instructions target a supported Ubuntu LTS machine with a public IP,
at least 4 CPU cores, 16 GB RAM, and an SSD. More RAM is useful when ingesting
or embedding many papers. It can also work over a private LAN; use a real
domain and HTTPS before allowing access outside that network.

## Before touching the host

1. Make the host reachable by SSH with an ordinary sudo-enabled administrator;
   disable password SSH after confirming key-based login works.
2. Assign a stable LAN address. If it will be public, forward only TCP 80 and
   443 from the router, and point the domain's DNS A/AAAA record to the public
   IP. Do **not** forward ports 8002, 6333, or 6334.
3. In Supabase Authentication, add `https://your-domain.example` as a site/
   redirect URL. If you use Notion OAuth, add
   `https://your-domain.example/api/integrations/notion/callback` there and in
   the Notion integration settings.
4. Commit and push the code you want to deploy. The host should use its own
   clean Git checkout; never deploy from a shared desktop folder.

## One-time host setup

Run the following as the host administrator. Install current supported Node,
Python, Docker Engine plus the Compose plugin, Git, rsync, and Caddy using
their official Ubuntu installation instructions. Caddy's official package is
recommended because it creates and manages its system service.

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip rsync curl ufw

sudo adduser --system --group --home /opt/zoetrope zoetrope
sudo install -d -o zoetrope -g zoetrope /opt/zoetrope /var/www/zoetrope /etc/zoetrope
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Install Docker Engine and Caddy from their official repositories, then clone
the repository as the service account and prepare its Python environment:

```bash
sudo -u zoetrope git clone <your-private-repository-url> /opt/zoetrope/app
sudo -u zoetrope python3 -m venv /opt/zoetrope/venv
sudo -u zoetrope /opt/zoetrope/venv/bin/python -m pip install --upgrade pip
sudo -u zoetrope /opt/zoetrope/venv/bin/python -m pip install -r /opt/zoetrope/app/backend/requirements.txt
```

Enable Corepack once after installing Node so the repository-pinned pnpm can
run, and install the narrowly scoped restart permission used by `deploy.sh`:

```bash
sudo corepack enable
sudo install -m 440 /opt/zoetrope/app/deploy/zoetrope-deploy.sudoers /etc/sudoers.d/zoetrope-deploy
sudo visudo -cf /etc/sudoers.d/zoetrope-deploy
```

Create `/etc/zoetrope/zoetrope.env` from `deploy/zoetrope.env.example`, fill
in the real values, then lock it down:

```bash
sudo install -m 640 -o root -g zoetrope /opt/zoetrope/app/deploy/zoetrope.env.example /etc/zoetrope/zoetrope.env
sudoedit /etc/zoetrope/zoetrope.env
```

Create `/opt/zoetrope/app/frontend/.env.production` with the public build-time
values (not server secrets):

```dotenv
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=replace_me
```

Start Qdrant. Its compose configuration binds both ports only to loopback.

```bash
cd /opt/zoetrope/app
sudo docker compose up -d qdrant
sudo docker compose ps
```

Install the API service and Caddy configuration after replacing
`your-domain.example` in the latter:

```bash
sudo install -m 644 /opt/zoetrope/app/deploy/zoetrope-api.service /etc/systemd/system/zoetrope-api.service
sudo install -m 644 /opt/zoetrope/app/deploy/Caddyfile /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now zoetrope-api caddy
```

Build and publish the frontend once. `deploy.sh` is run as the service account;
the narrowly scoped sudoers entry above lets it restart only its own API.

```bash
sudo -u zoetrope /opt/zoetrope/app/deploy/deploy.sh main
curl --fail https://your-domain.example/api/health
```

For a public hostname, Caddy will obtain and renew HTTPS certificates
automatically provided DNS is correct and ports 80/443 are publicly reachable.

## Subsequent deployments

SSH to the host and run:

```bash
sudo -u zoetrope /opt/zoetrope/app/deploy/deploy.sh main
```

Check a failure with:

```bash
sudo systemctl status zoetrope-api caddy
sudo journalctl -u zoetrope-api -n 100 --no-pager
sudo docker compose -f /opt/zoetrope/app/docker-compose.yml ps
```

## Data and backups

Back up these before updates or host maintenance:

- `/opt/zoetrope/app/backend/app/data/` — SQLite databases, uploaded PDFs,
  visual assets, and generated caches.
- The Docker volume `app_qdrant_storage` — vector index. Compose derives the
  prefix from the directory name, which is `app` for the `/opt/zoetrope/app`
  checkout; confirm with `docker volume ls` before relying on the name.
- `/etc/zoetrope/zoetrope.env` — encrypted, access-controlled copy only.

Test restoring a backup onto a non-production machine. SQLite's `.backup`
command or an application-stopped file copy is safer than copying a live
database file. The service must be stopped during a consistent file-level
backup.

## Intentional boundaries

- Only Caddy is public. FastAPI and Qdrant listen on `127.0.0.1`.
- The API systemd service is not put in the `docker` group. That avoids
  granting it effectively root-level host access. The optional Docker-backed
  paper-search and Reddit MCP integrations are consequently off by default;
  enable them only after reviewing that trade-off or isolating them separately.
- The frontend calls `/api`, so visitors never need to know the host's private
  API port. `VITE_API_URL` remains available only for an intentional custom
  API endpoint.
