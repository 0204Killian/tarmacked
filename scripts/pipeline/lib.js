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
  // v0.19: Northern Ireland (same 'ie' road data). Appended, never reordered.
  'County Antrim', 'County Armagh', 'County Down', 'County Fermanagh', 'County Londonderry', 'County Tyrone',
];
// The Republic's counties: the first 26 codes (the app's Ireland totals).
const REPUBLIC_COUNTIES = 26;

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

// Limits a zone tag stands for ("DE:rural", "IE:urban", "GB:nsl_single").
const RURAL_KMH = { DE: 100, AT: 100, FR: 80, IT: 90, ES: 90, PT: 90, NL: 80, BE: 70, LU: 90, IE: 80, GB: 97, PL: 90, CZ: 90, SK: 90, HU: 90, DK: 80, SE: 70, NO: 80, FI: 80, CH: 80 };
const MOTORWAY_KMH = { DE: 0, AT: 130, FR: 130, IT: 130, ES: 120, PT: 120, NL: 100, BE: 120, IE: 120, GB: 113, PL: 140, CZ: 130, SK: 130, HU: 130, DK: 130, SE: 110, NO: 110, FI: 120, CH: 120 };

// km/h from a maxspeed tag ("80", "50 mph", "IE:urban", "none"...), or 0
// if unknown or unlimited. The country tells what a zone tag means.
function speedOf(t, country = '') {
  const raw = String(t.maxspeed || '').split(';')[0].trim();
  const m = /^(\d+)\s*(mph)?/.exec(raw);
  if (m) {
    const v = Number(m[1]);
    return m[2] ? Math.round(v * 1.609) : v;
  }
  const z = /^([A-Z]{2}):([a-z_]+)$/.exec(raw);
  if (z) {
    const c = z[1];
    switch (z[2]) {
      case 'urban': case 'zone30': return z[2] === 'zone30' ? 30 : 50;
      case 'rural': case 'nsl_single': case 'national': case 'regional': case 'local': return RURAL_KMH[c] ?? 90;
      case 'nsl_dual': case 'trunk': return c === 'GB' ? 113 : RURAL_KMH[c] ?? 100;
      case 'motorway': return MOTORWAY_KMH[c] ?? 120;
      case 'living_street': return 20;
      default: return 0;
    }
  }
  if (raw === 'walk') return 7;
  return 0; // 'none' (no limit), 'signals', unknown
}

// Toll roads (the way, or for cars).
function tollOf(t) {
  const v = t['toll:motorcar'] ?? t.toll;
  return v === 'yes' || v === 'true';
}

// Unpaved surfaces.
const UNPAVED = new Set(['unpaved', 'gravel', 'fine_gravel', 'dirt', 'earth', 'ground', 'grass', 'sand', 'mud', 'compacted', 'pebblestone', 'rock', 'grass_paver', 'woodchips', 'clay']);
function unpavedOf(t) {
  return UNPAVED.has(String(t.surface || '').split(';')[0].trim());
}

// Car ferries: route=ferry that says it takes cars.
function carFerry(t) {
  if (t.route !== 'ferry') return false;
  const ok = (v) => v === 'yes' || v === 'designated' || v === 'permissive';
  return ok(t.motor_vehicle) || ok(t.motorcar) || ok(t.hgv);
}

// km/h of a ferry from its duration tag ("1:20", "01:20:00", "80"), else 20.
function ferrySpeed(t, lengthM) {
  const d = String(t.duration || '').trim();
  let min = 0;
  const hm = /^(\d+):(\d{1,2})(?::\d{1,2})?$/.exec(d);
  if (hm) min = Number(hm[1]) * 60 + Number(hm[2]);
  else if (/^\d+$/.test(d)) min = Number(d);
  if (min > 0 && lengthM > 0) return Math.max(5, Math.min(60, Math.round(lengthM / 1000 / (min / 60))));
  return 20;
}

// Seconds lost at a node: traffic lights, stop and yield signs, level crossings.
const NODE_DELAY_S = { traffic_signals: 12, stop: 6, give_way: 2, level_crossing: 8, toll_booth: 20 };
function nodeKind(t) {
  if (t.highway === 'traffic_signals') return 'traffic_signals';
  if (t.highway === 'stop') return 'stop';
  if (t.highway === 'give_way') return 'give_way';
  if (t.railway === 'level_crossing') return 'level_crossing';
  if (t.barrier === 'toll_booth') return 'toll_booth';
  return null;
}

// --- compact tile format (v2) ---
// { v: 2, names: [...], s: [[way, n, flags, county, name, class, speed, lat0, lon0, dlat, dlon, ...], ...] }
// coordinates as 1e-5 degree integers, first absolute then differences.
// flags: 1 = one-way forward, 2 = one-way reverse, 4 = roundabout,
// 8 = toll (v0.19), 16 = unpaved (v0.19). Older apps ignore the new bits.
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
    const flags = (seg.o === 1 ? 1 : 0) | (seg.o === -1 ? 2 : 0) | (seg.r ? 4 : 0) | (seg.t ? 8 : 0) | (seg.u ? 16 : 0);
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

// Reads a compact v2 tile back (for joining parts' tiles).
function decodeTile(data) {
  const names = data.names || [];
  return (data.s || []).map((row) => {
    const [way, idx, flags, county, name, cls, speed] = row;
    const coords = [];
    let la = 0, lo = 0;
    for (let i = 7; i + 1 < row.length; i += 2) {
      la = i === 7 ? row[i] : la + row[i];
      lo = i === 7 ? row[i + 1] : lo + row[i + 1];
      coords.push([la / COORD_SCALE, lo / COORD_SCALE]);
    }
    return {
      way, idx, coords,
      o: flags & 1 ? 1 : flags & 2 ? -1 : 0,
      r: !!(flags & 4), t: !!(flags & 8), u: !!(flags & 16),
      c: county >= 0 ? county : undefined,
      n: name >= 0 ? names[name] : null,
      h: cls, sp: speed,
    };
  });
}

module.exports = {
  decodeTile,
  CHUNK_TARGET_METERS, COORD_SCALE, TILE_DEGREES, ROAD_CLASSES, COUNTY_CODES, REPUBLIC_COUNTIES, PLACE_KINDS, RESTRICTIONS,
  haversine, round, tileIdForPoint, splitIntoChunks, onewayOf, roadName, drivable, speedOf, encodeTile,
  tollOf, unpavedOf, carFerry, ferrySpeed, NODE_DELAY_S, nodeKind,
};
