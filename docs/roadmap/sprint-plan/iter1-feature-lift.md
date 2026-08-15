---
sprint: iter1-feature-lift
iteration: 1
duration_days: 14
starts: 2026-08-15
ends: 2026-08-29
---

# Sprint — iter1-feature-lift

## Ziel

Fokus-Iteration: die drei Iteration-0-Restpunkte schliessen; Basis ist der Test-Helfer #31.

## Tickets

| Issue | Titel | Kind | Effort | Konsumenten / Feature |
|-------|-------|------|--------|-----------------------|
| #32 | Batch: Abgabe nachpruefen, verbrauchte Instanzen sperren, Recovery echt testen | feature-lift | M | batch-modus (depends_on #31) |
| #33 | Diagnose-Report: lastEligible ausgeben, Symmetrie-Test komplett, submitInfo absichern | feature-lift | S | diagnose-werkzeuge (depends_on #31, deckt #24) |
| #34 | Solver: toten Duplikat-Tiebreak entfernen und Suchgrenzen ehrlich dokumentieren | feature-lift | S | rating-solver (depends_on #31, deckt #26) |
