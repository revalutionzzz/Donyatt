# Flood-likelihood model card

Generated 2026-10-01 by `model/train.py`. Predicts the chance that Donyatt reaches 1.80 m within the next 3 h and 6 h. Logistic regression on standardised features; hourly samples where the level is below 1.80 m.

- Training: 2017-04-01 to 2022-12-31 (50378 hours, 10 floods).
- Test: 2023-01-01 to 2026-09-30 (32536 hours, 11 floods). Never seen in training.

Notice is measured from the first hourly prediction at or above the threshold (within 12 h before) to the time the river reached 1.80 m. Live readings arrive 15-45 min late, so real notice is shorter by about that much.

### Nowcast (data available now)

**Next 3 h** — test ROC AUC 0.999, average precision 0.688, Brier 0.0006 (base rate 0.0013; 30 positive hours in training, 42 in test)

| Threshold | Floods flagged early | Median notice | Shortest notice | False-alarm days per year |
|---|---|---|---|---|
| 0.05 | 11/11 | 2.5 h | 1.2 h | 6.7 |
| 0.10 | 11/11 | 2.5 h | 1.2 h | 5.1 |
| 0.20 | 11/11 | 1.5 h | 0.5 h | 2.9 |
| 0.40 | 11/11 | 1.2 h | 0.5 h | 0.8 |

Calibration (test): (-0.001, 0.02]: predicted 0.000, observed 0.000 (n=32382.0); (0.02, 0.05]: predicted 0.030, observed 0.056 (n=54.0); (0.05, 0.1]: predicted 0.070, observed 0.111 (n=27.0); (0.1, 0.2]: predicted 0.136, observed 0.267 (n=30.0); (0.2, 0.4]: predicted 0.263, observed 0.188 (n=16.0); (0.4, 1.0]: predicted 0.720, observed 0.852 (n=27.0)

**Next 6 h** — test ROC AUC 0.984, average precision 0.501, Brier 0.0017 (base rate 0.0024; 60 positive hours in training, 79 in test)

| Threshold | Floods flagged early | Median notice | Shortest notice | False-alarm days per year |
|---|---|---|---|---|
| 0.05 | 11/11 | 2.5 h | 2.2 h | 11.5 |
| 0.10 | 11/11 | 2.5 h | 1.2 h | 7.2 |
| 0.20 | 11/11 | 1.5 h | 1.0 h | 4.0 |
| 0.40 | 11/11 | 1.2 h | 0.2 h | 1.1 |

Calibration (test): (-0.001, 0.02]: predicted 0.000, observed 0.001 (n=32221.0); (0.02, 0.05]: predicted 0.032, observed 0.073 (n=151.0); (0.05, 0.1]: predicted 0.071, observed 0.070 (n=57.0); (0.1, 0.2]: predicted 0.144, observed 0.170 (n=47.0); (0.2, 0.4]: predicted 0.287, observed 0.355 (n=31.0); (0.4, 1.0]: predicted 0.619, observed 0.828 (n=29.0)

### With 6 h rain forecast (perfect-forecast upper bound)

**Next 3 h** — test ROC AUC 1.000, average precision 0.789, Brier 0.0005 (base rate 0.0013; 30 positive hours in training, 42 in test)

| Threshold | Floods flagged early | Median notice | Shortest notice | False-alarm days per year |
|---|---|---|---|---|
| 0.05 | 11/11 | 2.5 h | 2.0 h | 7.5 |
| 0.10 | 11/11 | 2.5 h | 1.2 h | 5.1 |
| 0.20 | 11/11 | 2.5 h | 1.2 h | 2.4 |
| 0.40 | 11/11 | 1.5 h | 1.0 h | 0.8 |

Calibration (test): (-0.001, 0.02]: predicted 0.000, observed 0.000 (n=32370.0); (0.02, 0.05]: predicted 0.031, observed 0.036 (n=55.0); (0.05, 0.1]: predicted 0.066, observed 0.037 (n=27.0); (0.1, 0.2]: predicted 0.147, observed 0.118 (n=34.0); (0.2, 0.4]: predicted 0.282, observed 0.500 (n=18.0); (0.4, 1.0]: predicted 0.759, observed 0.781 (n=32.0)

**Next 6 h** — test ROC AUC 0.999, average precision 0.754, Brier 0.0011 (base rate 0.0024; 60 positive hours in training, 79 in test)

| Threshold | Floods flagged early | Median notice | Shortest notice | False-alarm days per year |
|---|---|---|---|---|
| 0.05 | 11/11 | 5.5 h | 2.0 h | 9.6 |
| 0.10 | 11/11 | 4.5 h | 2.0 h | 5.6 |
| 0.20 | 11/11 | 3.8 h | 1.0 h | 3.2 |
| 0.40 | 9/11 | 2.8 h | 1.2 h | 0.8 |

Calibration (test): (-0.001, 0.02]: predicted 0.000, observed 0.000 (n=32188.0); (0.02, 0.05]: predicted 0.032, observed 0.051 (n=137.0); (0.05, 0.1]: predicted 0.069, observed 0.048 (n=83.0); (0.1, 0.2]: predicted 0.146, observed 0.200 (n=45.0); (0.2, 0.4]: predicted 0.276, observed 0.500 (n=32.0); (0.4, 1.0]: predicted 0.741, observed 0.784 (n=51.0)

For comparison, the existing Caution rule flagged 11 test floods with median notice 1.5 h (shortest 1.0 h), measured on the same hourly grid.


## How the site uses it

- Outlook bands: Low < 10% <= Elevated < 40% <= High (6 h chance).
- The site uses the forecast model when a fresh Open-Meteo forecast is available, otherwise the nowcast.
- An Elevated or High outlook (6 h chance >= 10%) raises a road to Caution. On the test floods that threshold flagged every flood, with about an hour more notice than the existing rules, for a similar number of false-alarm days. The model never lowers a status and never sets Avoid on its own.

## Limitations

- Small sample: 21 floods since the Chard rain gauge opened in 2017, split between training and test. The scores above will move as more floods are recorded.
- In the 2-40% range the model tends to under-predict (observed rates above predicted). Treat Elevated seriously.
- The forecast variant was trained and scored with the rain that actually fell. Live it gets Open-Meteo's grid forecast, which is less accurate and is an area average rather than the Chard gauge.
- It knows only the Donyatt gauge and Chard rain: not blocked culverts, other tributaries, or the downstream roads directly.

## Coefficients (standardised)

- nowcast, 6 h: level +0.29, rise_1h +0.08, rise_3h -0.01, rain_1h +0.45, rain_3h +0.48, rain_6h -0.70, rain_24h +0.72, rain_72h +1.51, intercept -10.36
- forecast, 6 h: level +0.48, rise_1h +0.20, rise_3h -0.11, rain_1h +0.31, rain_3h +0.46, rain_6h -0.75, rain_24h +0.30, rain_72h +1.35, fc_rain_6h +1.33, intercept -12.72
