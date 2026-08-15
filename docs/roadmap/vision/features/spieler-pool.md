---
slug: spieler-pool
name: Spieler-Pool (Laden, Normalisierung, Sperren)
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
- ea-fc-sbc-optimizer.user.js — isEvolution, normalizePlayer, resolvePlayerName, mergeIntoPool,
  removeFromPool, harvestItems (ca. Z. 770–1008)
- ea-fc-sbc-optimizer.user.js — Pool-Load Club/Unassigned/Storage inkl. Club-Lade-Takt
  (ca. Z. 1349–1399)
- ea-fc-sbc-optimizer.user.js — readPaletoolsLocks, findLockBranches, harvestIds,
  looksLikeItemId (ca. Z. 833–917)
- docs/LEARNINGS.md — §2, §7, §12, §16, §30
last_updated: '2026-08-14'
---

# Spieler-Pool (Laden, Normalisierung, Sperren)

## Zweck

Laedt Verein (paginiert, selbstbremsender Takt gegen 401er), Unassigned-Pile und SBC-Storage, normalisiert Rohdaten zu Spielerobjekten (schliesst Leihspieler/Evolutions/Konzepte aus), merged passiv erfasste Karten und filtert per PaleTools gesperrte Karten heraus.

## Code-Geographie

- `ea-fc-sbc-optimizer.user.js — isEvolution, normalizePlayer, resolvePlayerName, mergeIntoPool, removeFromPool, harvestItems (ca. Z. 770–1008)`
- `ea-fc-sbc-optimizer.user.js — Pool-Load Club/Unassigned/Storage inkl. Club-Lade-Takt (ca. Z. 1349–1399)`
- `ea-fc-sbc-optimizer.user.js — readPaletoolsLocks, findLockBranches, harvestIds, looksLikeItemId (ca. Z. 833–917)`
- `docs/LEARNINGS.md — §2, §7, §12, §16, §30`

## Strukturelle Maxima — Begründung

- **RA 85**: RA 85: Datenmodell und Normalisierung sind gut testbar und weitgehend unter eigener Kontrolle; der Deckel unter 100 kommt vom Lade-Weg (Rate-Limits, PaleTools-localStorage-Formate als fremde Schnittstelle).

## Phasen

core → diagnose → tests → docs → release — der eiserne Arbeitsablauf aus CLAUDE.md: Logik aendern, Diagnose-Felder fuer neue Fehlerbilder einbauen, Tests (Erwartungswerte per Brute-Force), LEARNINGS.md-Eintrag, Version bumpen (Push auf main = Deployment).

## Notizen

—
