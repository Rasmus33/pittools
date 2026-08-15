# Iteration-Effektivität — Iteration 3 (M6)

**Stand:** 2026-08-15T13:42:31Z

## Kennzahlen

> Gain-Kennzahlen zählen nur die in dieser Iteration (re-)gescorten **Fokus-Features**
> (3 von 9). 6 voll-gehaltene
> Feature(s) sind ausgeschlossen — ihr Alt-Gewinn wird nicht erneut gezählt (ADR #98).

- **avg_score_gain** über die Fokus-Features: **1.0**
- **median_score_gain**: 1.0
- **stdev_score_gain**: 0.0
- **under_expectation_ratio**: **0.0%** (0 / 3 Fokus-Features unter 70 % des erwarteten Gains)
- **worst_feature**: `android-app-wrapper` (Gain: 1.0)
- **best_feature**: `android-app-wrapper` (Gain: 1.0)

## Bewertung

🔴 **avg_gain < 10** — Iteration hat strukturell wenig bewegt. Empfehlung: nächste Iter aggressivere Lift-Pläne (höhere Ambitions-Regel-Faktoren in M3) ODER tieferes Re-Audit der Features die wenig gewonnen haben.

## Pro-Feature Gain-Vergleich (Fokus-Features)

Pre/Post/Target Σ sind hier **fokus-scoped** (nur re-gescorte Dimensionen), damit
Post − Pre == Tatsächlicher Gain. Absolute Σ-Scores stehen in `_summary.md`.

| Feature | Pre Σ | Post Σ | Target Σ | Tatsächlicher Gain | Erwarteter Gain | Reach % |
|---------|-------|--------|----------|---------------------|------------------|---------|
| `android-app-wrapper` | 79.0 | 80.0 | 80 | 1.0 | 1.0 | 100.0% |
| `ea-app-anbindung` | 74.0 | 75.0 | 75 | 1.0 | 1.0 | 100.0% |
| `sbc-vorgaben-erkennung` | 78.0 | 79.0 | 79 | 1.0 | 1.0 | 100.0% |

## Held-Features (nicht re-gescored)

Diese Features hatten in dieser Iteration keine re-gescorte Fokus-Zelle — ihr Gain
ist **N/A** (kein Alt-Gewinn doppelt gezählt, ADR #98).

- `batch-modus` — 1 Dim(s) held, gain N/A
- `bedienpanel-ui` — 1 Dim(s) held, gain N/A
- `diagnose-werkzeuge` — 1 Dim(s) held, gain N/A
- `rating-solver` — 1 Dim(s) held, gain N/A
- `spieler-pool` — 1 Dim(s) held, gain N/A
- `team-eintragen` — 1 Dim(s) held, gain N/A
