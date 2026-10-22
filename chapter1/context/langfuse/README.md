# Langfuse deployment and historical experiment import

Target: `chendx@miniboard-dev1.ycs.ynode.cn`, accessed using the existing `tsh` login.

- Official Langfuse release: `v4.66.0`
- Source commit: `29a40eb027c5f4bb8c72c2f6d2d7e98aa1ce0cbf`
- Source checkout: `/disk1/langfuse/source`
- Compose project: `context-lab-langfuse`
- UI: https://ai-tutor-helper.corp.youdao.com/langfuse
- Blob API: port `9060`; database/Redis/worker ports are not published.
- State: `/disk1/langfuse/data/`; bootstrap and service secrets: `/disk1/langfuse/.env` (mode 600).
- Dedicated rootless Docker image store: `/disk1/langfuse/docker-data`; user service `langfuse-docker.service` with lingering enabled for startup after reboot.

`compose.override.yml` layers isolated ports, data-disk volumes, memory limits and log rotation on top of the official Compose file. It disables public signup and the in-app AI agent. No company model API credential is required or copied to this deployment.

The source patch is saved in `patches/reasoning-content.patch`. The immutable
[2026-10-22 release record](releases/2026-10-22/README.md) includes the experiment
evidence, sanitized import identifiers, build receipts and verification results.
These tracked files can be restored from Git without the ignored `.source`,
`.import` or `.builder-vm` directories. For a fresh instance, copy `env.example`
to `.env` and replace all placeholders; retain existing secrets when updating an
existing instance. Credentials and build caches remain Git-ignored.

## Access

Open https://ai-tutor-helper.corp.youdao.com/langfuse using the existing account.
The local `.login.txt` contains its current URL, account and password (mode 600,
Git-ignored). A workstation tunnel is no longer needed for normal access.
The public API/SDK base URL is the same URL including `/langfuse`.

For private health diagnostics, an authenticated Teleport forward is available:

```bash
tsh ssh -N -L 127.0.0.1:8762:127.0.0.1:3060 chendx@miniboard-dev1.ycs.ynode.cn
```

Its health URL is `http://127.0.0.1:8762/langfuse/api/public/health`.
Use the public HTTPS entry for normal sign-in. Old root-path URLs on port 8762
must be replaced with the new subpath URLs.

The HTTPS rollout was verified on 2026-10-22: existing-account login, trace details
and expanded Formatted Thinking work through `/langfuse`. Read-only verification
matches the previous baseline exactly: five experiments, 51 observations, 25
scores and 23,302 tokens. No experiment was rerun or re-imported. Android downloads
remain available and the retired competition services remain disabled.

Deployment was verified on 2026-10-21: all six application containers running, the four backing services healthy, and `/api/public/health` reporting version `4.66.0`. All 51 imported observations' inputs, outputs and parent relationships match the source evidence exactly; the 17 generation observations total 23,302 tokens. The five experiments and 25 scores were read back successfully. The 17 pre-existing shared-Docker containers remain running, and the existing HTTP services on ports 80, 8020 and 10080 still return 200.

## Provision and launch

Clone the official release into the source directory and verify the commit above. Retain the existing `.env`; regenerating credentials would break access to existing state. Copy these deployment files into `/disk1/langfuse/` and run:

```bash
cd /disk1/langfuse
bash setup_rootless.sh # once; requires slirp4netns and fuse-overlayfs
python3 -u pull_images.py
bash deploy.sh
```

The image helper uses the host's existing HTTP proxy at `127.0.0.1:18080` to download archives onto the data disk, verifies the archived config against the registry digest, and checks the loaded platform, layer diff IDs and runtime configuration. It uses only the dedicated rootless daemon and never restarts or reconfigures the shared Docker daemon. `image-receipt.json` records exact digests. Data filesystem free space is checked before loading images.

Rootless setup adds an unused subordinate UID/GID range for `chendx`, enables its user-service lingering, and installs only the dedicated `~/.config/systemd/user/langfuse-docker.service`. The pre-existing `newuidmap`/`newgidmap` capabilities are retained. `rootless-subids.json` records the mapping, and the deployment script translates ClickHouse/MinIO volume ownership into that user namespace. Cgroup v2 plus systemd enforces the Compose memory limits. The default Docker context is unchanged; to inspect this instance explicitly:

```bash
export DOCKER_HOST="unix:///run/user/$(id -u)/langfuse-docker.sock"
docker compose -p context-lab-langfuse --env-file /disk1/langfuse/.env \
  -f /disk1/langfuse/source/docker-compose.yml \
  -f /disk1/langfuse/compose.override.yml ps
```

The helper binary is `crane` from Google's `go-containerregistry` release `v0.22.1`; archive SHA-256: `0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0`.

## Formatted reasoning support

`patches/reasoning-content.patch` adds OpenAI-compatible Chat Completions
`reasoning_content` to the existing Formatted **Thinking** sections. The
normalizer handles both input history and output, ignores empty values, and
preserves the raw source data. Existing traces need no re-import. The patch also
contains parser and UI-projection regression tests.

Apply the patch once to the pinned checkout, then use `build_web.sh` on the Linux
host to build a complete frontend. The helper pins Node 24.21.0 and pnpm 12.8.2,
checks the upstream commit and allowed source changes, rejects runtime `.env`
files in the build source, and packages fresh standalone output over the verified
official runtime. It records the source hash, build ID and image ID in
`build-tools/logs/build-receipt.json`. It never edits compiled JavaScript.

```bash
git -C /disk1/langfuse/source apply /disk1/langfuse/patches/reasoning-content.patch
bash /disk1/langfuse/build_web.sh bootstrap
bash /disk1/langfuse/build_web.sh install
# Run on a Linux builder with enough memory (24GB recommended).
export NEXT_PUBLIC_BASE_PATH=/langfuse
export LANGFUSE_BUILD_BUNDLER=turbopack LANGFUSE_BUILD_MEMORY_SAVER=true
export LANGFUSE_BUILD_HEAP_MB=16384 LANGFUSE_BUILD_THREADS=2 CIRCLE_NODE_TOTAL=2
export HTTP_PROXY=http://127.0.0.1:18080 HTTPS_PROXY=http://127.0.0.1:18080 NODE_USE_ENV_PROXY=1
bash /disk1/langfuse/build_web.sh build
export LANGFUSE_WEB_IMAGE=context-lab/langfuse-web:4.66.0-reasoning-subpath
bash /disk1/langfuse/build_web.sh image
```

The optional memory-saver flag enables Next's Webpack memory optimization and
disables browser/Sentry source-map generation for this build. Without the flag,
the upstream source-map and compiler defaults remain intact. Type checking and
the production client-bundle scan still run.

Webpack exhausted even a 16GB V8 heap. The default Turbopack compiler completes
optimization with much less memory; use it for this source version. Shared-host
attempts were abandoned because its 8GB build limit and managed swap policy
could not provide reliable build memory. All temporary swap, cron guard and
kernel adjustments were cleaned up, and the six baseline containers restored.
No other Compose project or Docker daemon was stopped.

The isolated builder is a Lima VZ/Rosetta Linux VM (24GB RAM, eight CPUs) running
a Linux **amd64** container with a 21GB resident limit, 16GB V8 heap and 8GB
temporary guest swap. Source paths remain `/disk1/langfuse/source`; Node, pnpm,
dependencies and generated native modules are all Linux x64. No ARM64/Darwin
native output is mixed into the image. Only an isolated share directory is
mounted, with no home directory or credentials. Builder state is Git-ignored
under `.builder-vm/`; the VM can be stopped after verified artifacts are copied
back to the deployment host. The helper validates and records Linux/x64 in its
build receipt.

The subpath image is `context-lab/langfuse-web:4.66.0-reasoning-subpath`, selected with
`LANGFUSE_WEB_IMAGE` in the deployment `.env`. Worker and backing services retain
their official images. Keep a previously verified subpath image for future web
rollbacks. The original `docker.langfuse.com/langfuse/langfuse:4.66.0` serves the
root path and cannot replace the subpath image behind this gateway.
`restore_runtime.sh` starts the runtime selected by the private `.env`, so a
failed future build cannot silently replace the deployed subpath image.
There are no database or experiment-data changes in this patch.

## Shared HTTPS domain

The public entry is `https://ai-tutor-helper.corp.youdao.com/langfuse`.
Langfuse's [custom base-path configuration](https://langfuse.com/self-hosting/configuration/custom-base-path)
requires rebuilding the frontend with `NEXT_PUBLIC_BASE_PATH=/langfuse` and
setting `NEXTAUTH_URL=https://ai-tutor-helper.corp.youdao.com/langfuse/api/auth`.
The build receipt and packaging step check the embedded path.

`rollout_subpath.sh` checks the build receipt/image, starts a temporary candidate
on localhost 3061, checks health and sign-in, then updates the private environment
and recreates web/worker. It restores the previous environment/runtime if the
health check fails. Backing services and imported observations are reused.

`gateway.mjs` streams `/langfuse` requests unchanged to localhost 3060. It forwards
`/android` to the existing download service on localhost 3211. Other routes
continue to return 503, preserving the retired competition deployments.
`install_gateway.sh` installs `langfuse-gateway.service` on port 3210 and a
download-service drop-in that moves its listener to localhost 3211. The download
script, site content and release pointers are unchanged. The installer compares
the download page before/after and rolls back on failure. It does not start
`ai-tutor-helper.service`.

After copying the updated override and helpers to `/disk1/langfuse`:

```bash
bash /disk1/langfuse/rollout_subpath.sh
bash /disk1/langfuse/install_gateway.sh # first installation only
```

For gateway rollback, disable/stop `langfuse-gateway.service`, remove only
`/etc/systemd/system/quizboard-android-download.service.d/20-langfuse-gateway.conf`,
run `systemctl daemon-reload`, then restart `quizboard-android-download.service`.
This returns Android downloads to their original port 3210. The tutor service
must remain disabled. The gateway service uses the pre-existing Node runtime
under `/home/chendx/services/ai-tutor-helper/runtime/`.

Verify existing data with the read-only helper; do not re-import to update the UI:

```bash
python3 chapter1/context/langfuse/verify_stored_evidence.py \
  --base-url https://ai-tutor-helper.corp.youdao.com/langfuse
node --test chapter1/context/langfuse/gateway.test.mjs
```

## Import Experiment 1-1

Preview locally, without sending data:

```bash
.venv/bin/python chapter1/context/langfuse/import_evidence.py \
  --evidence chapter1/context/validation/newapi_20261021_run1/evidence.json \
  --dry-run --output chapter1/context/langfuse/.import/preview.json
```

After the remote service is healthy, import using the server-local API:

```bash
cd /disk1/langfuse
python3 import_evidence.py --evidence evidence.json --env-file .env \
  --base-url http://127.0.0.1:3060/langfuse --output .import/payload.json
```

The importer creates one dataset item and five experiment runs. It sends 51 observations through OTLP/HTTP JSON with the v4 ingestion header, and attaches 25 recorded scores to the experiment-item root observations. It verifies stored observation IDs/counts, score counts, and five experiment IDs through the current public APIs.

Source evidence SHA-256: `790c39c98c786a07c403c77e85497325db5b6213cc019be5e0c5a33e23f348af`.

This is historical evidence import: no model calls and no fresh LLM evaluation are made. Full original requests/responses are retained in metadata. Tool nodes show local execution separately from the tool message in the **next actual model request**. The source contains 17 model calls and 29 tool actions.

Whole-run elapsed times were recorded; individual inference/tool latencies were not. Imported child spans are explicitly annotated timestamp points (`latency unrecorded`), using provider `response.created` or the local tool record time. Displayed 0ms child spans mean unknown duration, not measured instant execution. Naive tool timestamps are interpreted as Asia/Shanghai, matching the evidence-capture host.

Langfuse v4 observations are immutable and re-sending the same IDs creates duplicates. The importer checks for existing observations and records an upload marker before posting. It skips complete matching data and refuses to automatically retry a partial or uncertain upload. Score IDs/names/dates remain stable. After a successful import, `.import/import-receipt.json` contains verified counts and identifiers.

## Tests

```bash
.venv/bin/python -m unittest discover \
  -s chapter1/context/langfuse -p test_import_evidence.py
```

Upstream references: [Compose deployment](https://langfuse.com/self-hosting/deployment/docker-compose), [headless initialization](https://langfuse.com/self-hosting/administration/headless-initialization), [OTel experiment attributes](https://langfuse.com/integrations/native/opentelemetry/experiments), [v4 immutable observations](https://langfuse.com/faq/all/tracing-data-updates).
