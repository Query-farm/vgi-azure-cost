#!/usr/bin/env bash
# Reader-portable Bun/Git launcher. The only local source is the fixture adapter;
# every domain function and catalog comes from this immutable remote revision.
set -euo pipefail

notebook_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
worker_revision="8caf65fa35163e1cea5e8a9e656963d3dec80e73"
worker_source="$notebook_dir/artifacts/worker-$worker_revision"
if [[ ! -d "$worker_source/.git" ]]; then
  mkdir -p "$notebook_dir/artifacts"
  git clone --no-checkout https://github.com/Query-farm/vgi-azure-cost.git "$worker_source" >&2
  git -C "$worker_source" checkout --detach "$worker_revision" >&2
fi
if [[ "$(git -C "$worker_source" rev-parse HEAD)" != "$worker_revision" ]]; then
  echo "Fixture cache revision differs from its pin; use a fresh artifacts directory." >&2
  exit 1
fi
git -C "$worker_source" diff --quiet HEAD -- src package.json bun.lock || {
  echo "Fixture cache source was modified; use a fresh artifacts directory." >&2
  exit 1
}
(cd "$worker_source" && bun install --frozen-lockfile) >&2
cp "$notebook_dir/fixture_worker.ts" "$worker_source/_notebook_fixture_worker.ts"
exec bun run "$worker_source/_notebook_fixture_worker.ts"
