// Cuts a big region into a grid of parts for building one at a time.
//
//   node split.js "(minlon,minlat,maxlon,maxlat)" <parts> <parts dir>
//
// Writes <parts dir>/extract.json (for `osmium extract -c`) and prints one
// line per part: "<name> <minLat>,<minLon>,<maxLat>,<maxLon>". The boxes
// don't overlap; osmium's "smart" cut keeps every road that crosses a box
// edge whole in both parts, and build.js only counts a road piece in the
// part its middle is in.

const fs = require('fs');
const path = require('path');

const [boxArg, nArg, dir] = process.argv.slice(2);
const [minLon, minLat, maxLon, maxLat] = (boxArg.match(/-?\d+(\.\d+)?/g) || []).map(Number);
const n = Math.max(1, Number(nArg) || 1);
const midLat = (minLat + maxLat) / 2;
const wKm = (maxLon - minLon) * 111.32 * Math.cos((midLat * Math.PI) / 180);
const hKm = (maxLat - minLat) * 110.57;
let cols = Math.max(1, Math.round(Math.sqrt((n * wKm) / Math.max(1, hKm))));
let rows = Math.max(1, Math.ceil(n / cols));
cols = Math.max(1, Math.ceil(n / rows));
fs.mkdirSync(dir, { recursive: true });
const extracts = [];
const lines = [];
let k = 0;
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const la0 = minLat + ((maxLat - minLat) * r) / rows;
    const la1 = r === rows - 1 ? maxLat + 0.001 : minLat + ((maxLat - minLat) * (r + 1)) / rows;
    const lo0 = minLon + ((maxLon - minLon) * c) / cols;
    const lo1 = c === cols - 1 ? maxLon + 0.001 : minLon + ((maxLon - minLon) * (c + 1)) / cols;
    const name = `p${String(k++).padStart(2, '0')}`;
    const f = (x) => Math.round(x * 1e5) / 1e5;
    extracts.push({ output: `${name}.osm.pbf`, bbox: [f(lo0), f(la0), f(lo1), f(la1)] });
    lines.push(`${name} ${f(la0)},${f(lo0)},${f(la1)},${f(lo1)}`);
  }
}
fs.writeFileSync(path.join(dir, 'extract.json'), JSON.stringify({ directory: path.resolve(dir), extracts }, null, 2));
console.log(lines.join('\n'));
