---
feature: rating-solver
iteration: 0
score_current:
  RA: 78
score_target:
  RA: 90
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
patterns_required: []
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P3-deferred
effort: M
analyzed_at: 2026-08-15
---

# Lift-Plan — Rating-Solver (Team-Optimierung)

## Marschroute

Nur RA, kein PK-Anteil in dieser Iteration (`pk_files_to_cite: []`,
`citation_only: false`). RA 78 ist bereits `pass` (Schwellwert 66,5) — dieser
Plan ist strukturelle Politur, kein Notfall: vier kleine, unabhängig
testbare Struktur-Refactorings, jedes einzeln verhaltensneutral, in
genau der Reihenfolge, die der Gap-Report empfiehlt (höchster/eindeutigster
Befund zuerst). Die Rating-Formel (`squadRating`/`squadRatingExact`/`squadV`)
und das V-Maß werden an keiner Stelle angefasst — sie sind laut CLAUDE.md
"Nicht anfassen ohne Grund" und in keinem der vier Befunde ursächlich
beteiligt.

Jeder der vier Schritte läuft für sich durch den vollständigen eisernen
Arbeitsablauf aus CLAUDE.md (`node --check`, `node solver-test.js` 180/180,
Version bumpen, Push) — kein gemeinsamer Mega-Commit. Reihenfolge und
Begründung:

1. **`reserve()`-Funnel schließen** (Anker + Rarity-Pick) — zuerst, weil der
   Gap-Report das als Hauptgrund für den RA-Abzug benennt und weil die
   folgenden Schritte (Comparator-Factory, costOf-Extraktion) denselben
   Codeabschnitt anfassen; ein sauberer, getesteter Ausgangszustand an dieser
   Stelle verhindert, dass sich ein späterer Refactor mit einer noch offenen
   Invarianten-Lücke überlagert.
2. **Comparator-Factory** statt vier wörtlicher Duplikate — danach, eigener
   Commit, eigener Snapshot-Test.
3. **`costOf`-SSOT**: `costOf` aus der `solveCore`-Closure zu einer
   modul-weiten Factory `makeCostOf(pool, cfg)` heben, exportieren, und
   `solver-test.js`s manuelle `cardCostFn`-Nachbildung durch einen Aufruf
   dieser Factory ersetzen — danach, weil sie von der in Schritt 1
   unveränderten `costOf`-Signatur profitiert (kein zusätzlicher Merge-Konflikt
   mit dem `reserve()`-Umbau).
4. **`WASTE_WEIGHT`/`priorityOf`-Totcode klären** — zuletzt, weil isoliert und
   risikoärmster Schritt; blockiert nichts vorher.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`reserve()`-Funnel schließen (Anker-Pfad + manueller Rarity-Pick):**
   `ea-fc-sbc-optimizer.user.js:1908-1917` (`used.add(anchor.id);
   reserved.push(anchor);`) und `:1932-1936` (`used.add(pick.id);
   reserved.push(pick);`) jeweils durch `reserve(anchor)` bzw. `reserve(pick)`
   ersetzen, damit `usedAssets` in JEDEM Reservierungspfad nachgeführt wird
   (Vertrag von `reserve()` selbst, `:1855-1866`: "Jede Reservierung MUSS
   hierueber laufen").
   - **Reihenfolge laut CLAUDE.md/Q2:** ZUERST einen neuen, per Brute-Force
     verifizierten Testfall in `solver-test.js` schreiben, der Anker und
     manuellen Rarity-Pick mit KOLLIDIERENDER `assetId` konstruiert (zwei
     Pool-Einträge, verschiedene `id`, gleiche `assetId` — heute durch die
     vorgelagerte Pool-Dedupe zufällig verdeckt) und der VOR dem Umbau prüft,
     dass der jetzige Code sich nur zufällig richtig verhält bzw. NACH dem
     Umbau strukturell dedupliziert/ablehnt statt sich auf die Dedupe an
     anderer Stelle zu verlassen. `node solver-test.js` muss vor UND nach dem
     Umbau grün sein (180/180 + 1 neuer Test).
   - **Edge-Case (aus Gap-Report):** vor dem Umbau prüfen, ob `planBatch`/
     `usedIds` (`:2431`) implizit auf die Art der Reservierung (manuell vs.
     `reserve()`) oder auf Objekt-Identität in `reserved` angewiesen ist —
     ein reiner Funnel-Wechsel darf diese Unterscheidung nicht verwischen.
   - **Diagnose-Ergänzung (RA-Rubric "Beobachtbarkeit"):** einen Zähler/eine
     Warnung einbauen, die sichtbar macht, wenn der neu erzwungene Funnel
     tatsächlich eine `assetId`-Kollision am Anker- oder Rarity-Pick-Pfad
     abfängt (z.B. Eintrag in `warnings` oder ein Feld im Diagnose-Report) —
     bisher gäbe es dafür keinerlei Log-Spur, obwohl es der einzige Pfad ist,
     der HTTP 460 strukturell verhindert.
   - Pfad: `ea-fc-sbc-optimizer.user.js` (SOLVER-Block, `:1908-1917`,
     `:1932-1936`), neuer Test + ggf. Diagnose-Assertion in `solver-test.js`.
   - Erwarteter Gain: **+6 bis 8 Pt RA.**

2. **Comparator-Factory nach Vorbild `makeConsumeCmp` (`:1422`) extrahieren:**
   Neue Factory (Arbeitsname `makeFillCmp`) kapselt den Ausdruck
   `((b.isStorage?1:0)-(a.isStorage?1:0)) || (a.rating-b.rating) ||
   (costOf(a)-costOf(b)) || <tiebreak>` und ersetzt die vier wörtlichen
   Duplikate bei `:1958-1959`, `:2073-2075`, `:2197-2198`, `:2245-2246`.
   - **Wichtige Randbedingung, per Read bestätigt:** die vier Stellen nutzen
     NICHT denselben Tiebreak-Comparator — `:1958-1959` und `:2073-2075`
     schließen mit `reserveCmp` (`= makeConsumeCmp(pool)`, `:1854`), `:2197-2198`
     und `:2245-2246` mit `cmp` (`= makeConsumeCmp(avail)`, `:2107`) ab, weil
     `pool` und `avail` unterschiedliche (gefilterte) Kartenmengen sind. Die
     Factory MUSS den Tiebreak-Comparator (bzw. die Quelliste dafür) als
     Parameter nehmen — ein hartkodierter gemeinsamer Tiebreak würde an zwei
     der vier Stellen eine andere Reihenfolge erzeugen als heute (stille
     Verhaltensänderung).
   - Verhaltensneutralität: Snapshot-Vergleich der Sortierreihenfolge
     (nicht nur aggregiertes V/Kosten-Ergebnis) auf Fixtures mit
     Kosten-/Rating-Gleichständen, VOR und NACH dem Refactor, plus
     `node solver-test.js` 180/180 vorher = nachher.
   - Pfad: `ea-fc-sbc-optimizer.user.js` (neue Factory nahe `:1422`, vier
     Call-Sites), neuer Snapshot-Test in `solver-test.js`.
   - Erwarteter Gain: **+5 bis 7 Pt RA.**

3. **`costOf` als SSOT-Factory statt manueller `cardCostFn`-Kopie im Test:**
   `costOf` (`ea-fc-sbc-optimizer.user.js:1900-1906`, aktuell eine Closure
   innerhalb von `solveCore`, abhängig von `pool`/`cfg`-lokalen Variablen wie
   `countByRating`, `alpha`, `beta`, `guardCost`, `guardGroups`, `untrBonus`)
   zu einer modul-weiten Funktion `makeCostOf(pool, cfg)` heben, die exakt
   dieselbe Berechnung als benannte, exportierte Factory kapselt; `solveCore`
   ruft `const costOf = makeCostOf(pool, cfg);` an derselben Stelle auf statt
   die Closure inline zu definieren (reiner Hoist, keine Logik-Änderung).
   `SolverCore.makeCostOf` wird im Rückgabeobjekt (`:2434-2444`) exportiert.
   `solver-test.js` ersetzt seine eigenständige Nachbildung `cardCostFn`
   (`:71-88`, inkl. des Kommentars „MUSS synchron zu costOf() im Userscript
   bleiben" `:69`) durch `SolverCore.makeCostOf(pool, c)` an den zwei
   Aufrufstellen `bruteBest` (`:97`) und `solverObjective` (`:127`) —
   `cardCostFn` entfällt vollständig. Das schließt den Drift-Vektor
   strukturell (Q5/SSOT) statt ihn nur zusätzlich per Kommentar-Disziplin zu
   behaupten: Test und Solver rechnen danach nachweislich mit demselben Code,
   nicht nur mit demselben Kommentar-Versprechen. Die Brute-Force-Enumeration
   selbst bleibt unabhängig (eigene Rekursion in `bruteBest`) — nur die
   Kosten-DEFINITION wird geteilt, was dem Zweck der Brute-Force-Prüfung
   (unabhängige SUCHE, gleiche Kosten-Wahrheit) nicht widerspricht.
   - Verhaltensneutralität: `node solver-test.js` 180/180 vor und nach dem
     Umbau; da `makeCostOf` numerisch identisch zur bisherigen Closure ist
     (reiner Hoist), darf sich an keinem bestehenden Testergebnis etwas
     ändern — jede Abweichung wäre ein Hinweis auf eine bisher unbemerkte
     Diskrepanz zwischen `costOf` und `cardCostFn` und muss vor dem Merge
     aufgeklärt werden, nicht wegdiskutiert.
   - Pfad: `ea-fc-sbc-optimizer.user.js:1900-1906` (Extraktion + Export),
     `solver-test.js:69-88`, `:97`, `:127` (Ersatz von `cardCostFn`).
   - Erwarteter Gain: **+4 bis 6 Pt RA.**

4. **`WASTE_WEIGHT`/`priorityOf`-Totcode klären (entfernen, mit Beleg):**
   Per Grep in beiden primary_paths bestätigt: `WASTE_WEIGHT`
   (`:1513`, exportiert `:2443`) hat KEINEN Leser im gesamten Solver-Block
   (Fenstersteuerung läuft nachweislich über `windowV`/`cfg.maxOvershoot`,
   `:2288-2289`) und keinen Leser in `solver-test.js`. `priorityOf`
   (`:1413`, exportiert `:2440`) wird nur intern von `makeConsumeCmp`
   (`:1429`) gebraucht; der EXPORT hat keinen Aufrufer außerhalb des Moduls.
   Entscheidung: **entfernen statt behalten** — beide sind nachweislich tot,
   ein künstlicher Verwendungsgrund würde nur erfunden. Konkret:
   - `WASTE_WEIGHT`-Konstante (`:1513`) UND Export (`:2443`) vollständig
     entfernen.
   - `priorityOf`-EXPORT (`:2440`) entfernen; die Funktion selbst bleibt
     (wird intern von `makeConsumeCmp` gebraucht), wird aber nicht mehr Teil
     der öffentlichen `SolverCore`-API.
   - Danach `node solver-test.js` 180/180 (kein Test referenziert
     `SolverCore.WASTE_WEIGHT` oder `SolverCore.priorityOf` — vorab per Grep
     bestätigen, nicht nur annehmen).
   - Pfad: `ea-fc-sbc-optimizer.user.js:1513`, `:2440`, `:2443`.
   - Erwarteter Gain: **+2 bis 3 Pt RA.**

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | 1 (`reserve()`-Funnel schließen), 2 (Comparator-Factory), 3 (`makeCostOf`-Extraktion), 4 (Totcode entfernen) — jeweils der Code-Teil im SOLVER-Block |
| diagnose | Teil von 1: Diagnose-/Warnungs-Ergänzung, die eine tatsächlich abgefangene Anker-/Rarity-Pick-Kollision sichtbar macht |
| tests | Teil von 1: neuer Brute-Force-Testfall (kollidierende `assetId`); Teil von 2: Snapshot-Test auf exakte Sortierreihenfolge bei Gleichstand; Teil von 3: Ersatz von `cardCostFn` durch `SolverCore.makeCostOf` in `bruteBest`/`solverObjective`; Teil von 4: Grep-Bestätigung + Testlauf ohne Referenzen auf die entfernten Exports |
| docs | `docs/LEARNINGS.md`-Eintrag: reserve()-Funnel jetzt strukturell erzwungen (nicht mehr nur Kommentar-Vertrag), Comparator-Factory als kanonischer Weg, `costOf`/`makeCostOf` als einzige Kostenwahrheit, `WASTE_WEIGHT`/`priorityOf`-Export entfernt (mit Grund) |
| release | Pro Schritt einzeln: `@version`/`VERSION`-Bump, Push auf `main` (= Deployment) — vier kleine Releases statt eines großen |

## Shared-Item-Bedarf

Kein Shared-Item in dieser Iteration. Geprüft und verworfen:

- **Test-Extraktions-Helfer (`solver-test.js`s Regex-Marker-Extraktion vs.
  `app/guard-test.js`s `extractGuard()`):** beide Mechanismen wurden gelesen
  (`solver-test.js:10-13` — ein Einzeiler-Regex zwischen zwei Kommentar-
  Markern; `app/guard-test.js:24-44` — `indexOf`/`substring`-Bereichssuche
  über Java-String-Literale MIT anschließendem `unescapeJava`). Die
  Extraktionslogik ist grundverschieden (JS-Kommentar-Regex vs.
  Java-Literal-Rekonstruktion mit Unescaping) und `solver-test.js`s Teil ist
  bereits ein Einzeiler — eine gemeinsame Abstraktion würde keine reale
  Duplikation entfernen, sondern nur eine Indirektion über zwei
  unterschiedliche Probleme legen (Q1: kein Nutzen, nur Risiko). Kein
  SI-Kandidat.
- **`makeCostOf`/Comparator-Factory:** beide bleiben vollständig innerhalb
  von `ea-fc-sbc-optimizer.user.js` (SOLVER-Block) und werden nur von
  `solver-test.js` konsumiert — beides liegt in `primary_paths` von
  `rating-solver`, kein zweites Feature betroffen, daher kein
  Cross-Feature-SI.

`<feature>.shared-items.json` ist entsprechend eine leere Liste.

## Risiken / Edge-Cases

- **`planBatch`/`usedIds`-Reihenfolgeabhängigkeit (Aktion 1):** vor dem
  Schließen des `reserve()`-Funnels prüfen, ob `usedIds`-Tracking bei
  `:2431` implizit auf die Art der Reservierung oder auf Objekt-Identität in
  `reserved` angewiesen ist. Ein scheinbar kosmetischer Fix darf hier keine
  echte Verhaltensänderung an `planBatch` auslösen.
- **Sortierstabilität bei Kosten-Gleichstand (Aktion 2):** bestehende
  Brute-Force-Tests prüfen nur aggregiertes V/Kosten-Ergebnis, nicht WELCHE
  von zwei exakt kostengleichen Karten gewählt wird. Ohne das in der
  Aktionsbeschreibung geforderte Snapshot-Fixture (exakte `id`/`assetId`
  statt nur Summen) könnte die Factory-Extraktion bei Gleichstand eine
  andere, laut Aggregat weiterhin "korrekte" Karte wählen, ohne dass ein Test
  das bemerkt.
- **`reserveCmp` vs. `cmp` (Aktion 2):** die vier Duplikate schließen NICHT
  alle mit demselben Tiebreak-Comparator ab (`makeConsumeCmp(pool)` an zwei
  Stellen, `makeConsumeCmp(avail)` an den anderen zwei). Eine Factory, die
  den Tiebreak hartkodiert statt als Parameter zu nehmen, wäre KEINE
  verhaltensneutrale Extraktion.
- **Bronze/Silber ignoriert `minRating` bewusst (Produktregel, CLAUDE.md):**
  die gemischten Qualitäts-Vorgaben (`qTiers`, `:1945-1968`) nutzen `costOf`
  genauso wie die Gold-Pfade, aber KEINE `minRating`- oder
  Rarity-Gruppen-Logik. Beim Extrahieren der Comparator-Factory (Aktion 2)
  darf keine neue Kopplung entstehen, die diese Logik versehentlich in den
  Bronze/Silber-Zweig hineinzieht.
- **Reihenfolge der vier Schritte:** Aktion 1 zuerst und einzeln committen/
  pushen, bevor Aktion 2/3 denselben Codeabschnitt anfassen — reduziert das
  Risiko, dass ein fehlgeschlagener Test nicht eindeutig einer der vier
  Änderungen zugeordnet werden kann. Kein Big-Bang-PR (Gap-Report-Empfehlung
  "vorsichtig, in kleinen, unabhängig testbaren Schritten").
- **Mid-Iter-Einschub (Klasse G):** nicht zu erwarten — alle vier Aktionen
  bleiben vollständig innerhalb der zwei `primary_paths`-Dateien, kein
  zweites Feature ist beteiligt.

## Lift-Plan-Pre-Validation (M2)

`score_target.RA = 90` entspricht der Ambitions-Regel M3
(`78 + (95 - 78) * 0.7 ≈ 89,9 → 90`, `ceiling = structural_max` da RA keinen
PK-artigen Ceiling-Begriff hat). Kein PK-Anteil (`pk_files_to_cite: []`,
`citation_only: false`) — `plan estimate` schätzt RA hier per Reasoning
(manual_rubric-Adapter, kein deterministischer PK-Bruch).
