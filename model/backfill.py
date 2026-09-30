"""One-off backfill of historical Donyatt level and Snowdon Hill rainfall for model training.

Downloads 15-minute readings from the EA Hydrology API year by year and writes CSVs to
model/data/ (git-ignored). Standard library only.

    python3 model/backfill.py                  # full history
    python3 model/backfill.py --start 2024-01-01

Datum warning: the Donyatt hydrology series is in metres above Ordnance Datum (stage + 35 m)
until mid-September 2026 and in stage metres after that. Levels are converted to stage metres
(the scale of the EA thresholds in CLAUDE.md) and the raw value is kept alongside.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

HYDROLOGY = "https://environment.data.gov.uk/hydrology/id/measures"
STAGE_SCALE = "https://environment.data.gov.uk/flood-monitoring/id/stations/52115/stageScale"

SERIES = {
    "donyatt_level": {
        "measure": "6d2349f9-d71e-45a9-ba86-0bafdab39c35-level-i-900-m-qualified",
        "first_year": 1992,
        "is_level": True,
    },
    "snowdon_hill_rain": {
        "measure": "d1803c5a-e461-404b-8750-7f946456a6c6-rainfall-t-900-mm-qualified",
        "first_year": 2017,
        "is_level": False,
    },
}

HEADERS = {"User-Agent": "donyatt-flood-watch backfill (community flood tool)"}
OUT_FIELDS = ["ts_utc", "value", "raw_value", "datum_converted", "quality", "completeness", "qcode"]


def get(url: str, retries: int = 4) -> bytes:
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=120) as res:
                return res.read()
        except Exception as err:  # noqa: BLE001 - retry any network error
            if attempt == retries - 1:
                raise
            wait = 2 ** (attempt + 1)
            print(f"  retrying in {wait}s after: {err}", file=sys.stderr)
            time.sleep(wait)
    raise AssertionError("unreachable")


def stage_datum() -> float:
    """Height of the gauge zero above Ordnance Datum (35 m at Donyatt, per the EA stage scale)."""
    return float(json.loads(get(STAGE_SCALE))["items"]["datum"])


def to_stage(raw: float, datum: float) -> tuple[float, bool]:
    """Convert an mAOD reading to stage metres. Readings already in stage metres are left alone.

    Any real stage at Donyatt is far below datum/2 (record 2.63 m vs datum 35 m), so the
    two scales cannot be confused.
    """
    if raw > datum / 2:
        return round(raw - datum, 3), True
    return raw, False


def normalise_row(row: dict[str, str], datum: float | None) -> dict[str, object] | None:
    if row.get("value", "") == "":
        return None
    raw = float(row["value"])
    value, converted = to_stage(raw, datum) if datum is not None else (raw, False)
    return {
        # Hydrology API times are UTC without a suffix (checked against the flood-monitoring API).
        "ts_utc": row["dateTime"] + "Z",
        "value": value,
        "raw_value": raw,
        "datum_converted": int(converted),
        "quality": row.get("quality", ""),
        "completeness": row.get("completeness", ""),
        "qcode": row.get("qcode", ""),
    }


def fetch_chunk(measure: str, start: dt.date, end: dt.date) -> list[dict[str, str]]:
    url = f"{HYDROLOGY}/{measure}/readings.csv?mineq-date={start}&max-date={end}&_limit=50000"
    return list(csv.DictReader(io.StringIO(get(url).decode("utf-8"))))


def backfill(name: str, start: dt.date, end: dt.date, out_dir: Path) -> None:
    cfg = SERIES[name]
    datum = stage_datum() if cfg["is_level"] else None
    start = max(start, dt.date(cfg["first_year"], 1, 1))
    out_path = out_dir / f"{name}.csv"
    seen: set[str] = set()
    rows_written = converted = 0
    with out_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=OUT_FIELDS)
        writer.writeheader()
        chunk_start = start
        while chunk_start < end:
            chunk_end = min(dt.date(chunk_start.year + 1, 1, 1), end)
            rows = fetch_chunk(cfg["measure"], chunk_start, chunk_end)
            print(f"{name} {chunk_start}..{chunk_end}: {len(rows)} rows")
            for row in rows:
                out = normalise_row(row, datum)
                if out is None or out["ts_utc"] in seen:
                    continue
                seen.add(out["ts_utc"])
                writer.writerow(out)
                rows_written += 1
                converted += out["datum_converted"]
            chunk_start = chunk_end
    print(f"wrote {out_path}: {rows_written} rows ({converted} converted from mAOD)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--start", type=dt.date.fromisoformat, default=dt.date(1992, 1, 1))
    parser.add_argument("--end", type=dt.date.fromisoformat, default=dt.date.today() + dt.timedelta(days=1))
    parser.add_argument("--series", choices=sorted(SERIES), action="append")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent / "data")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name in args.series or sorted(SERIES):
        backfill(name, args.start, args.end, args.out)


if __name__ == "__main__":
    main()
