#!/usr/bin/env bash
# Take a consistent backup of this dedicated stack before schema migrations.
set -euo pipefail
cd /disk1/langfuse
export DOCKER_HOST="unix:///run/user/$(id -u)/langfuse-docker.sock"
test "$(docker info --format '{{.DockerRootDir}}')" = /disk1/langfuse/docker-data
compose=(docker compose -p context-lab-langfuse --env-file .env
  -f source/docker-compose.yml -f compose.override.yml)
backup="/disk1/langfuse/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p /disk1/langfuse/backups
mkdir -m 700 "$backup"
cp -p .env compose.override.yml "$backup/"
cp -p source/docker-compose.yml "$backup/source-compose.yml"
git -C source rev-parse HEAD > "$backup/source-commit.txt"
git -C source diff --binary HEAD > "$backup/source.patch"
docker inspect "$("${compose[@]}" ps -q langfuse-web)" \
  --format '{{.Image}}' > "$backup/web-image-id.txt"
docker inspect "$("${compose[@]}" ps -q langfuse-worker)" \
  --format '{{.Image}}' > "$backup/worker-image-id.txt"
restart() { "${compose[@]}" start >/dev/null; }
trap restart EXIT
"${compose[@]}" stop --timeout 60
sudo -n tar --numeric-owner -C /disk1/langfuse -czf "$backup/data.tar.gz" data
sudo -n chown "$(id -u):$(id -g)" "$backup/data.tar.gz"
chmod 600 "$backup/data.tar.gz"
tar -tzf "$backup/data.tar.gz" >/dev/null
sha256sum "$backup/data.tar.gz" > "$backup/SHA256SUMS"
restart
trap - EXIT
printf '%s\n' "$backup" > /disk1/langfuse/last-backup-path.txt
printf 'Consistent stack backup verified: %s\n' "$backup"
