// Works out a region's "county" areas (for stats) and its country border
// (roads are cut to it), once per region, from the admin boundaries osmium
// exported. Every part of the region is then built against the same list.
//
//   node areas.js <region id> <admin.geojsonseq> <out areas.json>
//
// areas.json: { level, names: [...], polys: [rings...], clip: rings | null }
// with rings as [[lat, lon], ...] (simplified to ~30 m), holes included:
// a point is inside when it's inside an odd number of an area's rings.

const fs = require('fs');
const readline = require('readline');
const L = require('./lib');
const { byId } = require('./regions');

async function* features(file) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (let line of rl) {
    if (line.charCodeAt(0) === 0x1e) line = line.slice(1);
    line = line.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // skip a broken line
    }
  }
}

const SIMPLIFY_DEG = 0.0003; // ~30 m

function simplifyRing(ring) {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ay, ax] = ring[a];
    const [by, bx] = ring[b];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let worst = -1, worstD = SIMPLIFY_DEG * SIMPLIFY_DEG;
    for (let i = a + 1; i < b; i++) {
      const [py, px] = ring[i];
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

// GeoJSON Polygon / MultiPolygon -> simplified [[lat, lon]] rings.
function ringsOf(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  const rings = [];
  for (const poly of polys) for (const ring of poly) rings.push(simplifyRing(ring.map(([lon, lat]) => [L.round(lat), L.round(lon)])));
  return rings;
}

function insideRings(rings, lat, lon) {
  let ins = false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const [y1, x1] = ring[i];
      const [y2, x2] = ring[i + 1];
      if (y1 > lat !== y2 > lat && x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1) > lon) ins = !ins;
    }
  }
  return ins;
}

// A point well inside an area (the middle of its biggest ring's box, or a vertex average).
function innerPoint(rings) {
  let best = rings[0];
  for (const r of rings) if (r.length > best.length) best = r;
  let la = 0, lo = 0;
  for (const [a, b] of best) {
    la += a;
    lo += b;
  }
  const p = [la / best.length, lo / best.length];
  if (insideRings(rings, p[0], p[1])) return p;
  return best[Math.floor(best.length / 2)];
}

async function chooseAreas(regionId, adminFile) {
  const region = byId(regionId) ?? { id: regionId, clip: null, level: 6 };
  // Big countries have tens of thousands of boundaries: read the file twice
  // rather than keep every shape in memory.
  const admin = async function* () {
    for await (const f of features(adminFile)) {
      const p = f.properties || {};
      if (!f.geometry || p.boundary !== 'administrative') continue;
      yield { p, level: String(p.admin_level || ''), geometry: f.geometry };
    }
  };

  // Ireland: the fixed county list (codes never change).
  if (regionId === 'ie') {
    const polys = L.COUNTY_CODES.map(() => null);
    const levelOf = L.COUNTY_CODES.map(() => '');
    for await (const f of admin()) {
      if (f.level !== '5' && f.level !== '6') continue;
      const code = L.COUNTY_CODES.indexOf(f.p.name);
      if (code < 0) continue;
      if (polys[code] && levelOf[code] === '6') continue; // the county level wins
      polys[code] = ringsOf(f.geometry);
      levelOf[code] = f.level;
    }
    return { level: 6, names: L.COUNTY_CODES, polys, clip: null };
  }

  // Pass 1: the country's border, and how many named areas each level has.
  let clip = null;
  let clipSize = 0;
  const counts = new Map();
  for await (const f of admin()) {
    if (f.level === '2' && region.clip) {
      const iso = f.p['ISO3166-1'] || f.p['ISO3166-1:alpha2'] || f.p['country_code'];
      if (String(iso || '').toUpperCase() === region.clip) {
        const rings = ringsOf(f.geometry);
        const n = rings.reduce((a, r) => a + r.length, 0);
        if (n > clipSize) {
          clip = rings;
          clipSize = n;
        }
      }
    }
    if (f.p.name) counts.set(f.level, (counts.get(f.level) ?? 0) + 1);
  }
  if (region.clip && !clip) console.error(`areas: no border found for ${region.clip}; roads won't be cut to the border`);

  // The configured level if it has a few areas, else the first that does
  // (municipalities, level 8, only when asked for: there are too many).
  const levels = [...new Set([String(region.level), '6', '4', '5', '7'])];
  const level = levels.find((l) => (counts.get(l) ?? 0) >= 3) ?? levels.find((l) => (counts.get(l) ?? 0) >= 1);
  if (!level) return { level: 0, names: [], polys: [], clip };

  // Pass 2: that level's areas inside the country.
  const found = [];
  for await (const f of admin()) {
    if (f.level !== level || !f.p.name) continue;
    const rings = ringsOf(f.geometry);
    if (!rings.length) continue;
    const [la, lo] = innerPoint(rings);
    if (clip && !insideRings(clip, la, lo)) continue; // a neighbour's area
    found.push({ name: String(f.p['name:en'] || f.p.name), rings });
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Map();
  const names = found.map((f) => {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    return n > 1 ? `${f.name} (${n})` : f.name;
  });
  return { level: Number(level), names, polys: found.map((f) => f.rings), clip };
}

module.exports = { chooseAreas, insideRings, ringsOf, simplifyRing };

if (require.main === module) {
  const [regionId, adminFile, outFile] = process.argv.slice(2);
  chooseAreas(regionId, adminFile)
    .then((a) => {
      fs.writeFileSync(outFile, JSON.stringify(a));
      const missing = a.names.filter((_, i) => !a.polys[i]);
      console.log(`areas: ${a.names.length} at admin level ${a.level}${a.clip ? ', cut to the country border' : ''}${missing.length ? ` (no boundary for ${missing.join(', ')})` : ''}`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
