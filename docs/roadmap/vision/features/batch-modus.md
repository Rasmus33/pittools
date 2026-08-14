---
slug: batch-modus
name: Batch-Modus (Mehrfach-Abgabe)
primary_repo: pittools
secondary_repos: []
structural_max:
  RA: 70
phase_sequence:
- core
- diagnose
- tests
- docs
- release
confidence: 0.9
code_geography:
- ea-fc-sbc-optimizer.user.js — onBatchPlanClick/onBatchRunClick, openNextInstance,
  submitChallengeToEa, popupState/dismissRewardPopup, clickLike, clickSetTile/clickAllFilter/clickChallengeRow/clickBackButton,
  setLooksRepeatable, matchesPlannedSbc, renderBatchPreview (ca. Z. 4220–4980)
- ea-fc-sbc-optimizer.user.js — planBatch (im Solver-Block)
- docs/LEARNINGS.md — §9, §21
- docs/ROADMAP.md — Batch-Navigation
last_updated: '2026-08-14'
---

# Batch-Modus (Mehrfach-Abgabe)

## Zweck

Plant Teams fuer mehrere Wiederholungen desselben SETs vorab (Vorschau + EINE Freigabe), dann pro Runde automatisch: eintragen, abgeben, Belohnungs-Popup wegraeumen, frische Challenge-Instanz oeffnen. Anker ist das SET plus Vorgaben — jede Wiederholung hat eine eigene challengeId. Bricht bei jeder Unstimmigkeit ab.

## Code-Geographie

- `ea-fc-sbc-optimizer.user.js — onBatchPlanClick/onBatchRunClick, openNextInstance, submitChallengeToEa, popupState/dismissRewardPopup, clickLike, clickSetTile/clickAllFilter/clickChallengeRow/clickBackButton, setLooksRepeatable, matchesPlannedSbc, renderBatchPreview (ca. Z. 4220–4980)`
- `ea-fc-sbc-optimizer.user.js — planBatch (im Solver-Block)`
- `docs/LEARNINGS.md — §9, §21`
- `docs/ROADMAP.md — Batch-Navigation`

## Strukturelle Maxima — Begründung

- **RA 70**: RA 70: fragilster Teil — DOM-Klicks auf EA-Views mit eigenem Event-System, Popup-Reihenfolgen, Hub-Filter, Set-Erschoepfung; jede EA-UI-Aenderung kann den Ablauf brechen. Der Deckel honoriert die Abbruch-Philosophie ('2 von 5 fertig' statt falsch abgegeben), nicht Unfehlbarkeit.

## Phasen

core → diagnose → tests → docs → release — der eiserne Arbeitsablauf aus CLAUDE.md: Logik aendern, Diagnose-Felder fuer neue Fehlerbilder einbauen, Tests (Erwartungswerte per Brute-Force), LEARNINGS.md-Eintrag, Version bumpen (Push auf main = Deployment).

## Notizen

—
