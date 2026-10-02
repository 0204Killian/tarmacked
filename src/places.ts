// Towns, villages and other named places (places.json from the road data),
// searched on the phone, so finding a town works with no signal. Several
// regions' lists can be added (cross-border trips).

import { haversine, Coord } from './geo';

export type PlacesFile = { kinds: string[]; places: [string, number, number, number][] };
export type Place = { name: string; subtitle: string; lat: number; lon: number; source: 'offline' | 'online' };

// Bigger places first when names match equally well.
const KIND_RANK: Record<string, number> = { city: 0, town: 1, village: 2, suburb: 3, hamlet: 4, neighbourhood: 5, locality: 6, isolated_dwelling: 7 };
const KIND_LABEL: Record<string, string> = {
  city: 'City', town: 'Town', village: 'Village', suburb: 'Area', hamlet: 'Hamlet', neighbourhood: 'Area', locality: 'Place', isolated_dwelling: 'Place',
};

// Lower case, no fadas or accents, apostrophes and dots dropped.
const ACCENTS: Record<string, string> = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', à: 'a', è: 'e', ì: 'i', ò: 'o', ù: 'u', â: 'a', ê: 'e', î: 'i', ô: 'o', û: 'u', ä: 'a', ë: 'e', ï: 'i', ö: 'o', ü: 'u', ç: 'c', ñ: 'n' };
export function fold(s: string): string {
  let t = s.toLowerCase();
  try {
    t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch {
    // no normalize() on this engine: the common accents by hand
  }
  return t
    .replace(/[áéíóúàèìòùâêîôûäëïöüçñ]/g, (c) => ACCENTS[c] ?? c)
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

type Entry = { name: string; folded: string; words: string[]; lat: number; lon: number; kind: string };

export class Places {
  private list: Entry[] = [];
  private regions = new Set<string>();

  get size() {
    return this.list.length;
  }

  add(region: string, file: PlacesFile) {
    if (this.regions.has(region) || !file || !Array.isArray(file.places)) return;
    this.regions.add(region);
    for (const [name, lat, lon, k] of file.places) {
      if (!name) continue;
      const folded = fold(name);
      this.list.push({ name, folded, words: folded.split(' '), lat, lon, kind: file.kinds?.[k] ?? 'locality' });
    }
  }

  /** Best matches for what's typed so far, nearer and bigger places first. */
  search(query: string, near: Coord | null, limit = 8): Place[] {
    const q = fold(query);
    if (q.length < 2) return [];
    const qWords = q.split(' ');
    const scored: { e: Entry; score: number }[] = [];
    for (const e of this.list) {
      let match: number;
      if (e.folded === q) match = 0;
      else if (e.folded.startsWith(q)) match = 1;
      else if (qWords.every((w) => e.words.some((x) => x.startsWith(w)))) match = 2;
      else continue;
      const km = near ? haversine(near, [e.lat, e.lon]) / 1000 : 0;
      // A match quality step is worth ~100 km; a size step ~25 km.
      const score = match * 100 + (KIND_RANK[e.kind] ?? 7) * 25 + Math.min(300, km);
      scored.push({ e, score });
    }
    scored.sort((a, b) => a.score - b.score);
    const out: Place[] = [];
    const seen = new Set<string>();
    for (const { e } of scored) {
      // The same name twice (a town and its townland): keep the first, unless far apart.
      const key = `${e.folded}|${Math.round(e.lat * 10)}|${Math.round(e.lon * 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const km = near ? haversine(near, [e.lat, e.lon]) / 1000 : null;
      const label = KIND_LABEL[e.kind] ?? 'Place';
      out.push({ name: e.name, subtitle: km === null ? label : `${label} · ${km < 10 ? km.toFixed(1) : Math.round(km)} km away`, lat: e.lat, lon: e.lon, source: 'offline' });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The nearest town or village to a point, for naming a dropped pin. */
  nearest(at: Coord, maxKm = 8): { name: string; km: number } | null {
    let best: Entry | null = null;
    let bestScore = Infinity;
    for (const e of this.list) {
      if (Math.abs(e.lat - at[0]) > 0.1 || Math.abs(e.lon - at[1]) > 0.15) continue;
      const d = haversine(at, [e.lat, e.lon]) / 1000;
      if (d > maxKm) continue;
      // Prefer a real town a bit further over a townland next door.
      const score = d + (KIND_RANK[e.kind] ?? 7) * 0.6;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best ? { name: best.name, km: haversine(at, [best.lat, best.lon]) / 1000 } : null;
  }
}
