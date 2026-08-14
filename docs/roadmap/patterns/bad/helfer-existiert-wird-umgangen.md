---
name: Kanonischer Helfer existiert, wird aber inline dupliziert/umgangen
slug: helfer-existiert-wird-umgangen
applies_to_features: [ea-app-anbindung, team-eintragen, batch-modus, rating-solver, bedienpanel-ui, sbc-vorgaben-erkennung]
related_patterns: []
related_antipatterns: [wissens-duplikate-ohne-ssot]
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

An mehreren Fremd-Grenzen und internen Kernpfaden von PitTools existiert
bereits genau eine kanonische Implementierung einer nicht-trivialen Logik —
teils sogar mit explizitem Kommentar, dass sie zur Wiederverwendung gedacht
ist (`findSbcController`/`findLiveChallenge`: "Helfer, die auch die Diagnose
nutzt") oder mit einer dokumentierten Invarianten, deren Verletzung einen
konkreten Live-Fehler auslöst (`reserve()`: "Zwei Karten desselben Spielers
im Team sind HTTP 460"). Trotzdem entstehen an anderer Stelle im selben
Abschnitt der Datei — oder sogar im selben Testlauf — neue Call-Sites, die
dieselbe Logik inline nachbauen statt den Helfer aufzurufen. Das Muster
zieht sich durch alle untersuchten Slices: EA-Service-Controller-Traversal,
DOM-Sichtbarkeitsprüfung, HTTP-Retry-Logik, Solver-Sortierung,
Solver-Reservierungs-Funnel und sogar die Test-Suite selbst. Auslöser ist
fast immer derselbe zeitliche Ablauf: eine neue Diagnose-Funktion, ein neuer
Live-Incident-Regressionstest oder ein zweiter Aufrufer wird unter
Zeitdruck direkt neben bzw. kurz nach der kanonischen Implementierung per
Copy-Paste ergänzt, ohne den Rückweg zum bereits vorhandenen Helfer zu
gehen. Funktional bleibt das oft lange unauffällig — bis jemand die
Kernlogik an nur einer der Kopien ändert.

## Pattern

Symptom: Ein Helfer mit klarer, oft sogar dokumentierter Verantwortung
existiert; ein neuer oder bestehender Aufrufer baut dieselbe Logik trotzdem
Zeile für Zeile (oder mit identischem Vergleichsausdruck) noch einmal
nach, statt den Helfer aufzurufen. Besonders gefährlich wird das, wenn der
Helfer nicht nur Boilerplate spart, sondern eine Invariante durchsetzt —
dann bricht der Bypass diese Invariante lautlos für alle, die nicht den
Kommentar am Helfer gelesen haben.

```js
// Antipattern — reserve() postuliert explizit:
// "Jede Reservierung MUSS hierueber laufen: sie fuehrt used und
//  usedAssets zusammen nach. Zwei Karten desselben Spielers sind HTTP 460."
function reserve(p) {
    used.add(p.id);
    usedAssets.add(p.assetId);   // <- genau das wird beim Bypass vergessen
    reserved.push(p);
}

// ... an anderer Stelle im selben Solver-Lauf:
used.add(anchor.id);
reserved.push(anchor);           // reserve() umgangen, usedAssets bleibt leer
```

**Stattdessen:** den vorhandenen Helfer aufrufen statt die Logik zu
duplizieren — sofern das ohne Verhaltensänderung möglich ist. Nicht jeder
Fund rechtfertigt sofortiges Refactoring: Wege, die laut CLAUDE.md
"Nicht anfassen ohne Grund" live verifiziert sind (z.B. `submitViaApp()`
als Submit-Weg 0), dürfen nicht mal eben auf den Helfer umgestellt werden,
nur um Q4 zu erfüllen — das Risiko einer Regression an einem kritischen
Pfad wiegt schwerer als die Duplikation selbst. Der `reserve()`-Fall ist der
heikelste Beleg dieses Clusters: aktuell folgenlos, weil vorgelagerte
Pool-Dedupe-Schritte pro `assetId` das HTTP-460-Risiko zufällig abfangen,
aber strukturell ungeschützt. Eine Korrektur muss verhaltensneutral sein
(`solver-test.js` vorher/nachher grün) und braucht einen eigenen
Testfall, der genau die Lücke abdeckt (z.B. Anker + Rarity-Pick mit
kollidierender `assetId`, brute-force-verifiziert), bevor der Bypass
geschlossen wird — sonst bleibt unklar, ob die Invariante wirklich greift.

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:2692-2716` — kanonische `getControllerChain()`
  (visited-Set, depth-cap, try/catch) vs. `:2720-2744` (`controllerScan()`)
  und `:2811-2836` (`refreshOpenSbcView()`) — derselbe Traversierungs-Block
  zweimal Zeile für Zeile nachgebaut, obwohl der Helfer zum Zeitpunkt beider
  Duplikate bereits definiert und aufrufbar ist.
- `ea-fc-sbc-optimizer.user.js:4986-4997` (`findLiveChallenge()`) und
  `:4999-5006` (`findSbcController()`) — als Diagnose-Helfer extrahiert, aber
  von `submitViaApp()` (`:2554-2570`) und `syncSbcWithOpenChallenge()`
  (`:742-753`) inline noch einmal nachgebaut statt aufgerufen.
- `ea-fc-sbc-optimizer.user.js:4653` — kanonische `visibleAll()` vs. vier
  identische Sichtbarkeits-Ausdrücke (`el.offsetParent !== null ||
  el.getClientRects().length`) inline bei `:3609` (`sbcButtonContainer()`),
  `:3794`/`:3839` (`buildDiagReport()`-Scans) und `:4279` (`popupState()`).
- `ea-fc-sbc-optimizer.user.js:1185`/`:1208`, `:1197-1201`/`:1221-1226`,
  `:1203`/`:1232` — `apiGet`/`apiPut` bauen URL und 401-Retry-Kaskade
  (Nudge → Sleep 3000 → rekursiver Retry, Grenze `_attempt<2`) fast
  wortgleich zweimal statt über eine gemeinsame `apiRequest()`-Funktion.
- `ea-fc-sbc-optimizer.user.js:1958-1959`, `:2073-2075`, `:2197-2198`,
  `:2245-2246` — derselbe Sortier-Komparator ("Storage → Rating → Kosten →
  Tiebreak") viermal wörtlich dupliziert, obwohl `makeConsumeCmp`
  (`:1422`) im selben Modul bereits als Comparator-Factory-Vorbild existiert.
- `ea-fc-sbc-optimizer.user.js:1855-1866` — `reserve()`-Definition mit
  expliziter Invarianten-Ansage vs. `:1908-1917` (Anker-Reservierung) und
  `:1932-1936` (manueller Rarity-Pick), die `used`/`reserved` inline pflegen
  und dabei `usedAssets` unbefüllt lassen.
- `solver-test.js:10` — die eine korrekte, zentrale `src`-Variable
  (`fs.readFileSync(...)`) vs. mindestens 10 weitere Blöcke ab Zeile 866
  (`:866`, `:954`, `:979`, `:997`, `:1035`, `:1126`, `:1157`, `:1198`,
  `:1223`, `:1242`), die dieselbe Datei erneut einlesen statt `src`
  wiederzuverwenden — bei zusätzlich uneinheitlicher Anführungszeichen-Wahl
  ein weiteres Indiz für Copy-Paste ohne Rückblick.

## Beziehungen

- **Verschwistert mit:** [[wissens-duplikate-ohne-ssot]] — dort liegt die
  fachliche Information (Konstante, URL-Schema, Formel) an mehreren Stellen
  ohne SSOT; hier existiert die SSOT bereits als aufrufbarer Helfer und wird
  trotzdem nicht benutzt. Beide Antipatterns erzeugen dieselbe
  Wartungslast (N Stellen statt einer bei jeder Änderung), unterscheiden
  sich aber im Ursprung: fehlende Zentralisierung vs. vorhandene
  Zentralisierung, die ignoriert wird.
- **Wurzelursache (Q1–Q7):** Q4 (DRY) dominiert bei allen Traversal-,
  Sichtbarkeits-, Retry- und Komparator-Belegen — der Helfer war zum
  Zeitpunkt der Duplikation bereits vorhanden und aufrufbar. Beim
  `reserve()`-Fund kommt Q2 hinzu (die Sonderfälle Anker/Rarity-Pick wurden
  vermutlich vor Einführung des Funnels geschrieben und beim Härten der
  Invariante nicht nachgezogen — die Invariante existiert seither nur als
  Kommentar-Vertrag, nicht als erzwungene Struktur). Bei `submitViaApp()`
  ist die Duplikation dagegen die bewusstere Seite von Q1: ein
  "Nicht anfassen ohne Grund"-Pfad wurde eher dupliziert als umgebaut, um
  ihn nicht zu gefährden — das ist an dieser einen Stelle vertretbar,
  entbindet aber nicht davon, den Grund als WARUM-Kommentar (Q6) direkt an
  der Duplikatstelle festzuhalten, statt es implizit zu lassen.
