---
sprint: iter0-feature-lift
iteration: 0
duration_days: 14
starts: 2026-08-14
ends: 2026-08-28
---

# Sprint — iter0-feature-lift

## Ziel

Alle 9 Features erreichen ihre M3-RA-Targets (Σ +110 Punkte); insbesondere
kommen android-app-wrapper und diagnose-werkzeuge über ihre Schwellwerte.
Kein Merge ohne komplett grünen eisernen Arbeitsablauf (keine Regression).

## Tickets

| Issue | Titel | Kind | Effort | Konsumenten / Feature |
|-------|-------|------|--------|-----------------------|
| #2 | App: stille Netzwerk- und Cache-Catches loggen + Ringpuffer-Tests | feature-lift | M | android-app-wrapper |
| #3 | Diagnose-Report: uiScan befuellen, Schema-Test, Log-Ringpuffer-Tests | feature-lift | M | diagnose-werkzeuge (depends_on #1) |
| #4 | Slot-Namensdrift beheben und SBC-Parser mit echten Tests absichern | feature-lift | S | sbc-vorgaben-erkennung |
| #5 | Batch: Anker-Sicherheitsnetz testen + Orchestrierung statisch absichern | feature-lift | S | batch-modus (depends_on #4) |
| #6 | Solver: reserve-Funnel schliessen, Komparator-Factory, Kostenformel-SSOT | feature-lift | M | rating-solver |
| #7 | Panel: Kosten-Defaults auf SSOT ziehen und Band-Editor absichern | feature-lift | S | bedienpanel-ui |
| #8 | Spieler-Pool: Fehlerpfade sichtbar machen, Normalisierung und Locks testen | feature-lift | S | spieler-pool |
| #9 | Team-Eintragen: Controller-Traversal konsolidieren mit Laufzeit-Tests | feature-lift | M | team-eintragen |
| #10 | EA-Anbindung: Fehler sichtbar machen und sbs/sbc-Pfadwissen konsolidieren | feature-lift | S | ea-app-anbindung |
