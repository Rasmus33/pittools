# Audit — `android-app-wrapper` — Iteration 2

**Stand:** 2026-08-15T12:14:18Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 79.0 | 79.0 / 80 | 56.0 | pass | user-manual |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 72.0 | 79.0 | 7.0 | 78 | 116.7% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 79.0 (≥ 72.0 Iter 1).

**Effektivität:** in-range
(7.0 von 6.0 = 116.7% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Evidence:**

- `app/java/com/sbctools/browser/MainActivity.java:454-466`
- `app/java/com/sbctools/browser/MainActivity.java:171-189`
- `app/java/com/sbctools/browser/MainActivity.java:844-857`
- `app/guard-test.js:294-358`
- `app/AndroidManifest.xml:4-5`

