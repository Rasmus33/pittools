# Iteration-Effektivität — Iteration 1 (M6)

**Stand:** 2026-08-15T10:26:33Z

## Kennzahlen

> Gain-Kennzahlen zählen nur die in dieser Iteration (re-)gescorten **Fokus-Features**
> (9 von 9). 0 voll-gehaltene
> Feature(s) sind ausgeschlossen — ihr Alt-Gewinn wird nicht erneut gezählt (ADR #98).

- **avg_score_gain** über die Fokus-Features: **11.7**
- **median_score_gain**: 13.0
- **stdev_score_gain**: 6.4
- **under_expectation_ratio**: **0.0%** (0 / 9 Fokus-Features unter 70 % des erwarteten Gains)
- **worst_feature**: `rating-solver` (Gain: 3.0)
- **best_feature**: `android-app-wrapper` (Gain: 24.0)

## Bewertung

🟢 Iteration im Soll-Bereich. avg_gain ≥ 10, under_expectation_ratio ≤ 30 %.

## Pro-Feature Gain-Vergleich (Fokus-Features)

Pre/Post/Target Σ sind hier **fokus-scoped** (nur re-gescorte Dimensionen), damit
Post − Pre == Tatsächlicher Gain. Absolute Σ-Scores stehen in `_summary.md`.

| Feature | Pre Σ | Post Σ | Target Σ | Tatsächlicher Gain | Erwarteter Gain | Reach % |
|---------|-------|--------|----------|---------------------|------------------|---------|
| `android-app-wrapper` | 48.0 | 72.0 | 70 | 24.0 | 22.0 | 109.1% |
| `batch-modus` | 65.0 | 69.0 | 69 | 4.0 | 4.0 | 100.0% |
| `bedienpanel-ui` | 68.0 | 82.0 | 80 | 14.0 | 12.0 | 116.7% |
| `diagnose-werkzeuge` | 76.0 | 84.0 | 82 | 8.0 | 6.0 | 133.3% |
| `ea-app-anbindung` | 64.0 | 74.0 | 72 | 10.0 | 8.0 | 125.0% |
| `rating-solver` | 89.0 | 92.0 | 90 | 3.0 | 1.0 | 300.0% |
| `sbc-vorgaben-erkennung` | 65.0 | 78.0 | 75 | 13.0 | 10.0 | 130.0% |
| `spieler-pool` | 70.0 | 83.0 | 80 | 13.0 | 10.0 | 130.0% |
| `team-eintragen` | 60.0 | 76.0 | 70 | 16.0 | 10.0 | 160.0% |
