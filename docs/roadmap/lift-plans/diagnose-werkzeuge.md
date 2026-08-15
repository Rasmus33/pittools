---
feature: diagnose-werkzeuge
iteration: 1
score_current:
  RA: 76
score_target:                              # Vorgabe M3-Target 82 (entspricht Ambitions-Regel:
  RA: 82                                   # 76 + (85-76)*0.7 = 82.3 -> 82)
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
patterns_required:                         # formal auf diagnose-werkzeuge anwendbare gute Patterns
                                           # (applies_to_features enthaelt diagnose-werkzeuge) - kein
                                           # PK-Ziel diese Iteration (pk_files_to_cite: []), sie leiten
                                           # die Aktionen inhaltlich an
  - diagnose-feld-statt-raten
  - warum-kommentare-mit-live-belegen
pk_files_to_cite: []
citation_only: false
shared_items_required:
  - test-extraktions-helfer
priority: P3-deferred                      # Sigma Gain (Mittelwerte 4+2.5+3=9.5) < 100 -> Heuristik-
                                           # Default; keine sicherheitsrelevante Sonderlage, alle drei
                                           # Aktionen additiv/klein.
effort: S                                  # Override: phase_sequence hat 5 Glieder (fixer 5-Phasen-
                                           # Workflow, gilt fuer jedes pittools-Feature identisch aus
                                           # CLAUDE.md), sagt hier nichts ueber den Umfang. Alle drei
                                           # Aktionen sind additiv/klein (1 Report-Zeile, 1 erweiterter
                                           # Testblock, 2 Try/Catch-Bloecke + 1 Regressionstest).
analyzed_at: '2026-08-15'
---

# Lift-Plan — Diagnose-Report um Eligibility-Sichtbarkeit und Fehlerabsicherung erweitern

**Ticket-Titel-Vorschlag (ADR #73):** Diagnose-Report um Eligibility-Sichtbarkeit und Fehlerabsicherung erweitern

## Marschroute

Drei additive, unabhängig abnehmbare RA-Aktionen entlang `core → diagnose →
tests → docs → release`, alle live gegen Userscript v4.45.0
(`const VERSION = '4.45.0';`, `ea-fc-sbc-optimizer.user.js:66`) verifiziert.
Wie schon in Iteration 0 IST der Diagnose-Report selbst die Kern-Code-
Geographie dieses Features — `core` bleibt deshalb wieder leer, die
inhaltlichen Änderungen landen in `diagnose` (neues Report-Feld,
Fehlerabsicherung) bzw. `tests` (Symmetrie-Test-Erweiterung,
Regressionstest für die neue Try/Catch-Disziplin).

Reihenfolge der Umsetzung folgt der Gap-Report-Empfehlung, NICHT
zwangsläufig der Phasen-Commit-Reihenfolge: zuerst Aktion 2 (Symmetrie-Test
um die dritte Richtung ergänzen — zeigt danach ROT, weil `lastEligible`
deklariert, aber im Report ungelesen ist), dann Aktion 1 (Report-Zeile
ergänzen — Test wird GRÜN), dann Aktion 3 (Try/Catch-Härtung +
Regressionstest dafür). Diese Reihenfolge macht während der Umsetzung
selbst sichtbar, ob Aktion 1 tatsächlich greift, statt es erst am Ende zu
hoffen. Die drei Aktionen dieses Plans **decken Cleanup-Kind #24
(`lastEligible` nie im Report) inhaltlich ab** — beim Merge dieses Lifts
schließt #24, kein separates Ticket dafür nötig.

Keine der drei Aktionen fasst Solver-, Netz- oder Submit-Logik an — reine
Beobachtbarkeits- und Abbruch-Disziplin-Arbeit am Report selbst.
`node --check`, `node solver-test.js` (aktuell grün) vor und nach jeder
Aktion, Versionsbump vor Push (nächste freie Version über 4.45.0 —
Implementer prüft den Live-Stand vor dem Bump, CLAUDE.md-Pflicht:
`@version` UND `const VERSION` müssen übereinstimmen).

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`lastEligible` additiv in den Report aufnehmen — Tri-State-sicher:**
   in `buildDiagReport()` (`ea-fc-sbc-optimizer.user.js`) direkt nach
   `submitVia: STATE.diag.submitVia || null,` (Zeile 4036, vor
   `controllerScan: controllerScan(),` in Zeile 4037) eine neue Zeile
   ergänzen:
   ```js
   lastEligible: typeof STATE.diag.lastEligible !== 'undefined' ? STATE.diag.lastEligible : null,
   ```
   Bewusst NICHT das im übrigen Report übliche `STATE.diag.X || null`-Idiom
   (siehe `locks`, `refreshLog`, `lastTeam`, `submitCandidates` in derselben
   Funktion) — `STATE.diag.lastEligible` ist an seiner Schreibstelle
   (`ea-fc-sbc-optimizer.user.js:2777`, direkt vor dem 403-Error-Throw in
   der `submitToSbc`-Fehlerbehandlung) dreiwertig: `true` = App hält Squad
   für abgabefähig, `false` = ausdrücklich NICHT abgabefähig (der für
   Rasmus wichtigste Fall — zeigt, dass eine Vorgabe fehlt, die der Solver
   nicht abdeckt), `null` = Prüfung nicht möglich. `|| null` würde
   `false || null` zu `null` kollabieren und den wichtigsten Fall
   ununterscheidbar von „nicht geprüft" machen. Reine Ergänzung, keine
   vorhandene Report-Zeile wird umbenannt oder entfernt (Report-Format-
   Kontinuität). **Erwarteter Gain: +3 bis +5 Pt** (Kriterium
   „Beobachtbarkeit" — schließt den einzigen von audit-evaluator benannten
   Abzugsgrund und Cleanup-Kind #24).

2. **Symmetrie-Test um die 3. Richtung ergänzen + Lesen/Schreiben trennen**
   (Pattern-Kandidat `symmetrie-test-lesen-schreiben-trennen`, hier als
   Beleg gestärkt): `solver-test.js:1711-1773` (Block 17) additiv erweitern,
   ohne die bestehenden Checks (a)/(b) zu verändern:
   - **Neue Prüfung (c):** „jedes deklarierte `STATE.diag`-Feld wird auch
     INNERHALB von `buildDiagReport()` gelesen" — spiegelbildlich zur
     bestehenden Prüfung (b, Zeilen 1751-1753), diesmal mit der `declared`-
     Menge als Ausgangspunkt statt `readNames`:
     ```js
     const missingFromReport = Array.from(declared).filter(n => !readNames.has(n));
     check('Jedes deklarierte STATE.diag-Feld wird auch INNERHALB von buildDiagReport() gelesen',
         missingFromReport.length === 0, missingFromReport.join(','));
     ```
     Vor Aktion 1 wäre dieser Check ROT (`lastEligible` fehlt in
     `readNames`), nach Aktion 1 GRÜN — genau der Regressionsschutz, der
     den `uiScan`-Fehlerfall aus Iteration 0 und den `lastEligible`-Fund
     dieser Iteration künftig automatisch aufdeckt.
   - **Bestehende Prüfung (Zeilen 1762-1772) verschärfen:** die aktuelle
     Regex `STATE\.diag\.NAME\b` matcht jede Erwähnung außerhalb des
     Funktionskörpers — auch eine reine Lesestelle (`if (STATE.diag.X)`)
     zählt fälschlich als „befüllt". Ersetzen durch ein Muster, das nur
     echte Schreibzugriffe zählt: Zuweisung `=` (nicht `==`/`===`/`!==`),
     `.push(`, `.shift(`, `++`, `--`:
     ```js
     const writeRe = new RegExp(
         'STATE\\.diag\\.' + name + '\\s*=[^=]' +          // Zuweisung, kein ==/===
         '|STATE\\.diag\\.' + name + '\\.(push|shift)\\(' + // Ringpuffer-Mutation
         '|STATE\\.diag\\.' + name + '\\s*(\\+\\+|--)',     // Zaehler
         'g');
     ```
     angewendet auf den Text außerhalb von `fnOpen`/`fnClose` (gleiche
     Fundstellen-Iteration wie bisher, nur die Match-Bedingung ändert
     sich). Aktuell hat zwar jedes der 21 deklarierten Felder eine echte
     Schreibstelle (kein Live-Bug, per Volltextsuche verifiziert) — die
     Verschärfung garantiert das aber strukturell für jedes künftige neue
     Feld, statt es dem Zufall zu überlassen.
   - Beide Ergänzungen bleiben additiv im selben Testblock 17 (kein neuer
     Block nötig, `declared`/`readNames`/`fnOpen`/`fnClose` sind bereits
     vorhanden und werden wiederverwendet — Q4).
   **Erwarteter Gain: +2 bis +3 Pt** (Kriterium „Testbarkeit" — verhindert
   strukturell, dass Aktion 1 oder ein künftiges Feld unbemerkt in
   denselben toten Report-Zustand zurückfällt).

3. **`submitInfo`-Block absichern + `buildDiagReport()`-Aufruf selbst gegen
   Ausfall wappnen:**
   - `ea-fc-sbc-optimizer.user.js:3942-3950` (`submitInfo`-IIFE, ruft
     `findSbcController()`/`findLiveChallenge()` auf — beide traversieren
     die undokumentierte EA-Controller-Kette über `getControllerChain()`)
     in ein eigenes Try/Catch fassen, analog zum strukturell gleichrangigen
     Nachbarblock `hubScan` (`:3914-3939`, bereits `try { … } catch (e) {
     return { error: … } }`):
     ```js
     submitInfo: (function () {
         try {
             const svc = window.services && window.services.SBC;
             const ctrl = findSbcController();
             return {
                 saveChallengeThere: !!(svc && typeof svc.saveChallenge === "function"),
                 liveChallengeThere: !!findLiveChallenge(),
                 controllerName: (ctrl && ctrl.constructor && ctrl.constructor.name) || null
             };
         } catch (e) { return { error: String(e && e.message || e) }; }
     })(),
     ```
   - `onDiagClick()` (`:4139`, `const report = buildDiagReport();`) selbst
     in ein Try/Catch nehmen, das im Fehlerfall `reportError('Diagnose-
     Report fehlgeschlagen', e)` aufruft (Helfer existiert bereits,
     `ea-fc-sbc-optimizer.user.js:147-150`, Block 16 in `solver-test.js`
     testet ihn) und trotzdem einen minimalen Fallback-Report loggt/kopiert:
     ```js
     let report;
     try { report = buildDiagReport(); }
     catch (e) {
         reportError('Diagnose-Report fehlgeschlagen', e);
         report = { version: VERSION, url: location.href, error: String(e && e.message || e) };
     }
     ```
   - Neuer Regressionstest in `solver-test.js` (neuer Block, Nummer 26):
     jeder Top-Level-IIFE-Sub-Block innerhalb von `buildDiagReport()`, der
     EA-Controller-Traversal aufruft (`findSbcController`,
     `findLiveChallenge`, `getControllerChain`), hat einen eigenen
     `catch`-Zweig — konkret: für die drei bekannten Sub-Blöcke `hubScan`,
     `submitInfo`, `launcher` per Regex prüfen, dass zwischen dem jeweiligen
     `(function () {` und dessen schließendem `})()` ein `catch (e)`
     vorkommt (gleiche Extraktionslogik wie in Block 17 — `matchingBrace`
     aus Block 17 wiederverwenden statt neu zu schreiben, Q4).
   Diese Aktion ist der einzige Grund, warum der Diagnose-Kanal selbst
   NICHT unter [[fehler-unsichtbar-verschluckt]] fallen darf: das
   Werkzeug, das EA-Wandel sichtbar machen soll, darf bei genau dieser
   Fehlerklasse nicht selbst lautlos verstummen (kein Toast, kein
   `diagError`, keine Konsolenzeile). **Erwarteter Gain: +2 bis +4 Pt**
   (Kriterium „Abbruch-Disziplin"/Fehlertoleranz gegen EA-Wandel).

**Erwarteter Gesamt-Gain: ~+9.5 Pt RA** (76 → ~85.5, gecappt auf
`structural_max=85`; Summe der Mittelwerte 4+2.5+3=9.5, komfortabel über
dem M3-Ziel-Gain von +6 und über der 90-%-Miss-Risk-Schwelle von +5.4).

## Phasen-Commit-Mapping

| Phase    | Aktionen |
|----------|----------|
| core     | — (leer diese Iteration: die gesamte Code-Geographie dieses Features IST bereits die Diagnose-Ebene, kein separater „Business-Logik"-Layer betroffen) |
| diagnose | Aktion 1 (`lastEligible` additiv in den Report), Aktion 3 Teil A (`submitInfo`-Try/Catch + `onDiagClick`-Absicherung) |
| tests    | Aktion 2 (Symmetrie-Test 3. Richtung + Lesen/Schreiben-Trennung, Block 17), Aktion 3 Teil B (neuer Regressionstest Block 26 für Try/Catch-Disziplin um EA-Controller-Traversal) |
| docs     | `docs/LEARNINGS.md`-Abschnitt: WARUM `lastEligible` bewusst ohne `\|\| null`-Idiom eingebunden wurde (Tri-State-Begründung), WARUM `submitInfo` jetzt wie `hubScan` gekapselt ist (Q7, IST-Zustand, kein „vorher/nachher") |
| release  | `@version`/`const VERSION` bumpen (nächste freie Version über 4.45.0), `node --check` + `node solver-test.js` final grün, Push auf `main` |

## Shared-Item-Bedarf

Ein SI-Kandidat, Details im Sidecar `diagnose-werkzeuge.shared-items.json`:

- **`test-extraktions-helfer`**: Aktion 2 (erweiterter Block 17) und Aktion 3
  (neuer Block 26) lesen beide erneut `ea-fc-sbc-optimizer.user.js` per
  `fs.readFileSync` und schneiden per klammernzählendem `matchingBrace()`
  einen benannten Funktionskörper heraus — exakt das Muster, das laut
  `gaps/_cross-cutting.md` bereits an über 10 Stellen in `solver-test.js`
  über mehrere Features dupliziert ist (SI-Kandidat als „reif" markiert).
  Dieser Plan registriert `diagnose-werkzeuge` deshalb als weiteren
  Konsumenten, statt selbst eine zusätzliche, lokale Kopie der Extraktion
  zu schreiben. **Kein harter Blocker:** ist der Helfer zum Zeitpunkt der
  Umsetzung noch nicht gemergt, nutzt der Implementer das bereits in Block
  17 vorhandene lokale `matchingBrace()` weiter (wie in dieser Iteration
  ohnehin für Aktion 2/3 beschrieben) und markiert die Migration auf den
  Helfer als `surprises[]`-Followup (Q4) für eine Folge-Iteration.

## Risiken / Edge-Cases

- **`\|\| null`-Idiom nicht kopieren (bindend aus dem Gap-Report):** der
  Tri-State von `lastEligible` (`true`/`false`/`null`) geht bei
  `STATE.diag.lastEligible || null` verloren — `false` (der wichtigste
  Fall: EA hat abgelehnt, WEIL der Squad wirklich nicht abgabefähig war)
  würde ununterscheidbar von „nicht geprüft". Aktion 1 verwendet deshalb
  explizit `typeof … !== 'undefined' ? … : null`, keine Abkürzung.
- **Reihenfolge Aktion 2 vor Aktion 1 ist beabsichtigt, nicht zufällig:**
  wird Aktion 1 zuerst umgesetzt und Aktion 2 danach vergessen, bleibt der
  neue Regressionsschutz aus und ein künftiges Feld kann denselben
  `lastEligible`-Fehlerfall unbemerkt wiederholen. Beide Aktionen gehören
  in denselben Lift-Durchlauf, auch wenn sie in unterschiedlichen Phasen-
  Commits (`diagnose` bzw. `tests`) landen.
- **Cleanup-Kind #24:** wird durch Aktion 1 inhaltlich erledigt — beim
  Merge dieses Lift-Plans schließt #24, kein separates Ticket dafür
  aufmachen.
- **`submitInfo`/`launcher`-Try/Catch nicht mit bestehendem `hubScan`
  verwechseln:** `hubScan` liefert bei Fehler bereits `{ error: … }` —
  Aktion 3 spiegelt exakt dieses Muster für `submitInfo`, ändert an
  `hubScan` selbst nichts (bereits konform, kein Ziel dieses Plans).
- **`onDiagClick`-Fallback darf den Report nicht verstummen lassen:** der
  minimale Fallback-Report (`{ version, url, error }`) muss trotzdem
  geloggt UND in die Zwischenablage kopiert werden (dieselben zwei
  Ausgabewege wie der volle Report) — sonst bleibt der Diagnose-Kanal bei
  einem kaputten Feld weiterhin stumm, nur eine Stufe später.
  Regressionstest (Block 26) deckt nur die Try/Catch-Kapselung der
  Sub-Blöcke ab, nicht das Fallback-Verhalten selbst (nicht per Regex
  robust prüfbar) — hier zählt die Implementer-Sorgfalt.
- **Zeilenangaben live gegen v4.45.0 neu verifiziert:** `:4036-4037`
  (`lastEligible`-Einfügestelle), `:2777` (Schreibstelle), `:3942-3950`
  (`submitInfo`), `:4139` (`onDiagClick`), `solver-test.js:1711-1773`
  (Block 17) — falls die tatsächliche Ausführung auf einem anderen
  Live-Stand aufsetzt, sind die Zeilen erneut zu prüfen, die Feldnamen und
  die Struktur der Änderung bleiben gültig.
- **Voller eiserner Arbeitsablauf auch für „nur Diagnose"-Änderungen:**
  jede Aktion löst `node --check`, vollen `solver-test.js`-Lauf und einen
  Versionsbump aus — jeder Push auf `main` ist sofort Deployment auf beide
  Handys (CLAUDE.md).
- **Mid-Iter-G-Vermutung:** keine — beide Aktionen bleiben in der eigenen
  Code-Geographie, kein Cross-Feature-Konflikt zu erwarten (kein anderer
  Iteration-1-Lift-Plan berührt `buildDiagReport`/`onDiagClick`/Block 17).

## Lift-Plan-Pre-Validation (M2)

Dimension RA ist `manual_rubric` (kein `pattern_adoption`-Adapter) —
`pk_files_to_cite` bleibt leer, `citation_only: false` (echte Code-/Test-
Änderungen, keine reine Beleg-Registrierung). `plan estimate
--feature=diagnose-werkzeuge` prüft daher nur `score_target.RA (82) ≤
min(structural_max=85, achievable_ceiling)` sowie die Abwesenheit von
Targets auf nicht-fokussierten Dimensionen (FOCUSED_DIMENSIONS=["RA"],
diese Iteration hat ohnehin nur RA). Erwarteter RA-Endwert aus der Summe
der Aktions-Mittelwerte (4+2.5+3=9.5) auf `score_current.RA=76` ergibt
~85.5, gecappt auf 85 — deutlich über der 90-%-Miss-Risk-Schwelle von
`6 × 0.9 = 5.4` bzw. dem geforderten Gain `+6`.
