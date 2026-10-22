#!/usr/bin/env bash
# Restore the published baseline after a bounded source-build maintenance window.
set -euo pipefail
cd /disk1/langfuse
export DOCKER_HOST="unix:///run/user/$(id -u)/langfuse-docker.sock"
unset LANGFUSE_WEB_IMAGE NEXTAUTH_URL NEXT_PUBLIC_BASE_PATH
test "$(docker info --format '{{.DockerRootDir}}')" = /disk1/langfuse/docker-data
docker compose -p context-lab-langfuse --env-file .env \
  -f source/docker-compose.yml -f compose.override.yml \
  up -d --pull never
