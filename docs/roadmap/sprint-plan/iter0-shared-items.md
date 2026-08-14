---
sprint: iter0-shared-items
iteration: 0
duration_days: 14
starts: 2026-08-14
ends: 2026-08-28
---

# Sprint — iter0-shared-items

## Ziel

Der `reportError`-Kern (warn + diagError in einem Aufruf) liegt gemergt und
getestet vor, damit die Feature-Lifts ihre Fehlerpfade darauf umstellen können.

## Tickets

| Issue | Titel | Kind | Effort | Konsumenten / Feature |
|-------|-------|------|--------|-----------------------|
| #1 | Diagnose-Helfer reportError: warn und diagError in einem Aufruf | shared-item | S | diagnose-werkzeuge, ea-app-anbindung, spieler-pool, team-eintragen |
