# Audit — `rating-solver` — Iteration 6

**Stand:** 2026-08-15T18:38:12Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 94.0 | 94.0 / 95 | 66.5 | pass | user-manual |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 92.0 | 94.0 | 2.0 | 93 | 200.0% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 94.0 (≥ 92.0 Iter 5).

**Effektivität:** in-range
(2.0 von 1.0 = 200.0% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Evidence:**

- `ea-fc-sbc-optimizer.user.js:2526-2657`
- `ea-fc-sbc-optimizer.user.js:2378-2513`
- `solver-test.js:3712-3802`
- `docs/LEARNINGS.md:1551-1641`

