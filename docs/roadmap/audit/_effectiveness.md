# Iteration-Effektivität — Iteration 0 (M6)

**Stand:** 2026-08-15T02:18:30Z

## Kennzahlen

> Gain-Kennzahlen zählen nur die in dieser Iteration (re-)gescorten **Fokus-Features**
> (9 von 9). 0 voll-gehaltene
> Feature(s) sind ausgeschlossen — ihr Alt-Gewinn wird nicht erneut gezählt (ADR #98).

- **avg_score_gain** über die Fokus-Features: **13.8**
- **median_score_gain**: 13.0
- **stdev_score_gain**: 5.3
- **under_expectation_ratio**: **0.0%** (0 / 9 Fokus-Features unter 70 % des erwarteten Gains)
- **worst_feature**: `batch-modus` (Gain: 5.0)
- **best_feature**: `android-app-wrapper` (Gain: 24.0)

## Bewertung

🟢 Iteration im Soll-Bereich. avg_gain ≥ 10, under_expectation_ratio ≤ 30 %.

## Pro-Feature Gain-Vergleich (Fokus-Features)

Pre/Post/Target Σ sind hier **fokus-scoped** (nur re-gescorte Dimensionen), damit
Post − Pre == Tatsächlicher Gain. Absolute Σ-Scores stehen in `_summary.md`.

| Feature | Pre Σ | Post Σ | Target Σ | Tatsächlicher Gain | Erwarteter Gain | Reach % |
|---------|-------|--------|----------|---------------------|------------------|---------|
| `android-app-wrapper` | 48.0 | 72.0 | 70 | 24.0 | 22.0 | 109.1% |
| `batch-modus` | 60.0 | 65.0 | 67 | 5.0 | 7.0 | 71.4% |
| `bedienpanel-ui` | 68.0 | 82.0 | 80 | 14.0 | 12.0 | 116.7% |
| `diagnose-werkzeuge` | 58.0 | 76.0 | 77 | 18.0 | 19.0 | 94.7% |
| `ea-app-anbindung` | 64.0 | 74.0 | 72 | 10.0 | 8.0 | 125.0% |
| `rating-solver` | 78.0 | 89.0 | 90 | 11.0 | 12.0 | 91.7% |
| `sbc-vorgaben-erkennung` | 65.0 | 78.0 | 75 | 13.0 | 10.0 | 130.0% |
| `spieler-pool` | 70.0 | 83.0 | 80 | 13.0 | 10.0 | 130.0% |
| `team-eintragen` | 60.0 | 76.0 | 70 | 16.0 | 10.0 | 160.0% |
