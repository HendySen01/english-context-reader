#!/usr/bin/env bash
set -euo pipefail

scratch=$(mktemp -d)
export CI_CANARY
CI_CANARY="reader-ci-$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
export COMPOSE_PROJECT_NAME="reader-ci-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
export COMPOSE_FILE=compose.yaml:deploy/ci/compose.yaml
export COMPOSE_DISABLE_ENV_FILE=1
export DOCKER_DEFAULT_PLATFORM=linux/amd64
export IMAGE_PREFIX="$COMPOSE_PROJECT_NAME"
export RELEASE=validation
export WEB_PORT=18080
export VITE_SUPABASE_URL=https://ci-placeholder.supabase.co
export VITE_SUPABASE_ANON_KEY=sb_publishable_ci_placeholder
export AI_ALLOWED_USER_IDS=12345678-1234-4234-8234-123456789abc
export DEEPSEEK_KEY_PATH="$scratch/model.key"
export CI_STATE_DIR="$scratch/state"
canary_env=.env.reader-ci-canary
canary_key=server/reader-ci-canary.key

if [[ -e "$canary_env" || -e "$canary_key" ]]; then
  rmdir "$scratch"
  printf 'Canary path already exists; refusing to overwrite it.\n' >&2
  exit 1
fi
cleanup() {
  docker compose down --volumes --remove-orphans --timeout 10 >"$scratch/cleanup.log" 2>&1 || true
  rm -f -- "$canary_env" "$canary_key"
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -m 0777 "$CI_STATE_DIR"
printf 'CI_CANARY=%s\n' "$CI_CANARY" >"$canary_env"
printf '%s\n' "$CI_CANARY" >"$canary_key"
printf '%s\n' "$CI_CANARY" >"$DEEPSEEK_KEY_PATH"
# This runner-only, synthetic file is read-only inside the container. Its parent is private on the runner.
chmod 0444 "$DEEPSEEK_KEY_PATH"

docker compose config --quiet
for service in web api; do
  if ! docker compose build "$service" >"$scratch/build-$service.log" 2>&1; then
    printf 'Docker build failed for %s; raw build output was withheld.\n' "$service" >&2
    exit 1
  fi
  if grep -Fq -- "$CI_CANARY" "$scratch/build-$service.log"; then
    printf 'A test secret appeared in the %s build log.\n' "$service" >&2
    exit 1
  fi
  printf 'Built %s image; canary absent from build output.\n' "$service"
done
docker image save -o "$scratch/images.tar" "$IMAGE_PREFIX-web:$RELEASE" "$IMAGE_PREFIX-api:$RELEASE"
python3 deploy/ci/audit.py "$scratch/images.tar"
rm -f -- "$scratch/images.tar"

export CI_API_ENTRY=server/index.js
docker compose up -d --wait --wait-timeout 90 --no-build api web
docker compose exec -T web nginx -t
docker compose exec -T api node -e '
  const fs = require("node:fs");
  const key = "/run/secrets/deepseek_api_key";
  if (process.getuid() !== 1000 || !fs.readFileSync(key).length ||
      !fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").some(
        line => line.split(" ")[4] === key && line.split(" ")[5].split(",").includes("ro")
      )) process.exit(1);
  fs.accessSync("/var/lib/reader", fs.constants.W_OK);
'
node deploy/ci/check.mjs production-entry

export CI_API_ENTRY=/ci/fixture.mjs
docker compose up -d --wait --wait-timeout 60 --no-build mock api web
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.MemPerc}}' \
  "$(docker compose ps -q web)" "$(docker compose ps -q api)"
node deploy/ci/check.mjs mocked
