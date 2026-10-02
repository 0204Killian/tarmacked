#!/usr/bin/env bash
# Builds tarmacked's road data on your PC (WSL / Ubuntu).
# Needs: osmium-tool, curl and Node.js 18 or newer
#   sudo apt install -y osmium-tool curl
#   node -v   (if it's older than v18, install a current Node.js first)
#
#   bash run.sh                 # Ireland, version = today's date
#   bash run.sh ie 2026-10-03b  # pick the version name yourself
#
# Then check the totals it prints, and upload with: bash upload.sh
set -euo pipefail
cd "$(dirname "$0")"

REGION="${1:-ie}"
VERSION="${2:-$(date +%Y-%m-%d)}"
case "$REGION" in
  ie) URL="https://download.geofabrik.de/europe/ireland-and-northern-ireland-latest.osm.pbf" ;;
  *) echo "Unknown region $REGION"; exit 1 ;;
esac

if ! command -v osmium >/dev/null; then echo "osmium isn't installed: sudo apt install -y osmium-tool"; exit 1; fi
if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]; then echo "Needs Node.js 18 or newer (node -v)"; exit 1; fi

mkdir -p data out
PBF="data/$REGION.osm.pbf"

# 1. Download (skipped if today's copy is already there).
if [ ! -f "$PBF" ] || [ "$(find "$PBF" -mtime +0 2>/dev/null)" ]; then
  echo "Downloading $URL ..."
  curl -L --fail -o "$PBF.part" "$URL"
  mv "$PBF.part" "$PBF"
fi
osmium fileinfo "$PBF" | grep -E "Bounding|timestamp" || true

# 2. Roads (with their node IDs, for turn restrictions).
osmium tags-filter "$PBF" \
  w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,unclassified,residential,living_street \
  -o data/roads.osm.pbf --overwrite
osmium export data/roads.osm.pbf --geometry-types=linestring -a type,id,way_nodes \
  -f geojsonseq -o data/roads.geojsonseq --overwrite

# 3. County boundaries.
osmium tags-filter "$PBF" r/admin_level=5,6 -o data/admin.osm.pbf --overwrite
osmium export data/admin.osm.pbf --geometry-types=polygon -f geojsonseq -o data/admin.geojsonseq --overwrite

# 4. Places (towns, villages...) and turn restrictions, for the sat-nav.
osmium tags-filter "$PBF" n/place=city,town,village,suburb,hamlet,neighbourhood,locality,isolated_dwelling \
  -o data/places.osm.pbf --overwrite
osmium export data/places.osm.pbf --geometry-types=point -f geojsonseq -o data/places.geojsonseq --overwrite
osmium tags-filter "$PBF" r/type=restriction -R -o data/restrictions.osm.pbf --overwrite
osmium cat data/restrictions.osm.pbf -f opl -o data/restrictions.opl --overwrite

# 5. Build the tiles.
node --max-old-space-size=6144 build.js "$REGION" "$VERSION" data out

echo
echo "Built out/$REGION/$VERSION. If the totals look right: bash upload.sh"
