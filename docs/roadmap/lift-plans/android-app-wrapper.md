---
feature: android-app-wrapper
iteration: 0
score_current:
  RA: 48
score_target:
  RA: 70
primary_paths:
  - app/java/com/sbctools/browser/MainActivity.java
  - app/guard-test.js
  - app/AndroidManifest.xml
patterns_required:
  - ea-grenz-fallback-ketten
  - diagnose-feld-statt-raten
  - eingebetteten-code-exakt-testen
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P2-normal
effort: M
analyzed_at: 2026-08-15
---

# Lift-Plan — Android-App (WebView-Wrapper mit Script-Injection)

## Marschroute

Die RA-Lücke (48/80, Schwelle 56) sitzt komplett an einer Stelle: die Netz-/
Cache-Grenze in `MainActivity.java` verschluckt Fehler ohne `addLog`, wodurch
der einzige Diagnosekanal am Gerät (⚙ → "Log teilen"/"Log kopieren") genau an
der Stelle blind ist, an der EAs/Github-CDNs Undokumentiertheit am härtesten
zuschlägt (Timeout, 4xx/5xx, kaputter Cache). Vier additive Schritte, alle
innerhalb der drei genannten Dateien, in dieser Reihenfolge (folgt
`phase_sequence: core → diagnose → tests → docs → release` aus dem
Vision-Doc):

1. **core:** rohe `addLog(...)`-Zeilen an jeder stillen Catch-/Early-Return-
   Stelle nachrüsten (Mangel 1/2/5) — kein Kontrollfluss ändert sich, nur
   Beobachtbarkeit.
2. **diagnose:** die so entstandenen Ad-hoc-Strings hinter einem einzigen
   `reportNetError(String where, String detail)`-Helfer bündeln UND die drei
   direkten Feldmutationen (`scriptsReady`, `paleStatus`, `paleInjected`)
   durch Setter ersetzen, die selbst `addLog` aufrufen (Mangel 4) — SSOT für
   "jede Statusänderung wird geloggt".
3. **tests:** `app/guard-test.js` um zwei statische Source-Regex-Checks
   erweitern (Mangel 3): ScriptLoader-Reihenfolge (Fallback-Kette) und
   Pflicht-`addLog`/`reportNetError` je Netz-/Cache-Methode. Kein Gerät,
   kein Build nötig — reiner `node`-Lauf.
4. **docs:** `docs/LEARNINGS.md` bekommt einen Eintrag, der den neuen
   `reportNetError`-Choke-Point und die drei Setter als "Nicht anfassen ohne
   Grund"-Kandidaten dokumentiert (Q7: IST-Zustand, kein Änderungsprotokoll).
5. **release:** `versionCode`/`versionName` in `app/AndroidManifest.xml`
   bumpen, `node app/guard-test.js` grün, `cd app && ./build.sh`,
   `apksigner verify --print-certs` = `41f23895…1b17`, APK an Rasmus zur
   Installation.

Reihenfolge ist bewusst additiv-zuerst (core vor dem SSOT-Refactor in
diagnose), damit ein Zwischenstand nach core allein schon regressionsfrei und
auslieferbar wäre, falls der Rest der Iteration abgebrochen werden müsste.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`addLog` an jeder stillen Catch-/Early-Return-Stelle nachrüsten (Build
   nötig):**
   - `fetchUrl` (`MainActivity.java:392-401`): im `catch (Exception e)`
     (:400) vor `return null` einen `addLog("fetchUrl " + u + ": " +
     e.getClass().getSimpleName() + " " + e.getMessage())`; im
     `HTTP != 200`-Zweig (:398) vor `return null` einen
     `addLog("fetchUrl " + u + ": HTTP " + c.getResponseCode())`.
   - `fetchUrlIfChanged` (`MainActivity.java:409-432`): analog im
     `catch` (:431), im `304`-Zweig (:420, informativ: "Cache aktuell"), im
     `HTTP != 200`-Zweig (:421) und im `body == null`-Zweig (:425) — vier
     Stellen, damit "kein Fortschritt" nicht mehr mit "Fehler" verwechselt
     werden kann.
   - `readAsset` (:434-437) und `readCache` (:439-442): je ein `addLog`
     im `catch` mit Dateiname + `e.getMessage()`.
   - `writeCache` (:444-451): `addLog` im bestehenden
     `/* Cache ist optional */`-Catch — der Kommentar bleibt (Q6: erklärt
     WARUM der Fehler nicht fatal ist), der `addLog`-Aufruf macht ihn
     zusätzlich sichtbar.
   - `appVersion` (:130-134): `addLog` im `catch` — betrifft ausgerechnet
     den Log-Kopf selbst (Mangel-Beleg im Gap-Report).
   - Rein additiv: alle Rückgabewerte (`null`/Fallback) bleiben unverändert
     — erfüllt "keine Regression" aus `CLAUDE.md`. Deckt Mangel 1, 2 und 5.
   - **Erwarteter Gain: +10 bis +14 Pt RA.**
   - Danach zwingend: `node app/guard-test.js` grün, `versionCode`/
     `versionName` in `app/AndroidManifest.xml` bumpen, `app/build.sh`,
     `apksigner verify --print-certs` = `41f23895…1b17`, APK an Rasmus.

2. **Zentralen `reportNetError(String where, String detail)`-Helfer
   einführen und die sechs Stellen aus Aktion 1 darauf umstellen (Build
   nötig):** eine einzelne benannte Instanzmethode auf `MainActivity`
   (keine anonyme innere Klasse, kein Lambda — d8-Constraint aus
   `app/README.md:110-111`/LEARNINGS §8), die `addLog("[net] " + where +
   ": " + detail)` bündelt. Aufrufer übergeben den bereits gebildeten
   Detail-String (`e.getMessage()`, `"HTTP " + code`, `"304 (Cache
   aktuell)"`) — eine Signatur, kein Overload-Set, damit keine
   Mehrdeutigkeit im d8-Build entsteht. Ersetzt die sechs Ad-hoc-Strings aus
   Aktion 1 durch einen Aufruf; künftige neue Netz-/Cache-Stellen rufen
   denselben Helfer statt eine siebte Variante zu erfinden (Q4/Q5). Vor der
   Umstellung: vollständige Aufrufer-Liste aus Aktion 1 gegenprüfen (Q3),
   damit keine der sechs Stellen beim Refactor vergessen wird.
   **Erwarteter Gain: +4 bis +6 Pt RA** (zusätzlich zu Aktion 1 — adressiert
   Testbarkeit/SSOT statt nur Beobachtbarkeit).

3. **`guard-test.js` um zwei statische Source-Regex-Checks erweitern (kein
   Build nötig, reiner Node-Test):** neue Prüf-Funktionen analog zu
   `extractGuard()` (`app/guard-test.js:25-44`), aber ohne Ausführung —
   reiner Text-Regex auf die rohe `MainActivity.java` (Technik 3 aus
   `eingebetteten-code-exakt-testen.md`, da `HttpURLConnection`/
   Dateizugriffe nicht sinnvoll in `vm` simulierbar sind):
   - **ScriptLoader-Reihenfolge:** im Textblock von `class ScriptLoader`
     (`MainActivity.java:730-772`) kommt für den Optimizer-Pfad
     `a.fetchUrl(` textlich vor `a.readCache(` vor `a.readAsset(`; für den
     PaleTools-Pfad kommt `a.readCache(` vor `a.fetchUrlIfChanged(`.
   - **Pflicht-Logging je Methode:** die Methodenkörper von `fetchUrl`,
     `fetchUrlIfChanged`, `readAsset`, `readCache`, `writeCache`,
     `appVersion` (per Klammer-Balance ab Methodensignatur extrahiert)
     enthalten nach Aktion 1/2 je mindestens einen Aufruf von `addLog(`
     oder `reportNetError(`.
   - Schließt Mangel 3 (keine automatisierte Prüfung der Fallback-Kette)
     ohne Gerät/Emulator. **Erwarteter Gain: +4 bis +6 Pt RA.**

4. **Zustands-Setter statt direkter Feldmutation (Build nötig):** für
   `scriptsReady`, `paleStatus`, `paleInjected` je einen Setter
   (`setScriptsReady(boolean)`, `setPaleStatus(String)`,
   `setPaleInjected(boolean)`) auf `MainActivity` einführen, der intern
   `addLog` bei jeder Änderung aufruft (nur bei tatsächlichem Wertwechsel
   loggen, analog zum bestehenden `!status.equals(a.paleStatus)`-Vergleich
   in `PalePoll`, `MainActivity.java:649`). Alle bekannten Schreibstellen
   umstellen:
   - `scriptsReady`: `ScriptLoader.run()` (:772, `a.scriptsReady = true` →
     `a.setScriptsReady(true)`) und `SettingsSave.onClick` (:825,
     `a.scriptsReady = false` → `a.setScriptsReady(false)`).
   - `paleStatus`: beide Stellen in `PalePoll.onReceiveValue` (:650, :667).
   - `paleInjected`: `injectPaleLate()` (:254, im eigenen Rumpf von
     `MainActivity`) und `SbcWebViewClient.onPageStarted` (:714).
   Felder bleiben package-private (Default-Sichtbarkeit) wie bisher — volle
   Kapselung (`private` + Getter für alle Lesestellen `:235`, `:253`) würde
   den Diff über die RA-Lücke hinaus auf reine Lesezugriffe ausweiten, ohne
   zusätzlichen Beobachtbarkeits-Gewinn, und ist deshalb bewusst außen vor
   ("Kapselungs-Verbesserung nur soweit d8-kompatibel", kein Selbstzweck).
   Bleibt d8-kompatibel: nur zusätzliche Methoden auf der bestehenden
   Top-Level-Klasse, keine neuen anonymen Klassen. Behebt Mangel 4
   strukturell statt punktuell. **Erwarteter Gain: +3 bis +5 Pt RA.**

Summe der vier Aktionen: +21 bis +31 Pt RA (Zielkorridor für
`score_target.RA = 70`, siehe Ambitions-Rechnung unten).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 1 — rohe `addLog`-Zeilen an allen sechs Stellen |
| diagnose | Aktion 2 — `reportNetError`-Helfer + Umstellung; Aktion 4 — Setter für `scriptsReady`/`paleStatus`/`paleInjected` + Umstellung aller Schreibstellen |
| tests | Aktion 3 — `guard-test.js`: ScriptLoader-Reihenfolge + Pflicht-Logging-Check |
| docs | `docs/LEARNINGS.md`-Eintrag: `reportNetError`/Setter als neuer Choke-Point, referenziert diese vier Aktionen (kein primary_path, aber Teil des eisernen Arbeitsablaufs) |
| release | `versionCode`/`versionName` in `app/AndroidManifest.xml` bumpen, `node app/guard-test.js`, `app/build.sh`, `apksigner verify --print-certs` = `41f23895…1b17`, APK an Rasmus |

## Shared-Item-Bedarf

Keine Shared-Items nötig. Alle vier Aktionen bleiben innerhalb einer Datei
(`MainActivity.java`) plus deren Test (`guard-test.js`) und haben nur einen
Konsumenten (dieses Feature) — `reportNetError` und die drei Setter sind
interne Choke-Points von `MainActivity`, kein wiederverwendbarer Helfer für
ein anderes Feature (das Userscript hat mit `diagError`/`STATE.diag` bereits
sein eigenes, strukturell anderes Äquivalent in einer anderen Sprache/Datei).
`android-app-wrapper.shared-items.json` ist deshalb eine leere Liste.

## Risiken / Edge-Cases

- **Nur `addLog`, nie UI-Aufrufe aus dem Hintergrund-Thread:** `ScriptLoader`
  läuft in einem eigenen `Thread` (`MainActivity.java:227`,
  `new Thread(new ScriptLoader(this)).start()`), nicht auf dem UI-Thread.
  `addLog` ist über `synchronized (logLines)` threadsicher und darf dort
  aufgerufen werden — ein versehentlich nachgerüsteter
  `Toast.makeText(...)` oder WebView-Zugriff direkt in
  `fetchUrl`/`fetchUrlIfChanged`/`readCache`/`writeCache` würde dagegen mit
  `CalledFromWrongThreadException` abstürzen. Jede der vier Aktionen bleibt
  strikt auf `addLog`/`reportNetError`/die neuen Setter beschränkt.
- **d8-Constraint bei neuen Hilfskonstrukten:** `reportNetError` (Aktion 2)
  und die drei Setter (Aktion 4) müssen benannte Instanzmethoden auf
  `MainActivity` selbst bleiben — keine anonyme innere Klasse, kein Lambda,
  sonst crasht der Gradle-lose `d8`-Build am InnerClasses-Attribut
  (`app/README.md:110-111`, LEARNINGS §8). Ein einziges Overload-freies
  Signatur-Design für `reportNetError` vermeidet zusätzlich Mehrdeutigkeiten.
- **Volle Ausliefer-Kette nach jeder Build-nötig-Aktion:** Ohne Rasmus'
  `app/debug.keystore` (nicht im Repo) lässt sich keine installierbare
  Update-APK bauen; `versionCode`/`versionName` müssen im Manifest gebumpt
  werden (aktuell `versionCode="10"`, `versionName="1.6.1"`,
  `app/AndroidManifest.xml:4-5`), `node app/guard-test.js` muss grün
  bleiben, und `apksigner verify --print-certs` muss weiter SHA-256
  `41f23895…1b17` zeigen. Aktionen 1, 2 und 4 sind Code-fertig, aber erst
  nach Build + Installation durch Rasmus tatsächlich am Gerät wirksam — kein
  Subagent kann diesen Schritt selbst reproduzieren. Empfehlung: Aktion 1
  UND 3 zuerst in einem Build/Commit bündeln (kleinstes Risiko, testbar ohne
  Gerät), Aktion 2+4 (SSOT-Refactor mit mehreren Call-Sites) danach in einem
  zweiten Build — Q3 verlangt vor dem Refactor die vollständige
  Aufrufer-Liste, die oben bereits pro Feld aufgeführt ist.
- **Mid-Iter-Einschub (Klasse G) unwahrscheinlich:** alle vier Aktionen
  bleiben innerhalb der zwei primary_paths (`MainActivity.java`,
  `guard-test.js`); ein Einschub käme nur infrage, falls die
  Aufrufer-Analyse zu Aktion 4 eine bisher unbekannte fünfte Schreibstelle
  für eines der drei Felder zutage fördert — dann zunächst dort ergänzen,
  nicht die Aktion aufteilen.
- **Priorität/Effort-Einordnung:** Die reine Gain-Summe (+21 bis +31) würde
  nach der Heuristik `Σ Gain < 100 → P3-deferred` einordnen; das Ticket wird
  hier bewusst auf `P2-normal` gehoben, weil RA laut Gap-Report die größte
  Einzel-Lücke im gesamten Projekt ist (48/80, am nächsten am
  `partial`/`fail`-Rand) und `effort: M` gewählt, weil `phase_sequence`
  5 Phasen umfasst und zwei getrennte Build+APK-Zyklen (siehe oben) mehr
  Kalenderzeit als ein reiner Code-Diff kosten.

## Lift-Plan-Pre-Validation (M2)

Reine RA-Dimension (`manual_rubric`, kein PK-Anteil): `pk_files_to_cite: []`,
`citation_only: false`. `plan estimate` liefert für diese Iteration keinen
PK-Endwert (keine Kandidaten zitiert) — die Ziel-Erreichung für RA ist per
Reasoning/`audit-evaluator` zu prüfen, nicht deterministisch. Ambitions-Rechnung
(M3): `48 + (min(80, 80) - 48) × 0.7 = 48 + 22.4 → 70` (gerundet), passend zum
vorgegebenen M3-Target 70. Die Summe der vier Aktions-Gains (+21 bis +31)
deckt die geforderte Distanz (+22) mit Puffer nach oben UND unten ab.
