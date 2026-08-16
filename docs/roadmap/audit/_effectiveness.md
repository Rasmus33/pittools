# Iteration-Effektivität — Iteration 10 (M6)

**Stand:** 2026-08-16T01:30:12Z

## Kennzahlen

> Gain-Kennzahlen zählen nur die in dieser Iteration (re-)gescorten **Fokus-Features**
> (9 von 10). 1 voll-gehaltene
> Feature(s) sind ausgeschlossen — ihr Alt-Gewinn wird nicht erneut gezählt (ADR #98).

- **avg_score_gain** über die Fokus-Features: **6.4**
- **median_score_gain**: 1.0
- **stdev_score_gain**: 14.9
- **under_expectation_ratio**: **11.1%** (1 / 9 Fokus-Features unter 70 % des erwarteten Gains)
- **worst_feature**: `android-app-wrapper` (Gain: 1.0)
- **best_feature**: `pack-opener` (Gain: 46.0)

## Bewertung

🔴 **avg_gain < 10** — Iteration hat strukturell wenig bewegt. Empfehlung: nächste Iter aggressivere Lift-Pläne (höhere Ambitions-Regel-Faktoren in M3) ODER tieferes Re-Audit der Features die wenig gewonnen haben.

## Pro-Feature Gain-Vergleich (Fokus-Features)

Pre/Post/Target Σ sind hier **fokus-scoped** (nur re-gescorte Dimensionen), damit
Post − Pre == Tatsächlicher Gain. Absolute Σ-Scores stehen in `_summary.md`.

| Feature | Pre Σ | Post Σ | Target Σ | Tatsächlicher Gain | Erwarteter Gain | Reach % |
|---------|-------|--------|----------|---------------------|------------------|---------|
| `android-app-wrapper` | 79.0 | 80.0 | 80 | 1.0 | 1.0 | 100.0% |
| `batch-modus` | 69.0 | 70.0 | 69 | 1.0 | 0.0 | 100.0% |
| `bedienpanel-ui` | 82.0 | 85.0 | 84 | 3.0 | 2.0 | 150.0% |
| `diagnose-werkzeuge` | 84.0 | 85.0 | 82 | 1.0 | -2.0 | -50.0% |
| `ea-app-anbindung` | 74.0 | 75.0 | 75 | 1.0 | 1.0 | 100.0% |
| `pack-opener` | 0.0 | 46.0 | 70 | 46.0 | 70.0 | 65.7% |
| `rating-solver` | 93.0 | 94.0 | 93 | 1.0 | 0.0 | 100.0% |
| `sbc-vorgaben-erkennung` | 78.0 | 80.0 | 79 | 2.0 | 1.0 | 200.0% |
| `spieler-pool` | 83.0 | 85.0 | 80 | 2.0 | -3.0 | -66.7% |

## Held-Features (nicht re-gescored)

Diese Features hatten in dieser Iteration keine re-gescorte Fokus-Zelle — ihr Gain
ist **N/A** (kein Alt-Gewinn doppelt gezählt, ADR #98).

- `team-eintragen` — 1 Dim(s) held, gain N/A
