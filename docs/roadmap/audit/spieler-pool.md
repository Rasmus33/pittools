# Audit — `spieler-pool` — Iteration 6

**Stand:** 2026-08-15T18:38:12Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 84.0 | 84.0 / 85 | 59.49999999999999 | pass | user-manual |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 83.0 | 84.0 | 1.0 | 80 | -33.3% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 84.0 (≥ 83.0 Iter 5).

**Effektivität:** in-range
(1.0 von -3.0 = -33.3% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Evidence:**

- `ea-fc-sbc-optimizer.user.js:1546-1552`
- `ea-fc-sbc-optimizer.user.js:1099-1121`
- `solver-test.js:3549-3641`
- `docs/LEARNINGS.md:1061-1097`

