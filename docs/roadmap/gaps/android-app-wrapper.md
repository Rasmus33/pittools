---
feature: android-app-wrapper
analyzed_at: 2026-08-14
iteration: 0
regression: false
score_current:
  RA: 48
score_target:
  RA: 64
---

# Gap-Report — Android-App (WebView-Wrapper mit Script-Injection)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 48 / 80 (capped 48)
**Schwellwert:** 56 (80 × 0.7)
**Status:** partial (≥ 50 % von 80 = 40, aber < 56)
**Begründung:** Der `audit-evaluator` würdigt positiv, dass die Fallback-Ketten
(`app/java/com/sbctools/browser/MainActivity.java:730-772`, ScriptLoader:
URL → Cache → gebündeltes Asset), die Marker-Extraktions-Testsuite
(`app/guard-test.js:25-118`) und die ausführlichen LEARNINGS-Begründungen
(`docs/LEARNINGS.md` §8) für Fehlertoleranz, Testbarkeit und dokumentiertes
WARUM sprechen. Abgewertet wird die Dimension durch stille Catches genau an
der DevTools-losen Netzwerk-/Cache-Grenze — `fetchUrl`
(`MainActivity.java:392-401`) und `fetchUrlIfChanged`
(`MainActivity.java:409-432`) verschlucken jede Exception ohne `addLog` — und
durch direkte Feldmutation zwischen Top-Level-Klassen
(`MainActivity.java:603-671`, `PalePoll` schreibt `a.paleStatus` direkt statt
über einen Mutator), was die Beobachtbarkeit zusätzlich schwächt: es gibt
keinen einzelnen Anlaufpunkt, an dem eine Zustandsänderung zwingend geloggt
wird.

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **Stille Catches an der Netzwerk-Grenze ohne `addLog`:**
   `MainActivity.java:392-401` (`fetchUrl`) und `MainActivity.java:409-432`
   (`fetchUrlIfChanged`) fangen jede `Exception` (Timeout, DNS-Fehler,
   4xx/5xx, malformte Redirects) und geben nur `null` zurück — kein
   `addLog(...)`. Damit landet der eigentliche Grund für einen
   Download-Fehlschlag nie im einzigen Diagnosekanal, den Rasmus am Gerät
   hat (⚙ → "Log teilen"/"Log kopieren", `app/README.md:67-86`). Exakt
   dieses Muster ist im Anti-Pattern
   `docs/roadmap/patterns/bad/fehler-unsichtbar-verschluckt.md` als
   Code-Beleg für dieses Feature aufgeführt.
2. **Cache-Fehlschläge komplett unsichtbar:** `readAsset`
   (`MainActivity.java:434-437`), `readCache` (`:439-442`) und `writeCache`
   (`:444-451`) haben je einen leeren bzw. kommentierten Catch
   (`/* Cache ist optional */`) ohne jeden Log-Aufruf. Ein dauerhaft
   fehlschlagender `writeCache` (z.B. Speicher voll, Berechtigung entzogen)
   bliebe über beliebig viele App-Starts hinweg unbemerkt — es gibt kein
   Signal, das den stillen Rückfall auf das gebündelte Asset anzeigt.
3. **Kein Test für die Java-seitige Fallback-Kette:** `app/guard-test.js`
   (219 Zeilen) extrahiert und prüft ausschließlich den PaleTools-Wächter
   (`extractGuard()`, `guard-test.js:25-44`; Testfälle nur zu
   `__pt_status`/`__pt_wait`, `guard-test.js:148-213`). Die in
   `ScriptLoader` (`MainActivity.java:730-772`) dokumentierte
   Reihenfolge-Logik (URL → Cache → Asset für den Optimizer;
   Cache-zuerst + Hintergrund-`fetchUrlIfChanged` für PaleTools) hat **keinen**
   automatisierten Test — anders als der Solver
   (`solver-test.js`, per `eingebetteten-code-exakt-testen`-Pattern), der
   jede Zeile Produktionscode brute-force-verifiziert.
4. **Direkte Feldmutation statt zentraler Mutatoren:** Mehrere Top-Level-Klassen
   schreiben direkt auf `MainActivity`-Felder ohne Setter/Log-Kopplung:
   `ScriptLoader.run()` setzt `a.scriptSbc`/`a.scriptPale`/`a.scriptsReady`
   (`MainActivity.java:746`, `:770-772`), `PalePoll.onReceiveValue` setzt
   `a.paleStatus` (`MainActivity.java:650`), `SbcWebViewClient.onPageStarted`
   setzt `a.paleInjected` (`MainActivity.java:714`). Es gibt keinen einzigen
   Punkt, der bei jeder Statusänderung zwingend `addLog` aufruft — im
   Gegensatz zum Userscript, wo `diagError()` genau diesen Single-Choke-Point
   für `STATE.diag` bildet (`docs/roadmap/patterns/good/diagnose-feld-statt-raten.md`).
   Neue Schreibstellen können die Log-Kopplung deshalb strukturell vergessen,
   wie bereits bei den Netzwerk-Methoden geschehen (Q5-Verstoß laut
   `fehler-unsichtbar-verschluckt.md` → „Wurzelursache (Q1-Q7)").
5. **Fehlerklassen gehen beim Rückgabewert `null` verloren:**
   `fetchUrl`/`fetchUrlIfChanged` liefern für "kein Netz", "404", "500" und
   "Timeout" identisch `null` zurück (`MainActivity.java:398`, `:400`,
   `:421`, `:431`). Selbst mit nachgerüstetem `addLog` im Catch bliebe der
   Erfolgsfall `HTTP != 200` (kein Exception-Pfad, sondern early-return bei
   `:398`/`:421`) komplett ohne Diagnose-Zeile — dieser Rückgabepfad ist kein
   `catch`, sondern ein stiller `if`-Ausstieg, den das Anti-Pattern nicht
   erfasst, der aber genauso beobachtbar gemacht werden muss.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`addLog` an jeder stillen Catch-/Early-Return-Stelle nachrüsten
   (Build nötig):** In `fetchUrl` (`MainActivity.java:392-401`),
   `fetchUrlIfChanged` (`:409-432`, inkl. der `HTTP != 200`- und
   `304`-Zweige), `readAsset`/`readCache`/`writeCache` (`:434-451`) und
   `appVersion` (`:130-134`) je einen `a.addLog(...)`-Aufruf mit
   Methode/URL(-Kurzform)/Statuscode bzw. `e.getMessage()` ergänzen. Rein
   additiv, keine Verhaltensänderung (Rückgabewerte bleiben `null`/Fallback)
   — erfüllt „keine Regression". Deckt exakt die vom `audit-evaluator`
   genannte Beobachtbarkeits-Lücke ab. **Erwarteter Gain: +10 bis +14 Pt
   RA.** Danach zwingend: `node app/guard-test.js` grün, `versionCode`/
   `versionName` in `app/AndroidManifest.xml` bumpen, `app/build.sh`, APK an
   Rasmus (Signatur-Check `apksigner verify --print-certs` = `41f23895…1b17`).
2. **Zentralen `reportNetError(String where, Exception|int status)`-Helfer
   einführen (Build nötig):** Eine einzelne **benannte Top-Level-Methode**
   (keine anonyme innere Klasse — d8-Constraint aus `app/README.md:110-111`
   und LEARNINGS §8) auf `MainActivity`, die Formatierung + `addLog` bündelt;
   von allen fünf Stellen aus Mangel 1/2 aufgerufen statt fünf separaten
   Ad-hoc-Log-Strings. Macht künftige neue Netzwerk-/Cache-Stellen (Q4/Q5)
   strukturell weniger vergessungsanfällig als aktuell. **Erwarteter Gain:
   +4 bis +6 Pt RA** (zusätzlich zu Aktion 1, da SSOT/Testbarkeit statt nur
   Beobachtbarkeit adressiert wird).
3. **`guard-test.js` um einen Testpfad für die `ScriptLoader`-Reihenfolge
   erweitern (kein Build nötig, reiner Node-Test):** Neue Funktion in
   `app/guard-test.js` (analog `extractGuard()`, aber als statischer
   Source-Regex-Check gemäß Technik 3 aus
   `docs/roadmap/patterns/good/eingebetteten-code-exakt-testen.md`, da
   `HttpURLConnection`/Dateizugriffe nicht sinnvoll in `vm` simulierbar sind):
   prüft per Regex, dass (a) `ScriptLoader.run()` `fetchUrl` vor `readCache`
   vor `readAsset` für den Optimizer aufruft, in genau dieser Textreihenfolge,
   (b) PaleTools `readCache` vor `fetchUrlIfChanged` aufruft, und (c) jede der
   in Mangel 3 genannten Methoden nach Aktion 1 mindestens einen
   `addLog`-Aufruf im Funktionskörper enthält. Schließt die Testbarkeits-Lücke
   aus Mangel 3, ohne dass ein Gerät/Emulator nötig ist. **Erwarteter Gain:
   +4 bis +6 Pt RA.**
4. **Zustands-Setter statt direkter Feldmutation (Build nötig):** Für
   `scriptsReady`, `paleStatus`, `paleInjected` je einen kleinen Setter auf
   `MainActivity` (`setScriptsReady(boolean)`, `setPaleStatus(String)`,
   `setPaleInjected(boolean)`) einführen, der intern `addLog` bei jeder
   Änderung aufruft; `ScriptLoader`/`PalePoll`/`SbcWebViewClient` rufen den
   Setter statt `a.feld = wert` direkt. Bleibt d8-kompatibel (keine neuen
   anonymen Klassen, nur Methoden auf der bestehenden Top-Level-Klasse).
   Behebt Mangel 4 strukturell statt punktuell. **Erwarteter Gain: +3 bis
   +5 Pt RA.**

## Edge-Cases (mind. 1 — M1)

- **Nur `addLog`, nie UI-Aufrufe aus Hintergrund-Threads:** `ScriptLoader`
  läuft in einem eigenen `Thread` (`MainActivity.java:227`,
  `new Thread(new ScriptLoader(this)).start()`), nicht auf dem UI-Thread.
  `addLog` ist über `synchronized (logLines)` threadsicher und darf dort
  bleiben — ein versehentlich nachgerüsteter `Toast.makeText(...)` oder
  WebView-Zugriff direkt in `fetchUrl`/`fetchUrlIfChanged`/`readCache` würde
  dagegen mit `CalledFromWrongThreadException` abstürzen. Jede Lift-Aktion
  hier muss sich strikt auf `addLog` beschränken.
- **d8-Constraint bei neuen Hilfskonstrukten:** Ein neuer `reportNetError`-
  Helfer (Aktion 2) oder neue Setter (Aktion 4) müssen als benannte
  Top-Level- oder Instanzmethoden auf `MainActivity` selbst leben — keine
  anonyme innere Klasse, sonst crasht der Gradle-lose `d8`-Build am
  InnerClasses-Attribut (`app/README.md:110-111`, LEARNINGS §8). Leicht zu
  übersehen, wenn man reflexhaft ein Lambda/eine anonyme `Runnable` einführt.
- **Jede App-seitige Änderung braucht den vollen Ausliefer-Umweg:** Ohne
  Rasmus' `app/debug.keystore` (nicht im Repo) lässt sich keine
  installierbare Update-APK bauen; `versionCode`/`versionName` müssen im
  Manifest gebumpt werden, `node app/guard-test.js` muss grün bleiben, und
  `apksigner verify --print-certs` muss weiter SHA-256 `41f23895…1b17`
  zeigen. Die hier vorgeschlagenen Aktionen sind Code-fertig, aber erst nach
  Build + Installation durch Rasmus tatsächlich am Gerät wirksam — das
  Skript kann diesen Schritt nicht selbst reproduzieren.

## Lift-Empfehlung

Vorsichtig, additiv, in kleinen Schritten: Aktion 1 (addLog nachrüsten) zuerst
allein umsetzen und bauen/testen lassen, da sie die größte Einzel-Lücke
schließt und am risikoärmsten ist (reine Log-Zeilen, kein Kontrollfluss
ändert sich). Aktion 3 (Testerweiterung) kann parallel ohne Geräte-Build
laufen und sollte VOR Aktion 1 im selben Iterationsschritt landen, damit sie
gleich die neuen `addLog`-Aufrufe mitprüft. Aktionen 2 und 4 (SSOT-Refactor)
erst danach, da sie mehrere Call-Sites gleichzeitig anfassen und pro
Q3-Prinzip eine vollständige Aufrufer-Analyse vor der Änderung verlangen. Kein
Mid-Iter-SI nötig — alle vier Aktionen bleiben innerhalb einer Datei
(`MainActivity.java`) plus deren Test (`guard-test.js`).
