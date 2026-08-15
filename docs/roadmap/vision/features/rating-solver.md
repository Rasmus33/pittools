---
slug: rating-solver
name: Rating-Solver (Team-Optimierung)
primary_repo: pittools
secondary_repos: []
structural_max:
  RA: 95
phase_sequence:
- core
- diagnose
- tests
- docs
- release
confidence: 0.95
code_geography:
- ea-fc-sbc-optimizer.user.js
- solver-test.js
- docs/LEARNINGS.md
last_updated: '2026-08-15'
---

# Rating-Solver (Team-Optimierung)

## Zweck

Exakter DP-Solver (bounded knapsack) zwischen den Markern [SOLVER-BEGIN]/[SOLVER-END]: findet aus dem Pool unter allen erkannten Vorgaben das Team mit minimalem exaktem Rating-Ueberschuss und geringsten Karten-Kosten — inkl. planBatch fuer mehrere Runden. Von solver-test.js per Brute-Force verifiziert.

## Code-Geographie

- `ea-fc-sbc-optimizer.user.js — Block [SOLVER-BEGIN]…[SOLVER-END] (ca. Z. 1411–2446): squadRating/squadRatingExact/squadV, parseRatingCosts/costOf, matchesRarity, buildDp, solve/solveCore, finishTeam, planBatch`
- `solver-test.js — Testsuite (extrahiert den Block per Marker, Brute-Force-Paritaet)`
- `docs/LEARNINGS.md — §1 (Rating-Formel, V-Mass)`

## Strukturelle Maxima — Begründung

- **RA 95**: RA 95: rein deterministische Logik ohne EA-Abhaengigkeit, per Brute-Force exakt verifizierbar — hoechster Deckel im Projekt. Die letzten 5 Punkte bleiben offen, weil die Rating-Formel selbst reverse-engineered ist (live verifiziert, nicht spezifiziert).

## Phasen

core → diagnose → tests → docs → release — der eiserne Arbeitsablauf aus CLAUDE.md: Logik aendern, Diagnose-Felder fuer neue Fehlerbilder einbauen, Tests (Erwartungswerte per Brute-Force), LEARNINGS.md-Eintrag, Version bumpen (Push auf main = Deployment).

## Notizen

—
