#!/usr/bin/env bash
set -euo pipefail
test "$(id -un)" = chendx
cd /disk1/langfuse

# Dedicated subordinate IDs for the user namespace; retain other users' ranges.
sudo -n python3 - <<'PY'
import fcntl, json
from pathlib import Path
with open('/run/lock/context-lab-subids.lock', 'w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    paths = [Path('/etc/subuid'), Path('/etc/subgid')]
    entries = [[line.split(':') for line in p.read_text().splitlines() if line and not line.startswith('#')] for p in paths]
    occupied = [(int(e[1]), int(e[1]) + int(e[2])) for rows in entries for e in rows if len(e) == 3]
    base = 1000000
    while any(base < stop and start < base + 65536 for start, stop in occupied):
        base += 65536
    result = {}
    for path, rows in zip(paths, entries):
        old = next((e for e in rows if e[0] in ('chendx', '6351') and int(e[2]) >= 65536), None)
        if old is None:
            with path.open('a') as f:
                f.write(f'chendx:{base}:65536\n')
            result[path.name] = base
        else:
            result[path.name] = int(old[1])
    Path('/disk1/langfuse/rootless-subids.json').write_text(json.dumps(result))
PY

if ! test -u /bin/newuidmap && ! getcap /bin/newuidmap | grep -q cap_setuid; then
  sudo -n setcap cap_setuid=ep /bin/newuidmap
fi
if ! test -u /bin/newgidmap && ! getcap /bin/newgidmap | grep -q cap_setgid; then
  sudo -n setcap cap_setgid=ep /bin/newgidmap
fi
sudo -n loginctl enable-linger chendx
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
mkdir -p /home/chendx/.config/systemd/user
cat > /home/chendx/.config/systemd/user/langfuse-docker.service <<'UNIT'
[Unit]
Description=Rootless Docker for the isolated Context Lab Langfuse deployment

[Service]
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR=%t/langfuse-rootlesskit
ExecStart=/bin/dockerd-rootless.sh --host=unix://%t/langfuse-docker.sock --data-root=/disk1/langfuse/docker-data --exec-root=%t/langfuse-docker-exec --pidfile=%t/langfuse-docker.pid
Restart=on-failure
RestartSec=3
TimeoutStartSec=0
Type=notify
NotifyAccess=all
Delegate=yes
TasksMax=infinity
LimitNOFILE=1048576
KillMode=mixed

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now langfuse-docker.service
docker --host "unix://$XDG_RUNTIME_DIR/langfuse-docker.sock" info --format 'RootDir={{.DockerRootDir}} Cgroup={{.CgroupDriver}} Security={{json .SecurityOptions}}'
