#!/usr/bin/env python3
"""Structural G-code comparison for engine-parity checks (wasm vs native vs Android).

Line diffs are useless across builds: toolpath order, travel placement and
M73 progress lines shift with stdlib tie-breaking. This compares what matters
for the print instead:

  * layer count and Z heights
  * filament extruded per feature type (;TYPE:) and in total
  * extrusion move count per type
  * header estimates (time, filament)
  * the set of tool changes, temperatures and Klipper object definitions

    compare-gcode.py a.gcode b.gcode [--tol 0.5]

Exit status 1 if any extrusion total differs by more than --tol percent.
"""
import argparse
import collections
import re
import sys


def parse(path):
    feat = collections.defaultdict(float)
    moves = collections.Counter()
    zs, temps, tools, objects = [], [], collections.Counter(), []
    est = {}
    cur_type, rel_e, e_last, z = "start", False, 0.0, None
    with open(path, encoding="utf-8", errors="replace") as f:
        for raw in f:
            line = raw.strip()
            if line.startswith(";TYPE:"):
                cur_type = line[6:]
                continue
            if line.startswith(";LAYER_CHANGE"):
                zs.append(None)
                continue
            if line.startswith(";Z:") and zs and zs[-1] is None:
                zs[-1] = float(line[3:])
                continue
            m = re.match(r"; (estimated printing time|total filament used \[g\]|filament used \[mm\]|total layers count)[^=]*= *(.*)", line)
            if m:
                est[m.group(1)] = m.group(2)
                continue
            if line.startswith("EXCLUDE_OBJECT_DEFINE"):
                objects.append(line.split(" CENTER")[0])
                continue
            code = line.split(";", 1)[0].strip()
            if not code:
                continue
            if code == "M83":
                rel_e = True
            elif code == "M82":
                rel_e = False
            elif re.fullmatch(r"T\d+", code):
                tools[code] += 1
            elif code.startswith(("M104", "M109", "M140", "M190")):
                temps.append(code)
            elif code.startswith(("G1 ", "G2 ", "G3 ")):
                e = None
                has_xy = False
                for w in code.split()[1:]:
                    if w[0] == "E":
                        e = float(w[1:])
                    elif w[0] in "XY":
                        has_xy = True
                if e is None:
                    continue
                de = e if rel_e else e - e_last
                if not rel_e:
                    e_last = e
                if de > 0 and has_xy:
                    feat[cur_type] += de
                    moves[cur_type] += 1
            elif code.startswith("G92"):
                for w in code.split()[1:]:
                    if w[0] == "E":
                        e_last = float(w[1:])
    return dict(feat=feat, moves=moves, zs=zs, temps=temps, tools=tools, objects=objects, est=est)


def pct(a, b):
    return 0.0 if a == b == 0 else 100.0 * (b - a) / max(abs(a), 1e-9)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--tol", type=float, default=0.5, help="max %% difference in extrusion per feature")
    args = ap.parse_args()
    A, B = parse(args.a), parse(args.b)
    bad = False

    print(f"layers: {len(A['zs'])} vs {len(B['zs'])}", "OK" if A["zs"] == B["zs"] else "DIFF (Z list differs)")
    bad |= A["zs"] != B["zs"]
    for k in sorted(set(A["est"]) | set(B["est"])):
        print(f"header {k}: {A['est'].get(k)} vs {B['est'].get(k)}")

    print(f"\n{'feature':<28}{'E a (mm)':>12}{'E b (mm)':>12}{'Δ%':>8}{'moves a':>10}{'moves b':>10}")
    total_a = total_b = 0.0
    for k in sorted(set(A["feat"]) | set(B["feat"]), key=lambda k: -A["feat"].get(k, 0)):
        ea, eb = A["feat"].get(k, 0.0), B["feat"].get(k, 0.0)
        total_a += ea
        total_b += eb
        d = pct(ea, eb)
        flag = "  <-- over tol" if abs(d) > args.tol and max(ea, eb) > 1.0 else ""
        bad |= bool(flag)
        print(f"{k:<28}{ea:>12.2f}{eb:>12.2f}{d:>8.3f}{A['moves'][k]:>10}{B['moves'][k]:>10}{flag}")
    print(f"{'TOTAL':<28}{total_a:>12.2f}{total_b:>12.2f}{pct(total_a, total_b):>8.3f}")

    for key in ("tools", "temps", "objects"):
        same = A[key] == B[key]
        print(f"\n{key}: {'identical' if same else 'DIFFER'}")
        if not same:
            bad = True
            print("  a:", A[key] if key != "temps" else A[key][:12])
            print("  b:", B[key] if key != "temps" else B[key][:12])
    print("\nRESULT:", "MISMATCH" if bad else f"match (extrusion within {args.tol}% per feature)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
