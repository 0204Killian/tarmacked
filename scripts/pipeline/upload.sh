#!/usr/bin/env bash
# Uploads built road data to Cloudflare R2 (tiles.tarmacked.com).
# Needs rclone, and the R2 keys either as environment variables (GitHub
# Actions secrets) or in ~/.tarmacked-r2 (a Codespace), never in the repo:
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
if [ -z "${R2_ACCESS_KEY_ID:-}" ] && [ -f ~/.tarmacked-r2 ]; then source ~/.tarmacked-r2; fi
: "${R2_ACCOUNT_ID:?R2 keys missing: set them as secrets or in ~/.tarmacked-r2}"
# A secret pasted with a space or new line at the end still works.
R2_ACCOUNT_ID="$(printf '%s' "$R2_ACCOUNT_ID" | tr -d '[:space:]')"
R2_ACCESS_KEY_ID="$(printf '%s' "$R2_ACCESS_KEY_ID" | tr -d '[:space:]')"
R2_SECRET_ACCESS_KEY="$(printf '%s' "$R2_SECRET_ACCESS_KEY" | tr -d '[:space:]')"

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
BUCKET="r2:tarmacked-tiles"
RETRY=(--retries 5 --low-level-retries 20)

if [ "$MODE" != "--manifest-only" ]; then
  for dir in out/*/*/; do
    [ -d "$dir" ] || continue
    rel="${dir#out/}"
    echo "Uploading $rel ($(ls "$dir" | wc -l) files) ..."
    # A new version folder is empty on R2, so no need to compare first.
    rclone copy "$dir" "$BUCKET/$rel" --transfers 32 --checkers 32 --no-check-dest "${RETRY[@]}" \
      --header-upload "Cache-Control: public, max-age=31536000, immutable" \
      --header-upload "Content-Type: application/json"
  done
fi
[ "$MODE" = "--data-only" ] && exit 0

# The live manifest straight from R2 (not through Cloudflare's website,
# which can turn away servers like GitHub's).
if rclone cat "$BUCKET/manifest.json" "${RETRY[@]}" > out/live-manifest.json 2>/dev/null && [ -s out/live-manifest.json ]; then
  : # read it
elif LIST="$(rclone lsf "$BUCKET/" --files-only "${RETRY[@]}")" && ! grep -qx manifest.json <<< "$LIST"; then
  echo '{"v":1,"regions":{}}' > out/live-manifest.json # the very first one
else
  echo "Couldn't read the live manifest from R2: not publishing (nothing changed for phones)."
  exit 1
fi
node publish.js out out/live-manifest.json
echo "Uploading manifest.json ..."
rclone copyto out/manifest.json "$BUCKET/manifest.json" "${RETRY[@]}" \
  --header-upload "Cache-Control: public, max-age=300" \
  --header-upload "Content-Type: application/json"

# Tidy up: in each rebuilt region, delete versions older than the one phones
# were on (they've had a month to move on; R2 storage stays small).
for f in out/entry-*.json; do
  region="$(basename "$f" .json)"
  region="${region#entry-}"
  for v in $(rclone lsf "$BUCKET/$region/" --dirs-only 2>/dev/null || true); do
    if ! grep -qx "$region/$v" out/keep.txt; then
      echo "Deleting old version $region/$v ..."
      rclone purge "$BUCKET/$region/$v" "${RETRY[@]}" || echo "  (couldn't delete it; next time)"
    fi
  done
done

echo "Done. Check: https://tiles.tarmacked.com/manifest.json"
