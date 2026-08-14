---
slice: tests
analyzed_at: 2026-08-14
iteration: 0
---

# Aspect — tests

Rohaufnahme dessen, was im Code zur Slice tatsächlich vorkommt. Vom
`aspect-analyzer`-Subagent geschrieben (Sonnet, parallel pro Slice).
Wird pro Iteration überschrieben — Git-Log ist die Historie.

## Beobachtetes Pattern: Marker-Extraktion des exakt ausgelieferten Codes

**Was passiert:** Beide Test-Dateien führen keine eigene Kopie der zu
testenden Logik. Sie extrahieren den Produktionscode aus der echten
Auslieferungsdatei (Userscript bzw. Java-Quelle) über Text-Marker und führen
genau dieses Fragment im Test aus. Damit kann eine Test/Produktiv-Divergenz
strukturell nicht entstehen.

**Code-Belege:**
- `solver-test.js:10` — `const src = fs.readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8');` liest die tatsächlich ausgelieferte Datei, kein Duplikat.
- `solver-test.js:11-13` — `src.match(/\/\/ \[SOLVER-BEGIN\]([\s\S]*?)\/\/ \[SOLVER-END\]/)` gefolgt von `new Function(m[1] + '\nreturn SolverCore;')()`: der extrahierte Block wird direkt kompiliert und ausgeführt, kein Abtippen der Logik.
- `solver-test.js:4-5` (Kommentar) — „Extrahiert den [SOLVER-BEGIN]..[SOLVER-END]-Block aus dem Userscript und testet GENAU den ausgelieferten Code (kein Duplikat)."
- `app/guard-test.js:25-44` — `extractGuard()` liest `MainActivity.java`, sucht die Marker `"(function(){" +` … `"})()", null);` und setzt die Java-String-Literale Zeile für Zeile zu einem JS-Programm zusammen (inkl. eigenem `unescapeJava`).
- `app/guard-test.js:9-12` (Kommentar) — „der Code hier aus der Java-Quelle extrahiert (gleiches Prinzip wie solver-test.js beim Userscript)".

**Wo das (noch) fehlt:** Nicht zutreffend — beide vorhandenen Test-Dateien der Slice folgen dem Prinzip durchgängig; es gibt keine dritte Testdatei, die Produktionslogik dupliziert.

## Beobachtetes Pattern: Brute-Force-Verifikation statt Kopf-Rechnung

**Was passiert:** Erwartungswerte für den Solver werden nicht von Hand
ausgerechnet, sondern gegen eine unabhängige Referenzimplementierung
(vollständige Enumeration/Brute-Force) geprüft. Das deckt sich mit der
CLAUDE.md-Vorgabe „Erwartungswerte NIE aus dem Kopf — immer per Brute-Force
verifizieren".

**Code-Belege:**
- `solver-test.js:92-125` — `bruteBest(pool, c)` enumeriert per Rekursion alle Teams, berechnet das minimale V und die minimalen Kosten unabhängig vom Solver.
- `solver-test.js:186-194` — „Und per Brute-Force: es gibt kein Team mit kleinerem V" prüft `SolverCore.squadV(...)` gegen `bruteBest(...).vMin`.
- `solver-test.js:197-230` — 40 randomisierte Durchläufe (`mulberry32`-Seed) vergleichen Solver-Ergebnis und Brute-Force-Ergebnis auf Lösbarkeit, Zielerreichung und minimale Kosten (`check('40x Brute-Force-Parität ...')`).
- `solver-test.js:446-456` — `bestWithProtected(pool, N, maxProt)` als weitere Brute-Force-Hilfsfunktion, explizit kommentiert: „damit die Erwartungswerte unten nicht aus dem Kopf kommen."
- `solver-test.js:476` und `solver-test.js:494` — zwei benannte Checks („Brute-Force: Ziel 90 ist mit genau 1 Gruppe-83-Karte erreichbar", „Brute-Force: ohne Alternative nur mit 2 geschützten Karten möglich") nutzen diese Referenzfunktion für konkrete Rarity-Schutz-Fälle.

**Wo das (noch) fehlt:** Für reine Zähl-/Verteilungs-Tests ohne Kostenoptimierung (z. B. die Bronze/Silber-Quoten-Tests ab `solver-test.js:873`) wird nicht brute-force-verifiziert, sondern die erwartete Anzahl direkt aus der Produktregel abgeleitet — dort ist die Erwartung aber auch trivial (fest vorgegebene Quote), nicht das Ergebnis einer Kostenoptimierung.

## Beobachtetes Pattern: Statische Source-Regex-Checks als Regressionsschutz für nicht direkt ausführbaren Code

**Was passiert:** Code, der nur im Browser/Android-Kontext läuft (DOM-Manipulation, EA-Controller-Zugriff, Touch-Events, Tampermonkey-Metadaten) wird nicht ausgeführt, sondern als Text auf konkrete, live aufgetretene Fehlerbilder geprüft (Substring-/Regex-Checks auf dem Quelltext-Ausschnitt der jeweiligen Funktion). Jeder dieser Blöcke trägt einen Kommentar mit Versionsnummer und Symptom des Live-Vorfalls, der den Test ausgelöst hat.

**Code-Belege:**
- `solver-test.js:349-378` — Metablock-Check: verhindert freie Kommentare im `==UserScript==`-Header und Version-Drift zwischen `@version` und `const VERSION`; Kommentar referenziert den Auto-Update-Ausfall in v4.11.0.
- `solver-test.js:380-410` — prüft, dass jede `panel.querySelector('#sbc-opt-…')`-Referenz ein passendes `id="sbc-opt-…"` im Panel-HTML hat und jeder `ui.<feld>.addEventListener` ein tatsächlich gesetztes `ui`-Feld trifft; Kommentar referenziert das leere Panel in v4.17.0.
- `solver-test.js:412-428` — iteriert über eine feste Helfer-Liste (`log, warn, toast, setStatus, escapeHtml, diagError`) und prüft per Regex, dass keine `const/let/var` gleichen Namens sie überschattet; Kommentar referenziert den `log is not a function`-Absturz in v4.12.0.
- `solver-test.js:946-970` — prüft am Quelltext-Ausschnitt von `submitChallengeToEa`, dass `_submitChallenge`, `getControllerChain`, `leftController`/`_overviewController` vorkommen; referenziert den Controller-Stack-Fehler aus v4.27.0.
- `solver-test.js:972-993` — prüft am Ausschnitt von `clickLike`, dass `touchstart`/`touchend` vor `pointerdown` kommen und Koordinaten gesetzt werden; referenziert den wirkungslosen Tap aus v4.29.0.
- `solver-test.js:1192-1216` — baut aus `function `- und `const … = function`-Deklarationen ein Set aller definierten Namen und prüft, dass jeder Aufruf eines eigenen Helfers (Namensschema `find/click/dismiss/resolve/collect/normalize/merge/extract/nudge/popup/batch…`) darin vorkommt; referenziert den Aufruf einer nie existierenden `findLiveSquad()` in v4.35.0.
- `solver-test.js:1218-1235` — prüft, dass `indexOf('RARE')` nicht mehr im Code vorkommt (traf Spielernamen wie „Carrarese Calcio"); referenziert v4.24.0.

**Wo das (noch) fehlt:** Nicht bewertbar ohne Live-Vorfall — das Muster wird laut Kommentaren durchgängig erst NACH einem aufgetretenen Fehler nachgezogen (reaktiv), nicht vorab für neue Browser-/DOM-Funktionen.

## Beobachteter Antipattern: Wiederholtes Neu-Einlesen der Zieldatei statt Wiederverwendung von `src`

**Was schiefläuft:** `solver-test.js` liest die Produktionsdatei bereits einmal zentral ein (`const src = fs.readFileSync(...)` in Zeile 10) und verwendet diese Variable in den meisten früheren Testblöcken. Ab dem Abschnitt „8b-2c" (rund Zeile 866) wiederholt sich stattdessen in zehn weiteren Blöcken `require('fs').readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8')` — jedes Mal in einem eigenen Block-Scope, der die äußere `src`-Variable durch eine gleichnamige lokale Variable überschattet. Die Datei wird dadurch bei jedem Testlauf mindestens elfmal von der Platte gelesen, obwohl der Inhalt unverändert und schon vorhanden ist. Zusätzlich ist die Anführungszeichen-Konvention dabei uneinheitlich (mal `'`, mal `"`), ein Indiz für Copy-Paste ohne Rückblick auf den bestehenden Stil.

**Code-Belege:**
- `solver-test.js:10` — die eine korrekte, zentrale Quelle: `const src = fs.readFileSync(...)`.
- `solver-test.js:866` — `const srcJs = require('fs').readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8');` (eigener Name, aber redundante Lese-Operation).
- `solver-test.js:954` — `const src = require("fs").readFileSync(...)` (Doppelte Anführungszeichen, überschattet die äußere `src`).
- `solver-test.js:979` — dieselbe Zeile erneut, Block „8b-2f".
- `solver-test.js:997` — dieselbe Zeile erneut, Block „8b-2g".
- `solver-test.js:1035` — dieselbe Zeile mit einfachen Anführungszeichen, Block „8b-2h".
- `solver-test.js:1126` — dieselbe Zeile mit doppelten Anführungszeichen, Block „8b-2i".
- `solver-test.js:1157` — dieselbe Zeile mit doppelten Anführungszeichen, Block „8b-2j".
- `solver-test.js:1198` — dieselbe Zeile mit einfachen Anführungszeichen, Block „8b-2k".
- `solver-test.js:1223` — dieselbe Zeile, Block „8b-3".
- `solver-test.js:1242` — dieselbe Zeile, Block „8b-4".

**Vermutete Wurzelursache:** Q4 (DRY) — jeder neue Live-Vorfall wurde offenkundig als isolierter, in sich abgeschlossener Testblock ergänzt (siehe das Pattern der Source-Regex-Checks oben), vermutlich per Copy-Paste des jeweils letzten Blocks statt Wiederverwendung der am Dateianfang bereits vorhandenen `src`-Variable. Bei aktuell elf Testdateien-Größe (`ea-fc-sbc-optimizer.user.js`, mehrere tausend Zeilen) ist der Performance-Effekt vernachlässigbar, der Wartbarkeits-Effekt aber real: Änderungen am Lese-Vorgang (z. B. Pfad, Encoding, Fehlerbehandlung) müssten an elf Stellen synchron gehalten werden.

## Weak Signals (zu wenige Belege für Pattern-Status)

- Zero-Dependency-Test-Harness mit eigenem `ok()`/`check()`-Zähler: `solver-test.js:15-23` (`tests`/`failures`, `check()`) und `app/guard-test.js:130-134` (`failed`, `ok()`) implementieren unabhängig voneinander dasselbe Minimal-Zählmuster (kein Test-Framework, Konsolen-Ausgabe pro Assertion, `process.exit(failures ? 1 : 0)` am Ende: `solver-test.js:1428-1429`, `app/guard-test.js:215-218`). Nur 2 Dateien in dieser Slice vorhanden — Cluster-Reife (≥2 Aspect-Files) kann hier nicht durch mehrere Slices bestätigt werden, aber innerhalb der Slice konsistent.
- Historische „Vorher war …"-Kommentare in Testerwartungen: `solver-test.js:1416` („Vorher war 85-86:5") und `solver-test.js:878` („Vor v4.28.0 gewann Math.max…") — nur 2 Stellen, potenziell ein Q7-Grenzfall (Doku beschreibt IST-Zustand, keine Historie), hier aber Code-Kommentar zur Begründung einer sonst überraschenden Testerwartung (Q6-Ausnahme „nicht-offensichtliche Entscheidung"). Zu wenige Stellen für einen eigenen Antipattern-Befund.
- Asynchrone Testblöcke über eine `pending`-Sammelstelle: `solver-test.js:17-18` (`const pending = []`) und `solver-test.js:1117` (`pending.push(Promise.all(results))`) sowie die Abrechnung erst nach `Promise.all(pending)` in `solver-test.js:1427-1433` — einziger Anwendungsfall ist der Club-Loader-Test; kommentiert als bewusste Ausnahme („sonst killt process.exit() die Loader-Tests, bevor sie laufen").
- Fake-Browser/Sandbox via Node `vm`-Modul: `app/guard-test.js:69-118` (`makeSandbox`, `start`) — einziges Vorkommen in der Slice, sehr detailliert (Zeitschwellen-Hooks, CSP-Fallback-Simulation), aber nur eine Datei/ein Anwendungsfall.

## Zusammenfassung

- 3 Pattern-Kandidaten in dieser Slice
- 1 Antipattern-Kandidat
- 4 Weak Signals
