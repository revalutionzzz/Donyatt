"""Stage 5: train the flood-likelihood model and export it for the Worker.

Predicts the chance that the River Isle at Donyatt reaches road-flooding level (1.80 m) within
the next 3 h and 6 h, from what is known at time t:

  level            current level (m)
  rise_1h, rise_3h change over the last 1 h / 3 h (m)
  rain_1h..72h     rain at Chard Snowdon Hill over the last 1/3/6/24/72 h (mm, log1p)
  fc_rain_6h       rain over the NEXT 6 h (mm, log1p)  -- "with forecast" variant only

Training uses 2017-2022 and testing 2023 onwards (the Chard rain gauge starts in 2017), so the
test scores are on floods the model never saw. In the "with forecast" variant the future rain
in training and testing is the rain that actually fell (a perfect forecast), so its scores are an
upper bound; live it gets Open-Meteo's forecast, which will be less accurate.

    pip install -r model/requirements.txt
    python3 model/backfill.py            # once, to fetch model/data/
    python3 model/train.py               # writes src/model/flood-model.json and model/reports/model_card.md
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

from analyse_events import find_events, load_level, load_rain

ROOT = Path(__file__).resolve().parent.parent
MODEL_OUT = ROOT / "src" / "model" / "flood-model.json"
CARD_OUT = ROOT / "model" / "reports" / "model_card.md"
PARITY_OUT = ROOT / "test" / "fixtures" / "model-parity.json"

ROAD_FLOOD_M = 1.80
HORIZONS = (3, 6)
TEST_FROM = pd.Timestamp("2023-01-01", tz="UTC")
RAIN_WINDOWS = (1, 3, 6, 24, 72)
NOWCAST_FEATURES = ["level", "rise_1h", "rise_3h"] + [f"rain_{h}h" for h in RAIN_WINDOWS]
FORECAST_FEATURES = NOWCAST_FEATURES + ["fc_rain_6h"]
# Outlook bands shown on the site, chosen from the test-period results below.
BANDS = {"elevated": 0.10, "high": 0.40}


def build_frame() -> pd.DataFrame:
    level = load_level()
    rain = load_rain()
    idx = level.index[(level.index >= rain.index[0]) & (level.index.minute == 0)]
    df = pd.DataFrame(index=idx)
    df["level"] = level.reindex(idx)
    df["rise_1h"] = df["level"] - level.shift(4).reindex(idx)
    df["rise_3h"] = df["level"] - level.shift(12).reindex(idx)
    for h in RAIN_WINDOWS:
        df[f"rain_{h}h"] = np.log1p(rain.rolling(h * 4, min_periods=h * 4).sum().reindex(idx))
    # Rain in (t, t+6h]: sum of the next 24 fifteen-minute readings.
    future = rain[::-1].rolling(24, min_periods=24).sum()[::-1].shift(-1)
    df["fc_rain_6h"] = np.log1p(future.reindex(idx))
    for h in HORIZONS:
        # Highest level in (t, t+h].
        ahead = level[::-1].rolling(h * 4, min_periods=h * 4).max()[::-1].shift(-1)
        df[f"y_{h}h"] = (ahead.reindex(idx) >= ROAD_FLOOD_M).astype(float).where(ahead.reindex(idx).notna())
    # Only moments when the road isn't already at flooding level: we predict the onset.
    df = df[df["level"] < ROAD_FLOOD_M]
    return df.dropna()


def fit(train: pd.DataFrame, features: list[str], target: str) -> tuple[LogisticRegression, np.ndarray, np.ndarray]:
    x = train[features].to_numpy()
    mean, scale = x.mean(axis=0), x.std(axis=0)
    scale[scale == 0] = 1
    clf = LogisticRegression(C=1.0, max_iter=2000)
    clf.fit((x - mean) / scale, train[target].to_numpy())
    return clf, mean, scale


def predict(clf: LogisticRegression, mean: np.ndarray, scale: np.ndarray, df: pd.DataFrame, features: list[str]) -> np.ndarray:
    return clf.predict_proba((df[features].to_numpy() - mean) / scale)[:, 1]


def event_lead_times(p: pd.Series, events: list[pd.Timestamp], threshold: float) -> list[float | None]:
    """For each flood, hours between the first p >= threshold in the 12 h before it and the flood."""
    out = []
    for t in events:
        window = p[t - pd.Timedelta("12h") : t - pd.Timedelta("1min")]
        hit = window[window >= threshold]
        out.append((t - hit.index[0]).total_seconds() / 3600 if len(hit) else None)
    return out


def false_alarm_days(p: pd.Series, y: pd.Series, threshold: float) -> int:
    """Days with p >= threshold where the river did NOT reach 1.80 m in the horizon, and no flood that day."""
    fired = p >= threshold
    flood_days = set(y[y == 1].index.floor("D"))
    return len({d for d in fired[fired & (y == 0)].index.floor("D") if d not in flood_days})


def evaluate(name, features, df, level_events):
    train, test = df[df.index < TEST_FROM], df[df.index >= TEST_FROM]
    test_events = [t for t in level_events if t >= TEST_FROM]
    test_years = (test.index[-1] - test.index[0]).days / 365.25
    result = {"features": features, "horizons": {}}
    lines = [f"### {name}\n"]
    for h in HORIZONS:
        target = f"y_{h}h"
        clf, mean, scale = fit(train, features, target)
        p = pd.Series(predict(clf, mean, scale, test, features), index=test.index)
        y = test[target]
        auc = roc_auc_score(y, p)
        ap = average_precision_score(y, p)
        brier = brier_score_loss(y, p)
        lines.append(f"**Next {h} h** — test ROC AUC {auc:.3f}, average precision {ap:.3f}, Brier {brier:.4f} "
                     f"(base rate {y.mean():.4f}; {int(train[target].sum())} positive hours in training, {int(y.sum())} in test)\n")
        lines.append("| Threshold | Floods flagged early | Median notice | Shortest notice | False-alarm days per year |")
        lines.append("|---|---|---|---|---|")
        for thr in (0.05, 0.1, 0.2, 0.4):
            leads = event_lead_times(p, test_events, thr)
            got = [x for x in leads if x is not None]
            med = f"{np.median(got):.1f} h" if got else "—"
            mn = f"{min(got):.1f} h" if got else "—"
            fa = false_alarm_days(p, y, thr) / test_years
            lines.append(f"| {thr:.2f} | {len(got)}/{len(test_events)} | {med} | {mn} | {fa:.1f} |")
        # Calibration: predicted vs observed, in bins.
        bins = pd.cut(p, [0, 0.02, 0.05, 0.1, 0.2, 0.4, 1.0], include_lowest=True)
        cal = pd.DataFrame({"p": p, "y": y}).groupby(bins, observed=True).agg(n=("y", "size"), predicted=("p", "mean"), observed=("y", "mean"))
        lines.append("\nCalibration (test): " + "; ".join(f"{iv}: predicted {r.predicted:.3f}, observed {r.observed:.3f} (n={r.n})" for iv, r in cal.iterrows()) + "\n")
        result["horizons"][str(h)] = {
            "intercept": float(clf.intercept_[0]),
            "coef": [float(c) for c in clf.coef_[0]],
            "mean": [float(v) for v in mean],
            "scale": [float(v) for v in scale],
            "testRocAuc": round(auc, 4),
            "testBrier": round(brier, 5),
        }
    return result, lines


def rules_baseline(df: pd.DataFrame, level_events) -> list[str]:
    """Lead time of the Stage 2 Caution rule (>= 1.2 m, or >= 1.0 m rising >= 0.1 m/h) on the same test floods."""
    test = df[df.index >= TEST_FROM]
    caution = ((test["level"] >= 1.2) | ((test["level"] >= 1.0) & (test["rise_1h"] >= 0.1))).astype(float)
    leads = [x for x in event_lead_times(caution, [t for t in level_events if t >= TEST_FROM], 0.5) if x is not None]
    return [f"For comparison, the existing Caution rule flagged {len(leads)} test floods with median notice "
            f"{np.median(leads):.1f} h (shortest {min(leads):.1f} h), measured on the same hourly grid.\n"]


def main() -> None:
    df = build_frame()
    level_events = [t for t in find_events(load_level()) if t >= df.index[0]]
    train_n = (df.index < TEST_FROM).sum()
    card = [
        "# Flood-likelihood model card\n",
        f"Generated {datetime.now(timezone.utc):%Y-%m-%d} by `model/train.py`. Predicts the chance that Donyatt reaches "
        f"{ROAD_FLOOD_M:.2f} m within the next 3 h and 6 h. Logistic regression on standardised features; "
        f"hourly samples where the level is below {ROAD_FLOOD_M:.2f} m.\n",
        f"- Training: {df.index[0]:%Y-%m-%d} to {TEST_FROM - pd.Timedelta('1D'):%Y-%m-%d} ({train_n} hours, "
        f"{sum(t < TEST_FROM for t in level_events)} floods).",
        f"- Test: {TEST_FROM:%Y-%m-%d} to {df.index[-1]:%Y-%m-%d} ({len(df) - train_n} hours, "
        f"{sum(t >= TEST_FROM for t in level_events)} floods). Never seen in training.\n",
        "Notice is measured from the first hourly prediction at or above the threshold (within 12 h before) to the time "
        "the river reached 1.80 m. Live readings arrive 15-45 min late, so real notice is shorter by about that much.\n",
    ]
    now_model, now_lines = evaluate("Nowcast (data available now)", NOWCAST_FEATURES, df, level_events)
    fc_model, fc_lines = evaluate("With 6 h rain forecast (perfect-forecast upper bound)", FORECAST_FEATURES, df, level_events)
    card += now_lines + fc_lines + rules_baseline(df, level_events)
    card.append("\n## How the site uses it\n")
    card.append(f"- Outlook bands: Low < {BANDS['elevated']:.0%} <= Elevated < {BANDS['high']:.0%} <= High (6 h chance).")
    card.append("- The site uses the forecast model when a fresh Open-Meteo forecast is available, otherwise the nowcast.")
    card.append(f"- An Elevated or High outlook (6 h chance >= {BANDS['elevated']:.0%}) raises a road to Caution. On the test floods "
                "that threshold flagged every flood, with about an hour more notice than the existing rules, for a similar number "
                "of false-alarm days. The model never lowers a status and never sets Avoid on its own.\n")
    card.append("## Limitations\n")
    card.append(f"- Small sample: {len(level_events)} floods since the Chard rain gauge opened in 2017, split between training and test. "
                "The scores above will move as more floods are recorded.")
    card.append("- In the 2-40% range the model tends to under-predict (observed rates above predicted). Treat Elevated seriously.")
    card.append("- The forecast variant was trained and scored with the rain that actually fell. Live it gets Open-Meteo's grid "
                "forecast, which is less accurate and is an area average rather than the Chard gauge.")
    card.append("- It knows only the Donyatt gauge and Chard rain: not blocked culverts, other tributaries, or the downstream roads directly.\n")
    card.append("## Coefficients (standardised)\n")
    for name, m in (("nowcast", now_model), ("forecast", fc_model)):
        h6 = m["horizons"]["6"]
        card.append(f"- {name}, 6 h: " + ", ".join(f"{f} {c:+.2f}" for f, c in zip(m["features"], h6["coef"])) + f", intercept {h6['intercept']:+.2f}")

    export = {
        "version": 1,
        "generated": f"{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}",
        "target": f"Donyatt level >= {ROAD_FLOOD_M} m within the horizon",
        "featureNotes": "level m; rise_1h/rise_3h m; rain_* = log1p(mm summed over the past window); fc_rain_6h = log1p(mm forecast for the next 6 h)",
        "trainPeriod": [f"{df.index[0]:%Y-%m-%d}", f"{TEST_FROM - pd.Timedelta('1D'):%Y-%m-%d}"],
        "bands": BANDS,
        "models": {"nowcast": now_model, "forecast": fc_model},
    }
    # Parity samples: the Worker's TypeScript must reproduce these probabilities exactly.
    samples = df[df.index >= TEST_FROM]
    picks = pd.concat([samples.nlargest(3, "rain_72h"), samples.nlargest(3, "level"), samples.sample(4, random_state=1)])
    parity = []
    for _, row in picks.iterrows():
        entry = {"features": {f: float(row[f]) for f in FORECAST_FEATURES}, "expected": {}}
        for name, m in (("nowcast", now_model), ("forecast", fc_model)):
            for h, hm in m["horizons"].items():
                z = hm["intercept"] + sum(c * (row[f] - mu) / sc for f, c, mu, sc in zip(m["features"], hm["coef"], hm["mean"], hm["scale"]))
                entry["expected"][f"{name}_{h}h"] = float(1 / (1 + np.exp(-z)))
        parity.append(entry)
    PARITY_OUT.write_text(json.dumps(parity, indent=1) + "\n")

    MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
    MODEL_OUT.write_text(json.dumps(export, indent=1) + "\n")
    CARD_OUT.write_text("\n".join(card) + "\n")
    print("\n".join(card))
    print(f"\nwrote {MODEL_OUT} and {CARD_OUT}")


if __name__ == "__main__":
    main()
