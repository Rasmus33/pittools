---
feature: rating-solver
analyzed_at: 2026-08-16
iteration: 10
regression: false
score_current:
  RA: 93
score_target:
  RA: 94-95
---

# Gap-Report — Rating-Solver — Iteration 10 (Produktregel-Gate-Abdeckungs-Audit)

**Sonderauftrag, kein normaler Dimensions-Gap-Lauf.** Anlass: LEARNINGS §47
(16.08., v4.67.0) — die TOTW-Ausnahme "Verein-Specials NIE außer TOTW" stand
im Reservierungs-Filter (`reservationCandidates`), fehlte aber im
allgemeinen `specialOnlyFromStorage`-Filter in `solveCore`. Der Auftrag: für
JEDE Produktregel aus `CLAUDE.md` § "Produkt-Regeln" alle Code-Gates finden,
die sie durchsetzen (müssten), und pro Gate feststellen, ob ein
Verhaltens-Test existiert — um genau diese Fehlerklasse ("Regel an Gate A
umgesetzt, an Gate B vergessen") systematisch zu jagen statt nur den
Anlass-Fall selbst zu bestätigen.

**Reproduktion (Stand v4.69.0):** `node --check ea-fc-sbc-optimizer.user.js`
sauber, `node solver-test.js` → **775/775 grün**. Kein Code editiert (Auftrag:
Bash nur zur Score-Reproduktion).

**Ehrliches Ergebnis vorweg:** 14 Produktregeln mit Solver-Bezug geprüft.
**10 davon vollständig gedeckt** (jedes berührte Gate identifiziert, jedes
Gate mit Verhaltenstest belegt, keine Regel-Lücke gefunden — davon 9 über
Code-Gates und 1 über eine Architektur-Abwesenheit ohne durchsetzbares Gate).
**4 haben eine kleine Test-Lücke an einem ansonsten korrekt implementierten
Gate. 0 echte Gate-Lücken** (keine Regel fehlt komplett an einem Berührungspunkt,
den sie eigentlich betreffen müsste — der Anlass-Fall selbst ist an allen vier
bekannten TOTW-Berührungspunkten, `solveCore`-Filter, `reservationCandidates`,
`computeRarityAvailability`, `makeCostOf`, konsistent und regressionsgetestet).
Das ist der eigentliche Wert dieses Audits: eine begründete
"keine Drift gefunden"-Aussage statt eines erzwungenen Fundes.

## Regel-Gate-Matrix

Nummerierung folgt `CLAUDE.md` § "Produkt-Regeln (von Rasmus, gelten immer)"
in Lesereihenfolge; R14 (`planBatch()`) liegt zwar in einem anderen
CLAUDE.md-Absatz ("Batch-Modus darf abgeben"), aber der planungsrelevante
Teil sitzt IM Solver-Block und gehört daher hier hinein — die
challengeId/staleRecover-Mechanik selbst liegt außerhalb des Solver-Blocks
und ist damit außerhalb dieses Audits.

### R1 — Gold ohne Ziel-OVR: genau N Rare, Rest Common, Obergrenzen

**Regel:** "Gold-SBCs ohne Ziel-OVR: GENAU so viele Rare wie gefordert, Rest
Common — ohne Rare-Vorgabe gar keine Rare." + Panel-Obergrenzen (Rare/Common).

| Gate | Datei:Zeile | Test |
|---|---|---|
| Gold-Zweig ohne Ziel (`needRare`/`gotRare`/Common-Fill) | `ea-fc-sbc-optimizer.user.js:2971-3017` | `solver-test.js:846-899` |
| Rare-Vorgabe ohne Ziel, `rareCap`/`lowMin` in `rcList`-Schleife | `ea-fc-sbc-optimizer.user.js:2847-2865` | `solver-test.js:899-982` |

**Status: GEDECKT.** Alle Fälle live-nah getestet: keine Rare ohne Vorgabe
(846), exakt N Rare (860), Obergrenze respektiert und bei Bedarf gelockert
mit Warnung (862/883), niedrigste Rare zuerst (865), Common-Grenze hält hohe
Commons draußen (891).

### R2 — Gemischte Qualitäts-Vorgaben (Bronze + Silber gemischt)

**Regel:** Quote pro Stufe, günstigste Karten je Stufe; EAs Anzahl gilt als
Minimum, Rest wird gleichmäßig verteilt, Überhang an die niedrigste Stufe;
Mehrliefern bei "Min. N" unschädlich.

| Gate | Datei:Zeile | Test |
|---|---|---|
| `qTiers`-Konstruktion + Rest-Verteilung | `ea-fc-sbc-optimizer.user.js:2137-2183` | `solver-test.js:1144-1214` (teilweise) |
| `qTiers`-Reservierungsschleife | `ea-fc-sbc-optimizer.user.js:2699-2727` | `solver-test.js:1165-1182` |
| `inQBand`-Prädikat (nicht-durchgehendes Fenster) | `ea-fc-sbc-optimizer.user.js:2212-2214` | `solver-test.js:1171` (indirekt) |

**Status: TEST-LÜCKE.** Das einzige Testszenario (`MIXED`, Zeile 1152-1157)
hat `count:1`/`count:1` auf `N=10` — ein **geradzahliger** Rest (8 Slots ohne
Angabe → 4/4 Basisanteil + 0 Rest). Die Rundungslogik selbst
(`ea-fc-sbc-optimizer.user.js:2163-2168`: `base = floor((N-stated)/tiers.length)`,
Restverteilung beginnt bei der NIEDRIGSTEN Stufe) ist für einen **ungeraden**
Rest oder **mehr als zwei** Stufen nirgends geprüft — der Code ist generisch
für beliebig viele Stufen geschrieben (`tiers.length`-Schleife), aber nur der
2-Stufen/geraden-Rest-Fall ist belegt. Kein bekannter Live-Fall mit 3 Stufen
oder ungeradem Rest, aber die Regel selbst ("Rest an die niedrigste Stufe")
ist eine der präzisesten in CLAUDE.md — ein Regressions-Bug hier (z.B.
Restverteilung an die HÖCHSTE statt niedrigste Stufe) würde von keinem Test
bemerkt.

### R3 — Bronze-/Silber-Vorgaben: niedrigste normale Karten

**Regel:** Niedrigste normale (kein Evo, kein Special) Karten, rare/non-rare
egal; Min-Rating wird bei Bronze/Silber komplett ignoriert, bei Gold bleibt
es Untergrenze.

| Gate | Datei:Zeile | Test |
|---|---|---|
| `qLo`/`qHi`/`qualityLow`-Berechnung (Single-Tier) | `ea-fc-sbc-optimizer.user.js:2185-2203` | `solver-test.js:748-782` |
| `plain`-Filter (kein Special als Vorgabe-Karte) | `ea-fc-sbc-optimizer.user.js:2229-2236` | `solver-test.js:757-764` |

**Status: GEDECKT.** Bronze: Min-Rating-Ignoranz + niedrigster normaler Pick
(748-757), Special-Fallback mit Warnung bei Mangel (762-764), Silber
(65-74-Fenster, 772), Gold behält Min-Rating als Untergrenze (782). Deckt
auch die Kombination mit `isEvolution()` implizit ab (Evos verlassen den Pool
schon beim Laden, R9).

### R4 — Nur Team-Rating zählt (Chemie/Position/Belohnung ignoriert)

**Regel:** "Es zählt NUR das Team-Rating. Chemie, Positionen,
SBC-Belohnungslogik: bewusst ignoriert."

**Status: GEDECKT durch Abwesenheit.** Kein Chemie-/Positions-/
Belohnungs-Code im gesamten Solver-Block (`grep` nach `chemistry`/`position`/
`formation` im SOLVER-Bereich: keine Treffer) — die Regel ist eine
Architektur-Entscheidung, kein durchsetzbares Gate. Kein Test nötig; ein
künftiger PR, der versehentlich Chemie-Logik einführt, würde als reiner
Code-Review-Fund auffallen, nicht als Solver-Gate-Lücke.

### R5 — Minimales exaktes Dezimal-Rating, Kosten entscheiden im Fenster

**Regel:** Minimales Rating über Ziel, innerhalb "Max. Rating-Überschuss"
entscheiden die Karten-Kosten.

| Gate | Datei:Zeile | Test |
|---|---|---|
| `windowV`-Berechnung | `ea-fc-sbc-optimizer.user.js:2379-2380` | `solver-test.js:1897-1912` |
| `searchTeam()` Fenster-Auswahl (`bestByV`/`chosen`) | `ea-fc-sbc-optimizer.user.js:2519-2544` | `solver-test.js:224-307` (40x Brute-Force) |
| `reserveWindowAware()` globales-Minimum-Pass 1/2 | `ea-fc-sbc-optimizer.user.js:2613-2694` | `solver-test.js` Abschnitt 8/8b (Rarity-Fenster-Tests) |

**Status: GEDECKT.** Die am schärfsten getestete Regel im gesamten Solver —
40x randomisierte Brute-Force-Parität gegen `SolverCore.solve()`
(`solver-test.js:224-307`) plus dediziertes Fenster-Test-Paar ("Überschuss
bleibt im Fenster" / "95er werden geschont", Zeile 1907-1911).

### R6 — Karten-Prioritäten (Storage-Gold → Storage-Special → Verein-Gold) + TOTW-Ausnahme

**Regel:** "Karten-Prioritäten: Storage-Gold → Storage-Special →
Verein-Gold. Verein-Specials NIE in SBCs — einzige Ausnahme: TOTW
(rareflag 3)." **Das ist die Regel aus dem Anlass-Fall.**

| Gate | Datei:Zeile | Test |
|---|---|---|
| `priorityOf()` (Konsum-Reihenfolge 1/2/3/4) | `ea-fc-sbc-optimizer.user.js:1713-1718` | `solver-test.js:310-316` (1v3), `1133-1141` (3v4) |
| `specialOnlyFromStorage`-Filter in `solveCore` + TOTW-Ausnahme | `ea-fc-sbc-optimizer.user.js:2216-2224` | `solver-test.js:432-442` (Test 8), `5412-5439` (Test 60d, Live-Bug-Regression) |
| `reservationCandidates()` + TOTW-Ausnahme | `ea-fc-sbc-optimizer.user.js:1907-1918` | `solver-test.js:4751-4849` (Ticket 68), `432-442` |
| `computeRarityAvailability()` (Panel-Anzeige) | `ea-fc-sbc-optimizer.user.js:3125-3155` | `solver-test.js:4788-4791` (Vereins-FUTTIES ausgeschlossen, Vereins-TOTW bleibt Kandidat) |
| `makeCostOf()` TOTW-Wertgleichheit (Bänder ignoriert) | `ea-fc-sbc-optimizer.user.js:1862-1874` | `solver-test.js:5339-5382` (Test 60a/60b) |

**Status: GEDECKT — inkl. des historischen Bug-Gates.** Alle vier bekannten
Berührungspunkte der TOTW-Ausnahme sind konsistent implementiert UND mit
eigenem Regressionstest abgesichert; `solver-test.js:5412-5439` ist exakt der
Live-Fall aus LEARNINGS §47 nachgebaut (Verein-TOTW bleibt nutzbar,
Verein-FUTTIES bleibt tabu, bei aktivem `specialOnlyFromStorage`). **Eine
kleine Test-Lücke bleibt:** `priorityOf()`s Stufe 2 (Storage-Special) wird nie
isoliert bewiesen — Test 5 (Zeile 310-316) beweist nur Stufe 1 vs. 3
(Storage-Gold vor Verein-Gold), Test 8b-2f (1133-1141) nur Stufe 3 vs. 4
(Verein-Gold vor Verein-Special). Dass Storage-Special (Stufe 2) tatsächlich
vor Verein-Gold (Stufe 3) konsumiert wird, folgt nur aus der Codelogik
(`priorityOf` gibt 2 vor 3 zurück), nicht aus einem Verhaltenstest — bei
einer versehentlichen Vertauschung der Stufen 2/3 (z.B. Copy-Paste-Fehler in
`priorityOf`) würde kein bestehender Test anschlagen, weil kein Testfall
einen Pool mit gleich-ratigem Storage-Special UND Verein-Gold gleichzeitig
zur Konsum-Entscheidung stellt.

### R7 — Ohne Ziel-Rating: Storage vor Verein, dann niedrigstes Rating, dann Kosten

**Regel:** LEARNINGS §15/§17 — feste Rangfolge ohne Ziel-OVR.

| Gate | Datei:Zeile | Test |
|---|---|---|
| `makeFillCmp()` (Storage → Rating → Kosten → Tiebreak) | `ea-fc-sbc-optimizer.user.js:1739-1744` | `solver-test.js:922-982` |
| Verwendung in Gold-Rare-Reservierung ohne Ziel | `ea-fc-sbc-optimizer.user.js:2862-2865, 2991-2993` | `solver-test.js:865, 922-932` |
| Verwendung im Auffüll-Schritt ohne Ziel | `ea-fc-sbc-optimizer.user.js:3039` | `solver-test.js:978-982` |
| Verwendung in `qTiers`-Reservierung | `ea-fc-sbc-optimizer.user.js:2712` | `solver-test.js:1175-1179` |

**Status: GEDECKT.** Vier Call-Sites, alle vier über dieselbe Factory
(`makeFillCmp`, SSOT) — kein Duplikat-Risiko. Jede Call-Site hat mindestens
einen direkten Test; die Kernaussage ("77er Storage vor 75er Verein", "kein
77er Verein ohne Not") ist an mehreren Stellen wörtlich reproduziert (922,
932, 978, 982).

### R8 — Unverkäufliche Karten zuerst (Default-Rabatt 3)

| Gate | Datei:Zeile | Test |
|---|---|---|
| `untrBonus`-Berechnung + Anwendung in `costOf()` | `ea-fc-sbc-optimizer.user.js:1858-1859, 1874` | `solver-test.js:673-684` |

**Status: GEDECKT.** Bonus wirkt (673), abschaltbar (677), überstimmt das
Ziel-Rating nicht (684 — wichtige Abgrenzung, dass der Rabatt nur ein
Tiebreak innerhalb des gültigen Fensters ist).

### R9 — Evolutions niemals verbauen

| Gate | Datei:Zeile | Test |
|---|---|---|
| `isEvolution()` | `ea-fc-sbc-optimizer.user.js:1027-1041` | `solver-test.js:1590-1613` (mehrere raw-Formen) |
| Aufruf in `normalizePlayer()` (einziger Gate, SSOT) | `ea-fc-sbc-optimizer.user.js:1052` | `solver-test.js:1608-1613` (inkl. `evoExcluded`-Zähler) |

**Status: GEDECKT — strukturell driftfrei.** `isEvolution()` läuft ausschließlich
beim Pool-Laden (Club UND Storage nutzen `normalizePlayer()`), es gibt keinen
zweiten Lade-Pfad, der ihn umgehen könnte — anders als bei der TOTW-Regel gibt
es hier nur EIN Gate, kein Drift-Risiko zwischen zwei Implementierungen.

### R10 — Gesperrte Karten (PaleTools) niemals verbauen, auch nicht als Anker/Vorgabe

| Gate | Datei:Zeile | Test |
|---|---|---|
| `isLockedOut()` / `filterLockedCards()` | `ea-fc-sbc-optimizer.user.js:1919-1940` | `solver-test.js:797-820` |
| Aufruf in `solveCore()` (VOR Anker/Vorgabe) | `ea-fc-sbc-optimizer.user.js:2208` | `solver-test.js:810` (Anker), `820` (Rarity-Vorgabe) |
| Aufruf in `computeRarityAvailability()` | `ea-fc-sbc-optimizer.user.js:3126-3127` | `solver-test.js:4801-4808` |

**Status: GEDECKT.** SSOT-Funktion an beiden Anwendungspunkten (Ticket #68
hat das explizit vereinheitlicht, LEARNINGS §45) — dasselbe Muster, das beim
TOTW-Fall gefehlt hatte, ist hier von Anfang an als gemeinsame Funktion
gebaut worden.

### R11 — Rating-Kosten-Tabelle (Default-Bänder + localStorage-Persistenz)

| Gate | Datei:Zeile | Test |
|---|---|---|
| `DEFAULT_RATING_COST_SPEC` | `ea-fc-sbc-optimizer.user.js:1794` | `solver-test.js:1933-1943` |
| `parseRatingCosts()` | `ea-fc-sbc-optimizer.user.js:1803-1820` | `solver-test.js:1933-1943`, `2360-2367` (Lang-/Kurzform-Äquivalenz) |
| Panel-Reset-Ableitung (Drift-Wächter) | `ea-fc-sbc-optimizer.user.js:4157-4176` | statischer Beleg im selben Testblock |

**Status: GEDECKT.** Die Default-Tabelle stimmt exakt mit CLAUDE.mds
Vorgabe überein (0-80:0, 81-83:2, 84:1, 85-88:2, 89-90:3, 91-92:4, 93+:12),
ein Test prüft das wörtlich; ein zweiter verhindert Drift zwischen Panel und
Solver-Konstante.

### R12 — Rarity-Schutz (HART, Gruppe 83): genau N, sonst gesperrt, Aufschlag +8

| Gate | Datei:Zeile | Test |
|---|---|---|
| `isProtectedRarity()` in `makeCostOf()` | `ea-fc-sbc-optimizer.user.js:1846-1853, 1873` | `solver-test.js:468-491` |
| `solve()` strict/loose Doppel-Versuch | `ea-fc-sbc-optimizer.user.js:2063-2109` | `solver-test.js:620-660` |
| `limitProtected`-Filter auf `avail` | `ea-fc-sbc-optimizer.user.js:2892` | `solver-test.js:475-490` (ohne Vorgabe keine Karte), `627-650` (mit Vorgabe genau N, Brute-Force-verifiziert) |

**Status: TEST-LÜCKE (klein).** Kern-Mechanik (hart ohne Vorgabe, genau N mit
Vorgabe, Lockerung bei Unlösbarkeit mit Warnung) ist umfassend und sogar
Brute-Force-verifiziert getestet (`bestWithProtected()`, Zeile 620-660). Was
fehlt: ein isolierter `makeCostOf()`-Test, der beweist, dass der
`rarityGuardCost`-Aufschlag (+8) TATSÄCHLICH einen messbaren Kostenunterschied
zwischen einer geschützten und einer sonst identischen ungeschützten Karte
erzeugt — der einzige Test mit `rarityGuardCost` UND einer TOTW/Gruppe-83-Karte
gleichzeitig (`solver-test.js:5339-5357`, Test 60a) vergleicht zwei TOTW
untereinander, wo sich der Aufschlag in der Differenz weghebt (beide
geschützt). CLAUDE.md sagt explizit "Kosten-Aufschlag wirkt zusätzlich
innerhalb des Erlaubten" — dieser Zusatz-Effekt ist nur indirekt über die
"HARTE Grenze" bewiesen (die überstimmt den Aufschlag ohnehin), nicht direkt
über den Kostenwert selbst.

### R13 — TOTW sind wertgleich (neue Produktregel v4.67.0, LEARNINGS §47)

**Regel:** Rating-Kosten-Bänder gelten für TOTW nicht; nur `rating/1000` als
minimaler Tiebreak; Scarcity/Storage-Rabatt/Untradeable-Bonus/Rarity-Schutz
wirken unverändert.

| Gate | Datei:Zeile | Test |
|---|---|---|
| `isTotw(p) ? (p.rating/1000) : bandFn(p.rating)` in `costOf()` | `ea-fc-sbc-optimizer.user.js:1862-1874` | `solver-test.js:5339-5357` (Test 60a) |
| Greedy-Reservierung ohne Ziel nimmt niedrigeren TOTW | (nutzt denselben `costOf`) | `solver-test.js:5358-5381` (Test 60b) |
| Fensterbewusste Reservierung mit Ziel (`reserveWindowAware`) | (nutzt denselben `costOf`) | `solver-test.js:411-431` (Test 8, "85er TOTW gewinnt trotz teurem Band") |

**Status: TEST-LÜCKE (klein).** Die Bänder-Ignoranz selbst ist von allen
Seiten bewiesen (Kostenformel direkt, Greedy-Pfad, Fenster-Pfad). Was laut
CLAUDE.md/Kommentar (`ea-fc-sbc-optimizer.user.js:1869`) "unverändert" bleiben
soll — Storage-Rabatt UND Untradeable-Bonus UND Scarcity gemeinsam auf EINE
TOTW-Karte angewendet — hat keinen eigenen Test: alle TOTW-Testkarten in
Abschnitt 60 sind `isStorage: false, untradeable: false` (Zeile 5342-5345,
5363-5365, 5418-5420). Ein Regressionsbug, der versehentlich den
Storage-Rabatt oder Untradeable-Bonus NUR für TOTW deaktiviert (z.B. ein zu
früh gesetztes `return` im `isTotw`-Zweig, der die nachfolgenden
`isStorage`/`untradeable`-Terme in `costOf()` überspringt), würde von keinem
bestehenden Test bemerkt.

### R14 — Batch-Planung: jede Runde ohne Vorrunden-Karten, ehrlicher Abbruch

**Regel:** "Batch-Modus darf abgeben" — `planBatch()` rechnet jede Runde ohne
die bereits verbauten Karten, bricht bei erster Unlösbarkeit ab und liefert
das Teilergebnis ehrlich statt eine falsche SBC abzugeben.

| Gate | Datei:Zeile | Test |
|---|---|---|
| `planBatch()` | `ea-fc-sbc-optimizer.user.js:3089-3113` | `solver-test.js:694-727` |

**Status: GEDECKT.** Keine Karte doppelt über Runden (697), jede Runde
erreicht das Ziel (699), `usedIds` deckt alle Runden ab (702), Abbruch wird
gemeldet mit `stoppedReason` (707), `requested` bleibt erhalten für die
Anzeige "N von M" (709), Rarity-Vorgabe wird pro Runde einzeln durchgesetzt
(719) und stoppt korrekt, wenn keine Kandidaten mehr da sind (726-727). Die
challengeId-/staleRecover-Logik selbst liegt außerhalb `[SOLVER-BEGIN]` und
ist damit außerhalb dieses Audits (separates Feature `batch-modus`).

## Zusammenfassung der Matrix

| # | Regel | Gates gefunden | Gate-Lücke (Regel fehlt an einem Gate) | Test-Lücke |
|---|---|---|---|---|
| R1 | Gold-Rare-Quote ohne Ziel | 2 | keine | keine |
| R2 | Gemischte Qualitäts-Vorgaben | 3 | keine | ungerader Rest/>2 Stufen ungetestet |
| R3 | Bronze/Silber niedrigste Karte | 2 | keine | keine |
| R4 | Nur Rating zählt | — (Architektur) | n/a | n/a |
| R5 | Minimales Dezimal-Rating im Fenster | 3 | keine | keine |
| R6 | Karten-Prioritäten + TOTW-Ausnahme | 5 | keine (Anlass-Fall gefixt & abgesichert) | `priorityOf` Stufe 2 isoliert ungetestet |
| R7 | Ohne-Ziel-Rangfolge | 4 | keine | keine |
| R8 | Unverkäuflich zuerst | 1 | keine | keine |
| R9 | Evolutions nie | 2 (1 SSOT-Gate) | keine | keine |
| R10 | Locks nie | 3 | keine | keine |
| R11 | Rating-Kosten-Tabelle | 3 | keine | keine |
| R12 | Rarity-Schutz hart | 3 | keine | Aufschlag-Effekt isoliert ungetestet |
| R13 | TOTW wertgleich | 3 | keine | Storage/Untradeable-Kombi mit TOTW ungetestet |
| R14 | Batch ehrlicher Abbruch | 1 | keine | keine |

**Fazit der Matrix:** 10 von 14 Regeln vollständig gedeckt (R1, R3, R4, R5,
R7, R8, R9, R10, R11, R14 — davon R4 architektonisch ohne Gate). 4 Regeln
(R2, R6, R12, R13) sind an ihren Gates korrekt implementiert, haben aber
jeweils eine kleine, konkret benannte Test-Lücke. 0 echte Gate-Lücken (keine
Regel fehlt komplett an einem Berührungspunkt).

## Konkrete Mängel + Lift-Aktionen

1. **R2 — Rundungslogik bei gemischten Vorgaben nur im geraden 2-Stufen-Fall
   getestet (`ea-fc-sbc-optimizer.user.js:2163-2168`, `solver-test.js:1152-1157`):**
   Lift-Aktion (test-only): neuen Testfall mit `count:0`/`count:0` (oder
   `count:1`) auf ungerader Slot-Zahl (z.B. `slots: 11`) ergänzen und
   erwarten, dass der Überhang (1 Slot) an die NIEDRIGSTE Stufe geht — Zeile
   2165-2168 sortiert `tiers` bereits aufsteigend nach `q`, der Test müsste
   das nur noch als Erwartungswert festschreiben. Kein Live-Risiko aktuell
   (EA schickt laut LEARNINGS §18 bisher nur 2-Stufen-Fälle), aber der Code
   ist generisch für N Stufen geschrieben — ein Test verhindert, dass ein
   künftiger 3-Stufen-Live-Fall die ungetestete Rest-Verteilung zuerst live
   entdeckt.

2. **R6 — `priorityOf()`-Stufe 2 (Storage-Special) nie isoliert gegen Stufe 3
   (Verein-Gold) bewiesen (`ea-fc-sbc-optimizer.user.js:1713-1718`):**
   Lift-Aktion (test-only): Pool aus gleich-ratigen Storage-Specials und
   Verein-Gold-Karten (ohne `specialOnlyFromStorage`, damit beide im Pool
   bleiben) bauen, `solve()` ohne Ziel-Rating aufrufen und erwarten, dass die
   Storage-Specials VOR den Verein-Gold-Karten verbraucht werden — analog zu
   Test 5 (Storage-Gold vs. Verein-Gold, Zeile 310-316) und Test 8b-2f
   (Verein-Gold vs. Verein-Special, Zeile 1133-1141), aber für das bisher
   ausgelassene Stufenpaar 2/3. Schließt die letzte Lücke in der
   4-stufigen Prioritäts-Kette.

3. **R12/R13 — Rarity-Schutz-Aufschlag und Storage-/Untradeable-Kombination
   nie isoliert an einer TOTW-Karte bewiesen (`ea-fc-sbc-optimizer.user.js:1846-1874`,
   `solver-test.js:5339-5357`):** Lift-Aktion (test-only, zwei kleine
   Ergänzungen zu Test 60a): (a) `costOf()` auf einer TOTW-Karte mit
   `rarityGuardCost: 8` vs. `rarityGuardCost: 0` aufrufen und die Differenz
   exakt auf 8 prüfen (statt nur zwei TOTW gegeneinander, wo sich der
   Aufschlag weghebt); (b) eine TOTW-Karte mit `isStorage: true` UND eine mit
   `untradeable: true` gegen ihr jeweiliges Gegenstück ohne diese Flags
   vergleichen und erwarten, dass Storage-Rabatt bzw. Untradeable-Bonus
   weiterhin greifen (Kostendifferenz entspricht `storageBonus`/
   `untradeableBonus`, nicht 0). Beide Ergänzungen sind reine
   `makeCostOf()`-Unit-Tests ohne `solve()`-Aufruf, also billig und schnell.

4. **R6 (Randnotiz, kein Fund, aber bewusst dokumentiert) —
   `computeRarityAvailability()` ignoriert eine gleichzeitig aktive
   Bronze/Silber-Qualitäts-Vorgabe (`ea-fc-sbc-optimizer.user.js:1903-1906`,
   Kommentar):** Das ist eine bewusste, kommentierte Vereinfachung
   (LEARNINGS §45: "die Anzeige braucht diese Einschränkungen nicht"), kein
   Mangel — Gruppe-83-Karten (TOTW/TOTS/FOF/FUTTIES) sind praktisch nie
   gleichzeitig Bronze/Silber-Kandidaten, daher inhaltlich irrelevant. Wird
   hier nur als Edge-Case dokumentiert, damit ein künftiger Audit ihn nicht
   erneut "findet" und fälschlich als Bug meldet.

## Edge-Case (Pflichtpunkt)

- **Ein 3-Stufen-Live-Fall bei gemischten Qualitäts-Vorgaben** (z.B. "Bronze
  Min. 3 + Silber Min. 3 + Gold Min. 3" auf 10 Slots) würde vom bestehenden
  Code technisch korrekt behandelt (die Schleifen in
  `ea-fc-sbc-optimizer.user.js:2137-2183`/`2699-2727` sind nicht auf 2 Stufen
  hartkodiert), aber OHNE jeden Testbeleg — genau die Art Lücke, die beim
  Übergang von 1-Stufen- auf 2-Stufen-Vorgaben (LEARNINGS §18) bereits einmal
  live überrascht hat ("Math.max gewann vorher"). Sollte EA das live
  schicken, ist R2s Lift-Aktion 1 der richtige Ort, das VORHER abzusichern.

## Lift-Empfehlung

Alle vier gefundenen Lücken sind reine Test-Ergänzungen an bereits korrekt
implementierten Gates (additiv, kein Code-Eingriff, kein Konflikt mit
"kleine Diffs") — kein Grund für einen aggressiven Lift-Plan. Priorität:
Aktion 1 (R2, 3-Stufen/ungerader-Rest) zuerst, weil sie die einzige mit einem
denkbaren (wenn auch unbewiesenen) Live-Pfad ist; Aktionen 2 und 3 sind reine
Vollständigkeits-Härtung ohne bekannten Auslöser. Der eigentliche Befund
dieser Iteration ist negativ im guten Sinn: **keine neue TOTW-artige
Gate-Drift gefunden** — der Anlass-Fall ist an allen vier Berührungspunkten
sauber gefixt und regressionsgetestet.
