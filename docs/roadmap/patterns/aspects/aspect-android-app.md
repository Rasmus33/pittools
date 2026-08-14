---
slice: android-app
analyzed_at: 2026-08-14
iteration: 0
---

# Aspect — android-app

Rohaufnahme dessen, was im Code zur Slice tatsächlich vorkommt. Vom
`aspect-analyzer`-Subagent geschrieben (Sonnet, parallel pro Slice).
Wird pro Iteration überschrieben — Git-Log ist die Historie.

## Beobachtetes Pattern: Mehrstufiger Fallback bei der Script-Beschaffung (Download → Cache → gebündeltes Asset)

**Was passiert:** Für den SBC-Optimizer gilt Download-zuerst mit Cache und
gebündeltem Asset als Rückfallebenen; für PaleTools (~900 KB) gilt bewusst
Cache-first ("stale-while-revalidate") — die Datei wird sofort aus dem Cache
verwendet, die Auffrischung läuft danach im Hintergrund per bedingtem GET
(ETag/Last-Modified), damit ein unveränderter Stand keinen vollen Download
mehr auslöst.

**Code-Belege:**
- `app/java/com/sbctools/browser/MainActivity.java:738-745` — SBC-Optimizer: URL → Cache → `readAsset("sbc-optimizer.user.js")`.
- `app/java/com/sbctools/browser/MainActivity.java:748-770` — PaleTools: `readCache("pale.js")` zuerst, Download nur wenn kein Cache-Treffer.
- `app/java/com/sbctools/browser/MainActivity.java:409-432` — `fetchUrlIfChanged`: bedingter GET mit If-None-Match/If-Modified-Since, 304 ohne Body.
- `app/java/com/sbctools/browser/MainActivity.java:789-798` — Hintergrund-Auffrischung NACH `StartWebApp`, blockiert den Start nicht mehr.
- `docs/LEARNINGS.md:750-775` (§20) — dokumentiert explizit, warum die alte Reihenfolge (Download vor Cache-Nutzung) ein Live-Problem war und die Asymmetrie Optimizer/PaleTools bewusst ist.

**Wo das (noch) fehlt:** —

## Beobachtetes Pattern: Gestückelte Cross-Context-Injection mit Sentinel und CSP-Fallback für große Scripts

**Was passiert:** Ein ~900 KB großes Script kann nicht in einem
`evaluateJavascript`-Aufruf übertragen werden (Binder-IPC-Transaktionslimit
~1 MB). Der Code wird deshalb in Häppchen (`PALE_CHUNK`) als ASCII-sichere
String-Literale übertragen, im Seitenkontext zu einem Puffer zusammengesetzt
und über ein `<script>`-Tag ausgeführt; scheitert das (CSP blockt inline
Scripts), greift `new Function` als Fallback — erkennbar über einen
Sentinel (`__pt_ran`), weil ein CSP-Block sonst still ohne Exception passiert.

**Code-Belege:**
- `app/java/com/sbctools/browser/MainActivity.java:72-76` — `PALE_CHUNK = 60000`, Kommentar begründet die Größe relativ zum ~1-MB-Binder-Limit.
- `app/java/com/sbctools/browser/MainActivity.java:273-286` — `injectPaleChunked`: Puffer-Aufbau, Chunk-Loop mit `jsQuote`.
- `app/java/com/sbctools/browser/MainActivity.java:296-308` — Ausführung über `<script>`-Tag, Sentinel `__pt_ran`, `new Function`-Fallback bei stillem CSP-Block.
- `app/java/com/sbctools/browser/MainActivity.java:370-390` — `jsQuote`: alles außerhalb ASCII-druckbar wird als `\uXXXX`-Escape geschrieben, umgeht Encoding-Fragen zwischen Java/Binder/JS.
- `docs/LEARNINGS.md:236-250` (§8) — Begründung und Verifikation (16 Chunks, Roundtrip byte-identisch).

**Wo das (noch) fehlt:** —

## Beobachtetes Pattern: Selbstjustierender Wächter für die Skript-Ladereihenfolge

**Was passiert:** PaleTools referenziert EA-Symbole auf Top-Level und stirbt,
wenn es zu früh läuft. Der Wächter pollt in 250-ms-Ticks auf das Vorhandensein
tragender EA-Symbole, startet bei fehlendem `UIItemActionEvent` nach einer
kurzen Nachfrist trotzdem (das Symbol könnte in dieser FC-Version gar nicht
existieren) und merkt sich pro Gerät in `SharedPreferences`, sobald das
nachweislich funktioniert hat — dann entfällt die Nachfrist beim nächsten
Start ganz. Bei dauerhaft fehlenden tragenden Symbolen wird NICHT ausgeführt,
um den einzigen Versuch nicht zu verbrennen.

**Code-Belege:**
- `app/java/com/sbctools/browser/MainActivity.java:331-366` — `miss()`/Wait-Loop mit SOFT/HARD-Schwellen, `blockers`-Filter für `UIItemActionEvent`.
- `app/java/com/sbctools/browser/MainActivity.java:277-278` — `paleSoftOk`-Präferenz steuert `softAfter` beim nächsten Start.
- `app/java/com/sbctools/browser/MainActivity.java:629-647` (`PalePoll.onReceiveValue`) — Beleg-basiertes Merken (`LS-Keys >= 1`) statt Vermutung.
- `app/guard-test.js:161-190` — Tests 3–5 verifizieren genau dieses Verhalten (Ausführen sobald bereit, Soft-Start ohne `UIItemActionEvent`, Aufgeben ohne Ausführen bei dauerhaft fehlenden Symbolen).
- `docs/LEARNINGS.md:823-849` (§22) — Herleitung der 40-Tick-Schwelle aus zwei Live-Logs statt Hand-Schätzung.

**Wo das (noch) fehlt:** —

## Beobachtetes Pattern: Extraktion eingebetteten JS-Codes in eine Fake-DOM-Testumgebung

**Was passiert:** Der aus Java-String-Literalen zusammengesetzte
PaleTools-Wächter lässt sich am Gerät nicht beobachten (er fällt still aus).
`guard-test.js` extrahiert genau diesen Code aus der `.java`-Quelle,
entfaltet die Java-Escapes und spielt ihn in einer minimalen
`vm`-Sandbox (Fake `document`/`localStorage`/Zeit-Hooks) durch 7 Szenarien
durch — ohne Dependencies, analog zur Testphilosophie des Repos
(vgl. `solver-test.js` für den Solver).

**Code-Belege:**
- `app/guard-test.js:25-44` — `extractGuard()`: liest `MainActivity.java`, entfernt Java-Kommentare, sammelt String-Literale, entfaltet Escapes.
- `app/guard-test.js:69-110` — `makeSandbox`: Fake-DOM mit `localStorage`, `querySelectorAll`, Zeit-Hooks (`softAfter`/`hardAfter`) statt Minuten realer Wartezeit.
- `app/guard-test.js:137-218` — 7 Testszenarien (Syntax, Warten ohne EA-Klassen, Ausführen sobald bereit, Soft-Start, Hard-Aufgeben, CSP-Fallback, Nachkontrolle).
- `CLAUDE.md:52-53` — Eiserner Arbeitsablauf verlangt `node app/guard-test.js` bei jeder App-Änderung, mit Begründung ("fällt sonst STILL aus").
- `app/README.md:87` — dokumentiert 18 Einzelchecks als Teil des Wächters.

**Wo das (noch) fehlt:** —

## Beobachtetes Pattern: Fail-fast statt stiller Degradation im Build-Skript

**Was passiert:** `build.sh` bricht an mehreren Stellen bewusst hart ab,
statt einen Fehler stillschweigend zu tolerieren — insbesondere dort, wo ein
stiller Fehler früher tatsächlich passiert ist (veraltetes Bundle-Asset durch
`|| true`) oder ein Live-Ausfall droht (falscher Keystore macht Update-in-place
unmöglich).

**Code-Belege:**
- `app/build.sh:46-58` — Keystore fehlt → harter Abbruch, kein stilles `keytool`-Erzeugen (nur mit explizitem `ALLOW_NEW_KEYSTORE=1`).
- `app/build.sh:63-67` — fester Pfad zum Quell-Script mit hartem Fehler, wenn er fehlt (ersetzt einen früheren `|| true`, der das Bundle-Asset unbemerkt veralten ließ).
- `app/build.sh:16,22` — `[ -n "$BTV" ] || { echo "FEHLER…"; exit 1; }` bzw. für die Plattform-Version — kein Weiterlaufen mit leerem Toolpfad.
- `docs/LEARNINGS.md:262-276` (§8) — listet die vier ursprünglichen stillen Fallen und wie jede durch einen harten Abbruch ersetzt wurde.

**Wo das (noch) fehlt:** Der Signatur-Check am Ende (`apksigner verify --print-certs`) ist weiterhin nur eine Textausgabe zum manuellen Vergleich, kein automatisiertes Gate (siehe Weak Signals).

## Beobachteter Antipattern: Stilles Verschlucken von Exceptions in Netzwerk-/Cache-Pfaden unterläuft das eigene Diagnose-Konzept

**Was schiefläuft:** Das Log-Ringpuffer-Konzept existiert explizit, weil am
Gerät keine Konsole hängt und "Debugging sonst Raten" ist (README, §8 in
LEARNINGS). Trotzdem verschlucken mehrere Methoden im selben File jede
`Exception` ersatzlos — ohne `addLog(...)`-Aufruf — sodass genau die Klasse
von Fehlern, für die das Log-System gebaut wurde (Netzwerk-Timeout, falscher
Statuscode, IO-Fehler beim Cache), am Gerät nicht mehr unterscheidbar ist. Nur
das Gesamtergebnis ("Optimizer=-1 Zeichen") landet im Log, nicht die Ursache.

**Code-Belege:**
- `app/java/com/sbctools/browser/MainActivity.java:392-401` (`fetchUrl`) — `catch (Exception e) { return null; }`, kein Log.
- `app/java/com/sbctools/browser/MainActivity.java:409-432` (`fetchUrlIfChanged`) — `catch (Exception e) { return null; }`, kein Log — betrifft auch den PaleTools-Cache-Refresh.
- `app/java/com/sbctools/browser/MainActivity.java:434-437` (`readAsset`) — `catch (Exception e) { return null; }`, kein Log.
- `app/java/com/sbctools/browser/MainActivity.java:439-442` (`readCache`) — `catch (Exception e) { return null; }`, kein Log.
- `app/java/com/sbctools/browser/MainActivity.java:444-451` (`writeCache`) — `catch (Exception e) { /* Cache ist optional */ }`, Kommentar erklärt WARUM ignoriert wird, aber auch hier kein `addLog`.
- `app/java/com/sbctools/browser/MainActivity.java:130-134` (`appVersion`) — `catch (Exception e) { return "?"; }`, betrifft ausgerechnet den Log-Kopf selbst.

**Vermutete Wurzelursache:** Q1/Q2 — die Diagnose-Infrastruktur (`addLog`)
war zum Zeitpunkt dieser Methoden bereits vorhanden (gleiche Klasse), wurde
hier aber nicht konsequent verwendet. Wirkt wie ein Symptom-Fix ("Absturz
verhindern, `null` zurückgeben") ohne die an anderer Stelle bereits gelöste
Wurzelfrage ("wie sieht Rasmus am Gerät, WARUM etwas fehlschlug?") mit
anzugehen.

## Beobachteter Antipattern: Ungekapselte Activity-State-Felder werden von zahlreichen Top-Level-Hilfsklassen direkt mutiert

**Was schiefläuft:** `MainActivity` hält seinen gesamten veränderlichen
Zustand (WebView, Preferences, geladene Scripts, PaleTools-Status) in
paketsichtbaren Feldern ohne Zugriffsschutz. Zehn separate Top-Level-Klassen
im selben File lesen und schreiben diese Felder direkt (`a.scriptSbc = null`,
`a.paleStatus = status`, `a.web.evaluateJavascript(...)`) statt über
Methoden/Kapselung — jede dieser Klassen kann den Zustand der Activity in
beliebiger Reihenfolge verändern, ohne dass eine zentrale Stelle Invarianten
prüft (z. B. dass `paleInjected` und `scriptsReady` zueinander passen).

**Code-Belege:**
- `app/java/com/sbctools/browser/MainActivity.java:78-83` — `WebView web`, `SharedPreferences prefs`, `scriptSbc`, `scriptPale`, `scriptsReady`, `paleInjected` ohne `private`.
- `app/java/com/sbctools/browser/MainActivity.java:730-772` (`ScriptLoader.run`) — schreibt `a.scriptSbc`, `a.scriptPale`, `a.paleSource`, `a.scriptsReady` direkt von einem Hintergrund-Thread aus.
- `app/java/com/sbctools/browser/MainActivity.java:649-650` (`PalePoll.onReceiveValue`) — schreibt `a.paleStatus` direkt.
- `app/java/com/sbctools/browser/MainActivity.java:812-829` (`SettingsSave.onClick`) — setzt `a.scriptsReady = false; a.scriptSbc = null; a.scriptPale = null;` und ruft danach `a.loadScriptsThenStart()` — Reset-Reihenfolge liegt in der Verantwortung des Aufrufers, nicht der Activity selbst.
- `app/java/com/sbctools/browser/MainActivity.java:538-572` (`GearDrag`) — ruft `a.saveGearPos(...)` bzw. `a.showSettings()` auf Basis von direktem Feldzugriff auf `v`/`a`.

**Vermutete Wurzelursache:** strukturell — Kommentar am Dateikopf
(`MainActivity.java:15-18`) erklärt, dass anonyme innere Klassen den
`d8`-Build ohne Gradle crashen lassen (NPE im InnerClasses-Attribut), daher
ausschließlich benannte Top-Level-Klassen. Diese Einschränkung erzwingt
faktisch den Verzicht auf private Kapselung mit Zugriffsmethoden, weil jede
Hilfsklasse eine Referenz auf die Activity braucht und deren Felder direkt
anspricht. Der Build-Constraint ist real und dokumentiert; die fehlende
Kapselung ist eine unadressierte Folge davon.

## Weak Signals (zu wenige Belege für Pattern-Status)

- Duplizierte Größen-Grenze ohne gemeinsame Konstante: `MainActivity.java:76`
  definiert `PALE_CHUNK = 60000`, `MainActivity.java:138-140` (`shareLog`)
  begrenzt den Log-Report unabhängig davon hart auf `120000` Zeichen mit dem
  Kommentar "dieselbe Grenze wie bei evaluateJavascript" — die beiden Zahlen
  sind nicht über eine gemeinsame Konstante verknüpft (Q4/DRY-Kandidat), nur
  zwei Fundstellen, daher kein voller Antipattern.
- `guard-test.js` extrahiert den Wächter über inzidentelle Code-Literale
  (`"(function(){" +` / `"})()", null);`, `app/guard-test.js:27-28`) statt
  über dedizierte Marker-Kommentare — bricht potenziell still, wenn der
  Wächter-Code so umformuliert wird, dass diese exakten Teilstrings nicht
  mehr vorkommen oder mehrfach auftreten. Nur eine Fundstelle im Code, daher
  kein voller Antipattern.
- Der Signatur-Check am Ende von `build.sh:117` (`apksigner verify
  --print-certs … | head -4`) ist reine Textausgabe zum manuellen Abgleich
  gegen den in `app/README.md:64` und `CLAUDE.md` genannten SHA-256-Fingerabdruck
  (`41f23895…1b17`) — kein automatisiertes `grep`/Exit-Code-Gate, obwohl der
  Rest von `build.sh` konsequent fail-fast ist. Nur eine Code-Fundstelle,
  daher kein voller Antipattern.

## Zusammenfassung

- 5 Pattern-Kandidaten in dieser Slice
- 2 Antipattern-Kandidaten
- 3 Weak Signals
