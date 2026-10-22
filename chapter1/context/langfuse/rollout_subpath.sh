#!/usr/bin/env bash
set -euo pipefail
cd /disk1/langfuse
export DOCKER_HOST="unix:///run/user/$(id -u)/langfuse-docker.sock"
image=context-lab/langfuse-web:4.67.0-reasoning-subpath
new_source=/disk1/langfuse/source-4.67.0
old_source=/disk1/langfuse/source-before-4.67.0
public_auth=https://ai-tutor-helper.corp.youdao.com/langfuse/api/auth
test "$(docker info --format '{{.DockerRootDir}}')" = /disk1/langfuse/docker-data
test "$(git -C "$new_source" rev-parse HEAD)" = 21931f2c29ed7d02c106de290e00b67df9049e75
test ! -e "$old_source"
# A release override is staged separately so the live configuration survives backup.
test -f compose.override-4.67.0.yml
python3 - <<'PY'
import json, subprocess
from pathlib import Path
r = json.loads(Path('build-tools/logs/build-receipt.json').read_text())
assert r['upstreamCommit'] == '21931f2c29ed7d02c106de290e00b67df9049e75'
assert r['basePath'] == '/langfuse'
assert (r['platform'], r['arch']) == ('linux', 'x64')
assert r['imageTag'] == 'context-lab/langfuse-web:4.67.0-reasoning-subpath'
assert subprocess.check_output(['docker', 'image', 'inspect', r['imageTag'], '--format', '{{.Id}}'], text=True).strip() == r['imageId']
print('Verified v4.67.0 build receipt and image ID.')
PY
bash backup_runtime.sh
backup="$(cat last-backup-path.txt)"
compose=(docker compose -p context-lab-langfuse --env-file .env
  -f "$new_source/docker-compose.yml" -f compose.override-4.67.0.yml)
previous=(docker compose -p context-lab-langfuse --env-file "$backup/.env"
  -f "$backup/source-compose.yml" -f "$backup/compose.override.yml")
candidate=context-lab-langfuse-web-subpath-check
if docker container inspect "$candidate" >/dev/null 2>&1; then
  echo 'Candidate name is already in use; inspect it before rollout.' >&2
  exit 1
fi
cleanup() { docker rm -f "$candidate" >/dev/null 2>&1 || true; }
trap cleanup EXIT
LANGFUSE_WEB_IMAGE="$image" NEXTAUTH_URL="$public_auth" NEXT_PUBLIC_BASE_PATH=/langfuse \
  "${compose[@]}" run -d --no-deps --name "$candidate" -p 127.0.0.1:3061:3000 langfuse-web
check_health() {
  local port="$1"
  for attempt in {1..90}; do
    if curl --connect-timeout 2 --max-time 10 -fsS "http://127.0.0.1:$port/langfuse/api/public/health" |
      python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="OK" and d["version"]=="4.67.0"' 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
check_health 3061
curl --connect-timeout 2 --max-time 10 -fsS http://127.0.0.1:3061/langfuse/auth/sign-in > /dev/null
cleanup
rollback() {
  trap - ERR HUP INT TERM
  cp -p "$backup/.env" .env
  cp -p "$backup/compose.override.yml" compose.override.yml
  if [[ -e "$old_source" ]]; then
    [[ ! -L source ]] || rm source
    [[ -e source ]] || mv "$old_source" source
  fi
  "${previous[@]}" up -d --no-deps --pull never langfuse-web langfuse-worker
  echo "Previous runtime restored. Additive nullable Slack columns may remain; full data backup: $backup" >&2
}
trap 'rollback; exit 1' ERR HUP INT TERM
python3 - <<'PY'
from pathlib import Path
p = Path('.env')
updates = {'LANGFUSE_WEB_IMAGE': 'context-lab/langfuse-web:4.67.0-reasoning-subpath',
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
cp -p compose.override-4.67.0.yml compose.override.yml
mv source "$old_source"
ln -s "$new_source" source
"${compose[@]}" up -d --no-deps --pull never langfuse-web langfuse-worker
check_health 3060
trap - ERR HUP INT TERM
printf 'v4.67.0 runtime healthy; consistent pre-upgrade backup: %s\n' "$backup"
