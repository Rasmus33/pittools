# Audit — `ea-app-anbindung` — Iteration 0

**Stand:** 2026-08-15T02:18:30Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 74.0 | 74.0 / 75 | 52.5 | pass | audit-evaluator |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 64.0 | 74.0 | 10.0 | 72 | 125.0% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 74.0 (≥ 64.0 Iter -1).

**Effektivität:** in-range
(10.0 von 8.0 = 125.0% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Begründung:** Regex-SSOT-Migration vollstaendig (alle Call-Sites, static-regression-getestet, ~35 neue Assertions fuer vorher ungetesteten Klassifizierer); Beobachtbarkeit strukturell ueber reportError geschlossen; apiRequest-Extraktion Q2-konform verschoben und dokumentiert — die bestehende 401-Retry-Duplikation deckelt zusammen mit der EA-Undokumentiertheit (max 75).
**Evidence:**

- `ea-fc-sbc-optimizer.user.js:194-207`
- `solver-test.js:2237-2329`
- `ea-fc-sbc-optimizer.user.js:147-150`
- `ea-fc-sbc-optimizer.user.js:1248-1257`
- `docs/LEARNINGS.md:1130-1163`

