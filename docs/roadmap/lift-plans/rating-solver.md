---
feature: rating-solver
iteration: 6
score_current:
  RA: 92
score_target:
  RA: 93
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
patterns_required:
  - warum-kommentare-mit-live-belegen
  - eingebetteten-code-exakt-testen
  - abbruch-disziplin
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P3-deferred
effort: S
analyzed_at: 2026-08-15
---

# Rating-Solver: Fensterbewusste Rarity-Vorgaben-Reservierung (Fix-Design für den verifizierten Fuzzing-Befund)

## Entscheidung: Additiver, fensterbewusster Reservierungs-Weg VOR dem heutigen Kosten-Greedy (nicht als Ersatz)

Der Gap-Report (Iteration 6) hat den Iteration-5-Rahmen ("Rest ist strukturell,
weil die Formel reverse-engineered ist") im Kern bestätigt, aber gleichzeitig
per 30x-Fuzzing (Seed `57015701`, Section 46 in `solver-test.js`) einen echten,
von der Formel selbst UNABHÄNGIGEN Defekt gefunden und dreifach gegen eine
zweite Enumeration verifiziert: die Rarity-Reservierung in `solveCore()`
(`ea-fc-sbc-optimizer.user.js:2258-2302`, konkret der Sortier-Zweig
`:2291-2294`) wählt die Vorgabe-Karte(n) für eine `rarityConstraints`-Vorgabe
(z.B. „1x Gruppe 83") **ausschließlich nach `costOf()`**, bevor überhaupt
bekannt ist, wie sich diese Wahl auf das team-weite `V`/den Rating-Überschuss
auswirkt. Der nachgelagerte DP (`runSearch`, `:2504-2622`) selbst rechnet
korrekt — er bekommt aber schon eine suboptimal FIXIERTE Reservierung als
Eingabe und kann sie nicht mehr korrigieren.

Minimal-Repro (4 Slots, `maxOvershoot 0`, 1x Gruppe-83-Vorgabe,
`solver-test.js:3760-3773`): Pool enthält eine Storage-Gruppe-83-Karte X
(Rating 91, günstig wegen Storage-Rabatt) und eine Vereins-Gruppe-83-Karte Y
(Rating 84, teurer). Der Solver reserviert heute X (billiger) und füllt mit
drei 84ern auf → `ovrExact 87.06` (`waste 3.06`), obwohl Y + drei 84er im
SELBEN Pool `84.00` (`waste 0`) erreicht hätte. Das verletzt die in CLAUDE.md
festgelegte Regel-Hierarchie wörtlich: „Innerhalb des Fensters … entscheiden
die Karten-Kosten" — das Fenster (hier `maxOvershoot 0`) hat Vorrang, Kosten
entscheiden NUR innerhalb davon. Die 30x-Fuzz-Schleife (`solver-test.js:3705-3747`)
findet dieselbe Ursache bei `t3` unabhängig vom Minimal-Repro.

**Gewählt: additiver, fensterbewusster Reservierungs-Weg ZUERST, heutiger
Kosten-Greedy als garantierter Fallback (Verhaltens-Superset).** Nicht ein
Ersatz des heutigen Codes — CLAUDE.md verlangt „additiv … statt als Ersatz",
und der Kosten-Greedy bleibt für alle Fälle, in denen der neue Weg wegen der
Kombinatorik-Schranke (siehe unten) nicht anläuft, exakt das heutige,
live-verifizierte Verhalten. Kein Fall, der heute lösbar ist, wird dadurch
unlösbar; kein heute gefundenes Team wird durch den neuen Weg schlechter
(nur gleich oder besser).

## Wurzelursache — warum der DP selbst NICHT das Problem ist

`runSearch()` (`:2504-2622`) berücksichtigt bereits reservierte Karten exakt
korrekt: `reservedSum` (`:2312`) und `HRes` (Summe der reservierten Karten
über der Booster-Grenze, `:2542-2544`) fließen in `scanSt()` ein, und das
Fenster `windowV` (`:2508-2509`) wird um das tatsächlich erreichbare `vMin`
gelegt (`:2593-2617`). Das Problem liegt VOR dem DP: die Rarity-Reservierung
(`:2258-2302`) legt die Vorgabe-Karte(n) fest, **bevor** `runSearch` überhaupt
aufgerufen wird (`:2623`), und zwar rein nach `costOf(a) - costOf(b)`
(`:2291-2294`, der Zweig ohne `!target`). Das bedeutet: der DP bekommt einen
bereits verengten, evtl. suboptimalen `reservedSum`/`HRes`-Ausgangswert und
kann nur noch das Beste aus einer bereits verschenkten Ausgangslage machen —
er wird nie gefragt, OB eine andere Kandidaten-Wahl für dieselbe Vorgabe ein
kleineres `vMin` (näher an `NEED`) ermöglicht hätte.

**Wichtige Eingrenzung (verhindert Scope-Creep):** derselbe Sortier-Ausdruck
existiert an mindestens zwei weiteren Stellen im Solver mit demselben
Kosten-zuerst-Muster:

- `playerLevelConstraints`-Reservierung (`:2211-2225`, konkret `:2217`) — läuft
  UNABHÄNGIG von `target` und hat vermutlich denselben Fehler (z.B. „min. 2x
  85+" könnte eine unnötig hohe 92er-Karte statt einer knapp reichenden 85er
  reservieren). **Nicht Teil dieses Fixes** — es gibt dafür KEINEN
  brute-force-verifizierten Fund (CLAUDE.md: „Erwartungswerte NIE aus dem
  Kopf"), nur eine Analogie-Vermutung. Als Risiko/Folge-Kandidat unten
  benannt, nicht hier mitgefixt (Q2).
- `qTiers`-Reservierung (Bronze/Silber-Quoten, `:2165-2193`) sortiert bereits
  mit `makeFillCmp` (rating-aufsteigend ZUERST, Kosten nur Tiebreak,
  `:1632-1637`) — **hat den Defekt strukturell nicht**, weil Bronze/Silber
  laut CLAUDE.md das Min-Rating ohnehin ignorieren und in der Praxis nie mit
  einem Ziel-OVR kombiniert auftreten (LEARNINGS §18); kein Fensterproblem,
  weil dort kein `target`/`windowV`-Konzept greift.
- Der `!target`-Zweig derselben `rcList`-Schleife (Rare-ohne-Ziel-OVR,
  `:2291-2292`, `makeFillCmp`) hat den Fehler ebenfalls nicht — dort gilt per
  LEARNINGS §15/§17 ohnehin „niedrigstes Rating vor Kosten", kein
  `maxOvershoot`-Fenster.

Der Fix ist also strikt auf die `rcList`-Reservierung **mit gesetztem
`target`** begrenzt (deckt sowohl den verifizierten Gruppe-83-Fall als auch
den strukturell identischen Gruppe-4/Rare-MIT-Ziel-OVR-Fall ab, weil beide
durch denselben Code-Zweig laufen — kein zusätzlicher Aufwand, derselbe
Bugfix-Punkt).

## Fix-Design: `reserveRarityWindowAware()` — bounded, additiv, DP-basiert

### Kernidee

Statt die `need` Vorgabe-Karten EINER Constraint per reinem Kosten-Vergleich
zu wählen, wird für eine **bounded Menge** von Kandidaten-Kombinationen
tatsächlich ausprobiert, wie gut sie sich downstream vervollständigen lassen
— unter Wiederverwendung DERSELBEN, bereits korrekten DP-Maschinerie
(`bandFor`/`scanSt`, `:2510-2571`), nicht einer zweiten, separat gepflegten
Kostenformel (Q4/Q5: kein zweites Kostenmodell, siehe
[[warum-kommentare-mit-live-belegen]] zum bestehenden `costOf`-SSOT-Pattern).

**Schritt 1 — unveränderter Kandidaten-Filter.** Dieselbe `poolAll`-Filterung
wie heute (`:2276-2290`, inkl. Qualitäts-Fenster, `rareCap`-Lockerung mit
Warnung, Storage/TOTW-Regel) bleibt exakt bestehen — nur die anschließende
AUSWAHL aus den Kandidaten ändert sich.

**Schritt 2 — verlustfreie Profil-Bündelung (Bound Teil 1).** Kandidaten
werden nach `rating` gruppiert; pro Rating wird nur der/die (bis zu `need`)
günstigste(n) Kandidat(en) (per bestehendem `costOf`) behalten. Das ist
**beweisbar verlustfrei**, nicht approximativ: der `V`-Beitrag einer Karte
hängt ausschließlich von ihrem `rating` ab (`squadV`, `:1669-1679`), Kosten
sind eine reine Funktion von `(rating, isStorage, isProtectedRarity,
untradeable)` (`makeCostOf`, `:1745-1751`) — bei gleichem Rating dominiert die
günstigste Karte jede teurere strikt (identisches `V`, gleicher oder
niedrigerer Preis). Damit schrumpft die Kandidatenmenge auf höchstens 100
Profile (Rating-Skala 0-99), in der Praxis für Gruppe 83 (TOTW/TOTS/FOF/
FUTTIES) deutlich weniger — diese Karten sind laut CLAUDE.md
("Rarity-Schutz") bewusst SELTEN, ein Spieler-Pool hat davon typischerweise
eine niedrige zweistellige Anzahl, nicht Tausende (anders als z.B. die
Gruppe-4/Rare-Menge, siehe Kombinatorik-Schranke unten).

**Schritt 3 — Kombinatorik-Schranke (Bound Teil 2, Constraint 3 der Aufgabe).**
Sei `P` = Anzahl Profile nach Schritt 2, `need` = noch fehlende Anzahl für
diese Constraint. Multiset-Kombinationen ohne Wiederholungs-Überschreitung
der tatsächlichen Verfügbarkeit je Profil: `C(P + need - 1, need)`. Nur wenn
dieser Wert einen festen `RARITY_WINDOW_TRIAL_CAP` (Vorschlag: **200** —
konservativ für Reaktionszeit am Handy; z.B. `P=15, need=3 → C(17,3)=680`
läge bereits DARÜBER und würde in den Fallback gehen, `P=8, need=2 → C(9,2)=36`
liefe durch) **unterschreitet**, wird Schritt 4 exakt ausgeführt. Sonst sofort
Fallback (Schritt 6) — **ehrlich benannte Restlücke, keine versteckte
Näherung:** SBCs mit einem Ziel-OVR UND einer sehr breiten,
kosten-heterogenen Rarity-Kandidatenmenge (`P` groß, `need` > 2-3) behalten
das heutige, nicht zwingend fensteroptimale Verhalten. Diese Kombination ist
nach Live-Erfahrung (LEARNINGS §6: „mit Vorgabe GENAU die geforderte Anzahl",
durchgehend kleine Zahlen in allen dokumentierten SBCs) der unwahrscheinliche
Rand, nicht der Regelfall — deshalb bewusst NICHT mit unbounded Rekursion
oder einer heuristischen Näherung "gelöst", sondern klar als Grenze benannt.

**Schritt 4 — Enumeration + DP-Wiederverwendung (kein zweiter Solver-Kern).**
Für jede der ≤ `RARITY_WINDOW_TRIAL_CAP` Kombinationen: die realen Karten
temporär reservieren (zusätzlich zu bereits vorher reservierten Ankern/
Qualitäts-/Level-Vorgaben — Reihenfolge der äußeren Schleife bleibt
unverändert) und **denselben** nachgelagerten Code (`runSearch`, `:2504-2622`)
mit dieser Reservierung aufrufen, um `vMin`/Kosten zu ermitteln — kein
eigenständiges zweites DP, sondern derselbe Aufruf, nur zeitlich VOR die
finale Reservierung vorgezogen. **Performance-Design-Punkt:** `bandFor()`
cached die DPs bereits nach `rBoost` (`:2510-2530`); da `avail` (der
Auffüll-Pool für die restlichen `k`-Slots) über alle Trial-Kombinationen
IDENTISCH bleibt (die Rarity-Kandidaten selbst sind wegen `limitProtected`
ohnehin nicht in `avail` enthalten, `:2321`), muss der `bandCache` als
**geteilte** Closure über alle Trials hinweg geführt werden, statt pro
Kombination neu aufgebaut zu werden — sonst multipliziert sich die ohnehin
schon bounded Trial-Zahl unnötig mit dem vollen DP-Aufbau. Dieser Punkt ist
ein Implementierungs-Detail, das der Fix-Umsetzung als Pflicht-Vorgabe
mitgegeben werden muss (sonst ist die Bound zwar korrekt, aber die reale
Laufzeit trotzdem unnötig hoch).

**Schritt 5 — Auswahl nach der Regel-Hierarchie.** Von allen im Fenster
`[globalVmin, globalVmin + windowV]` liegenden Trial-Ergebnissen (wobei
`globalVmin` das kleinste über ALLE Trials gefundene `vMin` ist — das ist der
tatsächliche Team-weite Rating-Überschuss, den CLAUDE.md als primäre
Nebenbedingung verlangt) gewinnt die Kombination mit den niedrigsten Kosten
(Storage-Vorrang, Untradeable-Rabatt — bereits in `costOf` enthalten, keine
zweite Formel). Das ist exakt CLAUDE.mds Regel-Hierarchie: „minimales
exaktes Dezimal-Rating über dem Ziel … innerhalb des Fensters … entscheiden
die Karten-Kosten" — nur jetzt korrekt auf die Reservierungs-ENTSCHEIDUNG
selbst angewendet statt erst auf die Auffüll-Karten danach.

**Schritt 6 — Fallback (Pflicht, additiv).** Wird `RARITY_WINDOW_TRIAL_CAP`
überschritten ODER liefert keine der Trial-Kombinationen überhaupt ein
lösbares Team (z.B. weil eine spätere Constraint die verbleibenden Slots
sprengt — bleibt unverändert der bestehenden `{ok:false, reason:...}`-Kette
weiter unten überlassen, kein neuer Fehlerpfad), reserviert die Funktion
GENAU den heutigen Kosten-Greedy (`:2291-2294`, Zeile für Zeile unverändert)
— mit einer NEUEN, aber nur im Cap-überschritten-Fall auftauchenden
`warnings`-Meldung („Fensterbewusste Vorgaben-Wahl übersprungen (zu viele
Kandidaten) — Kosten-Reihenfolge verwendet.") nach dem etablierten Muster
„Harte Constraints mit garantiertem Fallback + Pflicht-Warnung statt stillem
Scheitern" (Aspect-Solver-Pattern, 5 bestehende Belegstellen im Modul,
`ea-grenz-fallback-ketten`-Familie). Im "keine Trial-Kombination lösbar"-Fall
KEINE zusätzliche Warnung, weil der bestehende `{ok:false}`-Pfad diesen Fall
bereits genauso behandelt wie heute (kein neues Fehlerbild, kein doppeltes
Melden).

### Warum additiv statt Ersatz konkret sicher ist (Verhaltens-Superset-Beweis)

Der heutige Kosten-Greedy-Pick ist **immer** eine der in Schritt 2/3
enumerierten Profile (er IST per Definition das günstigste Profil unter den
Kandidaten). Der neue Weg wählt daraus die Kombination mit minimalem `vMin`,
und bei Gleichstand im Fenster die günstigste — das kann also nie zu einem
schlechteren Ergebnis führen als der heutige Pick, nur zu einem
gleichwertigen oder besseren (kleineres `waste` bei gleichen/niedrigeren
Kosten oder gleiches `waste` bei niedrigeren Kosten). Für alle Fälle, in
denen der neue Pfad NICHT anläuft (Cap überschritten), ist das Ergebnis
bytegleich mit heute. Damit ist die CLAUDE.md-Vorgabe „Refactorings ändern
nachweislich NICHTS am Verhalten … Verbesserungen kommen additiv" für den
Cap-überschritten-Fall wörtlich erfüllt (kein Unterschied) und für den
Normalfall im strengen Sinne „nur besser" erfüllt.

## Marschroute

1. **core** — `reserveRarityWindowAware()` als neue, private Helper-Funktion
   innerhalb der `solveCore`-IIFE ergänzen (Schritte 1-6 oben); Aufrufstelle
   `:2258-2302` so umbauen, dass sie bei gesetztem `target` diesen Weg statt
   des reinen `costOf`-Sorts nutzt, mit Fallback exakt auf den heutigen Code.
   `RARITY_WINDOW_TRIAL_CAP` als benannte Konstante nahe `DEFAULT_RATING_COST_SPEC`
   (SSOT-Konvention des Moduls). `bandCache`-Sharing über Trials hinweg wie
   in Schritt 4 beschrieben.
2. **diagnose** — neue `warnings`-Meldung für den Cap-überschritten-Fall
   (Schritt 6); kein neues Diagnose-Feld nötig (die Wahl selbst bleibt über
   die bestehende `reserved`/`teamDump`-Struktur beobachtbar).
3. **tests** — Section 46 (`solver-test.js:3690-3782`) auf die KORREKTE
   Erwartung drehen: Minimal-Repro erwartet `ovrExact === 84 && waste === 0`,
   die 30x-Fuzz-Schleife erwartet `allMatch === true` (kein `t3`-Sonderfall
   mehr). Zusätzlich: ein neuer, gezielt konstruierter Test für den
   Cap-überschritten-Fallback (Pool mit > `RARITY_WINDOW_TRIAL_CAP`
   distinct-rating Gruppe-83-Kandidaten bei `need` groß genug, um die
   Schranke zu reißen — erwartet: Ergebnis identisch mit dem heutigen
   Kosten-Greedy-Pick UND die neue Fallback-Warnung erscheint). Alle
   Erwartungswerte per Brute-Force (`bruteBest`/eine für diesen Test
   generalisierte Variante, die `rarityConstraints` kennt — siehe
   Gap-Aktion 2) verifiziert, NIE aus dem Kopf.
4. **docs** — `docs/LEARNINGS.md` §41 (Befund + Fix-Design, siehe unten);
   `@version`/`const VERSION` `4.56.0` → `4.57.0`.
5. **release** — Push auf `main` (Deployment = eiserner Arbeitsablauf CLAUDE.md).

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`reserveRarityWindowAware()` implementieren + Aufrufstelle umbauen
   (`ea-fc-sbc-optimizer.user.js:2258-2302`):** Neue Funktion nach dem in
   diesem Dokument beschriebenen Algorithmus (Schritte 1-6); Aufruf nur wenn
   `target` gesetzt ist (die `!target`-Fälle bleiben exakt beim heutigen,
   bereits korrekten `makeFillCmp`-Weg, LEARNINGS §15/17). `need`-Zählung,
   `matchesRarity`-Matching, `rareCap`-Lockerung-mit-Warnung und die
   Storage/TOTW-Filterregel (`:2276-2290`) bleiben unverändert — nur die
   Auswahl AUS den gefilterten Kandidaten ändert sich. Erwarteter Gain:
   +1 Pt RA (schließt den einzigen in dieser Iteration verifizierten,
   formel-unabhängigen Solver-Bug — direkt einschlägig für die
   RA-Rubrik „Fehlertoleranz"/„Abbruch-Disziplin bei falschen Ergebnissen").
2. **Fallback-Warnung + `RARITY_WINDOW_TRIAL_CAP`-Konstante
   (`ea-fc-sbc-optimizer.user.js`, nahe `DEFAULT_RATING_COST_SPEC`):**
   Cap-überschritten-Fall meldet sich einmalig über das bestehende
   dedupe-geschützte `warnings.push` (`:1902-1905`), keine neue
   Warn-Infrastruktur nötig. Erwarteter Gain: +0.5 Pt RA (Beobachtbarkeit:
   die dokumentierte Restlücke ist im Live-Betrieb sichtbar statt stumm).
3. **Section 46 auf die korrekte Erwartung drehen + Cap-Fallback-Test
   ergänzen (`solver-test.js:3690-3782` und neuer Abschnitt danach):**
   Minimal-Repro-Assertion `ovrExact===87.06/waste===3.06` →
   `ovrExact===84/waste===0`; 30x-Fuzz-Assertion `!allMatch` → `allMatch`.
   Neuer Test konstruiert einen Pool, der `RARITY_WINDOW_TRIAL_CAP`
   nachweislich überschreitet (z.B. `need=3` bei > 20 distinct-rating
   Gruppe-83-Kandidaten) und prüft: (a) Ergebnis stimmt mit dem
   unveränderten Kosten-Greedy überein (Regressionsschutz für den
   Fallback-Pfad selbst), (b) die neue Warnung erscheint. Erwarteter Gain:
   +1 Pt RA (schließt exakt die von CLAUDE.md verlangte, aber bisher nur für
   den Basispfad eingelöste Brute-Force-Pflicht für reservierungsbasierte
   Solver-Pfade — der ursprüngliche Gap-Fund, jetzt mit korrektem statt
   gepinntem Fehlverhalten).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 1 (`reserveRarityWindowAware()` + Aufrufstellen-Umbau, `RARITY_WINDOW_TRIAL_CAP`-Konstante, geteilter `bandCache` über Trials) |
| diagnose | Aktion 2 (Fallback-Warnung bei Cap-Überschreitung) |
| tests | Aktion 3 (Section 46 auf korrekte Erwartung drehen; neuer Cap-Fallback-Test; `node solver-test.js` muss nach dem Umbau vollständig grün sein — inkl. aller bisherigen 30x-/40x-Brute-Force-Paritätstests, die vom Umbau NICHT betroffen sein dürfen, da sie ohne Rarity-Reservierung laufen) |
| docs | `docs/LEARNINGS.md` §41 (Befund + Fix-Design, Bound-Begründung, Verhaltens-Superset-Argument); `@version`/`const VERSION` `4.56.0` → `4.57.0` |
| release | Push auf `main` (Deployment) |

## Shared-Item-Bedarf

Keiner. Der neue Helper (`reserveRarityWindowAware`) ist reine `SolverCore`-
interne Logik ohne zweiten Konsumenten außerhalb dieses Features — anders als
z.B. `test-extraktions-helfer` (Iteration 1) gibt es hier kein
Cross-Feature-Duplikat, das ein Shared Item rechtfertigen würde. Siehe
`rating-solver.shared-items.json` (leer).

## Risiken / Edge-Cases

- **`playerLevelConstraints`-Reservierung (`:2211-2225`) hat vermutlich
  denselben Fehler, ist aber NICHT Teil dieses Fixes** (siehe „Wichtige
  Eingrenzung" oben) — kein brute-force-verifizierter Fund, nur eine
  Analogie-Vermutung. Folge-Ticket-Kandidat für eine spätere Iteration,
  NICHT hier mit-fixen (Q2: kein Fix ohne eigenen, verifizierten Testfall).
  Wer diesen Fix implementiert, darf sich davon nicht zu einer stillen
  Mit-Reparatur verleiten lassen.
- **`RARITY_WINDOW_TRIAL_CAP` ist ein Performance-Kompromiss, kein
  mathematisch hergeleiteter Wert.** Der vorgeschlagene Default (200) ist
  konservativ für Reaktionszeit am Handy geschätzt, nicht gemessen — die
  Implementierung sollte die tatsächliche Trial-Laufzeit für ein realistisch
  großes Szenario (z.B. `P=14, need=3` → `C(16,3)=560`, knapp über dem
  Vorschlag) einmal am echten Code messen und den Wert bei Bedarf mit einem
  WARUM-Kommentar (Live-Zeitmessung, analog zum bestehenden
  `warum-kommentare-mit-live-belegen`-Muster) anpassen, statt ihn ungeprüft
  zu übernehmen.
- **Der geteilte `bandCache` über Trials hinweg ist kein optionales Detail,
  sondern Bedingung für die Bound-Aussage.** Ohne ihn multipliziert sich der
  volle DP-Aufbau (`buildDp` für `dpLow`/`dpHigh`, `:2527-2528`) mit der
  Trial-Zahl, und die in diesem Dokument behauptete „amortisierte" Kosten-
  Rechnung stimmt nicht mehr — ein Implementierungs-Review sollte das gezielt
  gegenprüfen (z.B. ein Zähler, wie oft `buildDp` pro `solve()`-Aufruf
  tatsächlich läuft, vorübergehend als Test-Instrumentierung).
- **Die 30x-Fuzz-Schleife (Section 46) UND die bereits bestehenden 40x-/
  Abschnitt-8-Brute-Force-Tests dürfen durch den Umbau nicht kollateral
  brechen** — insbesondere Test 4 (`:224-258`, OHNE Reservierungen) und die
  deterministischen Einzelszenarien (Abschnitt 8, 8b2, 8d2, 8d3, 8b4) laufen
  auf demselben `solveCore`, nutzen aber andere Constraint-Typen oder gar
  keine Reservierung — `node solver-test.js` muss die VOLLE Suite grün
  zeigen, nicht nur Section 46.
- **Mehrere `rarityConstraints` in derselben SBC** (die äußere
  `for (const rc of rcList)`-Schleife, `:2258`) bleiben weiterhin SEQUENZIELL
  behandelt (keine gemeinsame Optimierung über mehrere Constraints hinweg) —
  das ist bereits das heutige Verhalten und wird durch diesen Fix nicht
  verschlechtert, aber auch nicht behoben; eine gemeinsame Optimierung über
  mehrere Rarity-Vorgaben wäre eine deutlich größere, hier bewusst nicht
  vorgeschlagene Erweiterung.

## Lift-Plan-Pre-Validation (M2)

`pk_files_to_cite` ist leer (keine PK-Aktion, Dimension-Fokus ausschließlich
RA). `score_target.RA: 93 ≤ structural_max.RA: 95`. RA ist `manual_rubric`
(kein deterministischer PK-Divisor) — die Schätzung erfolgt über die
Reasoning-Fallback-Bewertung des `audit-evaluator`, nicht über `plan
estimate`s PK-Formel. Der Gain ist bewusst klein (+1) und als
Korrektheits-Fix, nicht als Score-Lift-Kampagne gerahmt (Auftrag: „kein
Score-Lift — score_target 92-93") — die drei Aktionen adressieren exakt den
einen in Iteration 6 verifizierten Fund, nicht mehr.
