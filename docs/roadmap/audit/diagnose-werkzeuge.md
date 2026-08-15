# Audit — `diagnose-werkzeuge` — Iteration 3

**Stand:** 2026-08-15T13:42:31Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 84.0 | 84.0 / 85 | 59.49999999999999 | pass | audit-evaluator |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 76.0 | 84.0 | N/A (held iter1) | 82 | — |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 84.0 (≥ 0.0 Iter 2).

**Effektivität:** all-held
(0.0 von 0.0 = 0.0% Reach über 0 Fokus-Dim, 1 Dim held)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Begründung:** Alle 3 Aktionen vollstaendig: lastEligible tri-state-sicher im Report, Symmetrie-Test mit 3 Richtungen + engen begruendeten Ausnahmen, Diagnose-Tool selbst gehaertet (Fallback ueber denselben Copy-Pfad, Regressionsblock 31). Rest zum Deckel 85 ist der inhaerente Lag fuer noch-nicht-gedachte Fehlerbilder.
**Evidence:**

- `ea-fc-sbc-optimizer.user.js:4066-4071`
- `ea-fc-sbc-optimizer.user.js:2795`
- `solver-test.js:1853-1905`
- `ea-fc-sbc-optimizer.user.js:4177-4195`
- `docs/LEARNINGS.md:1165-1208`

