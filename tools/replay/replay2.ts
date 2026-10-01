// Re-check starting from the user's real map (backup's driven roads), as the app does.
import * as fs from 'fs';
import { RoadNetwork, RoadSegment } from '../SRC/roadMatcher';
import { recheckDrives } from '../SRC/recheck';
declare const process: any;
const backup = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const net = new RoadNetwork();
for (const f of fs.readdirSync('/home/claude/repo/tiles')) if (f.startsWith('t_')) net.add(JSON.parse(fs.readFileSync('/home/claude/repo/tiles/' + f, 'utf8')).segments as RoadSegment[]);
const drives = backup.drives.map((d: any, i: number) => ({ id: i + 1, startedAt: d.startedAt, points: d.points.map((p: number[]) => ({ latitude: p[0], longitude: p[1], timestamp: p[2], accuracy: p[3] ?? null })) }));
const current = new Map<string, any>(backup.driven.map((d: any) => [d.id, d.s]));
const firstAt = new Map<string, number>(backup.driven.map((d: any) => [d.id, d.t]));
const trailsSince = Math.min(...drives.map((d: any) => d.startedAt));
(async () => {
  const withHistory = process.argv[4] === 'history';
  const r = await (recheckDrives as any)(net, drives, current, new Set(), new Map(), undefined, [], withHistory ? { firstAt, trailsSince } : null);
  const out = { driven: [...r.driven].map((id: string) => ({ id, shape: net.shapeOf(id) ?? current.get(id), len: net.length(id) })), add: r.add, remove: r.remove };
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  console.log(`${withHistory ? 'v0.14.2' : 'v0.14.1'}: +${r.add.length} −${r.remove.length}, ${r.driven.size} pieces, ${(out.driven.reduce((m: number, d: any) => m + d.len, 0) / 1000).toFixed(2)} km`);
})();
