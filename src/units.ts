// Metric or imperial (v0.21): how distances and speeds are shown and
// spoken. Metric is the default; imperial is an option (and the default for
// a phone first set up in the UK). Everything is stored in metres and km/h;
// only what's shown changes, so switching is instant and loses nothing.

export type Units = 'metric' | 'imperial';

const M_PER_MILE = 1609.344;
const M_PER_YARD = 0.9144;
const KMH_PER_MPH = 1.609344;

let current: Units = 'metric';
export const getUnits = () => current;
export function setUnits(u: Units) {
  current = u === 'imperial' ? 'imperial' : 'metric';
}

/** The distance as a number in km or miles ("12.3"). */
export function distNum(m: number, dp = 1, u: Units = current): string {
  return (u === 'imperial' ? m / M_PER_MILE : m / 1000).toFixed(dp);
}
export const distUnit = (u: Units = current) => (u === 'imperial' ? 'mi' : 'km');
/** "12.3 km" or "7.6 mi". */
export const dist = (m: number, dp = 1, u: Units = current) => `${distNum(m, dp, u)} ${distUnit(u)}`;
/** Fewer decimals once it's long: "1.4 km", "25 km". */
export function distShort(m: number, wholeFrom = 10, u: Units = current): string {
  const n = u === 'imperial' ? m / M_PER_MILE : m / 1000;
  return `${n.toFixed(n >= wholeFrom ? 0 : 1)} ${distUnit(u)}`;
}

/** A speed limit (stored in km/h) as shown: 100 → 100, or 62 mph; 48 (30 mph roads) → 30. */
export function speedNum(kmh: number, u: Units = current): number {
  return u === 'imperial' ? Math.round(kmh / KMH_PER_MPH) : Math.round(kmh);
}

/**
 * Spoken distance to a turn. Metric: "In 300 metres", "In 1.5 kilometres".
 * Imperial, the way UK sat-navs say it: yards up to a quarter of a mile,
 * then "a quarter of a mile", "half a mile", "three quarters of a mile",
 * then miles.
 */
export function spokenDistance(m: number, u: Units = current): string {
  if (u === 'metric') {
    if (m >= 950) {
      const km = Math.round(m / 500) / 2;
      return `In ${km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)} kilometre${km === 1 ? '' : 's'}`;
    }
    const r = m >= 200 ? Math.round(m / 100) * 100 : Math.max(50, Math.round(m / 50) * 50);
    return `In ${r} metres`;
  }
  const yd = m / M_PER_YARD;
  const mi = m / M_PER_MILE;
  if (yd < 400) {
    const r = yd >= 200 ? Math.round(yd / 100) * 100 : Math.max(50, Math.round(yd / 50) * 50);
    return `In ${r} yards`;
  }
  if (mi < 0.375) return 'In a quarter of a mile';
  if (mi < 0.625) return 'In half a mile';
  if (mi < 0.875) return 'In three quarters of a mile';
  if (mi < 1.25) return 'In 1 mile';
  const r = mi >= 10 ? Math.round(mi) : Math.round(mi * 2) / 2;
  return `In ${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)} miles`;
}

/** Distance on the turn banner: "300 m", "1.5 km"; "250 yd", "0.4 mi", "12 mi". */
export function shortDistance(m: number, u: Units = current): string {
  if (u === 'metric') {
    if (m >= 1000) return `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km`;
    return `${m >= 200 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10)} m`;
  }
  const yd = m / M_PER_YARD;
  const mi = m / M_PER_MILE;
  if (mi < 0.25) return `${yd >= 100 ? Math.round(yd / 50) * 50 : Math.max(10, Math.round(yd / 10) * 10)} yd`;
  return `${mi.toFixed(mi >= 10 ? 0 : 1)} mi`;
}
