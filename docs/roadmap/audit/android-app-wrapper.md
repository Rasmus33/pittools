# Audit — `android-app-wrapper` — Iteration 5

**Stand:** 2026-08-15T15:22:57Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 80.0 | 80.0 / 80 | 56.0 | pass | user-manual |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 79.0 | 80.0 | 1.0 | 80 | 100.0% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 80.0 (≥ 79.0 Iter 4).

**Effektivität:** in-range
(1.0 von 1.0 = 100.0% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Evidence:**

- `app/sdk-env.sh:1-26`
- `app/compile-check.sh:1-19`
- `app/guard-test.js:64-107`
- `app/guard-test.js:234-250`
- `docs/LEARNINGS.md:1439-1470`

