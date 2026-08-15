---
feature: rating-solver
analyzed_at: 2026-08-15
iteration: 6
regression: false
score_current:
  RA: 92
score_target:
  RA: 92
---

# Gap-Report — Rating-Solver (Team-Optimierung) — Iteration 6 (Verifikations-Runde)

**Auftrag dieser Runde:** die Iteration-5-Begründung ("Rest zum Deckel 95 bleibt
strukturell — reverse-engineerte Formel") verifizieren oder widerlegen, kein
künstlicher Lift-Zwang. Ergebnis vorweg: die Formel-Begründung selbst hält
stand, ABER auf dem Weg dorthin wurde ein echter, unabhängig von der Formel
stehender Coverage-Fund gemacht (M1-M3 unten) — er wird ehrlich gemeldet statt
unter "strukturell" verbucht.

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 92 / 95
**Schwellwert:** 66.5
**Status:** pass
**Begründung:** Live verifiziert mit v4.55.0 (`node --check` sauber,
`node solver-test.js` → 503/503 grün, `@version`/`VERSION` identisch). Die
Iteration-5-Bereinigungen sind im Code sichtbar angekommen: der tote
Duplikat-Stapel-Tiebreak ist aus `makeConsumeCmp()` entfernt (nur noch
`priorityOf`-Differenz, `ea-fc-sbc-optimizer.user.js:1596-1600`, Kommentar
`:1590-1595` erklärt das WARUM statt ein totes Verhalten zu behaupten), die
Suchgrenzen `1300`/`stHardCap = stLow + 900` tragen jetzt einen
Herleitungs-Kommentar (`:2549-2551`/`:2556`), und ein eigenes `warnings`-Signal
("Internes Suchfenster ausgeschöpft…", `:2613`) unterscheidet echte
Unlösbarkeit von Suchfenster-Erschöpfung — mit Gegenprobe-Testpaar
abgesichert.

**Prüffrage 2 (Formel-Drift-Beobachtbarkeit) — WIDERLEGT als offene Lücke:**
Es gibt keine DOM-/API-Rückkopplung, die `squadRatingExact()` gegen ein von
EA selbst anzeigtes Live-Rating vergleicht (keine Fundstelle für
"currentRating"/"teamRating"-Scraping im ganzen Modul). Das ist aber kein
unbeobachtetes Risiko: `liveSquad.isSBCSquadEligible()` — EAs EIGENE
Abgabefähigkeits-Prüfung (inkl. Rating) — wird in `submitChallengeToEa()`
VOR jedem echten Abgabe-Aufruf befragt und bricht bei `eligible === false`
hart ab, BEVOR `submitChallenge()`/`_submitChallenge()` überhaupt aufgerufen
wird (`ea-fc-sbc-optimizer.user.js:4702-4712`). Für den reaktiven 403-Pfad
(Einzel-Eintragen) gilt dieselbe Quelle (`:2877-2894`, "das ist die einzige
verlässliche Quelle", LEARNINGS §33: `lastEligible` ist im Report dreiwertig
sichtbar). Ein Formel-Drift würde also NICHT unbemerkt zu einer falsch
abgegebenen SBC führen — EAs eigener Gate wirft vorher. Damit ist die
Iteration-5-Prämisse ("Rest ist reine Formel-Unsicherheit") für den
Batch-Pfad tatsächlich durch Architektur abgesichert, nicht nur behauptet.

**Aber:** genau dieser Gate — der einzige Mechanismus, der Formel-Drift ODER
einen Solver-Bug im automatisierten Batch-Pfad abfangen würde — ist selbst
UNGETESTET (siehe M1). Das ist kein Formel-Problem, sondern eine
Testbarkeits-Lücke an der Stelle, die genau die Frage aus Prüffrage 2
beantworten soll.

## Mängel (≥ 3 — M1)

### RA — Robust Architecture

1. **Der `isSBCSquadEligible()`-Abbruchpfad in `submitChallengeToEa()` hat
   keinen einzigen Test, der `false` liefert
   (`ea-fc-sbc-optimizer.user.js:4705-4712`, `solver-test.js:2598-2599`):**
   Der einzige Test, der diese Funktion überhaupt ausführt (Abschnitt 27,
   `solver-test.js:2581-2644`), mockt den Squad fest mit
   `isSBCSquadEligible: () => true` (Zeile 2599) — der `if (eligible ===
   false) throw …`-Zweig bei `:4708-4711` wird in der gesamten Suite NIE
   erreicht. Der zweite Fundort, Abschnitt 26 (`solver-test.js:1400-1401`),
   prüft nur per Regex, dass die STRINGS `lastEligible`/`isSBCSquadEligible`
   im Quelltext vorkommen — keine Verhaltensprüfung. Ein Refactoring, das die
   Prüfung versehentlich hinter den `submitChallenge()`-Aufruf verschiebt,
   die Bedingung invertiert oder den `try{}catch(e){}` so verändert, dass
   `eligible` nie `false` werden kann, würde von KEINEM der 503 Tests
   bemerkt — genau der Fall, den Prüffrage 1 sucht: ein Solver-/Submit-naher
   Pfad, dessen Bruch unbemerkt eine falsche (nicht bloß suboptimale) Abgabe
   zulassen würde. Dieser Fund ist unabhängig von der Rating-Formel selbst
   (reiner Kontrollfluss-Test), widerlegt also punktuell die Einordnung
   "Rest ist nur Formel-Unsicherheit".

2. **Die randomisierte 40x-Brute-Force-Parität (Test 4, `solver-test.js:224-258`)
   ist per eigenem Code-Kommentar explizit auf Configs OHNE Reservierungen
   beschränkt (`solver-test.js:115`: "Nur für Configs OHNE Reservierungen
   korrekt"):** `bruteBest()` kennt weder `rarityConstraints` noch
   Qualitäts-Quoten noch `anchorId`/`rarityPickId` — es enumeriert reine
   Ziel-OVR-Teams. Damit hat GENAU der Solver-Zweig, der laut CLAUDE.md
   ("Bei Solver-Änderungen: … Erwartungswerte NIE aus dem Kopf — immer per
   Brute-Force verifiziert") am striktesten abgesichert sein soll, für seine
   reservierungs-basierten Pfade (Rarity-Quoten, Bronze/Silber-Quoten,
   Anker/Rarity-Pick-Override) KEINEN randomisierten Fuzz-Test — nur
   deterministische Einzelszenarien mit von Hand konstruierten Pools
   (Abschnitte 8, 8b2, 8d2, 8d3, 8b4). Die Einzelszenarien sind selbst
   sauber (explizite `BANDS`-Konstanten statt Rate-Werte, `bestWithProtected()`
   in 8b2 als partielle Brute-Force-Schranke, `solver-test.js:547-566`), aber
   sie decken keine Breite ab — ein Regressions-Bug, der nur bei
   Kombinationen außerhalb der ca. 10 handgebauten Pools auftritt (z.B.
   Kosten-Tiebreak zwischen zwei Rarity-Kandidaten bei ungewöhnlichem
   Storage-/Untradeable-Mix), würde unbemerkt bleiben.

3. **`planBatch()` (Abschnitt 8b4, `solver-test.js:638-679`) erbt dieselbe
   Lücke eine Ebene höher:** Batch-Planung mit Rarity-Vorgabe wird nur mit
   zwei knappen, handgebauten Pools geprüft (`futties`/`golds`-Konstruktion,
   `:662-678`) — keine randomisierte Mehrrunden-Fuzzing-Schleife prüft, dass
   `usedIds` über viele zufällige Pool-/Quoten-Kombinationen hinweg
   tatsächlich disjunkt bleibt und jede Runde kostenoptimal ist. Bei
   Formationsgrößen/Rating-Bereichen außerhalb des aktuell einzigen
   Aufrufer-Rahmens (siehe bereits dokumentierte Herleitung `:2549-2551`)
   wäre auch hier kein Fuzz-Netz vorhanden.

## Lift-Aktionen (≥ 3 — M1)

### RA — Robust Architecture

1. **Verhaltenstest für den `isSBCSquadEligible()`-Abbruch in
   `submitChallengeToEa()` ergänzen (Ziel: `solver-test.js`, Abschnitt 27
   erweitern oder neuer Abschnitt direkt danach):** Mock-Squad mit
   `isSBCSquadEligible: () => false` bauen (analog zum bestehenden Mock,
   `:2592-2617`), Erwartung: die Funktion wirft VOR jedem Aufruf von
   `submitChallenge`/`_submitChallenge` (per Spy/Zähler auf `ctrl.submitChallenge`
   nachweisen, dass er NIE aufgerufen wurde) und die Fehlermeldung enthält
   "NICHT abgegeben". Zusätzlich einen Test für `eligible === null` (Methode
   wirft oder existiert nicht) — muss weiterhin normal abgeben, wie es der
   bestehende `try{}catch(e){}` bei `:4707` vorsieht. Rein additiv, keine
   Verhaltensänderung am Code. Erwarteter Gain: +1-2 Pt RA (schließt die
   einzige echte "unbemerkt falsch abgegeben"-Lücke, die diese
   Verifikations-Runde gefunden hat — direkt einschlägig für die
   RA-Rubrik "Testbarkeit" und "Abbruch-Disziplin").

2. **`bruteBest()` auf `rarityConstraints`-Reservierungen generalisieren und
   in eine neue randomisierte Fuzz-Schleife einbauen (Ziel: `solver-test.js`,
   neuer Abschnitt nach 8b2 analog zu Abschnitt 4):** Die Brute-Force-Rekursion
   (`solver-test.js:119-152`) um eine Nebenbedingung erweitern, die pro Team
   die Anzahl Gruppe-83-Karten zählt und nur Teams mit exakt `count`
   akzeptiert (kleine Pools wie in Test 4, ~15-19 Karten, bleiben
   rechenbar). Randomisiert (fester Seed wie `mulberry32(1234567)`) über
   20-40 Läufe mit variabler Rarity-Quote, Storage-/Untradeable-Mix und
   Ziel-OVR laufen lassen, Vergleich gegen `SolverCore.solve()` wie in Test 4.
   Erwarteter Gain: +1 Pt RA (schließt die von CLAUDE.md selbst verlangte,
   aber bisher nur für den Basispfad eingelöste Brute-Force-Pflicht für
   Solver-Änderungen).

3. **Dieselbe Generalisierung auf Bronze/Silber-Qualitäts-Quoten anwenden
   (Ziel: `solver-test.js`, Ergänzung zu Abschnitt 8d2/`:681-`):** Analog zu
   Aktion 2, aber mit `qualityConstraints`/Quoten-Bändern statt
   `rarityConstraints` — Brute-Force-Nebenbedingung prüft pro Stufe
   (Bronze/Silber) die Mindestanzahl statt der Rarity-Gruppe. Erwarteter
   Gain: +0.5-1 Pt RA (schließt dieselbe Lücke für den zweiten
   reservierungsbasierten Vorgabetyp; niedrigerer Gain als Aktion 2, weil
   Bronze/Silber strukturell einfacher ist — niedrigstes Rating zuerst,
   LEARNINGS §15 — und damit von Natur aus weniger Fehlerfläche hat als der
   kosten-getriebene Rarity-Pfad).

## Edge-Cases (mind. 1 — M1)

- **Bei Aktion 1 nicht versehentlich den bestehenden 403-Reaktivpfad
  (`:2877-2894`) mittesten wollen und dabei den Unterschied verwischen:**
  Der 403-Pfad fragt `isSBCSquadEligible()` NACH einem gescheiterten
  Eintragen zu Diagnosezwecken ab (informativ, kein Abbruch — das Eintragen
  ist zu diesem Zeitpunkt schon fehlgeschlagen), während `submitChallengeToEa()`
  proaktiv VOR der echten Abgabe abbricht (Kontrollfluss-Gate). Beide
  brauchen eigene Tests mit eigener Semantik; ein gemeinsamer Test würde die
  Unterscheidung "informativ vs. abbrechend" verlieren, die LEARNINGS §33
  bewusst getroffen hat.

## Lift-Empfehlung

Der Iteration-5-Rahmen ("Rest ist strukturell, weil die Formel
reverse-engineered ist") hält der Verifikation im Kern stand — die
Beobachtbarkeits-Sorge aus Prüffrage 2 ist bereits durch
`isSBCSquadEligible()` architektonisch beantwortet, nicht nur behauptet.
Trotzdem hat diese Runde EINEN echten, formel-unabhängigen Fund gemacht: der
Gate selbst ist ungetestet, und die CLAUDE.md-Pflicht "Erwartungswerte immer
per Brute-Force" ist für reservierungsbasierte Solver-Pfade bisher nur
teilweise eingelöst. Das ist kein künstlicher Lift-Zwang — alle drei
Aktionen sind additive Tests ohne jeden Eingriff in Formel/V-Maß/DP-Kern,
adressieren aber eine reale Lücke zwischen dem, was CLAUDE.md verlangt, und
dem, was aktuell getestet ist. `score_target: 92` bleibt bewusst gleich dem
Ist-Wert (Verifikations-Runde, kein Lift-Auftrag) — die drei Aktionen sind
als Kandidaten für eine SPÄTERE Iteration dokumentiert, nicht als Forderung
für diese.
