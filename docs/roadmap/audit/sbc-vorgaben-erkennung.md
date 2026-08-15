# Audit — `sbc-vorgaben-erkennung` — Iteration 2

**Stand:** 2026-08-15T12:14:18Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 78.0 | 78.0 / 80 | 56.0 | pass | audit-evaluator |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 65.0 | 78.0 | N/A (held iter0) | 75 | — |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 78.0 (≥ 0.0 Iter 1).

**Effektivität:** all-held
(0.0 von 0.0 = 0.0% Reach über 0 Fokus-Dim, 1 Dim held)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Begründung:** Batch-Anker-Vergleich war struktureller No-Op und ist jetzt scharf, getestet und dokumentiert; Parser per Marker-Extraktion mit konstruierten EA-Objekten testbar; matchedAs schliesst die Dual-Use-Beobachtbarkeitsluecke inkl. Edge-Case. Verbleibender Deckel ist strukturell (EAs wechselnde Response-Form).
**Evidence:**

- `ea-fc-sbc-optimizer.user.js:4953`
- `ea-fc-sbc-optimizer.user.js:360`
- `ea-fc-sbc-optimizer.user.js:434-493`
- `solver-test.js:1876-1925`
- `docs/LEARNINGS.md:924-978`

