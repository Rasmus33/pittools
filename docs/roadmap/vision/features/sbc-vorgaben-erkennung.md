---
slug: sbc-vorgaben-erkennung
name: SBC-Vorgaben-Erkennung
primary_repo: pittools
secondary_repos: []
structural_max:
  RA: 80
phase_sequence:
- core
- diagnose
- tests
- docs
- release
confidence: 0.85
code_geography:
- ea-fc-sbc-optimizer.user.js — deepScanChallenge, findChallengeNode, collectChallengeNodes,
  applyFromSetChallenges, parseSbcChallenge, captureChallengeEntity, applyScan, syncSbcWithOpenChallenge
  (ca. Z. 317–770)
- ea-fc-sbc-optimizer.user.js — detectSquadSlotTotal (ca. Z. 2483–2537)
- docs/LEARNINGS.md — §6, §11
last_updated: '2026-08-14'
---

# SBC-Vorgaben-Erkennung

## Zweck

Liest aus der geoeffneten EA-FC-Challenge (Deep-Scan des Objektbaums bzw. services.SBC) generisch alle Vorgaben heraus: Ziel-OVR, Rarity-/Level-/Qualitaets-Constraints, Slot-Anzahl, Brick-Slots — unabhaengig von EAs wechselnden Response-Strukturen.

## Code-Geographie

- `ea-fc-sbc-optimizer.user.js — deepScanChallenge, findChallengeNode, collectChallengeNodes, applyFromSetChallenges, parseSbcChallenge, captureChallengeEntity, applyScan, syncSbcWithOpenChallenge (ca. Z. 317–770)`
- `ea-fc-sbc-optimizer.user.js — detectSquadSlotTotal (ca. Z. 2483–2537)`
- `docs/LEARNINGS.md — §6, §11`

## Strukturelle Maxima — Begründung

- **RA 80**: RA 80: EAs Response-Strukturen wechseln pro Season und teils pro SBC-Typ; der Deep-Scan ist bewusst generisch, aber ein struktureller Deckel bleibt, weil die Quelle undokumentiert ist. Hoeher als die reine API-Anbindung, weil Fehlerkennung durch reqDump/Diagnose gut beobachtbar ist.

## Phasen

core → diagnose → tests → docs → release — der eiserne Arbeitsablauf aus CLAUDE.md: Logik aendern, Diagnose-Felder fuer neue Fehlerbilder einbauen, Tests (Erwartungswerte per Brute-Force), LEARNINGS.md-Eintrag, Version bumpen (Push auf main = Deployment).

## Notizen

—
