# Audit — `diagnose-werkzeuge` — Iteration 0

**Stand:** 2026-08-15T02:18:30Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 76.0 | 76.0 / 85 | 59.49999999999999 | pass | audit-evaluator |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 58.0 | 76.0 | 18.0 | 77 | 94.7% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 76.0 (≥ 58.0 Iter -1).

**Effektivität:** in-range
(18.0 von 19.0 = 94.7% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Begründung:** Alle 4 Aktionen im Code gelandet: uiScan echt differenziert, Duplikat weg + Regressionstest, Schema 6→21 Felder, reportError an 7 Call-Sites konsumiert, app/log-test.js nach SSOT-Extraktionsprinzip. Abzug: Symmetrie-Test prueft nur 2 von 3 Richtungen — lastEligible bleibt befuellt-aber-unsichtbar (uiScan-Fehlerklasse in Gegenrichtung), unentdeckt vom eigenen Test.
**Evidence:**

- `ea-fc-sbc-optimizer.user.js:110-132`
- `solver-test.js:1711-1772`
- `ea-fc-sbc-optimizer.user.js:147-150`
- `ea-fc-sbc-optimizer.user.js:4127-4138`
- `app/log-test.js:48-58`

