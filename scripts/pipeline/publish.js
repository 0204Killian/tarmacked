// Puts newly built regions into the manifest (the file phones check for new
// road data), keeping every other region as it is live, and says which old
// versions can go.
//
//   node publish.js <out dir> [live manifest URL or file]
//
// Reads out/entry-*.json (from merge.js), writes out/manifest.json and
// out/keep.txt (for each region: the new version and the one phones are on
// now, as "<region>/<version>/" lines; older versions on R2 can be deleted).

const fs = require('fs');
const path = require('path');

const LIVE_URL = 'https://tiles.tarmacked.com/manifest.json';

async function readLive(src) {
  try {
    if (/^https?:/.test(src)) {
      const res = await fetch(src);
      if (res.ok) return await res.json();
      if (res.status === 404) return { v: 1, regions: {} };
      throw new Error(`HTTP ${res.status}`);
    }
    return JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch (e) {
    // Never publish over a manifest we couldn't read: that would drop regions.
    throw new Error(`couldn't read the live manifest (${src}): ${e.message}`);
  }
}

function publish(live, entries) {
  const manifest = { v: 1, regions: { ...(live.regions || {}) } };
  const keep = [];
  for (const e of entries) {
    const before = manifest.regions[e.id];
    if (before?.path && before.path !== e.path) keep.push(before.path);
    manifest.regions[e.id] = { version: e.version, path: e.path, tiles: e.tiles, builtAt: e.builtAt, name: e.name, bbox: e.bbox, cells: e.cells, km: e.km };
    keep.push(e.path);
  }
  // Regions not rebuilt this time: keep what they're on.
  for (const [id, r] of Object.entries(manifest.regions)) if (!entries.some((e) => e.id === id) && r.path) keep.push(r.path);
  return { manifest, keep: [...new Set(keep)].sort() };
}

module.exports = { publish };

if (require.main === module) {
  const [outDir = 'out', src = LIVE_URL] = process.argv.slice(2);
  (async () => {
    const entries = fs
      .readdirSync(outDir)
      .filter((f) => /^entry-[a-z]+\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')));
    if (!entries.length) throw new Error(`nothing built in ${outDir} (no entry-*.json)`);
    const live = await readLive(src);
    const { manifest, keep } = publish(live, entries);
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, 'keep.txt'), keep.join('\n') + '\n');
    for (const e of entries) console.log(`${e.id}: ${live.regions?.[e.id]?.version ?? 'new'} -> ${e.version} (${e.tiles} tiles, ${e.km} km)`);
    console.log(`manifest: ${Object.keys(manifest.regions).length} regions`);
  })().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
