// The road-data regions: one per country (a few islands share one), each
// built from its Geofabrik extract and published as its own folder and
// manifest entry on tiles.tarmacked.com. Ireland and Northern Ireland stay
// together as 'ie' (one island, one extract, and the app's home region).
//
//   id     manifest key and folder name (never change one once published)
//   slug   Geofabrik path under https://download.geofabrik.de/
//   clip   ISO country code whose border the roads are cut to (so two
//          countries never count the same road), or null for islands
//   level  OSM admin level of the "county" areas used for stats (the build
//          falls back to another level if this one finds too few)
//   main   road types in the routing graph: 10 = down to tertiary roads,
//          8 = down to secondary roads (big countries, to keep it small)
//   num    the region's number (its place in this list): the app files each
//          area as num * 1000 + its index, so areas of different regions
//          never share a code. Only ever add regions at the end.
//   country  ISO code of the country its areas belong to, for the app's
//          country totals (Ireland's region splits it: Northern Ireland's
//          six counties count for the UK, 'GB')
//
//   node regions.js ids                  every id
//   node regions.js matrix all|ie,gb,fr  a JSON list, for GitHub Actions
//   node regions.js get ie               KEY=value lines, for run.sh

const REGIONS = [
  { id: 'ie', name: 'Ireland & Northern Ireland', slug: 'europe/ireland-and-northern-ireland', clip: null, level: 6, main: 10 },
  { id: 'gb', name: 'Great Britain', slug: 'europe/great-britain', clip: 'GB', level: 6, main: 8 },
  { id: 'im', name: 'Isle of Man', slug: 'europe/isle-of-man', clip: null, level: 6, main: 10 },
  { id: 'gj', name: 'Guernsey & Jersey', slug: 'europe/guernsey-jersey', clip: null, level: 6, main: 10 },
  { id: 'fr', name: 'France', slug: 'europe/france', clip: 'FR', level: 6, main: 8 },
  { id: 'de', name: 'Germany', slug: 'europe/germany', clip: 'DE', level: 6, main: 8 },
  { id: 'it', name: 'Italy', slug: 'europe/italy', clip: 'IT', level: 6, main: 8 },
  { id: 'es', name: 'Spain', slug: 'europe/spain', clip: 'ES', level: 6, main: 8 },
  { id: 'pt', name: 'Portugal', slug: 'europe/portugal', clip: 'PT', level: 6, main: 10 },
  { id: 'nl', name: 'Netherlands', slug: 'europe/netherlands', clip: 'NL', level: 4, main: 8 },
  { id: 'be', name: 'Belgium', slug: 'europe/belgium', clip: 'BE', level: 6, main: 8 },
  { id: 'lu', name: 'Luxembourg', slug: 'europe/luxembourg', clip: 'LU', level: 6, main: 10 },
  { id: 'ch', name: 'Switzerland', slug: 'europe/switzerland', clip: 'CH', level: 4, main: 10 },
  { id: 'li', name: 'Liechtenstein', slug: 'europe/liechtenstein', clip: 'LI', level: 8, main: 10 },
  { id: 'at', name: 'Austria', slug: 'europe/austria', clip: 'AT', level: 6, main: 10 },
  { id: 'dk', name: 'Denmark', slug: 'europe/denmark', clip: 'DK', level: 7, main: 10 },
  { id: 'se', name: 'Sweden', slug: 'europe/sweden', clip: 'SE', level: 4, main: 10 },
  { id: 'no', name: 'Norway', slug: 'europe/norway', clip: 'NO', level: 4, main: 10 },
  { id: 'fi', name: 'Finland', slug: 'europe/finland', clip: 'FI', level: 6, main: 10 },
  { id: 'is', name: 'Iceland', slug: 'europe/iceland', clip: null, level: 5, main: 10 },
  { id: 'fo', name: 'Faroe Islands', slug: 'europe/faroe-islands', clip: null, level: 6, main: 10 },
  { id: 'ee', name: 'Estonia', slug: 'europe/estonia', clip: 'EE', level: 6, main: 10 },
  { id: 'lv', name: 'Latvia', slug: 'europe/latvia', clip: 'LV', level: 6, main: 10 },
  { id: 'lt', name: 'Lithuania', slug: 'europe/lithuania', clip: 'LT', level: 5, main: 10 },
  { id: 'pl', name: 'Poland', slug: 'europe/poland', clip: 'PL', level: 6, main: 8 },
  { id: 'cz', name: 'Czechia', slug: 'europe/czech-republic', clip: 'CZ', level: 6, main: 8 },
  { id: 'sk', name: 'Slovakia', slug: 'europe/slovakia', clip: 'SK', level: 4, main: 10 },
  { id: 'hu', name: 'Hungary', slug: 'europe/hungary', clip: 'HU', level: 6, main: 10 },
  { id: 'si', name: 'Slovenia', slug: 'europe/slovenia', clip: 'SI', level: 8, main: 10 },
  { id: 'hr', name: 'Croatia', slug: 'europe/croatia', clip: 'HR', level: 6, main: 10 },
  { id: 'ba', name: 'Bosnia and Herzegovina', slug: 'europe/bosnia-herzegovina', clip: 'BA', level: 6, main: 10 },
  { id: 'rs', name: 'Serbia', slug: 'europe/serbia', clip: 'RS', level: 6, main: 10 },
  { id: 'me', name: 'Montenegro', slug: 'europe/montenegro', clip: 'ME', level: 6, main: 10 },
  { id: 'xk', name: 'Kosovo', slug: 'europe/kosovo', clip: 'XK', level: 4, main: 10 },
  { id: 'mk', name: 'North Macedonia', slug: 'europe/macedonia', clip: 'MK', level: 6, main: 10 },
  { id: 'al', name: 'Albania', slug: 'europe/albania', clip: 'AL', level: 6, main: 10 },
  { id: 'gr', name: 'Greece', slug: 'europe/greece', clip: 'GR', level: 6, main: 10 },
  { id: 'bg', name: 'Bulgaria', slug: 'europe/bulgaria', clip: 'BG', level: 6, main: 10 },
  { id: 'ro', name: 'Romania', slug: 'europe/romania', clip: 'RO', level: 4, main: 10 },
  { id: 'md', name: 'Moldova', slug: 'europe/moldova', clip: 'MD', level: 4, main: 10 },
  { id: 'ua', name: 'Ukraine', slug: 'europe/ukraine', clip: 'UA', level: 4, main: 10 },
  { id: 'by', name: 'Belarus', slug: 'europe/belarus', clip: 'BY', level: 4, main: 10 },
  { id: 'cy', name: 'Cyprus', slug: 'europe/cyprus', clip: null, level: 6, main: 10 },
  { id: 'mt', name: 'Malta', slug: 'europe/malta', clip: null, level: 6, main: 10 },
  { id: 'ad', name: 'Andorra', slug: 'europe/andorra', clip: 'AD', level: 7, main: 10 },
  { id: 'mc', name: 'Monaco', slug: 'europe/monaco', clip: 'MC', level: 8, main: 10 },
];

// Countries the regions without a border cut (islands) belong to.
const ISLAND_COUNTRY = { ie: 'IE', im: 'IM', gj: 'GJ', is: 'IS', fo: 'FO', cy: 'CY', mt: 'MT' };
REGIONS.forEach((r, i) => {
  r.num = i;
  r.country = r.clip ?? ISLAND_COUNTRY[r.id] ?? r.id.toUpperCase();
});
// Areas per region must stay under this (the app's code = num * 1000 + index).
const MAX_AREAS = 1000;

const byId = (id) => REGIONS.find((r) => r.id === id);

module.exports = { REGIONS, byId, MAX_AREAS };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'ids') {
    console.log(REGIONS.map((r) => r.id).join(' '));
  } else if (cmd === 'matrix') {
    const want = !arg || arg === 'all' ? REGIONS.map((r) => r.id) : arg.split(/[\s,]+/).filter(Boolean);
    const bad = want.filter((id) => !byId(id));
    if (bad.length) {
      console.error(`Unknown region(s): ${bad.join(', ')}`);
      process.exit(1);
    }
    console.log(JSON.stringify(want));
  } else if (cmd === 'get') {
    const r = byId(arg);
    if (!r) {
      console.error(`Unknown region ${arg}`);
      process.exit(1);
    }
    console.log(`R_NAME='${r.name.replace(/'/g, '')}'\nR_SLUG=${r.slug}\nR_CLIP=${r.clip ?? ''}\nR_LEVEL=${r.level}\nR_MAIN=${r.main}`);
  } else {
    console.error('Usage: node regions.js ids | matrix <all|ids> | get <id>');
    process.exit(1);
  }
}
