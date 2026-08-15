---
feature: android-app-wrapper
analyzed_at: 2026-08-15
iteration: 2
regression: false
score_current:
  RA: 72
score_target:
  RA: 78
---

# Gap-Report — android-app-wrapper (Iteration 2, Fokus: RA)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 72 / 80
**Schwellwert:** 56 (structural_max × 0.7)
**Status:** pass
**Begründung:** Live gegen `main` (App-Version 1.7.0 / versionCode 11, Manifest
bestätigt: `app/AndroidManifest.xml:4-5`) verifiziert: `reportNetError`
(`MainActivity.java:425-427`) ist als einziger Log-Choke-Point an allen
6 Netz-/Cache-Pfaden verdrahtet (`fetchUrl` :437,442 · `fetchUrlIfChanged`
:465,469,476,485 · `readAsset` :493 · `readCache` :501 · `writeCache` :513 ·
`appVersion` :134), und `app/guard-test.js:281-299` erzwingt das statisch pro
Methode ("Pflicht-Logging in …") — bestätigt per `node app/guard-test.js`
(alle 18 Checks grün) und `node app/log-test.js` (alle Ringpuffer-Checks
grün). Die drei Zustands-Setter `setScriptsReady`/`setPaleStatus`/
`setPaleInjected` (`MainActivity.java:146-162`) loggen bei jeder tatsächlichen
Änderung. Restlücke laut Audit (bestätigt): Kapselung bleibt bewusst
package-private (kein `private`, `MainActivity.java:78-83`), die
Fallback-Ketten (Download→Cache→Asset fürs Skript, Cache→Download für
PaleTools, `ScriptLoader` :793-862) sind seit Iteration 0 unverändert. Diese
Gap-Analyse hat zusätzlich drei bisher nicht dokumentierte, live bestätigte
Lücken gefunden (M1, M3, M4 unten), die über die im Audit genannte Restlücke
hinausgehen.

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **304-Zweig läuft durch den fehler-benannten Choke-Point (Seed #1,
   bestätigt):** `reportNetError` ist per Doc-Kommentar explizit "Einziger
   Log-Choke-Point fuer Netz-/Cache-**Fehler**" (`MainActivity.java:420-427`),
   wird aber auch für den waschechten Nicht-Fehler-Fall "304 (Cache aktuell)"
   aufgerufen (`MainActivity.java:464-466`). Damit landet der erwartete,
   gesunde Zustand ("Auffrischung war unnötig, Cache passt") ununterscheidbar
   neben echten Fehlschlägen im selben `[net]`-Präfix — wer den Log-Report
   nach echten Fehlern durchsucht, muss jede `304`-Zeile händisch aussortieren.
2. **State-Setter-Muster nur teilweise adoptiert (Kapselungs-Rest, Seed #2,
   verschärft):** `scriptsReady`/`paleStatus`/`paleInjected` laufen
   ausschließlich über loggende Setter (`MainActivity.java:146-162`), aber
   `scriptSbc`, `scriptPale` und `paleSource` werden weiterhin als direkte
   Feldzuweisungen von außen geschrieben — `ScriptLoader.run()`
   (`MainActivity.java:809`, `:833-834`) und `SettingsSave.onClick()`
   (`MainActivity.java:889-890`). Das in Iteration 0/1 eingeführte
   SSOT-Muster (Q5) deckt damit nur 3 von 6 veränderlichen Feldern derselben
   Klasse ab; ein künftiger neuer Schreibzugriff auf `scriptSbc`/`scriptPale`
   hat kein strukturelles Vorbild, das ihn zum Loggen zwingt.
3. **WebView-Seitenlade-Fehler ohne jede Beobachtbarkeit (Seed #3,
   bestätigt):** `SbcWebViewClient` (`MainActivity.java:769-791`) überschreibt
   nur `onPageStarted`/`onPageFinished` — kein `onReceivedError`,
   `onReceivedHttpError` oder `onReceivedSslError` (per Grep über die
   gesamte Datei: keine Treffer). Schlägt der initiale Load von
   `WEB_APP_URL` fehl (DNS, TLS, kein Netz, EA-Serverfehler) oder ein
   Subressourcen-Host, zeigt die WebView nur ihre eigene Standard-Fehlerseite
   — weder Log-Ringpuffer noch Script-Report sehen davon etwas. Das ist die
   einzige Fremd-Grenze der App-Slice ganz ohne Diagnose-Spur.
4. **Leer-Body-Guard ist toter Code:** `readStream` (`MainActivity.java:518-528`)
   gibt immer einen `String` zurück (im schlimmsten Fall `""`), nie `null` —
   ein Abbruch der Schleife bei 0 gelesenen Bytes liefert `sb.toString()`,
   niemals `null`. Trotzdem prüft `fetchUrlIfChanged` explizit
   `if (body == null)` (`MainActivity.java:475-476`) als Schutz gegen einen
   leeren Server-Body — diese Bedingung kann strukturell nie zutreffen.
   `fetchUrl` (`MainActivity.java:429-445`, der Weg für den nicht
   verhandelbaren "Push=Deployment"-Optimizer) hat überhaupt keinen
   Leer-Body-Check. Ein 200er mit leerem Body wird an beiden Stellen als
   gültiger Inhalt behandelt; die Download-Log-Zeile
   (`MainActivity.java:841-842`, `!= null`-Prüfung) meldet dafür "OK", obwohl
   effektiv nichts injiziert wird.
5. **Weak-Signal Q4/DRY, unverändert seit Iteration 0:** `PALE_CHUNK = 60000`
   (`MainActivity.java:76`) und die 120000-Zeichen-Kappung in `shareLog`
   (`MainActivity.java:168`) sind zwei separat gepflegte Zahlen, nur durch
   einen Kommentar ("dieselbe Grenze wie bei evaluateJavascript") verbunden,
   keine gemeinsame Konstante — bereits in `docs/roadmap/patterns/aspects/
   aspect-android-app.md:159-164` als Weak Signal notiert, in dieser Iteration
   noch nicht adressiert.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **304/Cache-aktuell aus dem Fehler-Choke-Point auslösen (Build nötig):**
   Neue Methode `reportNetNote(where, detail)` neben `reportNetError`
   (`MainActivity.java:425-427`) mit eigenem Präfix (z.B. `"[net-ok] "`),
   `fetchUrlIfChanged` ruft sie bei `code == 304` (`:464-466`) statt
   `reportNetError` auf. `app/guard-test.js:281-299` um einen Check erweitern,
   der genau diese Umleitung erzwingt (analog zum bestehenden
   Pflicht-Logging-Muster). Macht den Choke-Point ehrlich benannt (Q6) und
   trennt Signal von Rauschen im Report. **Erwarteter Gain: +2 Pt RA**
   (Beobachtbarkeit).
2. **`scriptSbc`/`scriptPale`/`paleSource` durch loggende Setter kapseln
   (Build nötig):** Analog zu `setScriptsReady`/`setPaleStatus`/
   `setPaleInjected` (`MainActivity.java:146-162`) einen `setLoadedScripts(sbc,
   pale, source)`-Setter einführen, der die drei Felder in einem Rutsch setzt
   und `addLog` aufruft; alle Schreibstellen (`ScriptLoader` :809, :833-834;
   `SettingsSave` :889-890) darauf umstellen. `app/guard-test.js` um einen
   statischen Check erweitern, der außerhalb des Setters keine
   `.scriptSbc =`/`.scriptPale =`-Zuweisung mehr zulässt (Muster wie die
   bestehenden Pflicht-Logging-Checks, `guard-test.js:294-299`). Schließt die
   im Audit dokumentierte Kapselungs-Restlücke für den Teil, der ohne
   `private`-Modifikatoren (d8-Constraint) machbar ist. **Erwarteter Gain:
   +3 Pt RA** (SSOT/Kapselung).
3. **`onReceivedError`/`onReceivedHttpError` in `SbcWebViewClient` ergänzen
   (Build nötig):** Innerhalb der bestehenden benannten Klasse
   (`MainActivity.java:769-791`, keine neue anonyme Klasse — d8-Constraint)
   zwei Overrides hinzufügen, die bei `request.isForMainFrame()` einen
   `addLog`-Eintrag mit URL, Fehlercode/-beschreibung schreiben. Test-seitig
   mit einem neuen statischen Check in `app/guard-test.js` absichern
   (Existenz der Overrides + `addLog`-Aufruf, gleiches Extraktionsmuster wie
   die bestehenden Checks). Schließt die einzige Fremd-Grenze der Slice ohne
   Diagnose-Spur. **Erwarteter Gain: +3 Pt RA** (Beobachtbarkeit,
   Fehlertoleranz gegen externe Fehlerbilder).
4. **Leer-Body-Erkennung korrigieren (Build nötig):** In `fetchUrlIfChanged`
   (`MainActivity.java:475-476`) `body == null` durch `body.isEmpty()`
   ersetzen; denselben Check (mit eigenem `reportNetError`-Aufruf, "leerer
   Body") in `fetchUrl` (`MainActivity.java:429-445`) ergänzen, das für den
   Optimizer-Download bisher komplett fehlt. `app/guard-test.js` um ein
   Szenario erweitern, das einen 200er mit leerem Body simuliert (gleiche
   Sandbox-Technik wie die 7 bestehenden PalePoll-Szenarien,
   `guard-test.js:137-218`) und prüft, dass der Fall geloggt UND als
   Fehlschlag behandelt wird (kein stiller "OK"-Eintrag im Download-Log,
   `MainActivity.java:841-842`). **Erwarteter Gain: +2 Pt RA**
   (Testbarkeit + Fehlertoleranz — schließt einen Guard, der strukturell nie
   greifen konnte).
5. **`PALE_CHUNK`/`shareLog`-Kappung auf eine gemeinsame Konstante ziehen
   (Build nötig, klein):** Eine Konstante `MAX_LOG_SHARE_CHARS` explizit als
   Vielfaches/Bezug zu `PALE_CHUNK` benennen oder beide auf eine gemeinsame
   `IPC_SAFE_LIMIT`-Konstante zurückführen (`MainActivity.java:76`, `:168`),
   Kommentar durch echten Code-Bezug ersetzen (Q4). Niedrige Priorität, da
   nur ein Weak Signal, kein bestätigter Antipattern. **Erwarteter Gain:
   +1 Pt RA** (Puffer für den Fall, dass Aktionen 1-4 im Lift-Plan gekürzt
   werden müssen).

## Edge-Cases (mind. 1 — M1)

- **Choke-Point-Umbau darf die eigene Diagnose nicht verstümmeln:** Die
  Reklassifizierung von 304 (Aktion 1) muss die Zeile weiterhin sichtbar
  loggen (nur unter anderem Präfix), nicht stillschweigend entfernen —
  Rasmus nutzt genau diese Meldung, um zu bestätigen, dass die
  Hintergrund-Auffrischung von PaleTools lief (`docs/LEARNINGS.md` §20,
  Cache-Aktualität). Ein Wegfall wäre eine neue, unbeobachtete Lücke an
  exakt der Stelle, die gerade geschlossen werden soll.
- **`guard-test.js` extrahiert den PaleTools-Wächter über inzidentelle
  String-Literale** (`"(function(){" +` … `"})()", null);`,
  `app/guard-test.js:27-28`, bereits als Weak Signal in
  `docs/roadmap/patterns/aspects/aspect-android-app.md:165-170` notiert):
  jede Änderung an `injectPaleChunked` (`MainActivity.java:301-396`) im
  Rahmen der Aktionen oben muss nach dem Edit `node app/guard-test.js`
  laufen lassen UND stichprobenartig prüfen, dass die Extraktion noch den
  vollständigen Wächter-Code findet — ein verändertes Literal würde die
  Extraktion leise auf einen Teilblock verkürzen, statt hart zu scheitern.
- **d8-Constraint bei Aktion 3:** Die neuen `WebViewClient`-Overrides müssen
  in der bestehenden benannten `SbcWebViewClient`-Klasse landen, nicht als
  anonyme Klasse oder Lambda — der direkte `d8`-Build ohne Gradle stolpert
  sonst über das InnerClasses-Attribut (`MainActivity.java:15-18`,
  `app/README.md:110-111`).

## Lift-Empfehlung

Vorsichtig/additiv: alle 5 Aktionen sind lokale, nicht-brechende Ergänzungen
an bereits bestehenden Methoden/Klassen (neue Methode, neue Setter-Fassade,
zwei neue Overrides in einer bestehenden Klasse, ein Vergleichsoperator) ohne
Eingriff in die Fallback-Reihenfolge oder den Wächter-Timing-Kern — kein
Mid-Iter-SI nötig. Aktionen 1-3 (Gain-Summe +8) erreichen das M3-Ziel 78
bereits knapp über Schwelle; Aktion 4 dient als Absicherung gegen
Guard-Test-Verzögerungen, Aktion 5 ist optionaler Restposten. Da RA bereits
`pass` ist (72 ≥ 56 Schwelle), rechtfertigt der Abstand zum strukturellen
Deckel (80) keine aggressive Vollausschöpfung in dieser fokussierten
Iteration — alle vier MainActivity-Aktionen erfordern nach Abschluss einen
neuen APK-Build + Installation durch Rasmus (Keystore/Signatur-Check laut
`app/README.md:56-65`).
