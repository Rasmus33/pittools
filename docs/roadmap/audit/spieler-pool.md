# Audit — `spieler-pool` — Iteration 8

**Stand:** 2026-08-15T20:36:34Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 85.0 | 85.0 / 85 | 59.49999999999999 | pass | user-manual |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 83.0 | 85.0 | 2.0 | 80 | -66.7% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 85.0 (≥ 83.0 Iter 7).

**Effektivität:** in-range
(2.0 von -3.0 = -66.7% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Evidence:**

- `solver-test.js:4438-4496`
- `ea-fc-sbc-optimizer.user.js:1224-1237`
- `docs/LEARNINGS.md:1099-1119`

