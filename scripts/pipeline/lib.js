// Shared by the road-data pipeline (build.js) and its tests. Plain Node, no
// dependencies, so it runs anywhere WSL has `node`.
//
// IMPORTANT: road piece IDs ("way/<OSM id>#<n>") must stay exactly as the
// old Overpass script made them, or everyone's driven roads would have to
// be re-earned. So: same coordinate rounding (5 decimals), same ~100 m
// splitting, same tile choice (the piece's first point).

const CHUNK_TARGET_METERS = 100;
const COORD_SCALE = 100000; // 5 decimals, ~1.1 m
const TILE_DEGREES = 0.05; // must match src/geo.ts tileIdForPoint

// Road types kept, in a fixed order: the index is stored in the tiles
// ("h"), so only ever ADD to the end of this list.
const ROAD_CLASSES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'living_street',
];

// County codes: never reorder (the app's stored data depends on them).
const COUNTY_CODES = [
  'County Carlow', 'County Cavan', 'County Clare', 'County Cork', 'County Donegal',
  'County Dublin', 'County Galway', 'County Kerry', 'County Kildare', 'County Kilkenny',
  'County Laois', 'County Leitrim', 'County Limerick', 'County Longford', 'County Louth',
  'County Mayo', 'County Meath', 'County Monaghan', 'County Offaly', 'County Roscommon',
  'County Sligo', 'County Tipperary', 'County Waterford', 'County Westmeath', 'County Wexford',
  'County Wicklow',
];

// Kinds of place kept for search (index stored in places.json).
const PLACE_KINDS = ['city', 'town', 'village', 'suburb', 'hamlet', 'neighbourhood', 'locality', 'isolated_dwelling'];

// Turn restriction kinds (index stored in restrictions.json).
const RESTRICTIONS = [
  'no_left_turn', 'no_right_turn', 'no_straight_on', 'no_u_turn', 'no_entry', 'no_exit',
  'only_left_turn', 'only_right_turn', 'only_straight_on', 'only_u_turn',
];

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const round = (n) => Math.round(n * COORD_SCALE) / COORD_SCALE;

function tileIdForPoint(lat, lon) {
  return `t_${Math.floor(lat / TILE_DEGREES)}_${Math.floor(lon / TILE_DEGREES)}`;
}

// Exactly the old splitting rule.
function splitIntoChunks(coords) {
  if (coords.length < 2) return [coords];
  const chunks = [];
  let current = [coords[0]];
  let len = 0;
  for (let i = 1; i < coords.length; i++) {
    len += haversine(coords[i - 1], coords[i]);
    current.push(coords[i]);
    if (len >= CHUNK_TARGET_METERS) {
      chunks.push(current);
      current = [coords[i]];
      len = 0;
    }
  }
  if (current.length > 1) chunks.push(current);
  return chunks;
}

// 1 = one-way in drawn order, -1 = against it, 0 = two-way.
function onewayOf(t) {
  const ow = t.oneway;
  if (ow === 'no') return 0;
  if (ow === 'yes' || ow === 'true' || ow === '1') return 1;
  if (ow === '-1' || ow === 'reverse') return -1;
  if (t.highway === 'motorway') return 1;
  if (t.junction === 'roundabout' || t.junction === 'circular') return 1;
  return 0;
}

function roadName(t) {
  const ref = t.ref ? String(t.ref).replace(/;/g, '/') : '';
  const name = t.name || '';
  return [ref, name].filter(Boolean).join(' ') || null;
}

// Public, drivable by car. The most specific access tag that's set wins
// (motorcar > motor_vehicle > vehicle > access).
const BLOCKED = new Set(['no', 'private', 'agricultural', 'forestry', 'military', 'emergency', 'bus', 'psv']);
function drivable(t) {
  if (!ROAD_CLASSES.includes(t.highway)) return false;
  if (t.area === 'yes') return false;
  const access = t.motorcar ?? t.motor_vehicle ?? t.vehicle ?? t.access;
  return !(access && BLOCKED.has(String(access).split(';')[0].trim()));
}

// km/h from a maxspeed tag ("80", "50 mph", "IE:urban"...), or 0 if unknown.
function speedOf(t) {
  const m = /^\s*(\d+)\s*(mph)?/.exec(t.maxspeed || '');
  if (!m) return 0;
  const v = Number(m[1]);
  return m[2] ? Math.round(v * 1.609) : v;
}

// --- compact tile format (v2) ---
// { v: 2, names: [...], s: [[way, n, flags, county, name, class, speed, lat0, lon0, dlat, dlon, ...], ...] }
// coordinates as 1e-5 degree integers, first absolute then differences.
// flags: 1 = one-way forward, 2 = one-way reverse, 4 = roundabout.
function encodeTile(segments) {
  const names = [];
  const nameIdx = new Map();
  const s = segments.map((seg) => {
    let ni = -1;
    if (seg.n) {
      if (!nameIdx.has(seg.n)) {
        nameIdx.set(seg.n, names.length);
        names.push(seg.n);
      }
      ni = nameIdx.get(seg.n);
    }
    const flags = (seg.o === 1 ? 1 : 0) | (seg.o === -1 ? 2 : 0) | (seg.r ? 4 : 0);
    const row = [seg.way, seg.idx, flags, seg.c ?? -1, ni, seg.h ?? -1, seg.sp ?? 0];
    let plat = 0;
    let plon = 0;
    seg.coords.forEach(([la, lo], i) => {
      const a = Math.round(la * COORD_SCALE);
      const b = Math.round(lo * COORD_SCALE);
      row.push(i === 0 ? a : a - plat, i === 0 ? b : b - plon);
      plat = a;
      plon = b;
    });
    return row;
  });
  return { v: 2, names, s };
}

module.exports = {
  CHUNK_TARGET_METERS, COORD_SCALE, TILE_DEGREES, ROAD_CLASSES, COUNTY_CODES, PLACE_KINDS, RESTRICTIONS,
  haversine, round, tileIdForPoint, splitIntoChunks, onewayOf, roadName, drivable, speedOf, encodeTile,
};
