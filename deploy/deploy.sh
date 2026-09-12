#!/usr/bin/env bash
# Run on the host as the `zoetrope` user after the one-time setup in
# deploy/README.md. This is a deliberately small deployment mechanism: Git,
# package installers, a static build, and systemd -- no deployment platform.
set -euo pipefail

APP_DIR=/opt/zoetrope/app
VENV_DIR=/opt/zoetrope/venv
WEB_ROOT=/var/www/zoetrope
BRANCH="${1:-main}"

cd "$APP_DIR"
git fetch origin "$BRANCH"
git switch "$BRANCH"
git pull --ff-only origin "$BRANCH"

"$VENV_DIR/bin/python" -m pip install --requirement backend/requirements.txt
# Run pnpm from inside frontend/ rather than with `--dir` from the repository
# root. Corepack resolves the pnpm version from the working directory, and the
# root package.json has no packageManager field, so `--dir` runs the newest
# pnpm and then fails ERR_PNPM_BAD_PM_VERSION against the version pinned in
# frontend/package.json.
(cd frontend && corepack pnpm install --frozen-lockfile && corepack pnpm run build)

rsync -a --delete frontend/dist/ "$WEB_ROOT/"
sudo systemctl restart zoetrope-api
curl --fail --silent --show-error http://127.0.0.1:8002/health
