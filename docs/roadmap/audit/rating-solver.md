# Audit — `rating-solver` — Iteration 1

**Stand:** 2026-08-15T10:26:33Z
## Score-Stand

| Dim | Ist (raw) | Capped (struct_max) | Schwellwert | Status | Provenance |
|-----|-----------|----------------------|-------------|--------|------------|
| **RA** | 92.0 | 92.0 / 95 | 66.5 | pass | audit-evaluator |

## Pre / Post / Gain

| Dim | Pre | Post | Gain | Target | Reach % |
|-----|-----|------|------|--------|---------|
| **RA** | 89.0 | 92.0 | 3.0 | 90 | 300.0% |

> Held-Dimensionen (in dieser Iteration nicht re-gescored, ADR #98) zeigen `N/A` —
> ihr Gain wird nicht gegen eine veraltete Baseline gerechnet.

## Regression / Effektivität

🟢 Keine Regression — Σ Ist 92.0 (≥ 89.0 Iter 0).

**Effektivität:** in-range
(3.0 von 1.0 = 300.0% Reach über 1 Fokus-Dim)

## Evidence + Reasoning pro Dim

### RA — Robust Architecture

**Begründung:** Alle 3 Aktionen vollstaendig und rigoroser als geplant: Tiebreak per Reihenfolge-Beweis entfernt, Test 6 mit Gegenprobe gegen den Vakuum-Wahrheits-Vorwurf ersetzt, Suchgrenzen hergeleitet, neues Diagnose-Signal mit Gegenproben-Testpaar. Rest zum Deckel 95 bleibt strukturell (reverse-engineerte Formel).
**Evidence:**

- `ea-fc-sbc-optimizer.user.js:1495-1507`
- `ea-fc-sbc-optimizer.user.js:2401-2406`
- `ea-fc-sbc-optimizer.user.js:2511-2522`
- `solver-test.js:268-345`
- `docs/LEARNINGS.md:1210-1261`

