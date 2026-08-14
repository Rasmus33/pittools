---
name: Eingebetteten Code exakt testen (Marker-/Literal-Extraktion + Brute-Force + statische Source-Checks)
slug: eingebetteten-code-exakt-testen
applies_to_features: [rating-solver, android-app-wrapper, bedienpanel-ui]
related_patterns: [ea-grenz-fallback-ketten, diagnose-feld-statt-raten, abbruch-disziplin]
related_antipatterns: []
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

PitTools hat kein Build-System: das Userscript ist eine einzige Datei, die per
`@updateURL` direkt an Tampermonkey und die Android-App ausgeliefert wird —
Push auf `main` ist Deployment. Die Android-App wiederum injiziert Code, der
nur als String-Literale innerhalb von `MainActivity.java` existiert (der
PaleTools-Wächter). In beiden Fällen gibt es keinen separaten,
kompilierbaren Modul-Export für die zu testende Logik: Sie steckt in einer
IIFE mitten im Userscript bzw. in Java-String-Konkatenation. Zusätzlich läuft
ein Teil des Codes (DOM-Manipulation, EA-Controller-Zugriff, Touch-Events,
Tampermonkey-Metablock) nur im Browser-/Android-Kontext und lässt sich in
Node gar nicht ausführen. Diese Situation tritt bei jeder neuen
Solver-Änderung, jeder Änderung am PaleTools-Wächter und bei jedem neuen
Live-Fehlerbild an DOM-/Metadaten-Code auf.

## Pattern

Drei zusammengehörige Techniken vermeiden, dass Tests eine separat gepflegte
Kopie der Produktionslogik prüfen (was strukturell zu Test/Produktiv-Drift
führen würde):

1. **Marker-/Literal-Extraktion statt Duplikat.** Der Testlauf liest die
   tatsächlich ausgelieferte Datei zur Laufzeit ein, schneidet per Regex genau
   den Codeblock heraus (Kommentar-Marker im Userscript, feste String-Literale
   im Java-Quelltext) und führt ihn direkt aus (`new Function` bzw.
   `vm`-Sandbox). Eine Divergenz zwischen Test und Produktivcode kann so
   strukturell nicht entstehen — der Test prüft immer den echten Stand.
2. **Brute-Force-Verifikation statt Kopf-Rechnung.** Für den Solver werden
   erwartete Rating-/Kosten-Optima nie von Hand ausgerechnet, sondern gegen
   eine unabhängige, vollständige Enumeration geprüft — der Solver hat sich
   in der Vergangenheit mehrfach als schlauer als die Hand-Rechnung erwiesen.
3. **Statische Source-Regex-Checks für nicht ausführbaren Code.** Code, der
   nur im Browser (DOM, Tampermonkey-Metablock, Controller-Zugriff,
   Touch-Events) läuft, wird nicht ausgeführt, sondern als Text auf konkrete,
   bereits live aufgetretene Fehlerbilder geprüft (fehlendes `id=`,
   überschatteter Helper, falsche Event-Reihenfolge, Version-Drift im
   Metablock). Jeder dieser Checks trägt einen Kommentar mit Versionsnummer
   und Symptom des auslösenden Vorfalls.

```js
// 1) Marker-Extraktion: testet GENAU den ausgelieferten Code, kein Duplikat.
const src = fs.readFileSync(__dirname + '/produkt.user.js', 'utf8');
const m = src.match(/\/\/ \[BLOCK-BEGIN\]([\s\S]*?)\/\/ \[BLOCK-END\]/);
const Core = new Function(m[1] + '\nreturn Core;')();

// 2) Brute-Force statt Kopf-Rechnung: unabhängige Referenz statt Annahme.
const bruteBest = enumerateAllCombinations(pool, constraints);
check('kein besseres Team existiert', Core.solve(pool, constraints).cost === bruteBest.cost);

// 3) Statischer Source-Check für nicht ausführbaren Browser-Code.
// Referenziert einen konkreten Live-Vorfall (Version, Symptom) im Kommentar.
check('jede id=-Referenz hat ein passendes DOM-Element',
    everyQuerySelectorHasMatchingId(extractPanelHtml(src)));
```

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:1411` / `:2446` — `// [SOLVER-BEGIN]` /
  `// [SOLVER-END]`-Marker um die `SolverCore`-IIFE.
- `solver-test.js:10-13` — liest die echte Userscript-Datei, extrahiert den
  markierten Block per Regex und kompiliert ihn via `new Function(...)` —
  keine separat gepflegte Solver-Kopie.
- `solver-test.js:4-5` — Kommentar benennt das Ziel explizit: „testet GENAU
  den ausgelieferten Code (kein Duplikat)".
- `solver-test.js:92-125` — `bruteBest(pool, c)` enumeriert per Rekursion
  alle Teams und liefert minimales V/Kosten unabhängig vom Solver.
- `solver-test.js:197-230` — 40 randomisierte Durchläufe vergleichen
  Solver-Ergebnis gegen Brute-Force auf Lösbarkeit, Zielerreichung und Kosten.
- `solver-test.js:446-456` — `bestWithProtected(...)`, Kommentar: „damit die
  Erwartungswerte unten nicht aus dem Kopf kommen".
- `solver-test.js:349-378` — statischer Check auf Tampermonkey-Metablock
  (keine freien Kommentare im `==UserScript==`-Header, `@version` ==
  `const VERSION`), referenziert den Auto-Update-Ausfall in v4.11.0.
- `solver-test.js:380-410` — prüft `panel.querySelector('#sbc-opt-…')` gegen
  vorhandene `id="sbc-opt-…"`-Attribute im Panel-HTML, referenziert das leere
  Panel in v4.17.0.
- `solver-test.js:1192-1216` — sammelt alle definierten Funktionsnamen und
  prüft, dass jeder Helper-Aufruf im Code auch tatsächlich definiert ist,
  referenziert den Aufruf einer nie existierenden `findLiveSquad()` in
  v4.35.0.
- `app/guard-test.js:25-44` — `extractGuard()` liest `MainActivity.java`,
  sucht die Marker `"(function(){" +` … `"})()", null);` und setzt die
  Java-String-Literale Zeile für Zeile zu einem JS-Programm zusammen.
- `app/guard-test.js:9-12` — Kommentar: „der Code hier aus der Java-Quelle
  extrahiert (gleiches Prinzip wie solver-test.js beim Userscript)".
- `app/guard-test.js:69-118` — Fake-DOM-`vm`-Sandbox (`localStorage`,
  `querySelectorAll`, Zeit-Hooks) spielt den extrahierten Wächter durch
  7 Szenarien durch, ohne echtes Gerät.
- `CLAUDE.md` (Eiserner Arbeitsablauf) — verlangt `node solver-test.js` bei
  jeder Änderung und `node app/guard-test.js` bei jeder App-Änderung, mit der
  Begründung, dass der Wächter sonst „STILL" ausfällt.

## Beziehungen

- **Bezieht sich auf:** [[ea-grenz-fallback-ketten]] — beide Patterns
  entstehen aus derselben Randbedingung „kein Build-System, eine
  ausgelieferte Datei"; wo Fallback-Ketten Laufzeit-Robustheit gegen fremde
  Grenzen herstellen, stellt dieses Pattern Test-Robustheit gegen dieselbe
  Ein-Datei-Struktur her.
- **Bezieht sich auf:** [[diagnose-feld-statt-raten]] — die statischen
  Source-Checks entstehen reaktiv aus genau den Live-Vorfällen, die erst über
  den Diagnose-Report/App-Log sichtbar wurden; ohne diesen Kanal gäbe es kein
  Symptom, das der Regressionstest referenzieren könnte.
- **Bezieht sich auf:** [[abbruch-disziplin]] — beide Patterns teilen die
  Haltung „lieber hart prüfen als stillschweigend hoffen": dort bricht der
  Batch-Lauf bei jeder Laufzeit-Unstimmigkeit ab statt weiterzumachen, hier
  bricht der Testlauf (`process.exit(failures ? 1 : 0)`) den Deployment-Weg
  bei jeder Abweichung vom exakt ausgelieferten Code ab.
- **Voraussetzungen:** feste, grep-bare Marker bzw. Text-Anker im
  Produktivcode (`// [SOLVER-BEGIN]`/`// [SOLVER-END]`, die
  Java-String-Literale `"(function(){" +` … `"})()", null);`) — ändert sich
  deren Wortlaut, muss die Extraktion im Test mitgezogen werden.
