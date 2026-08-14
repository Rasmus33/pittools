---
slug: android-app-wrapper
name: Android-App (WebView-Wrapper mit Script-Injection)
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
confidence: 0.9
code_geography:
- app/java/com/sbctools/browser/MainActivity.java
- app/AndroidManifest.xml
- app/assets/sbc-optimizer.user.js
- app/build.sh
- app/guard-test.js
- app/README.md
last_updated: '2026-08-14'
---

# Android-App (WebView-Wrapper mit Script-Injection)

## Zweck

Eigenstaendige App 'PitTools': WebView um die EA-Web-App, injiziert bei jedem Start den Optimizer (Download-zuerst, Cache/Asset-Fallback) und PaleTools (gestueckelt wegen IPC-Limit, mit Bereitschafts-Waechter). Build ohne Gradle (build.sh), Signatur mit Rasmus' debug.keystore.

## Code-Geographie

- `app/java/com/sbctools/browser/MainActivity.java`
- `app/AndroidManifest.xml`
- `app/assets/sbc-optimizer.user.js`
- `app/build.sh`
- `app/guard-test.js`
- `app/README.md`

## Strukturelle Maxima — Begründung

- **RA 80**: RA 80: eigener Code mit Waechter-Test, aber strukturell gedeckelt durch WebView-IPC-Limits, Keystore-Abhaengigkeit (nicht im Repo) und fehlende DevTools am Geraet — Fehlerbilder sind nur ueber den Log-Ringpuffer beobachtbar.

## Phasen

core → diagnose → tests → docs → release — der eiserne Arbeitsablauf aus CLAUDE.md: Logik aendern, Diagnose-Felder fuer neue Fehlerbilder einbauen, Tests (Erwartungswerte per Brute-Force), LEARNINGS.md-Eintrag, Version bumpen (Push auf main = Deployment).

## Notizen

—
