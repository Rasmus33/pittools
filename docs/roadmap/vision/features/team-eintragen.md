---
slug: team-eintragen
name: Team ins SBC eintragen (Submit-Weg)
primary_repo: pittools
secondary_repos: []
structural_max:
  RA: 75
phase_sequence:
- core
- diagnose
- tests
- docs
- release
confidence: 0.85
code_geography:
- ea-fc-sbc-optimizer.user.js — toItemEntity, getControllerChain, findSbcController,
  refreshOpenSbcView, submitToSbc (ca. Z. 2671–2811, 4998–5048)
- docs/LEARNINGS.md — §5, §6 (Eindeutigkeit pro assetId, sonst HTTP 460), §19
last_updated: '2026-08-14'
---

# Team ins SBC eintragen (Submit-Weg)

## Zweck

Traegt das Solver-Team ueber UTItemEntityFactory + saveChallenge (Weg 0) in die offene SBC-Squad-Ansicht ein — der einzige bekannte Weg, der die Ansicht ohne F5 aktualisiert. Bei Einzel-SBCs drueckt Rasmus Submit selbst.

## Code-Geographie

- `ea-fc-sbc-optimizer.user.js — toItemEntity, getControllerChain, findSbcController, refreshOpenSbcView, submitToSbc (ca. Z. 2671–2811, 4998–5048)`
- `docs/LEARNINGS.md — §5, §6 (Eindeutigkeit pro assetId, sonst HTTP 460), §19`

## Strukturelle Maxima — Begründung

- **RA 75**: RA 75: haengt an EA-internen Controllern/Factories, die pro Plattform (PC vs. Handy) anders heissen und sich mit App-Updates aendern; Weg 0 ist 'nicht anfassen ohne Grund'. Beobachtbarkeit ueber submitVia/lastErrors ist gut, die Fragilitaet bleibt strukturell.

## Phasen

core → diagnose → tests → docs → release — der eiserne Arbeitsablauf aus CLAUDE.md: Logik aendern, Diagnose-Felder fuer neue Fehlerbilder einbauen, Tests (Erwartungswerte per Brute-Force), LEARNINGS.md-Eintrag, Version bumpen (Push auf main = Deployment).

## Notizen

—
