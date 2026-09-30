"""Analyse past Donyatt high-water events to calibrate the Stage 2 "Caution" rules.

Reads the CSVs written by backfill.py and prints a Markdown report:
  * every event where the level reached 1.80 m (historical road flooding at Donyatt),
  * how fast the river was rising on the way up, and how much warning 1.20 m / 1.40 m gave,
  * upstream rainfall (Snowdon Hill, 2017+) before each event,
  * how often candidate "rising fast" / "heavy rain" triggers fire, and how often they are
    followed by a real rise (so we can see the false-alarm cost).

    pip install -r model/requirements.txt
    python3 model/analyse_events.py > model/reports/flood_events.md
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

DATA = Path(__file__).parent / "data"
ROAD_FLOOD_M = 1.80
EVENT_GAP = pd.Timedelta("48h")  # crossings closer than this belong to the same event


def load_level() -> pd.Series:
    df = pd.read_csv(DATA / "donyatt_level.csv", usecols=["ts_utc", "value", "quality"])
    df["ts"] = pd.to_datetime(df["ts_utc"], utc=True)
    s = df.set_index("ts")["value"].sort_index()
    s = s[~s.index.duplicated()]
    # Regular 15-min grid; short gaps (<= 1 h) interpolated, longer gaps left empty.
    return s.resample("15min").mean().interpolate(limit=4, limit_area="inside")


def load_rain() -> pd.Series:
    df = pd.read_csv(DATA / "snowdon_hill_rain.csv", usecols=["ts_utc", "value"])
    df["ts"] = pd.to_datetime(df["ts_utc"], utc=True)
    s = df.set_index("ts")["value"].sort_index()
    return s[~s.index.duplicated()].resample("15min").sum(min_count=1)


def find_events(level: pd.Series) -> list[pd.Timestamp]:
    above = level >= ROAD_FLOOD_M
    crossings = level.index[above & ~above.shift(1, fill_value=False)]
    events: list[pd.Timestamp] = []
    for t in crossings:
        if not events or t - events[-1] > EVENT_GAP:
            events.append(t)
    return events


def last_crossing_before(level: pd.Series, t: pd.Timestamp, threshold: float) -> pd.Timestamp | None:
    window = level[t - pd.Timedelta("72h") : t]
    below = window[window < threshold]
    if below.empty:
        return None
    after = window[below.index[-1] :]
    up = after[after >= threshold]
    return up.index[0] if not up.empty else None


def fmt_h(td: pd.Timedelta | None) -> str:
    return "—" if td is None or pd.isna(td) else f"{td.total_seconds() / 3600:.1f} h"


def main() -> None:
    level = load_level()
    rain = load_rain()
    rise_1h = level.diff(4)  # metres per hour
    rain_3h = rain.rolling(12, min_periods=12).sum()
    rain_12h = rain.rolling(48, min_periods=48).sum()
    rain_24h = rain.rolling(96, min_periods=96).sum()

    events = find_events(level)
    print(f"# Donyatt high-water events (level ≥ {ROAD_FLOOD_M} m)\n")
    print(f"Level data {level.index[0].date()} to {level.index[-1].date()}; rain data from {rain.index[0].date()}.\n")
    print("| Crossed 1.80 m (UTC) | Peak | Warning from 1.20 m | from 1.40 m | Max rise in 6 h before (m/h) | Rain 12 h / 24 h before (mm) |")
    print("|---|---|---|---|---|---|")
    lead_12, lead_14, max_rises = [], [], []
    for t in events:
        peak = level[t : t + pd.Timedelta("48h")].max()
        t12 = last_crossing_before(level, t, 1.20)
        t14 = last_crossing_before(level, t, 1.40)
        max_rise = rise_1h[t - pd.Timedelta("6h") : t].max()
        r12 = rain_12h.get(t)
        r24 = rain_24h.get(t)
        rain_txt = "—" if r12 is None or pd.isna(r12) else f"{r12:.1f} / {r24:.1f}"
        if t12 is not None:
            lead_12.append(t - t12)
        if t14 is not None:
            lead_14.append(t - t14)
        max_rises.append(max_rise)
        print(f"| {t:%Y-%m-%d %H:%M} | {peak:.2f} m | {fmt_h(t - t12 if t12 else None)} | {fmt_h(t - t14 if t14 else None)} | {max_rise:.2f} | {rain_txt} |")

    def summary(name: str, xs: list[pd.Timedelta]) -> None:
        if xs:
            s = pd.Series([x.total_seconds() / 3600 for x in xs])
            print(f"- {name}: median {s.median():.1f} h, shortest {s.min():.1f} h ({len(xs)} events)")

    print(f"\n{len(events)} events.\n")
    summary("Time from 1.20 m to 1.80 m", lead_12)
    summary("Time from 1.40 m to 1.80 m", lead_14)
    mr = pd.Series(max_rises).dropna()
    print(f"- Fastest 1-hour rise in the 6 h before crossing: median {mr.median():.2f} m/h, min {mr.min():.2f} m/h\n")

    # How do candidate triggers perform? "Hit" = level reaches 1.40 m within the next 12 h.
    future_max_12h = level[::-1].rolling(48, min_periods=1).max()[::-1]
    reaches_14 = future_max_12h >= 1.40
    print("## Candidate Caution triggers\n")
    print("Counted once per day the trigger fires. A \"hit\" means Donyatt reached 1.40 m within 12 h.\n")
    print("| Trigger | Days fired | Days followed by ≥ 1.40 m | Hit rate |")
    print("|---|---|---|---|")

    def trigger(name: str, mask: pd.Series) -> None:
        mask = mask.fillna(False)
        days = mask[mask].index.floor("D").unique()
        hit_days = (mask & reaches_14)[lambda m: m].index.floor("D").unique()
        rate = f"{len(hit_days) / len(days):.0%}" if len(days) else "—"
        print(f"| {name} | {len(days)} | {len(hit_days)} | {rate} |")

    since_rain = level.index >= rain.index[0]
    lvl = level.where(since_rain)
    for rate in (0.05, 0.10, 0.15):
        trigger(f"Level ≥ 1.00 m and rising ≥ {rate:.2f} m/h", (lvl >= 1.0) & (rise_1h.where(since_rain) >= rate))
    for mm in (10, 15, 20, 25):
        trigger(f"Rain ≥ {mm} mm in 3 h (Snowdon Hill)", rain_3h.reindex(level.index) >= mm)
    for mm in (25, 35, 45):
        trigger(f"Rain ≥ {mm} mm in 12 h (Snowdon Hill)", rain_12h.reindex(level.index) >= mm)
    trigger("Level ≥ 1.20 m (any)", lvl >= 1.2)
    print("\nTrigger rows use the period with both rain and level data (2017 onwards).")


if __name__ == "__main__":
    main()
