#!/usr/bin/env python3
"""Multi-window anon growth for atrium leak A/B.

Warmup dominates the first ~10–20s. Short single-window rates look like
leaks. This script:
  1. Finds the atrium node worker (largest RSS node main.js).
  2. Samples Anonymous (smaps) every --interval seconds.
  3. Prints per-bucket rates + overall, so early warmup vs late climb
     are separable.

Usage:
  python3 scripts/anon_windows.py [--label NAME] [--warm 25] [--interval 10] [--buckets 6]
"""
from __future__ import annotations

import argparse
import os
import sys
import time


def find_worker() -> int | None:
    best = None
    best_rss = 0
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = (
                open(f"/proc/{pid}/cmdline", "rb")
                .read()
                .replace(b"\x00", b" ")
                .decode(errors="replace")
            )
        except Exception:
            continue
        if "node" not in cmd or "main.js" not in cmd:
            continue
        if "/usr/bin/node" not in cmd and "node " not in cmd:
            # still accept if main.js is clearly atrium
            if "atrium" not in cmd and "main.js" not in cmd:
                continue
        p = int(pid)
        try:
            rss = int(
                [l for l in open(f"/proc/{p}/status") if l.startswith("VmRSS:")][0].split()[1]
            )
        except Exception:
            continue
        if rss > best_rss:
            best_rss = rss
            best = p
    return best


def anon_mb(pid: int) -> float:
    total_kb = 0
    with open(f"/proc/{pid}/smaps") as f:
        for line in f:
            if line.startswith("Anonymous:"):
                total_kb += int(line.split()[1])
    return total_kb / 1024.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="run")
    ap.add_argument("--warm", type=float, default=25.0, help="seconds after worker found before t0")
    ap.add_argument("--interval", type=float, default=10.0, help="seconds per bucket")
    ap.add_argument("--buckets", type=int, default=6, help="number of intervals after t0")
    ap.add_argument("--pid", type=int, default=0, help="override worker pid")
    args = ap.parse_args()

    w = args.pid or find_worker()
    if not w:
        print(f"{args.label}: NO_WORKER", file=sys.stderr)
        return 1

    print(f"{args.label}: worker={w} warming {args.warm:.0f}s …", flush=True)
    time.sleep(args.warm)

    t0 = time.time()
    a0 = anon_mb(w)
    samples = [(0.0, a0)]
    print(f"{args.label}: t=0 anon={a0:.1f} MB", flush=True)

    for i in range(args.buckets):
        time.sleep(args.interval)
        t = time.time() - t0
        a = anon_mb(w)
        samples.append((t, a))
        prev_t, prev_a = samples[-2]
        dt = t - prev_t
        d = a - prev_a
        rate = (d * 60.0 / dt) if dt > 0 else 0.0
        print(
            f"{args.label}: bucket[{i}] t={t:.0f}s anon={a:.1f} "
            f"d={d:+.2f} rate={rate:+.2f} MB/min",
            flush=True,
        )

    # Summaries: overall, early (first 2 buckets), mid, late (last 2)
    def rate_between(i0: int, i1: int) -> float:
        t_a, a_a = samples[i0]
        t_b, a_b = samples[i1]
        dt = t_b - t_a
        if dt <= 0:
            return 0.0
        return (a_b - a_a) * 60.0 / dt

    n = len(samples) - 1  # bucket count
    overall = rate_between(0, n)
    early_end = min(2, n)
    late_start = max(0, n - 2)
    early = rate_between(0, early_end)
    late = rate_between(late_start, n)
    mid_lo = early_end
    mid_hi = late_start
    mid = rate_between(mid_lo, mid_hi) if mid_hi > mid_lo else float("nan")

    print(
        f"{args.label}: SUMMARY overall={overall:+.2f} "
        f"early={early:+.2f} mid={mid:+.2f} late={late:+.2f} MB/min "
        f"(Δanon={samples[-1][1] - a0:+.2f} MB over {samples[-1][0]:.0f}s)",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
