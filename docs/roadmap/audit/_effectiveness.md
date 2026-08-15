# Iteration-Effektivität — Iteration 2 (M6)

**Stand:** 2026-08-15T12:14:18Z

## Kennzahlen

> Gain-Kennzahlen zählen nur die in dieser Iteration (re-)gescorten **Fokus-Features**
> (4 von 9). 5 voll-gehaltene
> Feature(s) sind ausgeschlossen — ihr Alt-Gewinn wird nicht erneut gezählt (ADR #98).

- **avg_score_gain** über die Fokus-Features: **5.5**
- **median_score_gain**: 5.5
- **stdev_score_gain**: 2.4
- **under_expectation_ratio**: **0.0%** (0 / 4 Fokus-Features unter 70 % des erwarteten Gains)
- **worst_feature**: `rating-solver` (Gain: 3.0)
- **best_feature**: `diagnose-werkzeuge` (Gain: 8.0)

## Bewertung

🔴 **avg_gain < 10** — Iteration hat strukturell wenig bewegt. Empfehlung: nächste Iter aggressivere Lift-Pläne (höhere Ambitions-Regel-Faktoren in M3) ODER tieferes Re-Audit der Features die wenig gewonnen haben.

## Pro-Feature Gain-Vergleich (Fokus-Features)

Pre/Post/Target Σ sind hier **fokus-scoped** (nur re-gescorte Dimensionen), damit
Post − Pre == Tatsächlicher Gain. Absolute Σ-Scores stehen in `_summary.md`.

| Feature | Pre Σ | Post Σ | Target Σ | Tatsächlicher Gain | Erwarteter Gain | Reach % |
|---------|-------|--------|----------|---------------------|------------------|---------|
| `android-app-wrapper` | 72.0 | 79.0 | 78 | 7.0 | 6.0 | 116.7% |
| `batch-modus` | 65.0 | 69.0 | 69 | 4.0 | 4.0 | 100.0% |
| `diagnose-werkzeuge` | 76.0 | 84.0 | 82 | 8.0 | 6.0 | 133.3% |
| `rating-solver` | 89.0 | 92.0 | 90 | 3.0 | 1.0 | 300.0% |

## Held-Features (nicht re-gescored)

Diese Features hatten in dieser Iteration keine re-gescorte Fokus-Zelle — ihr Gain
ist **N/A** (kein Alt-Gewinn doppelt gezählt, ADR #98).

- `bedienpanel-ui` — 1 Dim(s) held, gain N/A
- `ea-app-anbindung` — 1 Dim(s) held, gain N/A
- `sbc-vorgaben-erkennung` — 1 Dim(s) held, gain N/A
- `spieler-pool` — 1 Dim(s) held, gain N/A
- `team-eintragen` — 1 Dim(s) held, gain N/A
