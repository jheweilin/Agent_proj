#!/usr/bin/env python3
"""Quick-look plots for COMSOL data blocks extracted by the platform.

Usage: python comsol_quickplot.py <data_dir>
For every <name>.csv with a <name>.meta.json next to it, writes <name>.png:
  kind=grid2d -> colour map (NaN = outside the geometry), kind=line -> curve,
  kind=table  -> first column vs the other columns.
Prints one JSON line per plot with basic statistics, for the agent to sanity-check.
"""
import csv
import json
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["font.sans-serif"] = ["WenQuanYi Zen Hei", "Noto Sans CJK JP", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False


def read_csv(path: Path):
    with path.open() as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    data = np.array([[float(x) if x not in ("", "NaN", "nan") else math.nan for x in r] for r in body if r], dtype=float)
    return header, data


def stats(v):
    v = v[np.isfinite(v)]
    if v.size == 0:
        return {"finite_points": 0}
    return {"finite_points": int(v.size), "min": float(v.min()), "max": float(v.max()), "mean": float(v.mean())}


def plot_one(csv_path: Path, meta: dict) -> dict:
    header, d = read_csv(csv_path)
    name, unit, kind = meta.get("name", csv_path.stem), meta.get("unit", ""), meta.get("kind", "table")
    label = f"{name} [{unit}]" if unit else name
    out = csv_path.with_suffix(".png")
    if kind == "grid2d" and d.shape[1] >= 3:
        nx, ny = int(meta.get("nx", 0)), int(meta.get("ny", 0))
        if not nx or not ny or nx * ny != len(d):
            xs, ys = np.unique(d[:, 0]), np.unique(d[:, 1])
            nx, ny = len(xs), len(ys)
        x = d[:, 0].reshape(ny, nx)
        y = d[:, 1].reshape(ny, nx)
        v = np.ma.masked_invalid(d[:, 2].reshape(ny, nx))
        fig, ax = plt.subplots(figsize=(6.4, 5.2), dpi=130)
        m = ax.pcolormesh(x, y, v, shading="auto", cmap="viridis")
        try:
            if np.isfinite(v.filled(np.nan)).sum() > 10 and float(v.max()) > float(v.min()):
                ax.contour(x, y, v, levels=10, colors="white", linewidths=0.5, alpha=0.7)
        except Exception:
            pass
        fig.colorbar(m, ax=ax, label=label)
        ax.set_xlabel(f"{header[0]} (m)")
        ax.set_ylabel(f"{header[1]} (m)")
        ax.set_aspect("equal", adjustable="box")
        ax.set_title(label)
        st = stats(d[:, 2])
    elif kind == "line" and d.shape[1] >= 4:
        fig, ax = plt.subplots(figsize=(6.4, 4.2), dpi=130)
        ax.plot(d[:, 0], d[:, 3], lw=1.6)
        ax.set_xlabel("arc length (m)")
        ax.set_ylabel(label)
        ax.grid(alpha=0.3)
        ax.set_title(f"{label} along ({d[0,1]:.3g}, {d[0,2]:.3g}) → ({d[-1,1]:.3g}, {d[-1,2]:.3g})")
        st = stats(d[:, 3])
    else:
        fig, ax = plt.subplots(figsize=(6.4, 4.2), dpi=130)
        for i in range(1, d.shape[1]):
            ax.plot(d[:, 0], d[:, i], marker="o", ms=3, lw=1.4, label=header[i])
        ax.set_xlabel(header[0])
        if d.shape[1] > 2:
            ax.legend()
        ax.grid(alpha=0.3)
        ax.set_title(name)
        st = stats(d[:, 1:].ravel()) if d.shape[1] > 1 else {}
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)
    return {"name": name, "kind": kind, "csv": str(csv_path), "png": str(out), "rows": int(len(d)), **st}


def main():
    root = Path(sys.argv[1])
    for meta_path in sorted(root.glob("*.meta.json")):
        csv_path = meta_path.with_name(meta_path.name.replace(".meta.json", ".csv"))
        if not csv_path.exists():
            continue
        try:
            print(json.dumps(plot_one(csv_path, json.loads(meta_path.read_text()))), flush=True)
        except Exception as e:
            print(json.dumps({"name": csv_path.stem, "error": f"{type(e).__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    main()
