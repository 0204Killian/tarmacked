#!/usr/bin/env bash
# Uploads built road data to Cloudflare R2 (tiles.tarmacked.com) with r2.js.
# Needs Node.js 18+, and the R2 keys either as environment variables
# (GitHub Actions secrets) or in ~/.tarmacked-r2 (a Codespace), never in the repo:
#   R2_ACCOUNT_ID=...
#   R2_ACCESS_KEY_ID=...
#   R2_SECRET_ACCESS_KEY=...
#
#   bash upload.sh                  # everything in out/: data, then the manifest
#   bash upload.sh --data-only      # just the region folders (a build job)
#   bash upload.sh --manifest-only  # just the manifest + tidy-up (after all builds)
#
# Data goes up first and the manifest last, so phones only switch to a new
# version once every file of it is there. Then versions older than the one
# phones were on are deleted (keep.txt, from publish.js).
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-all}"
if [ -z "${R2_ACCESS_KEY_ID:-}" ] && [ -f ~/.tarmacked-r2 ]; then set -a; source ~/.tarmacked-r2; set +a; fi
: "${R2_ACCOUNT_ID:?R2 keys missing: set them as secrets or in ~/.tarmacked-r2}"
export R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

if [ "$MODE" != "--manifest-only" ]; then
  for dir in out/*/*/; do
    [ -d "$dir" ] || continue
    rel="${dir#out/}"
    node r2.js upload "$dir" "$rel" "public, max-age=31536000, immutable"
  done
fi
[ "$MODE" = "--data-only" ] && exit 0

# The live manifest straight from R2 (not through Cloudflare's website,
# which can turn away servers like GitHub's). Missing = the very first one;
# couldn't read = stop, so other regions are never dropped.
set +e
node r2.js cat manifest.json > out/live-manifest.json
CODE=$?
set -e
if [ "$CODE" = "2" ]; then
  echo '{"v":1,"regions":{}}' > out/live-manifest.json
elif [ "$CODE" != "0" ]; then
  echo "Couldn't read the live manifest from R2: not publishing (nothing changed for phones)."
  exit 1
fi
node publish.js out out/live-manifest.json
echo "Uploading manifest.json ..."
node r2.js put out/manifest.json manifest.json "public, max-age=300"

# Tidy up: in each rebuilt region, delete versions older than the one phones
# were on (they've had time to move on; R2 storage stays small).
for f in out/entry-*.json; do
  region="$(basename "$f" .json)"
  region="${region#entry-}"
  for v in $(node r2.js dirs "$region" || true); do
    if ! grep -qx "$v" out/keep.txt; then
      echo "Deleting old version $v ..."
      node r2.js purge "$v" || echo "  (couldn't delete it; next time)"
    fi
  done
done

echo "Done. Check: https://tiles.tarmacked.com/manifest.json"
