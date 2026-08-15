# Audit — `diagnose-werkzeuge` — Iteration 2

**Stand:** 2026-08-15T12:14:18Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 84.0 | 84.0 / 85 | 59.49999999999999 | pass | audit-evaluator |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 76.0 | 84.0 | 8.0 | 82 | 133.3% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 84.0 (≥ 76.0 Iter 1).

**Effektivität:** in-range
(8.0 von 6.0 = 133.3% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Begründung:** Alle 3 Aktionen vollstaendig: lastEligible tri-state-sicher im Report, Symmetrie-Test mit 3 Richtungen + engen begruendeten Ausnahmen, Diagnose-Tool selbst gehaertet (Fallback ueber denselben Copy-Pfad, Regressionsblock 31). Rest zum Deckel 85 ist der inhaerente Lag fuer noch-nicht-gedachte Fehlerbilder.
**Evidence:**

- `ea-fc-sbc-optimizer.user.js:4066-4071`
- `ea-fc-sbc-optimizer.user.js:2795`
- `solver-test.js:1853-1905`
- `ea-fc-sbc-optimizer.user.js:4177-4195`
- `docs/LEARNINGS.md:1165-1208`

