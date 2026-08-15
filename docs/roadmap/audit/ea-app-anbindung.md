# Audit — `ea-app-anbindung` — Iteration 4

**Stand:** 2026-08-15T14:36:41Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 75.0 | 75.0 / 75 | 52.5 | pass | user-manual |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 74.0 | 75.0 | 1.0 | 75 | 100.0% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 75.0 (≥ 74.0 Iter 3).

**Effektivität:** in-range
(1.0 von 1.0 = 100.0% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Evidence:**

- `ea-fc-sbc-optimizer.user.js:279-301`
- `ea-fc-sbc-optimizer.user.js:263-274`
- `solver-test.js:2976-3028`
- `docs/LEARNINGS.md:1383-1431`

