// Areas (counties, council areas, départements...) and countries, across
// every road-data region (v0.21). Pure logic, so it can be tested on its own.
//
// Each region's areas are numbered from 0 in its own data; the app files
// them under one code for the whole world: region number * 1000 + index.
// Ireland's region is number 0, so its county codes never changed.
// A region can hold more than one country: Ireland's has Northern
// Ireland, whose six counties count for the United Kingdom.

export const AREA_BLOCK = 1000;
export const areaCode = (regionNum: number, index: number) => regionNum * AREA_BLOCK + index;
export const regionNumOf = (code: number) => Math.floor(code / AREA_BLOCK);

export type RegionStats = { id: string; num: number; names: string[]; meters: number[]; countries: string[] };
export type Area = { code: number; name: string; country: string; meters: number };
export type Country = { iso: string; name: string; meters: number; areas: number[] };
export type AreaBook = { areas: Map<number, Area>; countries: Map<string, Country> };

// Names for the countries our regions cover (ISO codes as the pipeline
// writes them; GJ is our own code for the Channel Islands).
const COUNTRY_NAMES: Record<string, string> = {
  IE: 'Ireland', GB: 'United Kingdom', IM: 'Isle of Man', GJ: 'Channel Islands', FR: 'France', DE: 'Germany', IT: 'Italy',
  ES: 'Spain', PT: 'Portugal', NL: 'Netherlands', BE: 'Belgium', LU: 'Luxembourg', CH: 'Switzerland', LI: 'Liechtenstein',
  AT: 'Austria', DK: 'Denmark', SE: 'Sweden', NO: 'Norway', FI: 'Finland', IS: 'Iceland', FO: 'Faroe Islands', EE: 'Estonia',
  LV: 'Latvia', LT: 'Lithuania', PL: 'Poland', CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary', SI: 'Slovenia', HR: 'Croatia',
  BA: 'Bosnia and Herzegovina', RS: 'Serbia', ME: 'Montenegro', XK: 'Kosovo', MK: 'North Macedonia', AL: 'Albania',
  GR: 'Greece', BG: 'Bulgaria', RO: 'Romania', MD: 'Moldova', UA: 'Ukraine', BY: 'Belarus', CY: 'Cyprus', MT: 'Malta',
  AD: 'Andorra', MC: 'Monaco', US: 'United States',
};
export const countryName = (iso: string) => COUNTRY_NAMES[iso] ?? iso;

/** "County Kilkenny" → "Kilkenny" (and the same for "County Antrim"). */
export const shortArea = (name: string) => name.replace(/^County /, '');

/**
 * A region's figures from its stats.json. Data from before v0.21 has no
 * countries: Ireland's region then counts its first 26 counties for
 * Ireland and the rest (Northern Ireland) for the UK. Even older data has
 * only the 26 counties (counties / totalMeters).
 */
export function regionStatsFrom(json: any, id: string, num: number, country: string): RegionStats | null {
  if (!json) return null;
  const names: string[] | null = Array.isArray(json.areas) && Array.isArray(json.areaMeters) ? json.areas : Array.isArray(json.counties) ? json.counties : null;
  const meters: number[] | null = Array.isArray(json.areas) && Array.isArray(json.areaMeters) ? json.areaMeters : Array.isArray(json.totalMeters) ? json.totalMeters : null;
  if (!names || !meters || names.length !== meters.length) return null;
  const countries: string[] = Array.isArray(json.areaCountry) && json.areaCountry.length === names.length
    ? json.areaCountry
    : names.map((_, i) => (id === 'ie' ? (i < 26 ? 'IE' : 'GB') : country));
  return { id, num: typeof json.num === 'number' ? json.num : num, names, meters: meters.map((m) => Number(m) || 0), countries };
}

/** Every area of these regions, and the countries they add up to. */
export function buildBook(regions: RegionStats[]): AreaBook {
  const areas = new Map<number, Area>();
  const countries = new Map<string, Country>();
  for (const r of regions) {
    r.names.forEach((name, i) => {
      const code = areaCode(r.num, i);
      const iso = r.countries[i];
      const meters = r.meters[i];
      areas.set(code, { code, name, country: iso, meters });
      let c = countries.get(iso);
      if (!c) countries.set(iso, (c = { iso, name: countryName(iso), meters: 0, areas: [] }));
      c.meters += meters;
      c.areas.push(code);
    });
  }
  return { areas, countries };
}

export type AreaRow = { code: number; name: string; country: string; driven: number; total: number; percent: number };
export type CountryRow = { iso: string; name: string; driven: number; total: number; percent: number };

/**
 * Driven and total road per area and per country. Roads marked private or
 * gone come off the totals (so 100% can be reached). Areas with no road
 * (no boundary found in the data) are left out.
 */
export function figures(book: AreaBook, driven: Map<number, number>, excluded: Map<number, number>): { areas: AreaRow[]; countries: CountryRow[] } {
  const areas: AreaRow[] = [];
  const byCountry = new Map<string, CountryRow>();
  book.areas.forEach((a) => {
    if (a.meters <= 0) return;
    const total = Math.max(0, a.meters - (excluded.get(a.code) ?? 0));
    const d = Math.min(total, driven.get(a.code) ?? 0);
    areas.push({ code: a.code, name: a.name, country: a.country, driven: d, total, percent: total > 0 ? (d / total) * 100 : 0 });
    let c = byCountry.get(a.country);
    if (!c) byCountry.set(a.country, (c = { iso: a.country, name: countryName(a.country), driven: 0, total: 0, percent: 0 }));
    c.driven += d;
    c.total += total;
  });
  const countries = [...byCountry.values()];
  countries.forEach((c) => (c.percent = c.total > 0 ? (c.driven / c.total) * 100 : 0));
  return { areas, countries };
}

/** Most complete first, then most driven, then A to Z. */
export const byCompletion = <T extends { percent: number; driven: number; name: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => b.percent - a.percent || b.driven - a.driven || a.name.localeCompare(b.name));

// --- badges (v0.21) ---

export type Badge = 'bronze' | 'silver' | 'gold' | 'platinum';
export const BADGES: { badge: Badge; at: number; label: string; color: string }[] = [
  { badge: 'bronze', at: 10, label: 'Bronze', color: '#c8834b' },
  { badge: 'silver', at: 30, label: 'Silver', color: '#c7ccd1' },
  { badge: 'gold', at: 60, label: 'Gold', color: '#e8b931' },
  { badge: 'platinum', at: 100, label: 'Platinum', color: '#b9f2ff' },
];

/**
 * The badge an area has earned. Platinum needs every road (rounding to
 * 100.00% isn't enough: a few metres short still says 99.99).
 */
export function badgeFor(row: { driven: number; total: number; percent: number }): (typeof BADGES)[number] | null {
  let got: (typeof BADGES)[number] | null = null;
  for (const b of BADGES) {
    const reached = b.at >= 100 ? row.total > 0 && row.driven >= row.total - 0.5 : row.percent >= b.at;
    if (reached) got = b;
  }
  return got;
}

/** The next badge and how far off it is, for "12.4% to silver". */
export function nextBadge(row: { percent: number; driven: number; total: number }): { badge: (typeof BADGES)[number]; toGo: number } | null {
  const have = badgeFor(row);
  const next = BADGES.find((b) => !have || b.at > have.at);
  if (!next) return null;
  return { badge: next, toGo: Math.max(0, next.at - row.percent) };
}
