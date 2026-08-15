# Audit — `sbc-vorgaben-erkennung` — Iteration 7

**Stand:** 2026-08-15T20:07:19Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 80.0 | 80.0 / 80 | 56.0 | pass | user-manual |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 78.0 | 80.0 | 2.0 | 79 | 200.0% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 80.0 (≥ 78.0 Iter 6).

**Effektivität:** in-range
(2.0 von 1.0 = 200.0% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Evidence:**

- `ea-fc-sbc-optimizer.user.js:740-749`
- `solver-test.js:3031-3106`
- `docs/LEARNINGS.md:1369-1373`

