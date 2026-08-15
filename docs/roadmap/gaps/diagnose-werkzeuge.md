---
feature: diagnose-werkzeuge
analyzed_at: '2026-08-15'
iteration: 1
regression: false
score_current:
  RA: 76
score_target:
  RA: 82
---

# Gap-Report — Diagnose-Werkzeuge (Script-Report & App-Log)

Live verifiziert gegen Userscript v4.45.0 (`const VERSION = '4.45.0';` —
`ea-fc-sbc-optimizer.user.js:66`).

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 76 / 85 (structural_max)
**Schwellwert:** 59.5
**Status:** pass
**Begründung (Adapter, audit-evaluator post-iter-0):** Alle 4 Iteration-0-Aktionen
sind im Code gelandet — `uiScan` ist eine echte, eigenständige DOM-Momentaufnahme
(`ea-fc-sbc-optimizer.user.js:4126-4138`), das `rareConstraints`-Duplikat ist weg
und regressionsgetestet (`solver-test.js:1775-1793`), `STATE.diag` deckt jetzt
21 statt 6 Felder ab (`ea-fc-sbc-optimizer.user.js:110-132`), `reportError` wird
an 7+ Call-Sites konsumiert (`ea-fc-sbc-optimizer.user.js:147-150` plus
Aufrufer), und `app/log-test.js` testet den App-Log-Ringpuffer nach dem
Extraktionsprinzip. Der einzige benannte Abzug: der Symmetrie-Test in
`solver-test.js` (Block 17, `:1711-1773`) prüft nur 2 von 3 Richtungen
(gelesen→deklariert, deklariert→irgendwo-außerhalb-referenziert), nicht aber
deklariert→im-Report-tatsächlich-gelesen — dadurch bleibt `STATE.diag.lastEligible`
befüllt, aber im Report unsichtbar, ohne dass der eigene Test es meldet.

## Mängel (≥ 3 — RA)

1. **`lastEligible` befüllt, aber im Report tot:** `STATE.diag.lastEligible` wird
   deklariert (`ea-fc-sbc-optimizer.user.js:122`) und bei jedem 403-Fehlschlag
   befüllt (`ea-fc-sbc-optimizer.user.js:2777`, direkt vor dem `throw` mit der
   Fehlermeldung ans UI) — aber `buildDiagReport()`
   (`ea-fc-sbc-optimizer.user.js:3844-4125`) liest es an keiner Stelle. Ein
   403-Vorfall ist damit nur im Moment der Toast-Meldung sichtbar; im
   nachträglich kopierten Report (dem eigentlichen Debugging-Kanal laut
   CLAUDE.md) fehlt exakt das Feld, das zeigt, ob die App den Squad selbst für
   abgabefähig hielt. Deckt sich wörtlich mit der Audit-Begründung.
2. **Symmetrie-Test deckt nur 2 von 3 Richtungen ab:** `solver-test.js:1711-1773`
   (Block 17) prüft (a) `STATE.diag` deklariert ≥18 Felder, (b) jedes in
   `buildDiagReport()` gelesene Feld ist deklariert, (c) jedes deklarierte Feld
   wird *irgendwo außerhalb* des Report-Funktionskörpers referenziert. Es fehlt
   die vierte — korrekt die dritte fachliche — Richtung: deklariert → tatsächlich
   *innerhalb* von `buildDiagReport()` gelesen. Genau diese Lücke ließ Mangel 1
   unbemerkt grün durchlaufen; der Test kann strukturell nicht zwischen „Feld
   erscheint im Report" und „Feld wird nur irgendwo im File referenziert"
   unterscheiden. Zusätzlich unterscheidet Check (c) nicht zwischen Lesen und
   Schreiben: die Regex `STATE\.diag\.NAME\b` (`solver-test.js:1764`) matcht
   jede Erwähnung außerhalb — auch eine reine Lesestelle (`if (STATE.diag.X)`)
   zählt als „befüllt", obwohl das Feld dort nie geschrieben wird. Aktuell hat
   zwar jedes der 21 Felder eine echte Schreibstelle (kein Live-Bug), aber die
   Prüfung selbst garantiert das nicht — ein künftiges Feld könnte denselben
   uiScan-Fehler von der Schreib-Seite unbemerkt wiederholen.
3. **`submitInfo`-Block in `buildDiagReport()` ohne eigenen Try/Catch:**
   `ea-fc-sbc-optimizer.user.js:3942-3950` ruft `findSbcController()` und
   `findLiveChallenge()` direkt auf (beide traversieren die undokumentierte,
   EA-eigene Controller-Kette über `getControllerChain()` — genau die Stellen,
   die laut Score-Kriterium RA am fragilsten gegen EA-Wandel sind), ohne
   Absicherung. Die strukturell gleichrangigen Nachbar-Blöcke `hubScan`
   (`:3914-3939`) und der Button-Scan in `launcher` (`:3969-3986`) sind beide
   in ein eigenes `try { … } catch (e) { return { error: … } }` bzw.
   `try {} catch (e) {}` gefasst. Wirft `findSbcController()`/
   `findLiveChallenge()` (z.B. weil `c.getSquad()` bei einer neuen EA-Version
   selbst wirft), reißt das die GESAMTE `buildDiagReport()` mit — und
   `onDiagClick()` ruft `buildDiagReport()` seinerseits unguarded auf
   (`ea-fc-sbc-optimizer.user.js:4139`, kein umschließendes Try/Catch, kein
   `reportError`-Aufruf). Ergebnis: das einzige Werkzeug, das Fehler sichtbar
   machen soll, würde bei genau der Fehlerklasse, die es beobachten soll,
   selbst lautlos ausfallen — kein Toast, kein `diagError`, keine Konsolenzeile
   mit Kontext.

## Lift-Aktionen (≥ 3 — RA)

1. **`lastEligible` additiv in den Report aufnehmen:** in `buildDiagReport()`
   (`ea-fc-sbc-optimizer.user.js`, z.B. direkt neben
   `submitVia: STATE.diag.submitVia || null,` bei Zeile 4036) eine neue Zeile
   `lastEligible: typeof STATE.diag.lastEligible !== 'undefined' ? STATE.diag.lastEligible : null,`
   ergänzen — bewusst NICHT das sonst übliche `|| null`-Idiom (Edge-Case
   unten). Reine Ergänzung, keine vorhandene Report-Zeile wird umbenannt oder
   entfernt (Report-Format-Kontinuität). Erwarteter Gain: schließt genau den
   einen von audit-evaluator benannten Abzugsgrund — voraussichtlich +3 bis
   +5 Pt RA (Beobachtbarkeit-Kriterium).
2. **Symmetrie-Test um die 3. Richtung ergänzen + Lesen/Schreiben trennen:**
   `solver-test.js:1711-1773` (Block 17) additiv erweitern: (a) dritte Prüfung
   „jedes deklarierte `STATE.diag`-Feld wird auch INNERHALB von
   `buildDiagReport()` (zwischen `fnOpen`/`fnClose`) referenziert" — spiegelbildlich
   zum bestehenden Check (b), diesmal mit `declared`-Menge als Ausgangspunkt
   statt `readNames`; (b) die bestehende „unassigned"-Prüfung (`:1762-1772`) auf
   echte Schreibmuster verschärfen (`=` außerhalb von `==`/`===`/`!==`, `.push(`,
   `.shift(`, `++`, `--`) statt jeder bloßen Erwähnung, damit eine reine
   Lesestelle nicht mehr als „befüllt" durchgeht. Dies ist der Pattern-Kandidat
   `symmetrie-test-lesen-schreiben-trennen` (1 Beleg: dieser Testblock selbst)
   und deckt inhaltlich **Cleanup-Kind #24** ab — die Umsetzung dieser
   Lift-Aktion sollte #24 im selben Zug erledigen, damit es nicht doppelt
   eingeplant wird. Erwarteter Gain: hebt den Testbarkeit-Teil der Rubric und
   verhindert das Wiederauftreten der uiScan/lastEligible-Fehlerklasse
   strukturell statt punktuell — +2 bis +3 Pt RA zusätzlich zu Aktion 1 (Test
   selbst hat keinen Score-Wert, aber verhindert, dass Aktion 1 in einer
   künftigen Iteration unbemerkt wieder zurückfällt).
3. **`submitInfo` absichern + `buildDiagReport()`-Aufruf selbst gegen Ausfall
   wappnen:** `ea-fc-sbc-optimizer.user.js:3942-3950` in
   `try { … return {...}; } catch (e) { return { error: String(e && e.message || e) }; }`
   fassen, analog zu `hubScan` (`:3914-3939`). Zusätzlich `onDiagClick()`
   (`:4139`) den Aufruf `const report = buildDiagReport();` in ein eigenes
   Try/Catch nehmen, das im Fehlerfall `reportError('Diagnose-Report
   fehlgeschlagen', e)` aufruft und einen minimalen Fallback-Report
   (`{ version: VERSION, url: location.href, error: String(e && e.message
   || e) }`) trotzdem loggt/kopiert — der Diagnose-Kanal darf bei EINEM
   kaputten Feld nicht komplett verstummen. Regressionstest in
   `solver-test.js` ergänzen: jeder Top-Level-IIFE-Block in
   `buildDiagReport()`, der EA-Controller-Traversal aufruft
   (`findSbcController`, `findLiveChallenge`, `getControllerChain`), hat einen
   eigenen `catch`. Erwarteter Gain: schließt eine bisher nicht auditierte,
   aber konkrete Fehlertoleranz-/Abbruch-Disziplin-Lücke — +2 bis +4 Pt RA.

## Edge-Cases (mind. 1 — RA)

- **`|| null`-Idiom zerstört den Tri-State bei Aktion 1:** `lastEligible` ist
  bewusst dreiwertig (`true` = App hält Squad für abgabefähig, `false` =
  ausdrücklich NICHT abgabefähig, `null` = Prüfung nicht möglich/EA-Objekt
  fehlt). Das im übrigen Report durchgängig verwendete Muster
  `STATE.diag.X || null` (siehe `locks`, `refreshLog`, `lastTeam`,
  `submitCandidates` in `buildDiagReport()`) würde `false || null` zu `null`
  kollabieren — der wichtigste Fall („EA hat's abgelehnt, weil der Squad
  wirklich nicht abgabefähig war") würde ununterscheidbar von „konnte nicht
  geprüft werden". Bei der Umsetzung von Lift-Aktion 1 explizit auf
  `typeof … !== 'undefined' ? … : null` oder eine gleichwertige Prüfung
  achten, nicht das Standard-Idiom kopieren.

## Lift-Empfehlung

Vorsichtig-additiver Lift: alle drei Aktionen sind reine Ergänzungen
(neue Report-Zeile, erweiterter Testblock, zusätzliches Try/Catch) ohne
Eingriff in bestehende Report-Feldnamen oder Solver-Logik — passt zum
"additiv/regressionssicher"-Auftrag dieser Iteration. Aktion 2 zuerst
umsetzen (deckt Cleanup-Kind #24 ab und verhindert, dass Aktion 1 unbemerkt
wieder zurückfällt), dann Aktion 1, dann Aktion 3 — in dieser Reihenfolge
zeigt der erweiterte Test bereits während der Umsetzung von Aktion 1 rot/grün
an, ob die neue Report-Zeile tatsächlich greift.
