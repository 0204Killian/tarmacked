// Draws your driven roads into small map images ("tiles"), which the map
// shows as a single image layer. Drawing thousands of separate lines is
// what made the map slow; a handful of pictures is cheap to show.
//
// The pictures are only a display cache: they're redrawn from the driven
// roads in the database whenever those change, and live in the phone's
// cache folder, so iOS may clear them at any time without losing anything.
//
// Tiles use the standard web map grid (zoom z, column x, row y), drawn at
// double resolution for sharpness. Only the area on screen (plus a margin)
// is drawn, at the zoom levels the map is likely to ask for.

import { Skia, PaintStyle, StrokeCap, StrokeJoin, SkSurface } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';
import { Coord, lonToWorldX, latToWorldY } from './geo';

const TILE_PX = 512; // drawn at 2x; shown as 256-point tiles
const SCALE = TILE_PX / 256;
const MIN_Z = 3;
const MAX_Z = 19;
const MAX_TILES_PER_LEVEL = 300;
const GRID_DEG = 0.02; // lookup grid for shapes, ~2km

export type ViewRegion = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };

type Shape = { coords: Coord[]; minLat: number; maxLat: number; minLon: number; maxLon: number };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function strokeFor(z: number) {
  if (z >= 14) return { outline: 7, core: 4 };
  if (z >= 11) return { outline: 5, core: 3 };
  return { outline: 3.5, core: 2 };
}

export class DrivenTileRenderer {
  private root: Directory;
  private gen = 0;
  private rendered = new Set<string>();
  private shapes: Shape[] = [];
  private grid = new Map<string, number[]>();
  private surface: SkSurface | null = null;
  private job = 0;

  constructor() {
    this.root = new Directory(Paths.cache, 'driven-tiles');
    // Start clean each launch — tiles from last time may be out of date.
    try {
      if (this.root.exists) this.root.delete();
    } catch {
      // ignore — a fresh generation folder is used anyway
    }
    this.root.create({ intermediates: true, idempotent: true });
    this.surface = Skia.Surface.Make(TILE_PX, TILE_PX) ?? Skia.Surface.MakeOffscreen(TILE_PX, TILE_PX);
    if (!this.surface) throw new Error("couldn't create a drawing surface");
  }

  // What the map's image layer reads. Changes whenever the roads change,
  // which makes the map drop its old pictures.
  get pathTemplate(): string {
    const base = decodeURI(this.root.uri.replace(/^file:\/\//, '')).replace(/\/?$/, '/');
    return `${base}g${this.gen}/{z}/{x}/{y}.png`;
  }

  get generation() {
    return this.gen;
  }

  // New set of driven roads: start a fresh generation of pictures.
  setShapes(shapes: Coord[][]) {
    const old = new Directory(this.root, `g${this.gen}`);
    this.gen++;
    this.job++; // cancels any drawing still running for the old roads
    this.rendered.clear();
    try {
      if (old.exists) old.delete();
    } catch {
      // not fatal
    }
    this.shapes = [];
    this.grid.clear();
    for (const coords of shapes) {
      if (coords.length < 2) continue;
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      for (const [la, lo] of coords) {
        if (la < minLat) minLat = la;
        if (la > maxLat) maxLat = la;
        if (lo < minLon) minLon = lo;
        if (lo > maxLon) maxLon = lo;
      }
      const i = this.shapes.push({ coords, minLat, maxLat, minLon, maxLon }) - 1;
      for (let a = Math.floor(minLat / GRID_DEG); a <= Math.floor(maxLat / GRID_DEG); a++) {
        for (let b = Math.floor(minLon / GRID_DEG); b <= Math.floor(maxLon / GRID_DEG); b++) {
          const k = `${a}_${b}`;
          const list = this.grid.get(k);
          if (list) list.push(i);
          else this.grid.set(k, [i]);
        }
      }
    }
  }

  /**
   * Draws any missing pictures for the area on screen. Returns how many
   * new picture files were written (0 = nothing new for the map to show).
   */
  async renderRegion(region: ViewRegion, screenWidthPts: number): Promise<number> {
    const job = ++this.job;
    const gen = this.gen;
    const zf = Math.log2((360 * screenWidthPts) / (256 * Math.max(region.longitudeDelta, 1e-6)));
    const z0 = Math.max(MIN_Z, Math.min(MAX_Z, Math.floor(zf)));
    const levels = [z0, z0 + 1, z0 + 2].filter((z) => z <= MAX_Z);
    // Screen area plus half a screen of margin each way.
    const minLat = region.latitude - region.latitudeDelta;
    const maxLat = region.latitude + region.latitudeDelta;
    const minLon = region.longitude - region.longitudeDelta;
    const maxLon = region.longitude + region.longitudeDelta;

    let written = 0;
    for (const z of levels) {
      const x0 = Math.floor(lonToWorldX(minLon, z) / 256);
      const x1 = Math.floor(lonToWorldX(maxLon, z) / 256);
      const y0 = Math.floor(latToWorldY(maxLat, z) / 256);
      const y1 = Math.floor(latToWorldY(minLat, z) / 256);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES_PER_LEVEL) continue;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          if (job !== this.job || gen !== this.gen) return written; // superseded
          const key = `${z}/${x}/${y}`;
          if (this.rendered.has(key)) continue;
          this.rendered.add(key);
          if (this.drawTile(z, x, y)) {
            written++;
            if (written % 8 === 0) await tick();
          }
        }
      }
    }
    return written;
  }

  // Returns true if a picture was written (tiles with no roads are skipped).
  private drawTile(z: number, x: number, y: number): boolean {
    const { outline, core } = strokeFor(z);
    const originX = x * 256;
    const originY = y * 256;
    // Tile bounds in degrees, padded by the line width.
    const padPx = outline;
    const n = 256 * 2 ** z;
    const lonAt = (px: number) => (px / n) * 360 - 180;
    const latAt = (py: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * py) / n));
    const tMinLon = lonAt(originX - padPx);
    const tMaxLon = lonAt(originX + 256 + padPx);
    const tMaxLat = latAt(originY - padPx);
    const tMinLat = latAt(originY + 256 + padPx);

    const hits = this.shapesIn(tMinLat, tMinLon, tMaxLat, tMaxLon);
    if (hits.length === 0) return false;

    const path = Skia.Path.Make();
    for (const s of hits) {
      s.coords.forEach(([la, lo], i) => {
        const px = (lonToWorldX(lo, z) - originX) * SCALE;
        const py = (latToWorldY(la, z) - originY) * SCALE;
        if (i === 0) path.moveTo(px, py);
        else path.lineTo(px, py);
      });
    }

    const surface = this.surface!;
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('transparent'));
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeCap(StrokeCap.Round);
    paint.setStrokeJoin(StrokeJoin.Round);
    paint.setColor(Skia.Color('#0d3818'));
    paint.setStrokeWidth(outline * SCALE);
    canvas.drawPath(path, paint);
    paint.setColor(Skia.Color('#39d353'));
    paint.setStrokeWidth(core * SCALE);
    canvas.drawPath(path, paint);
    surface.flush();
    const bytes = surface.makeImageSnapshot().encodeToBytes();

    const dir = new Directory(this.root, `g${this.gen}`, String(z), String(x));
    dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `${y}.png`);
    if (file.exists) file.delete();
    file.create();
    file.write(bytes);
    return true;
  }

  private shapesIn(minLat: number, minLon: number, maxLat: number, maxLon: number): Shape[] {
    const overlaps = (s: Shape) => s.maxLat >= minLat && s.minLat <= maxLat && s.maxLon >= minLon && s.minLon <= maxLon;
    const a0 = Math.floor(minLat / GRID_DEG), a1 = Math.floor(maxLat / GRID_DEG);
    const b0 = Math.floor(minLon / GRID_DEG), b1 = Math.floor(maxLon / GRID_DEG);
    if ((a1 - a0 + 1) * (b1 - b0 + 1) > 400) return this.shapes.filter(overlaps); // zoomed out: just scan
    const seen = new Set<number>();
    const out: Shape[] = [];
    for (let a = a0; a <= a1; a++) {
      for (let b = b0; b <= b1; b++) {
        for (const i of this.grid.get(`${a}_${b}`) || []) {
          if (seen.has(i)) continue;
          seen.add(i);
          if (overlaps(this.shapes[i])) out.push(this.shapes[i]);
        }
      }
    }
    return out;
  }
}
