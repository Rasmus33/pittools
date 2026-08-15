---
feature: android-app-wrapper
iteration: 2
score_current:
  RA: 72
score_target:
  RA: 78
primary_paths:
  - pittools/app/java/com/sbctools/browser/MainActivity.java
  - pittools/app/guard-test.js
  - pittools/app/AndroidManifest.xml
  - pittools/app/README.md
patterns_required:
  - diagnose-feld-statt-raten
  - warum-kommentare-mit-live-belegen
  - eingebetteten-code-exakt-testen
pk_files_to_cite:
  - pittools/app/java/com/sbctools/browser/MainActivity.java
  - pittools/app/guard-test.js
citation_only: false
shared_items_required: []
priority: P3-deferred    # Heuristik: Sigma Gain Pflicht-Aktionen 1-3 = 8 < 100
effort: M                # Heuristik: len(phase_sequence) = 5 (core..release) -> Bracket 5-8
analyzed_at: '2026-08-15'
---

# Lift-Plan — Android-App (WebView-Wrapper mit Script-Injection)

## Marschroute

RA steht bei 72 (Schwelle 56, Status pass), M3-Ziel dieser Iteration ist 78
bei einem strukturellen Deckel von 80. Alle fünf Aktionen aus dem
Gap-Report (Iteration 2) sind lokale, additive Ergänzungen an bereits
bestehenden Methoden/Klassen in `MainActivity.java` — keine neue anonyme
Klasse, kein Eingriff in Fallback-Reihenfolge oder Wächter-Timing. Reihenfolge
folgt dem eisernen Arbeitsablauf aus `CLAUDE.md`: erst die Logik ändern
(core), dabei sofort die zugehörigen Diagnose-Aufrufe mitziehen (diagnose),
danach `app/guard-test.js` erweitern und grün bekommen (tests), README auf
den neuen Ist-Stand bringen (docs), zuletzt `versionCode`/`versionName`
bumpen (release) — der APK-Build selbst liegt beim PO (Keystore-Zugriff).

Aktionen 1–3 sind Pflicht (Gain-Summe +8, konservativ auf das Ziel 78
gerundet statt auf den rechnerischen Endwert 80 — Einzel-Gains sind
Schätzungen, keine linear-additive Messung). Aktion 4 ist Absicherung, falls
1–3 in der Umsetzung weniger Gain liefern als geschätzt. Aktion 5 ist
optionaler Restposten (Q4/DRY, kein bestätigter Antipattern) und wird nur bei
Zeitüberschuss gezogen. Da RA bereits `pass` ist, wird hier bewusst nicht auf
den strukturellen Deckel (80) hin optimiert.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **304/Cache-aktuell aus dem Fehler-Choke-Point auslösen (Pflicht).**
   - *Zielpfad(e):* `app/java/com/sbctools/browser/MainActivity.java:420-427`
     (`reportNetError`), `:453-488` (`fetchUrlIfChanged`, 304-Zweig
     `:464-466`); `app/guard-test.js:281-299` (Pflicht-Logging-Checks).
   - *Schritte:*
     1. Neue Methode `reportNetNote(String where, String detail)` direkt
        neben `reportNetError` einfügen — gleicher Aufbau
        (`addLog("[net-ok] " + where + ": " + detail)`), eigenes Präfix
        `[net-ok]` statt `[net]`. WARUM-Kommentar mit Live-Bezug: 304 ist
        kein Fehler, sondern die Bestätigung "Hintergrund-Refresh lief,
        Cache passt" (`docs/LEARNINGS.md` §20).
     2. In `fetchUrlIfChanged` den `if (code == 304)`-Zweig (`:464-466`) von
        `reportNetError(...)` auf `reportNetNote(...)` umstellen. Der
        Log-Text ("304 (Cache aktuell)") bleibt inhaltlich erhalten —
        Pflicht-Edge-Case aus dem Gap-Report: die Zeile darf nicht
        verschwinden, nur das Präfix ändert sich.
     3. `app/guard-test.js` um einen Check erweitern (Nähe der bestehenden
        Pflicht-Logging-Schleife `:294-299`): `reportNetNote` existiert und
        verwendet das `[net-ok]`-Präfix; der 304-Zweig in
        `fetchUrlIfChanged` ruft `reportNetNote(`, nicht mehr
        `reportNetError(`.
   - *Test-Absicherung:* `node app/guard-test.js` (neuer statischer Check,
     gleiches `extractBraceBlock`-Muster wie die bestehenden
     Reihenfolge-Checks `:262-279`); `node app/log-test.js` zur Kontrolle,
     dass der Ringpuffer beide Präfixe unverändert verarbeitet.
   - *Risiken/Rollback:* Wer den Report bisher stur nach `[net]` filtert
     (statt 304-Zeilen manuell auszusortieren), sieht 304-Zeilen künftig
     NICHT mehr unter `[net]` — genau das ist der Zweck der Aktion, aber
     ein Auswerte-Skript, das exakt auf `[net]`-Vorkommen zählt, müsste
     mitziehen. Rollback: `reportNetNote`-Aufruf in `fetchUrlIfChanged`
     durch `reportNetError` ersetzen (Ein-Zeilen-Diff), Methode kann stehen
     bleiben.
   - *Erwarteter Gain:* +2 Pt RA.

2. **`scriptSbc`/`scriptPale`/`paleSource` durch loggenden Setter kapseln
   (Pflicht).**
   - *Zielpfad(e):* `MainActivity.java:80-81,128` (Felder), `:146-162`
     (bestehende Setter `setScriptsReady`/`setPaleStatus`/`setPaleInjected`),
     `:809,833-834` (`ScriptLoader.run`), `:889-890` (`SettingsSave.onClick`).
   - *Schritte:*
     1. Neuen Setter `void setLoadedScripts(String sbc, String pale, String
        source)` neben den drei bestehenden Settern einführen: setzt alle
        drei Felder in einem Rutsch und ruft `addLog` mit einer
        Zusammenfassung (Zeichenlängen + Quelle) auf, nur wenn sich
        mindestens ein Wert tatsächlich ändert (gleiches Vergleichsmuster
        wie `setPaleStatus`).
     2. `ScriptLoader.run()` (`:809`, `:833-834`) von den drei
        Einzel-Feldzuweisungen auf einen Aufruf
        `a.setLoadedScripts(sbc, pale, source)` umstellen.
     3. `SettingsSave.onClick()` (`:889-890`, Reset auf `null`) auf
        `a.setLoadedScripts(null, null, null)` umstellen.
     4. `app/guard-test.js` um einen statischen Check erweitern: außerhalb
        des Setter-Methodenkörpers darf im gesamten Java-Source keine
        `.scriptSbc =`, `.scriptPale =` oder `.paleSource =`-Zuweisung mehr
        vorkommen (Regex über den vollen Source abzüglich des extrahierten
        Setter-Blocks, analog zum Pflicht-Logging-Muster `:294-299`).
   - *Test-Absicherung:* `node app/guard-test.js` (neuer statischer
     Grep-Check plus alle 18 bestehenden Checks grün — reine Kapselung
     ohne Logikänderung, die im Feld sichtbaren Endwerte bleiben identisch).
   - *Risiken/Rollback:* `paleSource` trägt an den zwei Call-Sites
     unterschiedliche Semantik (`"Cache"`/`"Download"`/`"keine"` in
     `ScriptLoader` vs. `null` beim Reset) — der neue Setter muss beide
     Fälle unverändert durchreichen, sonst ändert sich die im Log-Report
     angezeigte "PaleTools-Quelle" (`:116`). Rollback: die drei
     Feldzuweisungen an den zwei Call-Sites zurückschreiben; der Setter
     kann als unbenutzter Code stehen bleiben oder in einem Folge-Commit
     entfernt werden.
   - *Erwarteter Gain:* +3 Pt RA.

3. **`onReceivedError`/`onReceivedHttpError` in `SbcWebViewClient` ergänzen
   (Pflicht).**
   - *Zielpfad(e):* `MainActivity.java:769-791` (bestehende benannte Klasse
     `SbcWebViewClient`).
   - *Schritte:*
     1. Innerhalb der bestehenden Klasse (keine neue anonyme Klasse/Lambda —
        d8-Constraint, `MainActivity.java:15-18`, `app/README.md:110-111`)
        zwei Overrides ergänzen: `onReceivedError(WebView, WebResourceRequest,
        WebResourceError)` und `onReceivedHttpError(WebView,
        WebResourceRequest, WebResourceResponse)`.
     2. Beide prüfen `request.isForMainFrame()` und rufen bei `true`
        `a.addLog("[webview] " + request.getUrl() + ": " + <Code> + " " +
        <Beschreibung>)` auf; Sub-Ressourcen-Fehler werden mitgeloggt, aber
        ohne gesondertes Schema — derselbe Ringpuffer.
     3. Bereits geprüft (Q3): `app/build.sh:84` baut mit
        `--min-sdk-version 26` — deckt `WebResourceRequest.isForMainFrame()`
        (API 21) und `onReceivedError`/`onReceivedHttpError` in der
        3-Parameter-Form (API 23) vollständig ab, kein SDK-Gate nötig.
     4. `app/guard-test.js` um einen Check erweitern: beide Overrides
        existieren in der `SbcWebViewClient`-Klasse und ihr jeweiliger
        Methodenkörper enthält einen `addLog(`-Aufruf (`extractBraceBlock`
        auf `class SbcWebViewClient`, gleiches Muster wie bei den
        bestehenden Checks).
   - *Test-Absicherung:* `node app/guard-test.js` — da beide Methoden reines
     Android-`WebViewClient`-API sind (kein aus Java-Literalen
     zusammengesetzter JS-Wächter), reicht ein struktureller Source-Check,
     keine `vm`-Sandbox-Simulation nötig.
   - *Risiken/Rollback:* Keine Regression möglich, da `onPageStarted`/
     `onPageFinished` unverändert bleiben — reine Ergänzung um zwei neue
     Overrides. Rollback: beide Overrides entfernen, Klasse fällt auf den
     bisherigen Zwei-Methoden-Stand zurück.
   - *Erwarteter Gain:* +3 Pt RA.

4. **Leer-Body-Erkennung korrigieren (Absicherung).**
   - *Zielpfad(e):* `MainActivity.java:429-445` (`fetchUrl`), `:453-488`
     (`fetchUrlIfChanged`, Leer-Body-Check `:474-478`), `:518-528`
     (`readStream`), `:841-844` (Download-Logzeile in `ScriptLoader`).
   - *Schritte:*
     1. In `fetchUrlIfChanged`: `if (body == null)` (`:475`) durch
        `if (body.isEmpty())` ersetzen. WARUM-Kommentar an der Stelle
        (Q6): `readStream` (`:518-528`) liefert laut Signatur nie `null`,
        nur `sb.toString()` (im schlimmsten Fall `""`) — der alte Vergleich
        konnte strukturell nie zutreffen.
     2. In `fetchUrl` (`:429-445`) nach `readStream(...)` (`:440`) denselben
        Leer-Check ergänzen: Ergebnis zwischenspeichern, bei `isEmpty()`
        `reportNetError("fetchUrl " + u, "leerer Body")` aufrufen und `null`
        statt des leeren Strings zurückgeben — dieser Pfad hat bisher
        überhaupt keinen Leer-Body-Schutz.
     3. Die bestehende Download-Logzeile (`:841-844`, `!= null`-Prüfung
        "OK") bleibt unverändert, greift aber jetzt tatsächlich, weil beide
        Fetch-Methoden bei leerem Body konsistent `null` statt `""`
        liefern.
     4. `app/guard-test.js` um ein Szenario erweitern (gleiche
        Sandbox-Technik wie die 7 bestehenden PalePoll-Szenarien
        `:137-218`): Stub für einen 200er mit leerem Body, prüft dass
        sowohl `fetchUrl` als auch `fetchUrlIfChanged` `null` liefern UND
        `reportNetError` mit "leerer Body" aufrufen.
   - *Test-Absicherung:* `node app/guard-test.js` (neues Szenario); kein
     Node-Äquivalent zu `node --check` für Java — lokale `javac`-Prüfung vor
     dem PO-seitigen `./build.sh`.
   - *Risiken/Rollback:* Grep über alle Aufrufer bestätigt: beide
     Fetch-Ergebnisse werden ausschließlich auf `!= null` geprüft, bevor sie
     injiziert werden (`ScriptLoader:804-844`) — kein Aufrufer verlässt sich
     auf einen leeren, aber nicht-`null` String. Rollback:
     `body.isEmpty()` zurück zu `body == null` in `fetchUrlIfChanged`, neuen
     Check in `fetchUrl` entfernen.
   - *Erwarteter Gain:* +2 Pt RA.

5. **`PALE_CHUNK`/`shareLog`-Kappung auf eine gemeinsame Konstante ziehen
   (optional).**
   - *Zielpfad(e):* `MainActivity.java:76` (`PALE_CHUNK`), `:168`
     (`shareLog`-Kappung `120000`).
   - *Schritte:*
     1. Neue, klar benannte Konstante (z.B. `MAX_LOG_SHARE_CHARS`) einführen,
        die ihren Bezug zu `PALE_CHUNK`/dem Binder-IPC-Limit im Code
        ausdrückt statt nur im Kommentar; `shareLog` (`:168`) darauf
        umstellen.
     2. Kommentar "dieselbe Grenze wie bei evaluateJavascript" durch den
        echten Code-Bezug ersetzen (Q4) — Zahlenwert bleibt exakt `120000`.
     3. Kein neuer Verhaltens-Check nötig (reines Konstanten-Refactoring),
        bestehende `app/guard-test.js`-Checks müssen grün bleiben.
   - *Test-Absicherung:* `node app/guard-test.js` (Regressionslauf ohne neue
     Assertions); manueller Diff-Check, dass `120000` nirgends mehr
     hartkodiert doppelt vorkommt.
   - *Risiken/Rollback:* Minimal — reines Konstanten-Refactoring ohne
     Verhaltensänderung. Rollback: Konstante zurück in das Literal auflösen.
   - *Erwarteter Gain:* +1 Pt RA (Puffer, nur bei Zeitüberschuss).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 1 (`reportNetNote` + Umleitung des 304-Zweigs), Aktion 2 (`setLoadedScripts`-Setter + Umstellung der drei Schreibstellen), Aktion 3 (`onReceivedError`/`onReceivedHttpError`-Skelett in `SbcWebViewClient`), Aktion 4 (`isEmpty()`-Fix in `fetchUrlIfChanged` + neuer Leer-Body-Check in `fetchUrl`), Aktion 5 (gemeinsame Konstante) |
| diagnose | Aktion 3 (`addLog`-Aufrufe in den zwei neuen Overrides), Aktion 4 (`reportNetError("leerer Body")` in `fetchUrl`) — Reflexionsschritt direkt im selben Commit wie core: prüfen, dass jede neue Fehlerstelle tatsächlich geloggt wird (Antipattern `fehler-unsichtbar-verschluckt`) |
| tests | `app/guard-test.js`-Erweiterungen für Aktionen 1-4 (neue Checks), Regressionslauf für Aktion 5 |
| docs | `app/README.md` „Technik-Notizen" auf den neuen Ist-Stand bringen (neue Overrides, neue Konstante) |
| release | `app/AndroidManifest.xml`: `versionCode` 11 → 12, `versionName` „1.7.0" → „1.8.0"; APK-Build + Signaturprüfung (`apksigner verify --print-certs`) obliegt dem PO nach dem Merge — Keystore liegt nicht im Repo |

## Shared-Item-Bedarf

Kein Shared-Item-Bedarf in dieser Iteration. Der Gap-Report empfiehlt
explizit kein Mid-Iter-SI: alle fünf Aktionen sind lokale, additive
Ergänzungen an bereits bestehenden Methoden/Klassen derselben Datei ohne
Cross-Feature-Konsum. Sidecar entsprechend leer.

## Risiken / Edge-Cases

- **Choke-Point-Umbau darf die eigene Diagnose nicht verstümmeln (Aktion
  1):** die 304-Zeile muss nach der Reklassifizierung weiterhin sichtbar
  geloggt werden, nur unter dem Präfix `[net-ok]` statt `[net]` — Rasmus
  nutzt genau diese Meldung, um die Hintergrund-Auffrischung von PaleTools
  zu bestätigen (`docs/LEARNINGS.md` §20). Ein ersatzloser Wegfall wäre eine
  neue, unbeobachtete Lücke an der Stelle, die gerade geschlossen wird.
- **`guard-test.js` extrahiert den PaleTools-Wächter über inzidentelle
  String-Literale** (`"(function(){" +` … `"})()", null);`,
  `app/guard-test.js:48-49`): jede Änderung, die `injectPaleChunked`
  (`MainActivity.java:301-396`) im Rahmen dieser Aktionen berührt, muss
  nach dem Edit `node app/guard-test.js` laufen lassen UND stichprobenartig
  prüfen, dass `extractGuard()` weiterhin den vollständigen Wächter-Code
  findet — ein verändertes Literal in dessen Nähe würde die Extraktion
  leise auf einen Teilblock verkürzen statt hart zu scheitern. Keine der
  fünf Aktionen berührt `injectPaleChunked` direkt; die Prüfung erfolgt
  trotzdem als Stichprobe, weil derselbe Java-Source-File Ziel aller
  Edits ist.
- **d8-Constraint bei Aktion 3:** Die neuen `WebViewClient`-Overrides müssen
  in der bestehenden benannten `SbcWebViewClient`-Klasse landen, nicht als
  anonyme Klasse oder Lambda — der direkte `d8`-Build ohne Gradle stolpert
  sonst über das InnerClasses-Attribut (`MainActivity.java:15-18`,
  `app/README.md:110-111`).
- **Reihenfolge-Abhängigkeit Aktion 2 → Aktion 4:** beide ändern
  Schreibpfade rund um `scriptSbc`/`scriptPale` bzw. deren Quellwerte in
  `ScriptLoader`. Aktion 2 zuerst umsetzen (Kapselung), danach Aktion 4
  (Leer-Body-Fix) — vermeidet, dass derselbe Codeblock zweimal in
  unterschiedlicher Reihenfolge diffed werden muss.
- **Kein Regressionsrisiko am Userscript:** alle Aktionen betreffen
  ausschließlich `app/`; `ea-fc-sbc-optimizer.user.js` bleibt unverändert,
  daher kein `@version`-Bump und kein `node solver-test.js`-Lauf
  erforderlich — nur `node app/guard-test.js` als Gate.

## Lift-Plan-Pre-Validation (M2)

Ziel-Delta: 78 − 72 = 6. Pflicht-Aktionen 1–3 summieren sich auf +8 (rechnerisch
72 + 8 = 80 = `structural_max`), werden aber konservativ auf das Ziel 78
gerundet, da Einzel-Gains Schätzungen sind, keine linear-additive Messung.
8 ≥ 6 (Ziel-Delta) erfüllt die M3-Ambitionsregel mit Puffer; selbst wenn nur
zwei der drei Pflicht-Aktionen den vollen Gain liefern (z.B. +2 und +3 = +5),
schließt Aktion 4 (+2) die Lücke zum Ziel-Delta. `plan estimate
--feature=android-app-wrapper` sollte auf Basis von `pk_files_to_cite`
(`MainActivity.java`, `guard-test.js`) einen Zielwert ≥ 78 und ≤ 80
(`structural_max`) bestätigen.
