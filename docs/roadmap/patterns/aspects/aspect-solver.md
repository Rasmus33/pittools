---
slice: solver
analyzed_at: 2026-08-14
iteration: 0
---

# Aspect — solver

Rohaufnahme dessen, was im Code zur Slice tatsächlich vorkommt. Vom
`aspect-analyzer`-Subagent geschrieben (Sonnet, parallel pro Slice).
Wird pro Iteration überschrieben — Git-Log ist die Historie.

Untersuchter Block: `// [SOLVER-BEGIN]` bis `// [SOLVER-END]` in
`ea-fc-sbc-optimizer.user.js:1411-2446` (IIFE `SolverCore`), plus dessen
Extraktion/Nutzung in `solver-test.js` und der Aufrufstelle
`ea-fc-sbc-optimizer.user.js:4811` (`planBatch`) sowie der
Diagnose-Wrapper um `SolverCore.solve` (`:5127-5141`).

## Beobachtetes Pattern: Harte Constraints mit garantiertem Fallback + Pflicht-Warnung statt stillem Scheitern

**Was passiert:** Mehrere Constraints werden zuerst STRIKT versucht; schlägt
das fehl, wird gezielt gelockert und IMMER eine Warnung angehängt (nie
stilles Weiterlaufen, nie kommentarloses Abbrechen). Dasselbe Muster taucht
an mindestens fünf unabhängigen Stellen im Solver auf.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1641-1654` — `solve()` versucht `solveCore(..., limitProtected=true)`, bei Scheitern `limitProtected=false` mit Warnung „Schutz gelockert".
- `ea-fc-sbc-optimizer.user.js:1785-1791` — Bronze/Silber ohne genug normale Karten: Specials werden zugelassen, mit Warnung.
- `ea-fc-sbc-optimizer.user.js:2064-2071` — Rare-Obergrenze (`maxRareRating`) wird gelockert, wenn keine Kandidaten übrig sind, mit Warnung.
- `ea-fc-sbc-optimizer.user.js:2213-2221` — Common-Obergrenze bei Gold-SBCs wird gelockert, wenn zu wenige Commons da sind, mit Warnung.
- `ea-fc-sbc-optimizer.user.js:2391-2395` — `maxExpensiveEnabled`-Beschränkung wird gelockert, wenn `runSearch(exp)` scheitert, mit Warnung.

**Wo das (noch) fehlt:** Keine gegenteiligen Stellen gefunden — das Muster ist konsistent angewendet.

## Beobachtetes Pattern: Config-Werte werden inline am Verwendungsort mit explizitem `!= null`-Fallback aufgelöst

**Was passiert:** Statt Defaults zentral vorzuverarbeiten, liest jede
Stelle den Config-Wert direkt mit `cfg.X != null ? cfg.X : DEFAULT`
unmittelbar dort, wo er gebraucht wird — der Default steht damit neben
seiner fachlichen Begründung (Kommentar).

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1873-1874` — `alpha`/`beta` (Scarcity/Storage-Bonus).
- `ea-fc-sbc-optimizer.user.js:1888` — `guardCost` (Rarity-Schutz-Aufschlag, Default 8).
- `ea-fc-sbc-optimizer.user.js:1898` — `untrBonus` (Untradeable-Rabatt, Default 3).
- `ea-fc-sbc-optimizer.user.js:2054-2056` — `rareCap`/`lowMin` für Rare-Vorgaben ohne Ziel-OVR.
- `ea-fc-sbc-optimizer.user.js:2288-2289` — `windowV` aus `cfg.maxOvershoot` (Default 0.10).

## Beobachtetes Pattern: Testbarkeit über Marker-Extraktion des reinen Rechenkerns statt Duplikat/Modul-Split

**Was passiert:** Der Solver bleibt Teil des einen Userscripts (Deploy-Constraint:
ein File), ist aber zwischen `// [SOLVER-BEGIN]`/`// [SOLVER-END]` klar
abgegrenzt. `solver-test.js` liest die Datei zur Laufzeit ein, extrahiert per
Regex genau diesen Block und führt ihn über `new Function(...)` aus — die
Tests prüfen so den EXAKT ausgelieferten Code, kein separat gepflegtes
Testdouble.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1411` / `:2446` — Marker-Kommentare um die `SolverCore`-IIFE.
- `solver-test.js:10-13` — `src.match(/\/\/ \[SOLVER-BEGIN\]([\s\S]*?)\/\/ \[SOLVER-END\]/)` + `new Function(...)`.
- `solver-test.js:4-5` — Kommentar erklärt explizit das WARUM: „testet GENAU den ausgelieferten Code (kein Duplikat)".
- `CLAUDE.md` (Repo-Struktur-Sektion) — dokumentiert dieselbe Konvention als Vertrag für künftige Solver-Änderungen.

## Beobachtetes Pattern: WARUM-Kommentare mit Live-Zahlen statt Was-Kommentaren (Q6-konform)

**Was passiert:** Kommentare beschreiben durchgehend, WARUM eine
nicht-offensichtliche Entscheidung getroffen wurde, oft mit konkreten
Live-Zahlen/Versionen als Beleg — nicht was der nächste Codeblock tut.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1630-1636` — Warum Rarity-Schutz eine HARTE Grenze ist und nicht über Kosten gelöst wird, mit konkretem Zahlenbeispiel (92er FUTTIES 12.5 vs. Vereins-Gold 13).
- `ea-fc-sbc-optimizer.user.js:1793-1801` — Warum Spieler-Eindeutigkeit pro `assetId` nötig ist (HTTP 460) und die Prioritätsreihenfolge dafür.
- `ea-fc-sbc-optimizer.user.js:2224-2233` — Warum ohne Ziel-Rating ausnahmslos „niedrigstes Rating vor Kosten" gilt, mit Live-Regression-Beleg (v4.25.0, sieben Vereins-77er statt 75er).
- `ea-fc-sbc-optimizer.user.js:2116-2120` — Warum `finishTeam` eine Endkontrolle vor dem Eintragen macht (Live-Vorfall: doppelt belegter Slot, HTTP 460, im Report nicht sichtbar).

## Beobachteter Antipattern: Sortier-Komparator „Storage → Rating → Kosten → Tiebreak" viermal wörtlich dupliziert

**Was schiefläuft:** Derselbe mehrteilige Vergleichsausdruck
`((b.isStorage?1:0)-(a.isStorage?1:0)) || (a.rating-b.rating) || (costOf(a)-costOf(b)) || <tiebreak>`
ist an vier Stellen Zeichen für Zeichen dupliziert (zwei weitere Varianten
ohne den Storage-Teil kommen hinzu). Eine Änderung an der Rangfolge (z.B.
neue Zwischenstufe) müsste an sechs Stellen synchron nachgezogen werden.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1958-1959` — Gemischte Qualitäts-Vorgaben (Bronze/Silber).
- `ea-fc-sbc-optimizer.user.js:2073-2075` — Rarity-Vorgabe, Rare-ohne-Ziel-Variante.
- `ea-fc-sbc-optimizer.user.js:2197-2198` — Gold-SBC Rare-Reservierung ohne Ziel-OVR.
- `ea-fc-sbc-optimizer.user.js:2245-2246` — Auffüll-Karten ohne Ziel-OVR (`fillers`).
- (Varianten ohne Storage-Vorrang, gleiches Muster minus ein Glied) `ea-fc-sbc-optimizer.user.js:1998` und `:2075` (zweiter Zweig desselben Ternary).

**Vermutete Wurzelursache:** Q4 (DRY) — kein gemeinsamer Comparator-Factory
für „Storage-Vorrang + Rating + Kosten + Konsum-Tiebreak", obwohl
`makeConsumeCmp` (Zeile 1422) bereits als Comparator-Factory-Vorbild im
selben Modul existiert und als Vorlage hätte dienen können.

## Beobachteter Antipattern: `reserve()`-Funnel-Invariante wird von Anker- und Rarity-Pick-Pfad umgangen

**Was schiefläuft:** Der Kommentar bei `reserve()` postuliert explizit:
„Jede Reservierung MUSS hierueber laufen: sie fuehrt used und usedAssets
zusammen nach. Zwei Karten desselben Spielers im Team sind HTTP 460." Zwei
Reservierungspfade halten sich nicht daran, sondern inlinen `used.add()` +
`reserved.push()` OHNE `usedAssets.add()` zu pflegen. Aktuell bleibt das
folgenlos, weil vorgelagerte Dedupe-Schritte (`pool`/`poolAll` pro
`assetId`) das Risiko zufällig abfangen — die Invariante ist damit nur
durch eine an anderer Stelle liegende Zufallsbedingung geschützt, nicht
strukturell durch den Code selbst, der laut eigenem Kommentar dafür
zuständig sein soll.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1855-1866` — Kommentar + Definition von `reserve()`, das als einziger erlaubter Weg deklariert wird.
- `ea-fc-sbc-optimizer.user.js:1908-1917` — Anker-Reservierung: `used.add(anchor.id); reserved.push(anchor);` ohne `reserve()`-Aufruf, `usedAssets` bleibt unberührt.
- `ea-fc-sbc-optimizer.user.js:1932-1936` — Manuelle Rarity-Pick-Karte: `used.add(pick.id); reserved.push(pick);` — derselbe Bypass.

**Vermutete Wurzelursache:** Q2/Q4 — die beiden Sonderfälle (Anker,
manueller Rarity-Pick) wurden vermutlich vor oder unabhängig von `reserve()`
geschrieben und beim Einführen des Funnels nicht nachgezogen; die
Invariante existiert nur als Kommentar-Vertrag, nicht als vom Compiler/Code
erzwungene Struktur (z.B. indem `reserved`/`used` privat blieben und nur via
`reserve()` erreichbar wären).

## Beobachteter Antipattern: Kostenformel zwischen Solver und Test-Harness dupliziert, nur per Kommentar synchron gehalten

**Was schiefläuft:** `costOf()` im Solver ist nicht exportiert; die
Brute-Force-Tests bilden dieselbe Formel in `solver-test.js` separat nach.
Die einzige Absicherung gegen Drift ist ein Kommentar, kein Mechanismus
(kein gemeinsamer Import, kein Cross-Check-Test, der beide Implementierungen
gegeneinander auf Zufallsdaten prüft).

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1900-1906` — `costOf(p)` (Original-Formel: Scarcity, Storage-Rabatt, Rarity-Aufschlag, Untradeable-Rabatt).
- `solver-test.js:69` — Kommentar „MUSS synchron zu costOf() im Userscript bleiben - sonst vergleichen die Brute-Force-Tests gegen ein anderes Kostenmodell".
- `solver-test.js:71-88` — `cardCostFn()`, eigenständige Nachbildung derselben Formel.

**Vermutete Wurzelursache:** Q5 (SSOT) — strukturell bedingt durch das
Marker-Extraktionsmodell (Pattern oben): nur was zwischen den SOLVER-Markern
steht, wird exportiert/getestet, `costOf` ist aber eine Closure innerhalb der
IIFE und nicht Teil des öffentlichen `SolverCore`-Objekts. Die Duplikation
selbst ist ein bewusster Kompromiss, aber ohne automatisierte
Drift-Erkennung (z.B. ein Test, der `costOf` und `cardCostFn` auf denselben
Zufallskarten vergleicht) bleibt „MUSS synchron bleiben" reine Disziplin.

## Weak Signals (zu wenige Belege für Pattern-Status)

- `WASTE_WEIGHT` (`ea-fc-sbc-optimizer.user.js:1513`, exportiert `:2443`): definiert und mit ausführlichem Kommentar versehen, aber im gesamten Solver-Block nirgends gelesen/verwendet — die tatsächliche Fenstersteuerung läuft über `windowV`/`cfg.maxOvershoot` (`:2288`). Wirkt wie ein Rest einer abgelösten Gewichtungsstrategie (Q7-Risiko: Kommentar beschreibt einen Mechanismus, der nicht mehr greift).
- `priorityOf` (`ea-fc-sbc-optimizer.user.js:1413`, exportiert `:2440`): wird nur intern von `makeConsumeCmp` (`:1429`) genutzt, aber zusätzlich öffentlich exportiert; kein Aufrufer außerhalb des Moduls und keine Nutzung in `solver-test.js` gefunden — möglicherweise toter Export.
- `warnings.push`-Override zur Dedupe (`ea-fc-sbc-optimizer.user.js:1660-1664`): überschreibt eine Array-Instanzmethode, um doppelte Warnungen zu unterdrücken — ungewöhnlicher Kunstgriff, aber mit klarem WARUM-Kommentar belegt (vermeidet History aus v4.x, wo eine Meldung sechsfach untereinanderstand). Nur eine Fundstelle im Solver.
- `finishTeam`-Endkontrolle (`ea-fc-sbc-optimizer.user.js:2115-2147`): wertvolle Verteidigungsschicht direkt vor der Rückgabe (Duplikat-/Vollständigkeitsprüfung mit Team-Dump für die Diagnose), aber einzige Stelle dieser Art im Solver — noch kein wiederkehrendes Muster innerhalb dieser Slice.

## Zusammenfassung

- 4 Pattern-Kandidaten in dieser Slice
- 3 Antipattern-Kandidaten
- 4 Weak Signals
