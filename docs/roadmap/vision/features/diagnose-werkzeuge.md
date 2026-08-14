---
slug: diagnose-werkzeuge
name: Diagnose-Werkzeuge (Script-Report & App-Log)
primary_repo: pittools
secondary_repos: []
structural_max:
  RA: 85
phase_sequence:
- core
- diagnose
- tests
- docs
- release
confidence: 0.6
code_geography:
- ea-fc-sbc-optimizer.user.js — buildDiagReport, onDiagClick, diagError, STATE.diag.*
  (ca. Z. 3701–4008)
- app/java/com/sbctools/browser/MainActivity.java — addLog, buildLogReport, shareLog/copyLog,
  onConsoleMessage
- CLAUDE.md — Debugging-Konvention
last_updated: '2026-08-14'
---

# Diagnose-Werkzeuge (Script-Report & App-Log)

## Zweck

Zwei Copy-Paste-Kanaele vom Handy in den Chat: JSON-Diagnose-Report im Panel (Vorgaben, Fehler, Controller-Scan, batchSteps) und App-seitiger Ringpuffer aller Konsolenmeldungen inkl. PaleTools/uncaught errors. Arbeitsregel: fehlt Info fuer ein neues Problem, erst Diagnose-Feld einbauen, Report anfordern, dann fixen.

## Code-Geographie

- `ea-fc-sbc-optimizer.user.js — buildDiagReport, onDiagClick, diagError, STATE.diag.* (ca. Z. 3701–4008)`
- `app/java/com/sbctools/browser/MainActivity.java — addLog, buildLogReport, shareLog/copyLog, onConsoleMessage`
- `CLAUDE.md — Debugging-Konvention`

## Strukturelle Maxima — Begründung

- **RA 85**: RA 85: beide Kanaele sind unter eigener Kontrolle und der bewaehrte Kern des Arbeitsablaufs; Deckel unter 100, weil der Report nur zeigt, was vorher als Feld eingebaut wurde — neue Fehlerbilder brauchen immer eine Runde Vorlauf.

## Phasen

core → diagnose → tests → docs → release — der eiserne Arbeitsablauf aus CLAUDE.md: Logik aendern, Diagnose-Felder fuer neue Fehlerbilder einbauen, Tests (Erwartungswerte per Brute-Force), LEARNINGS.md-Eintrag, Version bumpen (Push auf main = Deployment).

## Notizen

—
