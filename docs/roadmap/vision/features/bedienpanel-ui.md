---
slug: bedienpanel-ui
name: Bedienpanel & Einstiegspunkte
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
confidence: 0.75
code_geography:
- ea-fc-sbc-optimizer.user.js
- docs/LEARNINGS.md
last_updated: '2026-08-15'
---

# Bedienpanel & Einstiegspunkte

## Zweck

Das On-Page-UI: PitTools-Button in der SBC-Aktionsleiste + fliegender Kreis oeffnen ein ziehbares Panel — 'Spieler laden' oben, Min-Rating/Max-Ueberschuss prominent, Rest unter 'Erweiterte Einstellungen' (Zustand gemerkt), inkl. editierbarem Rating-Kosten-Band-Editor. Konfig in localStorage.

## Code-Geographie

- `ea-fc-sbc-optimizer.user.js — injectStyles, buildPanel, readConfig, renderResult, toast, setStatus, refreshSbcInfoUI (ca. Z. 2927–3358, 4008–4220)`
- `ea-fc-sbc-optimizer.user.js — Band-Editor: defaultBands, bandsToSpec, saveBands, initBandEditor (ca. Z. 3358–3459)`
- `ea-fc-sbc-optimizer.user.js — makeDraggable, inSbcView, togglePanel, buildSbcButton, syncLauncher (ca. Z. 3478–3701)`
- `docs/LEARNINGS.md — §10`

## Strukturelle Maxima — Begründung

- **RA 85**: RA 85: eigenes DOM, volle Kontrolle; solver-test prueft statisch, dass jede querySelector-Referenz existiert. Deckel unter 100 wegen der Einhaenge-Punkte in EAs Container (.sbc-button-container) und Viewport-Eigenheiten am Handy.

## Phasen

core → diagnose → tests → docs → release — der eiserne Arbeitsablauf aus CLAUDE.md: Logik aendern, Diagnose-Felder fuer neue Fehlerbilder einbauen, Tests (Erwartungswerte per Brute-Force), LEARNINGS.md-Eintrag, Version bumpen (Push auf main = Deployment).

## Notizen

—
