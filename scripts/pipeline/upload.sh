#!/usr/bin/env bash
# Uploads the built road data to Cloudflare R2 (tiles.tarmacked.com).
# Needs: rclone (sudo apt install -y rclone) and ~/.tarmacked-r2 containing:
#   R2_ACCOUNT_ID=...
#   R2_ACCESS_KEY_ID=...
#   R2_SECRET_ACCESS_KEY=...
# (chmod 600 ~/.tarmacked-r2 — never commit it or share it.)
#
# Tiles go up first; the manifest last, so phones only switch to the new
# version once every file of it is there. Old versions are left in place.
set -euo pipefail
cd "$(dirname "$0")"
source ~/.tarmacked-r2

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
BUCKET="r2:tarmacked-tiles"

for dir in out/*/*/; do
  rel="${dir#out/}"
  echo "Uploading $rel ..."
  rclone copy "$dir" "$BUCKET/$rel" --transfers 32 --checkers 32 \
    --header-upload "Cache-Control: public, max-age=31536000, immutable" \
    --header-upload "Content-Type: application/json"
done

echo "Uploading manifest.json ..."
rclone copyto out/manifest.json "$BUCKET/manifest.json" \
  --header-upload "Cache-Control: public, max-age=300" \
  --header-upload "Content-Type: application/json"

echo "Done. Check: https://tiles.tarmacked.com/manifest.json"
