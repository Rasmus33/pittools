# Iteration-Effektivität — Iteration 8 (M6)

**Stand:** 2026-08-15T20:36:34Z

## Kennzahlen

> Gain-Kennzahlen zählen nur die in dieser Iteration (re-)gescorten **Fokus-Features**
> (8 von 9). 1 voll-gehaltene
> Feature(s) sind ausgeschlossen — ihr Alt-Gewinn wird nicht erneut gezählt (ADR #98).

- **avg_score_gain** über die Fokus-Features: **1.8**
- **median_score_gain**: 1.5
- **stdev_score_gain**: 0.9
- **under_expectation_ratio**: **0.0%** (0 / 8 Fokus-Features unter 70 % des erwarteten Gains)
- **worst_feature**: `android-app-wrapper` (Gain: 1.0)
- **best_feature**: `bedienpanel-ui` (Gain: 3.0)

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
| `rating-solver` | 92.0 | 95.0 | 93 | 3.0 | 1.0 | 300.0% |
| `sbc-vorgaben-erkennung` | 78.0 | 80.0 | 79 | 2.0 | 1.0 | 200.0% |
| `spieler-pool` | 83.0 | 85.0 | 80 | 2.0 | -3.0 | -66.7% |

## Held-Features (nicht re-gescored)

Diese Features hatten in dieser Iteration keine re-gescorte Fokus-Zelle — ihr Gain
ist **N/A** (kein Alt-Gewinn doppelt gezählt, ADR #98).

- `team-eintragen` — 1 Dim(s) held, gain N/A
