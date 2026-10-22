#!/usr/bin/env bash
# Build on the Linux deployment host; keep the published runtime and worker.
set -euo pipefail

source_root="${LANGFUSE_SOURCE_ROOT:-/disk1/langfuse/source}"
tools_root="${LANGFUSE_BUILD_TOOLS:-/disk1/langfuse/build-tools}"
build_action="${1:-build}"
upstream_commit=29a40eb027c5f4bb8c72c2f6d2d7e98aa1ce0cbf
runtime_image=docker.langfuse.com/langfuse/langfuse:4.66.0
runtime_id=sha256:8e8d248990fa35883a72e3cce0c704524d886268dfe4e62879b94d2ba39d5966
receipt="$tools_root/logs/build-receipt.json"
patch_paths=(
  packages/shared/src/utils/normalized-io/conventions/providers/openai/index.ts
  packages/shared/src/utils/normalized-io/conventions/providers/openai/openai.test.ts
  web/src/features/traces/hooks/useChatMLParser.clienttest.ts
  web/next.config.mjs
)
if [[ "$build_action" == build ]]; then
  rm -f "$receipt"
fi
export PATH="$tools_root/node-v24.21.0-linux-x64/bin:$tools_root/pnpm/bin:$PATH"
export TMPDIR="$tools_root/tmp" XDG_CACHE_HOME="$tools_root/cache"
export PNPM_HOME="$tools_root/pnpm-home"
export npm_config_store_dir="$tools_root/pnpm-store"
export npm_config_cache="$tools_root/cache/npm"
export pnpm_config_verify_deps_before_run=false
export CI=true HUSKY=0 NEXT_TELEMETRY_DISABLED=1 DOCKER_BUILD=1
export NEXT_MANUAL_SIG_HANDLE=true
export NODE_OPTIONS="--max-old-space-size=${LANGFUSE_BUILD_HEAP_MB:-4096}"
export RAYON_NUM_THREADS="${LANGFUSE_BUILD_THREADS:-2}" UV_THREADPOOL_SIZE=2
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$PNPM_HOME" "$tools_root/logs"
if [[ "$build_action" == bootstrap ]]; then
  mkdir -p "$tools_root/downloads"
  archive="$tools_root/downloads/node-v24.21.0-linux-x64.tar.xz"
  curl -fsSL --retry 2 https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o "$archive"
  printf '%s  %s\n' fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 "$archive" | sha256sum -c -
  tar -xJf "$archive" -C "$tools_root"
  npm install --global --prefix "$tools_root/pnpm" pnpm@12.8.2 --loglevel error
  node --version
  pnpm --version
  exit
fi
cd "$source_root"

[[ "$(node --version)" == v24.21.0 ]]
[[ "$(pnpm --version)" == 12.8.2 ]]
node -e 'if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build and image packaging require Linux x64")'
assert_source_patch() {
  [[ "$(git rev-parse HEAD)" == "$upstream_commit" ]] || {
    echo 'Source HEAD differs from the pinned upstream v4.66.0 commit.' >&2
    exit 1
  }
  changed_files="$(git diff --name-only HEAD)"
  while IFS= read -r changed_path; do
    case "$changed_path" in
      '') ;;
      'packages/shared/src/utils/normalized-io/conventions/providers/openai/index.ts'|\
      'packages/shared/src/utils/normalized-io/conventions/providers/openai/openai.test.ts'|\
      'web/src/features/traces/hooks/useChatMLParser.clienttest.ts'|\
      'web/next.config.mjs') ;;
      *) echo "Unexpected source modification: $changed_path" >&2; exit 1 ;;
    esac
  done <<< "$changed_files"
}
if [[ "$build_action" == build || "$build_action" == image ]]; then
  assert_source_patch
  for env_file in .env .env.local .env.production .env.production.local web/.env web/.env.local web/.env.production web/.env.production.local; do
    [[ ! -f "$env_file" ]] || {
      echo "Refusing a source build/image with a runtime environment file: $env_file" >&2
      exit 1
    }
  done
fi

case "$build_action" in
  install)
    pnpm install --frozen-lockfile
    ;;
  build)
    patch_sha="$(git diff --binary HEAD -- "${patch_paths[@]}" | sha256sum | cut -d ' ' -f 1)"
    # Match the official Docker build's self-hosted source preparation.
    [[ ! -e web/src/middleware.ts ]] || {
      echo 'Self-hosted source must omit web/src/middleware.ts, as in the official Dockerfile.' >&2
      exit 1
    }
    node packages/shared/clickhouse/scripts/prepare-migrations.mjs materialize packages/shared/clickhouse/migrations
    case "${LANGFUSE_BUILD_BUNDLER:-turbopack}" in
      turbopack)
        pnpm exec turbo run build --filter=web... --concurrency=1 --output-logs=full
        ;;
      webpack)
        pnpm exec turbo run build --filter='web^...' --concurrency=1 --output-logs=full
        INLINE_RUNTIME_CHUNK=false pnpm --filter web exec dotenv -e ../.env -- next build --webpack
        pnpm --filter web run build:otel-worker
        ;;
      *) echo 'LANGFUSE_BUILD_BUNDLER must be turbopack or webpack.' >&2; exit 1 ;;
    esac
    pnpm run scan:client-bundle
    assert_source_patch
    [[ "$(git diff --binary HEAD -- "${patch_paths[@]}" | sha256sum | cut -d ' ' -f 1)" == "$patch_sha" ]]
    node - "$receipt" "$upstream_commit" "$patch_sha" "$runtime_id" <<'NODE'
const fs = require("node:fs");
const [file, upstreamCommit, patchSha256, runtimeImageId] = process.argv.slice(2);
const nextBuildId = fs.readFileSync("web/.next/BUILD_ID", "utf8").trim();
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const buildConfig = JSON.parse(fs.readFileSync("web/.next/required-server-files.json", "utf8")).config;
if (buildConfig.basePath !== basePath) throw new Error("Built base path differs from requested base path");
fs.writeFileSync(file, JSON.stringify({ upstreamCommit, patchSha256, runtimeImageId,
  nextBuildId, basePath, bundler: process.env.LANGFUSE_BUILD_BUNDLER ?? "turbopack",
  rayonThreads: process.env.RAYON_NUM_THREADS, nextCpuCountEnv: process.env.CIRCLE_NODE_TOTAL,
  memorySaverBuild: process.env.LANGFUSE_BUILD_MEMORY_SAVER === "true", nodeOptions: process.env.NODE_OPTIONS,
  platform: process.platform, arch: process.arch,
  node: process.version, pnpm: "12.8.2", builtAt: new Date().toISOString() }, null, 2) + "\n");
NODE
    ;;
  image)
    export DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/6351/langfuse-docker.sock}"
    patch_sha="$(git diff --binary HEAD -- "${patch_paths[@]}" | sha256sum | cut -d ' ' -f 1)"
    node - "$receipt" "$upstream_commit" "$patch_sha" "$runtime_id" <<'NODE'
const fs = require("node:fs");
const [file, upstreamCommit, patchSha256, runtimeImageId] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
for (const [key, value] of Object.entries({ upstreamCommit, patchSha256, runtimeImageId, basePath, platform: "linux", arch: "x64" })) {
  if (receipt[key] !== value) throw new Error(`Build receipt mismatch: ${key}`);
}
for (const buildIdPath of ["web/.next/BUILD_ID", "web/.next/standalone/web/.next/BUILD_ID"]) {
  if (fs.readFileSync(buildIdPath, "utf8").trim() !== receipt.nextBuildId) {
    throw new Error(`Build ID mismatch: ${buildIdPath}`);
  }
}
const buildConfig = JSON.parse(fs.readFileSync("web/.next/required-server-files.json", "utf8")).config;
if (buildConfig.basePath !== basePath) throw new Error("Image base path differs from requested base path");
NODE
    [[ "$(docker image inspect "$runtime_image" --format '{{.Id}}')" == "$runtime_id" ]] || {
      echo 'Published runtime image differs from the verified v4.66.0 image.' >&2
      exit 1
    }
    [[ -f web/.next/standalone/web/server.js ]]
    [[ -f web/.next/standalone/web/otelIngestionWorker.js ]]
    image_context="$(mktemp -d "$tools_root/tmp/web-image.XXXXXX")"
    trap 'rm -rf "$image_context"' EXIT
    mkdir -p "$image_context/app/web/.next/static" "$image_context/app/web/public" \
      "$image_context/app/packages/shared/scripts" "$image_context/app/packages/shared/prisma" \
      "$image_context/app/packages/shared/clickhouse"
    cp -a web/.next/standalone/. "$image_context/app/"
    cp -a web/.next/static/. "$image_context/app/web/.next/static/"
    cp -a web/public/. "$image_context/app/web/public/"
    cp -a web/next.config.mjs web/package.json "$image_context/app/"
    cp -a web/entrypoint.sh "$image_context/app/web/entrypoint.sh"
    cp -a packages/shared/prisma/. "$image_context/app/packages/shared/prisma/"
    cp -a packages/shared/clickhouse/. "$image_context/app/packages/shared/clickhouse/"
    cp -a packages/shared/scripts/cleanup.sql "$image_context/app/packages/shared/scripts/cleanup.sql"
    chmod 755 "$image_context/app/web/entrypoint.sh"
    cat > "$image_context/Dockerfile" <<'DOCKERFILE'
ARG BASE_RUNTIME
FROM ${BASE_RUNTIME}
USER 0
RUN rm -rf /app
WORKDIR /app
COPY --chown=1001:1001 app/ /app/
USER 1001
DOCKERFILE
    image_tag="${LANGFUSE_WEB_IMAGE:-context-lab/langfuse-web:4.66.0-reasoning}"
    docker build --pull=false --build-arg "BASE_RUNTIME=$runtime_image" \
      --label "org.opencontainers.image.version=4.66.0-reasoning" \
      --label "org.opencontainers.image.revision=$upstream_commit" \
      --label "context-lab.source-patch-sha256=$patch_sha" \
      --label "context-lab.runtime-image-id=$runtime_id" \
      --label "context-lab.base-path=${NEXT_PUBLIC_BASE_PATH:-}" \
      --tag "$image_tag" "$image_context"
    built_image_id="$(docker image inspect "$image_tag" --format '{{.Id}}')"
    node - "$receipt" "$image_tag" "$built_image_id" <<'NODE'
const fs = require("node:fs");
const [file, imageTag, imageId] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
fs.writeFileSync(file, JSON.stringify({ ...receipt, imageTag, imageId,
  imageBuiltAt: new Date().toISOString() }, null, 2) + "\n");
NODE
    printf '%s\n' "$built_image_id"
    ;;
  *)
    echo 'Usage: build_web.sh bootstrap|install|build|image' >&2
    exit 2
    ;;
esac
