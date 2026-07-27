#!/usr/bin/env python3
"""Build src/results/report-data.json from data/mango-tango-all-votes.csv.

The CSV (an all-votes export from the admin console) is gitignored; the
generated JSON of aggregate stats is committed and rendered at /results.
Re-run after replacing the CSV: python3 scripts/build-report-data.py
"""
import csv
import itertools
import json
import statistics as st
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "mango-tango-all-votes.csv"
OUT = ROOT / "src" / "results" / "report-data.json"

with open(SRC, newline="") as f:
    rows = list(csv.reader(f))
header = rows[0]
seen: Counter = Counter()
cols = []
for n in header[4:]:
    seen[n] += 1
    cols.append(n if seen[n] == 1 else f"{n} ({seen[n]})")

tasters = []
for r in rows[1:]:
    scores = {cols[i]: int(v) for i, v in enumerate(r[4:]) if v.strip()}
    tasters.append({"id": r[0], "name": r[1] or None, "status": r[2], "scores": scores})

submitted = [t for t in tasters if t["status"] == "submitted"]


def label(t):
    # First names only on the public page (no surnames); unnamed tasters
    # get a short anonymous id.
    if t["name"]:
        return t["name"].split()[0]
    return f"Taster {t['id'][:4]}"


def stats(vals):
    return {
        "n": len(vals),
        "mean": round(st.mean(vals), 2),
        "med": st.median(vals),
        "sd": round(st.pstdev(vals), 2) if len(vals) > 1 else 0.0,
        "min": min(vals),
        "max": max(vals),
    }


mangoes = []
for c in cols:
    vals = [t["scores"][c] for t in tasters if c in t["scores"]]
    if not vals:
        continue
    dist = [0] * 10
    for v in vals:
        dist[v - 1] += 1
    svals = [t["scores"][c] for t in submitted if c in t["scores"]]
    mangoes.append({
        "name": c,
        **stats(vals),
        "dist": dist,
        "subMean": round(st.mean(svals), 2) if svals else None,
        "subN": len(svals),
    })

mangoes.sort(key=lambda m: -m["mean"])
for i, m in enumerate(mangoes, 1):
    m["rank"] = i
by_sub = sorted([m for m in mangoes if m["subN"] >= 4], key=lambda m: -m["subMean"])
for i, m in enumerate(by_sub, 1):
    m["subRank"] = i

histogram = [0] * 10
for t in tasters:
    for v in t["scores"].values():
        histogram[v - 1] += 1

# Taster stats (>=10 ratings)
named = [t for t in tasters if len(t["scores"]) >= 10]
tstats = []
for t in named:
    v = list(t["scores"].values())
    tstats.append({
        "label": label(t),
        "status": t["status"],
        "mean": round(st.mean(v), 2),
        "sd": round(st.pstdev(v), 2),
        "n": len(v),
        "tens": sum(1 for x in v if x == 10),
        "ones": sum(1 for x in v if x == 1),
    })
tstats.sort(key=lambda x: -x["mean"])


def pearson(a, b):
    ma, mb = st.mean(a), st.mean(b)
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    va = sum((x - ma) ** 2 for x in a) ** 0.5
    vb = sum((y - mb) ** 2 for y in b) ** 0.5
    return cov / (va * vb) if va and vb else 0.0


pairs = []
for t1, t2 in itertools.combinations(named, 2):
    common = sorted(set(t1["scores"]) & set(t2["scores"]))
    if len(common) >= 15:
        r = pearson([t1["scores"][c] for c in common], [t2["scores"][c] for c in common])
        pairs.append({"a": label(t1), "b": label(t2), "r": round(r, 2)})
pairs.sort(key=lambda p: -p["r"])

oracle = []
for t in named:
    xs, ys = [], []
    for c, v in t["scores"].items():
        others = [u["scores"][c] for u in tasters if u is not t and c in u["scores"]]
        if len(others) >= 5:
            xs.append(v)
            ys.append(st.mean(others))
    if len(xs) >= 15:
        oracle.append({"label": label(t), "r": round(pearson(xs, ys), 2)})
oracle.sort(key=lambda o: -o["r"])

movers = sorted(
    (m for m in mangoes if m.get("subRank") and abs(m["rank"] - m["subRank"]) >= 3),
    key=lambda m: -abs(m["rank"] - m["subRank"]),
)

report = {
    "meta": {
        "title": "Mango Tango 2026",
        "date": "July 26, 2026",
        "tasters": len(tasters),
        "submitted": len(submitted),
        "mangoesTasted": len(mangoes),
        "votes": sum(len(t["scores"]) for t in tasters),
        "neverRated": [c for c in cols if all(c not in t["scores"] for t in tasters)
                       and not c.endswith("(2)")],
    },
    "mangoes": mangoes,
    "histogram": histogram,
    "tasters": tstats,
    "twins": pairs[:1],
    "opposites": pairs[-1:],
    "oracle": oracle[:1],
    "movers": [{"name": m["name"], "all": m["rank"], "sub": m["subRank"]} for m in movers],
    "totalTens": histogram[9],
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(report, indent=1) + "\n")
print(f"wrote {OUT}  ({len(mangoes)} mangoes, {report['meta']['votes']} votes)")
