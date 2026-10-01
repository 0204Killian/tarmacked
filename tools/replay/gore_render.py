# Renders one gore dump: roads (grey, one-way thicker), true path (white dashed),
# GPS (blue), credited (green), wrongly credited (red).
import json, sys, math
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
D = json.load(open(sys.argv[1])); out = sys.argv[2]; half = float(sys.argv[3]) if len(sys.argv) > 3 else 0.004
lat, lon = D['at']; k = math.cos(math.radians(lat))
runs = [d for d in D['dumps'] if d['bad']][:4] or D['dumps'][:2]
fig, axs = plt.subplots(1, len(runs), figsize=(6 * len(runs), 6), facecolor='#0f1311')
if len(runs) == 1: axs = [axs]
for ax, r in zip(axs, runs):
    ax.set_facecolor('#1b2420')
    for s in D['roads']:
        ax.plot([c[1] for c in s['coords']], [c[0] for c in s['coords']], color='#55605a', lw=3 if s.get('o') else 2, zorder=1)
    ax.plot([c[1] for c in r['coords']], [c[0] for c in r['coords']], color='white', lw=1, ls='--', zorder=2)
    bad = {b['id'] for b in r['bad']}
    for g in r['got']:
        if g['shape']: ax.plot([c[1] for c in g['shape']], [c[0] for c in g['shape']], color='#ff4d4d' if g['id'] in bad else '#39d353', lw=2.5 if g['id'] in bad else 1.6, zorder=4 if g['id'] in bad else 3)
    ax.scatter([p['longitude'] for p in r['pts']], [p['latitude'] for p in r['pts']], s=6, color='#5aa0ff', zorder=5)
    ax.set_xlim(lon - half / k, lon + half / k); ax.set_ylim(lat - half, lat + half); ax.set_aspect(1 / k)
    ax.set_xticks([]); ax.set_yticks([]); ax.set_title(f"{r['route']} seed {r['seed']}: " + ', '.join(f"{b['id']} {b['m']}m" for b in r['bad'])[:70], color='white', fontsize=8)
fig.tight_layout(); fig.savefig(out, dpi=80, facecolor='#0f1311')
