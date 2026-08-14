---
slug: ea-app-anbindung
name: EA-Web-App-Anbindung (Session & API-Zugriff)
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
confidence: 0.7
code_geography:
- ea-fc-sbc-optimizer.user.js — fetch/XHR-Wrapper, absorbSessionHeaders, detectApiBase,
  classifyUrl, handleResponseBody (ca. Z. 116–312)
- ea-fc-sbc-optimizer.user.js — servicesAvailable, obsPromise, responseOk, apiHeaders,
  httpErrText (ca. Z. 1008–1350)
- ea-fc-sbc-optimizer.user.js — installServicesHooks, boot, findLiveChallenge (ca.
  Z. 4982–5145)
- docs/LEARNINGS.md — §3, §4
last_updated: '2026-08-14'
---

# EA-Web-App-Anbindung (Session & API-Zugriff)

## Zweck

Doppelt abgesicherter Zugriff auf die inoffizielle EA-FC-Web-App-Laufzeit: Netzwerk-Interception (fetch/XHR) UND direkter Zugriff auf interne App-Services (window.services.*), inkl. Session-Header (SID, Phishing-Token) und API-Base-Erkennung. Fundament fuer alle anderen Features.

## Code-Geographie

- `ea-fc-sbc-optimizer.user.js — fetch/XHR-Wrapper, absorbSessionHeaders, detectApiBase, classifyUrl, handleResponseBody (ca. Z. 116–312)`
- `ea-fc-sbc-optimizer.user.js — servicesAvailable, obsPromise, responseOk, apiHeaders, httpErrText (ca. Z. 1008–1350)`
- `ea-fc-sbc-optimizer.user.js — installServicesHooks, boot, findLiveChallenge (ca. Z. 4982–5145)`
- `docs/LEARNINGS.md — §3, §4`

## Strukturelle Maxima — Begründung

- **RA 75**: RA 75: inoffizielle, undokumentierte API — Robustheit ist strukturell durch EA gedeckelt (Session-Mechanik, Rate-Limits, Umbauten ohne Ankuendigung). Der Wert honoriert die Doppel-Absicherung (Netzwerk + Services), nicht die Quelle.

## Phasen

core → diagnose → tests → docs → release — der eiserne Arbeitsablauf aus CLAUDE.md: Logik aendern, Diagnose-Felder fuer neue Fehlerbilder einbauen, Tests (Erwartungswerte per Brute-Force), LEARNINGS.md-Eintrag, Version bumpen (Push auf main = Deployment).

## Notizen

—
