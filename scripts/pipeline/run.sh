#!/usr/bin/env bash
# Builds one region's road data (regions.js) from OpenStreetMap.
# Runs on GitHub Actions every month for every region (.github/workflows/
# road-data.yml), or by hand in a Codespace / Linux:
#   sudo apt install -y osmium-tool curl     (and Node.js 18 or newer)
#
#   bash run.sh                 # Ireland & Northern Ireland, version = today
#   bash run.sh fr              # France
#   bash run.sh ie 2026-11-01b  # pick the version name yourself
#
# Then check the totals it prints, and upload with: bash upload.sh (needs the R2 keys)
# Big countries are cut into parts and built one part at a time, so memory
# stays at about what Ireland needs (NODE_HEAP, in MB, raises the limit).
set -euo pipefail
cd "$(dirname "$0")"

REGION="${1:-ie}"
eval "$(node regions.js get "$REGION")"
VERSION="${2:-$(date +%Y-%m-%d)}"
# A version name is never reused: phones and Cloudflare keep a version's
# files forever, so the same name twice would mix two builds. If today's
# date is already live, the next free one is used (2026-10-02b, c...).
# (Read from R2 itself when the keys are here: the website can turn servers away.)
if [ -n "${R2_ACCOUNT_ID:-}" ]; then MANIFEST_CMD=(node r2.js cat manifest.json); else MANIFEST_CMD=(curl -s https://tiles.tarmacked.com/manifest.json); fi
LIVE="$("${MANIFEST_CMD[@]}" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).regions['$REGION'].version)}catch{console.log('')}})" || true)"
if [ -z "${2:-}" ] && [ -n "$LIVE" ] && [[ "$LIVE" == "$VERSION"* ]]; then
  SUFFIX="${LIVE#"$VERSION"}" # '' or a letter
  if [ -z "$SUFFIX" ]; then VERSION="${VERSION}b"; else VERSION="$VERSION$(printf "\\$(printf '%03o' $(( $(printf '%d' "'$SUFFIX") + 1 )))")"; fi
fi
# Couldn't tell what's live (no connection, or the website turned the
# server away): add the time, so the name can't be one that's in use.
if [ -z "${2:-}" ] && [ -z "$LIVE" ]; then VERSION="$(date -u +%Y-%m-%d-%H%M)"; fi
if [ "$VERSION" = "$LIVE" ]; then echo "Version $VERSION is already live. Pick a new name, e.g. bash run.sh $REGION ${VERSION}b"; exit 1; fi
COUNTRY="${R_CLIP:-}"
[ "$REGION" = "ie" ] && COUNTRY=IE
echo "Building $R_NAME ($REGION) version $VERSION (live now: ${LIVE:-none})"

if ! command -v osmium >/dev/null; then echo "osmium isn't installed: sudo apt install -y osmium-tool"; exit 1; fi
if [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]; then echo "Needs Node.js 18 or newer (node -v)"; exit 1; fi

WORK="data/$REGION"
mkdir -p "$WORK" out
PBF="$WORK/region.osm.pbf"
URL="https://download.geofabrik.de/${R_SLUG}-latest.osm.pbf"

# 1. Download (skipped if today's copy is already there).
if [ ! -f "$PBF" ] || [ "$(find "$PBF" -mtime +0 2>/dev/null)" ]; then
  echo "Downloading $URL ..."
  curl -L --fail --retry 3 -o "$PBF.part" "$URL"
  mv "$PBF.part" "$PBF"
fi
osmium fileinfo "$PBF" | grep -E "Bounding|timestamp" || true

# 2. Areas (counties etc.) and the country border, once for the whole region.
LEVELS=2,4,5,6,7
[ "$R_LEVEL" = "8" ] && LEVELS=2,4,5,6,7,8 # municipalities only where asked: big countries have tens of thousands
osmium tags-filter "$PBF" "r/admin_level=$LEVELS" -o "$WORK/admin.osm.pbf" --overwrite
osmium export "$WORK/admin.osm.pbf" --geometry-types=polygon -f geojsonseq -o "$WORK/admin.geojsonseq" --overwrite
node --max-old-space-size="${NODE_HEAP:-6144}" areas.js "$REGION" "$WORK/admin.geojsonseq" "$WORK/areas.json"
rm -f "$WORK/admin.osm.pbf" "$WORK/admin.geojsonseq"

# 3. Parts: about one per 300 MB of download.
rm -rf "$WORK/parts" "$WORK/built"
mkdir -p "$WORK/parts" "$WORK/built"
SIZE_MB=$(( $(stat -c %s "$PBF") / 1000000 ))
NPARTS=$(( (SIZE_MB + 299) / 300 ))
if [ "$NPARTS" -gt 1 ]; then
  BOX="$(osmium fileinfo -g header.boxes "$PBF" | head -1)"
  node split.js "$BOX" "$NPARTS" "$WORK/parts" > "$WORK/parts.txt"
  echo "Cutting into $(wc -l < "$WORK/parts.txt") parts ..."
  osmium extract -c "$WORK/parts/extract.json" -s smart "$PBF" --overwrite
else
  ln -sf ../region.osm.pbf "$WORK/parts/p00.osm.pbf"
  echo "p00 -" > "$WORK/parts.txt"
fi

# 4. Each part: roads (with their node IDs), slow-down nodes, ferries,
#    places and turn restrictions, then build.js.
while read -r P BBOX; do
  IN="$WORK/parts/$P.osm.pbf"
  D="$WORK/parts/$P"
  mkdir -p "$D"
  echo "Part $P ($BBOX)"
  osmium tags-filter "$IN" \
    w/highway=motorway,motorway_link,trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link,unclassified,residential,living_street \
    -o "$D/roads.osm.pbf" --overwrite
  osmium export "$D/roads.osm.pbf" --geometry-types=linestring -a type,id,way_nodes \
    -f geojsonseq -o "$D/roads.geojsonseq" --overwrite
  osmium tags-filter "$IN" n/highway=traffic_signals,stop,give_way n/railway=level_crossing n/barrier=toll_booth \
    -o "$D/nodes.osm.pbf" --overwrite
  osmium export "$D/nodes.osm.pbf" --geometry-types=point -a type,id -f geojsonseq -o "$D/nodes.geojsonseq" --overwrite
  osmium tags-filter "$IN" w/route=ferry -o "$D/ferries.osm.pbf" --overwrite
  osmium export "$D/ferries.osm.pbf" --geometry-types=linestring -a type,id,way_nodes -f geojsonseq -o "$D/ferries.geojsonseq" --overwrite
  osmium tags-filter "$IN" n/place=city,town,village,suburb,hamlet,neighbourhood,locality,isolated_dwelling \
    -o "$D/places.osm.pbf" --overwrite
  osmium export "$D/places.osm.pbf" --geometry-types=point -f geojsonseq -o "$D/places.geojsonseq" --overwrite
  osmium tags-filter "$IN" r/type=restriction -R -o "$D/restrictions.osm.pbf" --overwrite
  osmium cat "$D/restrictions.osm.pbf" -f opl -o "$D/restrictions.opl" --overwrite
  node --max-old-space-size="${NODE_HEAP:-6144}" build.js "$REGION" "$D" "$WORK/built/$P" "$WORK/areas.json" "${BBOX:--}" "$R_MAIN" "$COUNTRY" < /dev/null
  rm -rf "$D"
  if [ "$NPARTS" -gt 1 ]; then rm -f "$IN"; fi
done < "$WORK/parts.txt"

# 5. Join the parts into out/<region>/<version>.
node --max-old-space-size="${NODE_HEAP:-6144}" merge.js "$REGION" "$VERSION" "$WORK/built" "$WORK/areas.json" out
rm -rf "$WORK/built" "$WORK/parts"

echo
echo "Built out/$REGION/$VERSION. If the totals look right: bash upload.sh"
