# Audit — `rating-solver` — Iteration 0

**Stand:** 2026-08-15T02:18:30Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 89.0 | 89.0 / 95 | 66.5 | pass | audit-evaluator |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 78.0 | 89.0 | 11.0 | 90 | 91.7% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 89.0 (≥ 78.0 Iter -1).

**Effektivität:** in-range
(11.0 von 12.0 = 91.7% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Begründung:** Alle 4 Struktur-Refactorings live verifiziert: reserve()-Funnel strukturell erzwungen inkl. Kollisions-Warnung, Komparator-Factory mit erhaltenem Tiebreak-Unterschied, makeCostOf als mechanische SSOT (Test ruft denselben Code), Totcode raus. Distanz zum Deckel 95: Kern-Formel bleibt reverse-engineered.
**Evidence:**

- `ea-fc-sbc-optimizer.user.js:1992-2003`
- `ea-fc-sbc-optimizer.user.js:1519-1524`
- `ea-fc-sbc-optimizer.user.js:1601-1613`
- `solver-test.js:857-954`
- `docs/LEARNINGS.md:986-1038`

