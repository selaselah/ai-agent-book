#!/usr/bin/env bash
# Install the shared domain entry without re-enabling the retired tutor app.
set -euo pipefail
cd /disk1/langfuse
node_bin=/home/chendx/services/ai-tutor-helper/runtime/node-v24.21.0-linux-x64/bin/node
download_script=/home/chendx/services/quizboard-android-download/current/serve.py
test -x "$node_bin"
test -f "$download_script"
"$node_bin" --check gateway.mjs
sudo -n systemctl is-active --quiet quizboard-android-download.service
if sudo -n systemctl is-active --quiet ai-tutor-helper.service; then
  echo 'Retired tutor service is unexpectedly active; inspect before changing the entry.' >&2
  exit 1
fi
if [[ -f /etc/systemd/system/quizboard-android-download.service.d/20-langfuse-gateway.conf ]]; then
  echo 'Gateway already installed; use systemctl restart langfuse-gateway after editing its source.' >&2
  exit 1
fi
test ! -e /etc/systemd/system/langfuse-gateway.service
if ss -H -lnt 'sport = :3211' | read -r _; then
  echo 'Port 3211 is already in use.' >&2
  exit 1
fi
backup="/disk1/langfuse/gateway-backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 700 "$backup"
sudo -n systemctl cat quizboard-android-download.service > "$backup/download-service.txt"
curl --connect-timeout 2 --max-time 10 -fsS http://127.0.0.1:3210/android/ -o "$backup/android.html"
rollback() {
  trap - ERR HUP INT TERM
  sudo -n systemctl disable --now langfuse-gateway.service || true
  sudo -n rm -f /etc/systemd/system/langfuse-gateway.service
  sudo -n rm -f /etc/systemd/system/quizboard-android-download.service.d/20-langfuse-gateway.conf
  sudo -n systemctl daemon-reload
  sudo -n systemctl restart quizboard-android-download.service
}
trap 'rollback; exit 1' ERR HUP INT TERM
sudo -n mkdir -p /etc/systemd/system/quizboard-android-download.service.d
sudo -n tee /etc/systemd/system/quizboard-android-download.service.d/20-langfuse-gateway.conf > /dev/null <<EOF
[Service]
ExecStart=
ExecStart=/usr/bin/python3 $download_script --site /home/chendx/services/ai-tutor-helper/shared/android-download --bind 127.0.0.1 --port 3211
EOF
sudo -n tee /etc/systemd/system/langfuse-gateway.service > /dev/null <<EOF
[Unit]
Description=Langfuse and Android download domain gateway
After=network.target quizboard-android-download.service
Conflicts=ai-tutor-helper.service

[Service]
Type=simple
User=chendx
WorkingDirectory=/disk1/langfuse
ExecStart=$node_bin /disk1/langfuse/gateway.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
MemoryMax=192M
CPUQuota=100%

[Install]
WantedBy=multi-user.target
EOF
sudo -n systemctl daemon-reload
sudo -n systemctl restart quizboard-android-download.service
sudo -n systemctl enable --now langfuse-gateway.service
for attempt in {1..20}; do
  if curl --connect-timeout 2 --max-time 10 -fsS http://127.0.0.1:3210/android/ -o "$backup/android-after.html"; then break; fi
  sleep 1
done
cmp "$backup/android.html" "$backup/android-after.html"
curl --connect-timeout 2 --max-time 10 -fsS http://127.0.0.1:3210/langfuse/api/public/health > "$backup/langfuse-health.json"
test "$(curl --connect-timeout 2 --max-time 10 -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3210/02/)" = 503
trap - ERR HUP INT TERM
printf 'Gateway installed; backup: %s\n' "$backup"
