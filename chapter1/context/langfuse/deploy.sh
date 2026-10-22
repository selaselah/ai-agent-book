#!/usr/bin/env bash
set -euo pipefail

cd /disk1/langfuse
expected_commit=21931f2c29ed7d02c106de290e00b67df9049e75
test "$(git -C source rev-parse HEAD)" = "$expected_commit"
test -f .env
chmod 600 .env

export DOCKER_HOST="unix:///run/user/$(id -u)/langfuse-docker.sock"
test "$(docker info --format '{{.DockerRootDir}}')" = /disk1/langfuse/docker-data
python3 - <<'PY'
import json, os, subprocess
from pathlib import Path
ids = json.loads(Path('rootless-subids.json').read_text())
for name in ['postgres', 'clickhouse', 'clickhouse-logs', 'minio', 'redis']:
    path = Path('data') / name
    path.mkdir(parents=True, exist_ok=True)
    inside_uid = 101 if name.startswith('clickhouse') else 65532 if name == 'minio' else 0
    uid = ids['subuid'] + inside_uid - 1 if inside_uid else os.getuid()
    gid = ids['subgid'] + inside_uid - 1 if inside_uid else os.getgid()
    subprocess.run(['sudo', '-n', 'chown', str(uid) + ':' + str(gid), str(path)], check=True)
    subprocess.run(['sudo', '-n', 'chmod', '750', str(path)], check=True)
PY

compose=(docker compose -p context-lab-langfuse --env-file .env
  -f source/docker-compose.yml -f compose.override.yml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --pull missing
"${compose[@]}" ps
