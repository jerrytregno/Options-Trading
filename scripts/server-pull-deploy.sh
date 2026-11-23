#!/usr/bin/env bash
# Run ON THE LIGHTSAIL INSTANCE (browser SSH or ssh -i … ubuntu@HOST).
# Pulls latest main and rebuilds. Keeps .env and data/ on the server.
set -euo pipefail
cd ~/Options-Trading
git fetch origin main
git reset --hard origin/main
chmod +x deploy.sh
GIT_PULL=0 ./deploy.sh