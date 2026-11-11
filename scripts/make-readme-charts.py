#!/usr/bin/env python3
"""Regenerates the README charts that come from bench/results/*.json.

    python3 scripts/make-readme-charts.py

Writes docs/assets/precision.svg, scan-scaling.svg and agent-languages.svg.
Needs matplotlib and numpy. The numbers are read from the recorded runs, never typed in.
"""
import json, math, glob, os
import numpy as np
import matplotlib
matplotlib.use("svg")
import matplotlib.pyplot as plt

matplotlib.rcParams["svg.fonttype"] = "path"
matplotlib.rcParams["font.family"] = "DejaVu Sans"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
R = os.path.join(ROOT, "bench", "results")
OUT = os.path.join(ROOT, "docs", "assets")
BLUE, ORANGE, GREEN, GREY = "#1a7fbd", "#e8672f", "#009e73", "#8a8a8a"


def load(name):
    return json.load(open(os.path.join(R, name)))


def wilson(k, n, z=1.96):
    if n == 0:
        return 0.0, 1.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def style(ax):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.grid(color="#e3e3e3", linewidth=0.6)
    ax.set_axisbelow(True)


# ---- precision and recall ---------------------------------------------------
def precision():
    acc = sorted(glob.glob(os.path.join(R, "accuracy-*.json")))[-1]
    d = json.load(open(acc))
    t = d["totals"]
    kinds = [
        ("HTTP routes", ["routes"]), ("Call targets", ["calls"]), ("Data access", ["dataAccess"]),
        ("Components", ["components"]), ("Component renders", ["renders"]), ("Pages", ["pages"]),
        ("Frontend → backend requests", ["requests"]), ("Store reads and writes", ["stores", "storeAccess"]),
        ("Env reads", ["env"]), ("Scripts, runs, env declarations", ["scripts", "runs", "envDeclarations"]),
        ("Style links", ["styleLinks"]), ("SQL tables", ["sqlTables"]), ("gRPC / proto rpcs", ["rpcs"]),
    ]
    rows = []
    for label, ks in kinds:
        tp = sum(t[k]["tp"] for k in ks); fp = sum(t[k]["fp"] for k in ks); fn = sum(t[k]["fn"] for k in ks)
        rows.append((label, tp, fp, fn))
    fig, axes = plt.subplots(1, 2, figsize=(11, 5.6), sharey=True)
    for ax, which in zip(axes, ("precision", "recall")):
        style(ax)
        for i, (label, tp, fp, fn) in enumerate(rows):
            n = tp + (fp if which == "precision" else fn)
            v = tp / n if n else 1.0
            lo, hi = wilson(tp, n)
            ax.barh(i, v * 100, color=BLUE if which == "precision" else GREEN, height=0.62, alpha=0.9)
            ax.errorbar(v * 100, i, xerr=[[max(0, v * 100 - lo * 100)], [max(0, hi * 100 - v * 100)]], color="#222", capsize=3, lw=1)
            ax.text(101.5, i, f"{v*100:.1f}%  (n = {n})", va="center", fontsize=8.5)
        ax.set_xlim(0, 100)
        ax.set_xticks(range(0, 101, 20))
        ax.set_title("Precision: reported facts that are right" if which == "precision" else "Recall: labeled facts that are found",
                     loc="left", fontsize=10.5, fontweight="bold")
    axes[0].set_yticks(range(len(rows)))
    axes[0].set_yticklabels([r[0] for r in rows], fontsize=9)
    axes[0].invert_yaxis()
    fig.subplots_adjust(left=0.2, right=0.84, wspace=0.65, top=0.88, bottom=0.14)
    nsamples = len(d["samples"])
    fig.text(0.01, 0.02, f"Hand-written labels on {nsamples} pinned open-source samples (JS/TS, Vue, Svelte, Angular, Go, Rust); "
             f"error bars are Wilson 95% intervals. Run {os.path.basename(acc)[9:-5]}. docs/accuracy.md",
             fontsize=8, style="italic", color="#555")
    fig.savefig(os.path.join(OUT, "precision.svg"))
    plt.close(fig)


# ---- scan scaling -----------------------------------------------------------
def scaling():
    pts = {}
    for name in ("0.1.0-2026-10-29.json", "0.1.0-2026-11-04-go.json", "0.1.0-2026-11-05-go-scan.json", "0.1.0-2026-11-11-rust.json"):
        for r in load(name)["results"]:
            pts[r["sample"]] = r  # later runs replace earlier ones
    def lang(s):
        return "Go" if "go" in s.split("-") else "Rust" if "rust" in s.split("-") else "JS/TS"
    cols = {"JS/TS": BLUE, "Go": "#00a5c9", "Rust": ORANGE}
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.3))
    xs = np.array([r["nodes"] / 1000 for r in pts.values()])
    ys = np.array([r["scanCold"]["ms"] / 1000 for r in pts.values()])
    slope, icpt = np.polyfit(xs, ys, 1)
    grid = np.linspace(0, xs.max() * 1.05, 20)
    for ax, key, ylab in ((axes[0], "ms", "Cold scan, wall time (s)"), (axes[1], "maxRssMb", "Peak memory, RSS (MB)")):
        style(ax)
        for s, r in pts.items():
            v = r["scanCold"][key] / (1000 if key == "ms" else 1)
            ax.scatter(r["nodes"] / 1000, v, color=cols[lang(s)], s=36, zorder=3)
        ax.set_xlabel("Graph size (thousand nodes)")
        ax.set_ylabel(ylab)
    axes[0].plot(grid, icpt + slope * grid, "--", color=GREY, lw=1, label=f"fit: {icpt:.2f} s + {slope*1000:.0f} µs/node")
    axes[0].legend(loc="upper left", frameon=False, fontsize=8.5)
    for s, r in pts.items():
        if s in ("internet-nest", "express", "ky", "internet-rust-actix-diesel-realworld"):
            short = {"internet-nest": "nestjs/nest", "internet-rust-actix-diesel-realworld": "actix + diesel\n(shell grammar)"}.get(s, s)
            axes[1].annotate(short, (r["nodes"] / 1000, r["scanCold"]["maxRssMb"]), textcoords="offset points", xytext=(-8, -3) if s.startswith("internet-rust") else (-6, 7), ha="right", va="top" if s.startswith("internet-rust") else "bottom", fontsize=8)
    axes[0].annotate("nestjs/nest", (xs.max(), ys[list(pts).index("internet-nest")]), textcoords="offset points", xytext=(-6, 7), ha="right", fontsize=8)
    for l, c in cols.items():
        axes[1].scatter([], [], color=c, s=36, label=l)
    axes[1].legend(loc="center right", frameon=False, fontsize=8.5)
    axes[0].set_title("Scans scale linearly", loc="left", fontsize=10.5, fontweight="bold")
    axes[1].set_title("…in bounded memory", loc="left", fontsize=10.5, fontweight="bold")
    fig.subplots_adjust(left=0.07, right=0.98, bottom=0.2, top=0.9, wspace=0.22)
    fig.text(0.01, 0.02, f"Built CLI, cold cache, Apple M4, Node v24.13.0. {len(pts)} samples (JS/TS, Go, Rust, runs of 2026-10-29 to 2026-11-11); "
             "nestjs/nest = 1,714 files. docs/benchmarks.md", fontsize=8, style="italic", color="#555")
    fig.savefig(os.path.join(OUT, "scan-scaling.svg"))
    plt.close(fig)


# ---- agent benchmark on Go and Rust -----------------------------------------
def agents():
    sets = [
        ("Go, small backends\n(8 questions)", "agent-go-%s-runs3-2026-11-04.json"),
        ("Go, larger repositories\n(8 questions)", "agent-go-large-%s-runs3-2026-11-05.json"),
        ("Rust\n(10 questions)", "agent-rust-%s-runs3-2026-11-11.json"),
    ]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.4), gridspec_kw={"width_ratios": [1, 1.25]})
    ax0, ax1 = axes
    style(ax0); style(ax1)
    for i, (label, pat) in enumerate(sets):
        for j, (model, col) in enumerate((("sonnet", BLUE), ("haiku", ORANGE))):
            t = load(pat % model)["totals"]
            b, c = t["baseline"], t["concentrate"]
            change = (c["medianInputTokens"] / b["medianInputTokens"] - 1) * 100
            y = i + (j - 0.5) * 0.36
            ax1.barh(y, change, height=0.32, color=col, label=model if i == 0 else None)
            ax1.text(change + (1.2 if change >= 0 else -1.2), y, f"{change:+.0f}%", va="center", ha="left" if change >= 0 else "right", fontsize=8.5)
            ax0.barh(y, 100 * c["correct"] / c["runs"], height=0.32, color=col, alpha=0.9)
            ax0.text(101, y, f"{c['correct']}/{c['runs']} vs {b['correct']}/{b['runs']}", va="center", fontsize=8.5)
    for ax in axes:
        ax.set_yticks(range(len(sets)))
        ax.invert_yaxis()
    ax0.set_yticklabels([s[0] for s in sets], fontsize=9)
    ax1.set_yticklabels([])
    ax0.set_xlim(0, 100); ax0.set_xticks(range(0, 101, 25))
    ax0.set_xlabel("Correct answers with Concentrate (%)\n(label: with vs without)")
    ax0.set_title("Both modes answer everything correctly", loc="left", fontsize=10.5, fontweight="bold")
    ax1.axvline(0, color="#444", lw=0.8)
    ax1.set_xlim(-25, 30)
    ax1.set_xlabel("Change in median input tokens (left = cheaper)")
    ax1.set_title("…at about the same cost", loc="left", fontsize=10.5, fontweight="bold")
    ax1.legend(loc="lower right", frameon=False, fontsize=8.5)
    fig.subplots_adjust(left=0.18, right=0.97, bottom=0.25, top=0.9, wspace=0.55)
    fig.text(0.01, 0.02, "Claude Code, 3 runs per question and mode (2026-11-04 to 2026-11-11). Go and Rust repositories are small enough "
             "to grep; the graph pays off on whole-repository questions, see the first chart. docs/agent-benchmark.md",
             fontsize=8, style="italic", color="#555")
    fig.savefig(os.path.join(OUT, "agent-languages.svg"))
    plt.close(fig)


if __name__ == "__main__":
    precision(); scaling(); agents()
