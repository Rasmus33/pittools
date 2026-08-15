# Audit — `sbc-vorgaben-erkennung` — Iteration 3

**Stand:** 2026-08-15T13:42:31Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 79.0 | 79.0 / 80 | 56.0 | pass | user-manual |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 78.0 | 79.0 | 1.0 | 79 | 100.0% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 79.0 (≥ 78.0 Iter 2).

**Effektivität:** in-range
(1.0 von 1.0 = 100.0% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Evidence:**

- `ea-fc-sbc-optimizer.user.js:436`
- `ea-fc-sbc-optimizer.user.js:838`
- `solver-test.js:2832-2936`
- `docs/LEARNINGS.md:1328-1381`

