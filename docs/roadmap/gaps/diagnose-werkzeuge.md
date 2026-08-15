---
feature: diagnose-werkzeuge
analyzed_at: '2026-08-15'
iteration: 6
regression: false
score_current:
  RA: 84
score_target:
  RA: 84
---

# Gap-Report — Diagnose-Werkzeuge (Script-Report & App-Log)

**Modus dieser Iteration:** Verifikations-Runde (kein Fokus-Lift). Auftrag:
die 84er-Bewertung und ihre Restpunkt-Begründung ("der Report zeigt nur, was
vorher als Feld eingebaut wurde — neue Fehlerbilder brauchen eine Runde
Vorlauf") gegen den Live-Code prüfen, nicht künstlich Aktionen erzeugen. Live
verifiziert gegen Userscript v4.55.0 (`const VERSION = '4.55.0';`,
`ea-fc-sbc-optimizer.user.js:66`), `solver-test.js` (503/503 grün),
`docs/LEARNINGS.md` (1526 Zeilen).

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 84 / 85 (structural_max)
**Schwellwert:** 59.5
**Status:** pass
**Begründung (bestätigt):** `STATE.diag` deklariert inzwischen 27 Felder
(`ea-fc-sbc-optimizer.user.js:111-139`, gegenüber 21 zur Zeit der 84er-Bewertung
in Iteration 5) — die acht seither dazugekommenen Felder
(`batchFailedSteps`, `batchStuckCount`, `submitWithoutResponseCount`,
`submitConfirmations`, `scanStats`, `utasUnclassified`,
`lastUnclassifiedPaths`, `popupDismissCount`) sind alle in `buildDiagReport()`
tatsächlich gelesen (`:4014-4319`) und außerhalb mit einem echten
Schreibmuster befüllt — verifiziert über den in Iteration 1 gehärteten,
3-Richtungen-Symmetrietest (`solver-test.js:1818-1906`, Block 17), der
`node solver-test.js` bei jedem der 503 Tests grün durchläuft. Die einzige
Ausnahme (`lastTap`) ist explizit und nachvollziehbar begründet (mittelbarer
Fluss über `clickSetTile()` → `batchSteps`/`batchFailedSteps`,
`solver-test.js:1858-1865`). Das Fehlertoleranz-Kriterium ist ebenfalls
bestätigt: `submitInfo`/`hubScan`/`launcher` sind alle drei per eigenem
Try/Catch abgesichert und das über Regressionsblock 31
(`solver-test.js:2803-2833`) auch getestet; `onDiagClick()` selbst fängt
einen `buildDiagReport()`-Ausfall ab und liefert einen Fallback-Report
(`ea-fc-sbc-optimizer.user.js:4337-4343`). Damit halten alle drei
Iteration-1-Aktionen unverändert, UND sie decken auch die in iter3-5 neu
hinzugekommenen Felder korrekt mit ab — **keine Drift in Verdrahtung oder
Testabdeckung gefunden.** Die einzige neue, im Rahmen dieser Verifikation
gefundene Abweichung betrifft nicht Code/Tests, sondern die
Doku-Konsolidierung: siehe Mangel 1 unten.

## Mängel (Verifikations-Runde — bewusst keine künstliche ≥3-Auffüllung)

1. **`LEARNINGS.md` §25 listet nur 19 von 27 `STATE.diag`-Feldern:**
   `docs/LEARNINGS.md:903-908` zählt die vollständige Form von `STATE.diag`
   auf ("`fetchSeen`, `xhrSeen`, `utasSeen`, `lastUtasPaths`, `lastErrors`,
   `evoExcluded`, `lastSquadPutBody`, `staleRecover`, `locks`, `clubLoad`,
   `submitVia`, `lastEligible`, `refreshLog`, `uiScan`, `batchSteps`,
   `lastTeam`, `submitCandidates`, `submitChallengeVia`, `lastTap`") — das
   war zum Stand von Iteration 0/1 vollständig (21 deklarierte Felder,
   2 davon zu dem Zeitpunkt noch nicht extra genannt), ist aber inzwischen
   um 8 Felder veraltet: `batchFailedSteps`, `batchStuckCount`,
   `submitWithoutResponseCount`, `submitConfirmations`, `scanStats`,
   `utasUnclassified`, `lastUnclassifiedPaths`, `popupDismissCount` fehlen
   in dieser zentralen Aufzählung. Betrifft das RA-Rubric-Kriterium
   "Dokumentierte Begründung" (`score-criteria.md:22-23`) — nicht, weil das
   WARUM fehlt (jedes der 8 Felder hat eine eigene, korrekte
   LEARNINGS-Erklärung: `batchStuckCount`/`popupDismissCount` in §27,
   `submitWithoutResponseCount`/`submitConfirmations`/`batchFailedSteps` in
   §27/§33, `scanStats` in §37, `utasUnclassified`/`lastUnclassifiedPaths`
   in §38), sondern weil die EINE Stelle, die die Gesamtform beschreiben
   soll, keine SSOT mehr ist (Q5/Q7-Randfall: keine falsche Aussage, aber
   eine unvollständige).
2. **`solver-test.js:1835` prüft nur `declared.size >= 18` statt der
   tatsächlichen Zahl:** Der Schwellwert stammt aus Iteration 0 (damals 21
   Felder, "≥18" als Sicherheitsabstand gewählt). Aktuell sind 27 Felder
   deklariert — der Test bleibt technisch korrekt (Mindestanforderung
   weiterhin erfüllt) und deckt daher keinen Fehler auf, ist aber als reine
   Untergrenze kein Regressionsschutz gegen ein versehentlich ENTFERNTES
   Feld irgendwo zwischen 18 und 27 (ein Rückbau auf z.B. 20 Felder bliebe
   unbemerkt grün). Geringes Risiko (kein Feld wurde bisher entfernt, nur
   ergänzt), aber eine reine Zahlengrenze statt einer stichhaltigen Prüfung.
3. **Kein drittes, unabhängig auffindbares Mangel-Muster:** die gezielte
   Suche nach denselben Fehlerklassen wie in Iteration 0/1 (tote
   Deklaration ohne Schreibstelle wie `uiScan` damals, gelesenes-aber-
   undeklariertes Feld, unabgesichertes EA-Controller-Traversal in einem
   Report-Sub-Block, Try/Catch-Lücke in `onDiagClick`) liefert für die
   iter3-5-Ergänzungen **keinen Treffer** — der Symmetrietest UND die
   manuelle Live-Durchsicht von `buildDiagReport()` (`:4014-4319`) zeigen
   für alle 8 neuen Felder korrekte Verdrahtung. Das ist der Kern dieser
   Verifikations-Runde: die Abwesenheit eines dritten Mangels ist selbst der
   Befund, kein unter den Tisch gefallener.

## Lift-Aktionen (Verifikations-Runde — nur was echt vorhanden ist)

1. **`LEARNINGS.md:903-908` additiv auf den aktuellen Feldstand bringen:**
   die Aufzählung um die 8 fehlenden Feldnamen ergänzen (reine Textänderung,
   keine Code-Berührung, Q7-konform: beschreibt nur den IST-Zustand, kein
   "vorher/nachher"). **Erwarteter Gain: 0 bis +1 Pt RA** — die einzelnen
   WARUMs stehen bereits an anderer Stelle (§27/33/37/38), diese Aktion
   schließt nur die SSOT-Lücke der zentralen Übersicht; kein score-tragender
   Fehler wird behoben, deshalb realistisch am unteren Rand des Gain-Bereichs
   oder score-neutral.
2. **`solver-test.js:1835` von `>= 18` auf die tatsächliche Feldzahl (27,
   mit demselben "mindestens"-Vorbehalt für künftige Ergänzungen, z.B.
   `>= 27`) anheben:** verhindert, dass ein versehentliches Entfernen
   mehrerer Felder zwischen 18 und 27 unbemerkt grün bliebe. Rein additive
   Verschärfung eines bestehenden Checks, keine neue Testinfrastruktur.
   **Erwarteter Gain: 0 bis +1 Pt RA** (Kriterium "Testbarkeit" — schließt
   eine Lücke, die noch nie einen echten Fehler durchgelassen hat, also
   eher vorbeugend als score-bewegend).
3. **Keine dritte Aktion vorhanden.** Eine dritte Aktion künstlich zu
   erzeugen (z.B. ein neues, noch nicht gebrauchtes Diagnose-Feld auf
   Verdacht einbauen) würde der Debugging-Konvention aus `CLAUDE.md`
   widersprechen ("Fehlt Info für ein neues Problem: erst ein Diagnose-Feld
   einbauen" — setzt ein KONKRETES, bereits aufgetretenes Problem voraus,
   nicht Spekulation) und wäre ein Q2-Verstoß (Vorratsarbeit ohne
   Wurzelursache). Diese Iteration liefert deshalb bewusst nur 2 echte,
   beide kosmetische Aktionen statt einer erfundenen dritten.

## Edge-Cases (mind. 1 — RA)

- **Der "generische Catch-all" aus Prüffrage 3 existiert bereits und ist
  kein ungenutztes Potenzial:** `reportError()`/`STATE.diag.lastErrors`
  (`ea-fc-sbc-optimizer.user.js:143-157`) fängt bereits JEDEN Fehler an
  15 Call-Sites unabhängig vom konkreten Fehlerbild ab, und die
  DOM-Scans in `buildDiagReport()` (`hubScan`-Tile-Dump, `launcher`-
  Button-Dump, `controllerScan()`, `servicesKeys`) sind bereits generisch
  (kein Named-Field pro erwartetem Fehlerbild nötig, um EINE neue,
  unerwartete UI-Struktur sichtbar zu machen). Der in der Audit-Begründung
  benannte Rest-Lag betrifft NICHT fehlende generische Auffangmechanismen,
  sondern echte NEUE, noch nicht gedachte Fehlerpfade (neue Fehlerklassen,
  die weder ein `warn()`/`diagError()`-Aufruf noch ein bestehender DOM-Scan
  je erreicht) — das ist beim Lift-Planen leicht mit "es fehlt nur noch ein
  Catch-all" zu verwechseln, obwohl der Catch-all bereits da ist und diesen
  Rest strukturell nicht schließen kann.

## Lift-Empfehlung

Kein Lift-Plan für diese Iteration. Die beiden gefundenen Aktionen sind
kosmetisch (Doku-Sync, Test-Untergrenze), score-neutral bis marginal, und
stehen einem Lift-Plan mit dem üblichen Aufwand (5-Phasen-Workflow inkl.
Versionsbump + Push = Deployment auf beide Handys, CLAUDE.md) nicht im
Verhältnis. Empfehlung: als Notiz für die nächste ohnehin anstehende
`diagnose-werkzeuge`-Änderung mitnehmen (z.B. im selben Commit miterledigen,
der das nächste neue Feld einführt), kein eigener Lift-Durchlauf. Die
84er-Bewertung und ihre "inhärenter Lag"-Begründung sind damit **bestätigt,
nicht widerlegt**.
