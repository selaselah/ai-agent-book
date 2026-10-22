#!/usr/bin/env bash
set -euo pipefail
cd /disk1/langfuse
export DOCKER_HOST="unix:///run/user/$(id -u)/langfuse-docker.sock"
image=context-lab/langfuse-web:4.66.0-reasoning-subpath
public_auth=https://ai-tutor-helper.corp.youdao.com/langfuse/api/auth
test "$(docker info --format '{{.DockerRootDir}}')" = /disk1/langfuse/docker-data
python3 - <<'PY'
import json, subprocess
from pathlib import Path
r = json.loads(Path('build-tools/logs/build-receipt.json').read_text())
assert r['basePath'] == '/langfuse'
assert (r['platform'], r['arch']) == ('linux', 'x64')
assert r['imageTag'] == 'context-lab/langfuse-web:4.66.0-reasoning-subpath'
assert subprocess.check_output(['docker', 'image', 'inspect', r['imageTag'], '--format', '{{.Id}}'], text=True).strip() == r['imageId']
print('Verified build receipt and image ID.')
PY
compose=(docker compose -p context-lab-langfuse --env-file .env -f source/docker-compose.yml -f compose.override.yml)
candidate=context-lab-langfuse-web-subpath-check
if docker container inspect "$candidate" >/dev/null 2>&1; then
  echo 'Candidate name is already in use; inspect it before rollout.' >&2
  exit 1
fi
LANGFUSE_WEB_IMAGE="$image" NEXTAUTH_URL="$public_auth" NEXT_PUBLIC_BASE_PATH=/langfuse \
  "${compose[@]}" run -d --no-deps --name "$candidate" -p 127.0.0.1:3061:3000 langfuse-web
trap 'docker rm -f "$candidate" >/dev/null 2>&1 || true' EXIT
healthy=false
for attempt in {1..90}; do
  if curl --connect-timeout 2 --max-time 10 -fsS http://127.0.0.1:3061/langfuse/api/public/health > /dev/null; then healthy=true; break; fi
  sleep 2
done
test "$healthy" = true
curl --connect-timeout 2 --max-time 10 -fsS http://127.0.0.1:3061/langfuse/auth/sign-in > /dev/null
docker rm -f "$candidate" > /dev/null
trap - EXIT
backup="/disk1/langfuse/runtime-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup"
cp -p .env "$backup/.env"
rollback() {
  trap - ERR HUP INT TERM
  cp -p "$backup/.env" .env
  "${compose[@]}" up -d --no-deps --pull never langfuse-web langfuse-worker
}
trap 'rollback; exit 1' ERR HUP INT TERM
python3 - <<'PY'
from pathlib import Path
p = Path('.env')
updates = {'LANGFUSE_WEB_IMAGE': 'context-lab/langfuse-web:4.66.0-reasoning-subpath',
           'NEXT_PUBLIC_BASE_PATH': '/langfuse',
           'NEXTAUTH_URL': 'https://ai-tutor-helper.corp.youdao.com/langfuse/api/auth'}
lines = p.read_text().splitlines()
lines = [f'{line.split("=",1)[0]}={updates.pop(line.split("=",1)[0])}'
         if line.split('=',1)[0] in updates else line for line in lines]
lines.extend(f'{key}={value}' for key, value in updates.items())
p.write_text('\n'.join(lines) + '\n')
p.chmod(0o600)
PY
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-deps --pull never langfuse-web langfuse-worker
healthy=false
for attempt in {1..60}; do
  if curl --connect-timeout 2 --max-time 10 -fsS http://127.0.0.1:3060/langfuse/api/public/health >/dev/null; then healthy=true; break; fi
  sleep 2
done
test "$healthy" = true
trap - ERR HUP INT TERM
printf 'Subpath runtime healthy; previous environment: %s/.env\n' "$backup"
