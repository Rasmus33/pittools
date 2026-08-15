# Audit — `team-eintragen` — Iteration 1

**Stand:** 2026-08-15T10:26:33Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 76.0 | 75 / 75 | 52.5 | pass | audit-evaluator |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 60.0 | 76.0 | 16.0 | 70 | 160.0% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 76.0 (≥ 60.0 Iter 0).

**Effektivität:** in-range
(16.0 von 10.0 = 160.0% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Begründung:** Alle 5 Aktionen umgesetzt: Traversal konsolidiert (depth-Divergenz bewusst geglaettet + Tiefe-13-Test), findLiveChallenge mit gehaertetem typeof-Guard (latenter Bug gefixt), reportError-Adoption, echte Verhaltenstests am synthetischen Controller-Baum statt Text-Greps, Weg 0 kommentiert-unangetastet. Rest-Abstand = inhaerente EA-Fragilitaet von submitViaApp (wird vom Cap 75 gedeckelt).
**Evidence:**

- `ea-fc-sbc-optimizer.user.js:2840-2852`
- `ea-fc-sbc-optimizer.user.js:801-818`
- `ea-fc-sbc-optimizer.user.js:5145-5160`
- `solver-test.js:2096-2234`
- `docs/LEARNINGS.md:1091-1128`

