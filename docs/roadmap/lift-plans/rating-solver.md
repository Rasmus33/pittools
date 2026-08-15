---
feature: rating-solver
iteration: 1
score_current:
  RA: 89
score_target:
  RA: 90
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
patterns_required:
  - warum-kommentare-mit-live-belegen
  - eingebetteten-code-exakt-testen
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P3-deferred
effort: S
analyzed_at: 2026-08-15
---

# Rating-Solver: Toten Duplikat-Tiebreak bereinigen, Suchgrenzen belegen

## Entscheidung: Bereinigen statt Dokumentieren

Der Gap-Report (Iteration 1) belegt strukturell UND per Live-Reproduktion,
dass der Duplikat-Stapelgrößen-Tiebreak in `makeConsumeCmp`
(`ea-fc-sbc-optimizer.user.js:1493-1509`) nie feuern kann: beide Aufrufer
(`:1982` `makeConsumeCmp(pool)`, `:2212` `makeConsumeCmp(avail)`) bekommen
ausschließlich pro `assetId` bereits deduplizierte Listen — die
SPIELER-EINDEUTIGKEIT (`:1930-1953`, `:1960-1978`) läuft VOR jedem Aufruf von
`makeConsumeCmp` und lässt strukturell genau eine Karte pro `assetId` übrig.
`counts.get(k)` ist damit für jeden Schlüssel konstant `1`, die Differenz
immer `0`. Das ist kein Wahrscheinlichkeits-, sondern ein Reihenfolge-Beweis
(Dedupe läuft zeitlich vor Tiebreak-Aufruf) — Entfernen ist per Definition
verhaltensneutral, **wenn** der Beweis im Test steht (Brute-Force-/Suite-Parität
vorher=nachher). Dieselbe Situation wurde in derselben Iteration bei
`WASTE_WEIGHT`/`priorityOf` bereits korrekt als tot erkannt und entfernt
(LEARNINGS §28) — dieser Lift zieht den Rest desselben Musters nach (Q6/Q7:
zwei Kommentarstellen behaupten aktuell ein Verhalten, das nicht eintreten
kann).

Gewählt: **(a) Bereinigen.** Nicht (b) Dokumentieren-als-bewusst-tot, weil
kein Aufrufer mit nicht-deduplizierter Liste denkbar ist, ohne die
SPIELER-EINDEUTIGKEIT selbst zu umgehen (die wiederum durch HTTP-460-Schutz
hart erzwungen ist, LEARNINGS-Referenz `:1793-1801`/heute `:1921-1929`) — ein
"Defense-in-Depth"-Argument für (b) hätte hier keine reale Grundlage, es
würde nur toten Code stehen lassen. Die Bereinigung ersetzt zusätzlich den
vakuum-wahren Test 6 durch einen echten Dedupe-Verhaltenstest, statt ihn
unangetastet zu lassen — sonst bliebe die zweite Hälfte des Gap-Fundes
(irreführender Testname) unadressiert.

## Marschroute

Drei eng verwandte Hygiene-Funde aus dem Gap-Report, alle additiv/entfernend,
keine Berührung der geschützten Rating-Formel/des V-Maßes:

1. **core** — toten Tiebreak samt beider irreführender Kommentare entfernen;
   WARUM-Kommentar für die unbelegten Suchgrenzen-Magic-Numbers (`1300`,
   `900`) ergänzen (reine Herleitung, keine Wertänderung).
2. **diagnose** — Erschöpfung des internen Suchfensters (`stHardCap`) als
   eigenes Diagnose-Signal von echter Unlösbarkeit unterscheiden.
3. **tests** — Test 6 durch einen echten Dedupe-Verhaltenstest ersetzen;
   volle Suite vor UND nach dem Tiebreak-Schnitt grün als Neutralitätsbeleg;
   neuer Test für das Diagnose-Signal aus Schritt 2.
4. **docs** — LEARNINGS.md-Eintrag (nächster freier Abschnitt nach §32) +
   Versionsbump (`@version`/`const VERSION`: `4.45.0` → `4.46.0`).
5. **release** — Push auf `main` (Deployment). Schließt Cleanup-Kind #26
   beim Merge.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **Toten Duplikat-Stapel-Tiebreak entfernen
   (`ea-fc-sbc-optimizer.user.js:1493-1509`, `:1677`, `:1982`, `:2212`):**
   `counts`-Map und die zweite Vergleichszeile
   (`return (counts.get(kb) || 0) - (counts.get(ka) || 0);`) aus
   `makeConsumeCmp` streichen, Funktion braucht dann keinen `list`-Parameter
   mehr — auf `makeConsumeCmp()` kürzen und beide Aufrufer (`:1982`, `:2212`)
   entsprechend anpassen (kein Verhaltensunterschied, da der Rückgabewert nur
   noch von `priorityOf(a) - priorityOf(b)` abhängt). Kommentar `:1493-1495`
   auf die tatsächlich lebendige Priorität kürzen und durch einen kurzen
   WARUM-Verweis ersetzen ("kein Duplikat-Tiebreak nötig — SPIELER-EINDEUTIGKEIT
   `:1921-1929` lässt hier strukturell nur eine Karte pro assetId zu"; Q6
   Hidden-Invariante). Kommentar `:1677` ("Konsum-Präferenz (Storage,
   Duplikat-Stapel) als Tiebreak") auf "Konsum-Präferenz (Storage) als
   Tiebreak" kürzen. **Pflicht-Beleg der Verhaltensneutralität:**
   `node solver-test.js` muss unmittelbar VOR dem Schnitt (aktueller Stand:
   354/354 grün) und unmittelbar DANACH (siehe Aktion 3) exakt denselben
   Zählerstand liefern — kein Testfall darf durch den Schnitt umschlagen.
   Erwarteter Gain: +1 Pt RA (Testbarkeit/Dokumentierte Begründung: schließt
   einen live-verifizierten Q6/Q7-Verstoß an zwei Stellen).

2. **Test 6 (`solver-test.js:220-231`) durch echten Dedupe-Verhaltenstest
   ersetzen:** Der bisherige Test prüft nur, dass nach der (an anderer Stelle
   bereits getesteten) Spieler-Eindeutigkeits-Dedupe 10 Duplikate auf 1
   kollabieren — vakuum-wahr bezüglich des behaupteten Stapelgrößen-Tiebreaks.
   Ersatz: zwei gezielte Assertions gegen die tatsächlich lebendige
   `dupeScore`-Rangfolge (`ea-fc-sbc-optimizer.user.js:1932-1939`) — (a) 10
   Duplikate-plus-1-Alternative desselben `assetId` kollabieren nachweislich
   auf genau 1 Kandidaten (`res.poolInfo.count` prüfen, nicht nur
   Team-Zusammensetzung — deckt den in der Gap-Reproduktion gezeigten Fall
   `count===17` statt `26` direkt ab); (b) zwei Duplikate desselben `assetId`
   mit unterschiedlichem Storage-Flag UND gegenläufigem Rating (Storage
   niedriger bewertet als Nicht-Storage) — `dupeScore` muss die
   Storage-Karte behalten, weil Storage (+10) in der Rangfolge NICHT gegen
   Rating aufgewogen wird, sondern als eigene, höhere Stufe zählt. Testname
   ändert sich von "Duplikat-Stapel: vom größten Stapel zuerst" auf etwas wie
   "Spieler-Dedupe: dupeScore-Rangfolge entscheidet, nicht Stapelgröße".
   Edge-Case-Pflicht (Gap-Report): vor dem Umbau prüfen, dass die bisherige
   Teil-Deckung (10→1-Kollaps) nicht ersatzlos verschwindet — Assertion (a)
   übernimmt das explizit, zusätzlich bleibt `solver-test.js:820-855`/
   `:857-919` als bestehende Dedupe-Abdeckung unverändert bestehen. Erwarteter
   Gain: +0.5-1 Pt RA (Testbarkeit: keine vakuum-wahre Assertion mehr in der
   Suite).

3. **WARUM-Kommentar + Diagnose-Unterscheidung für die Suchgrenzen
   (`ea-fc-sbc-optimizer.user.js:2405-2406`, `:2455`, `:2504`):** Kommentar
   nach dem Muster [[warum-kommentare-mit-live-belegen]] ergänzen, der
   herleitet, warum `sMaxLow`/`sMaxHigh` (`Math.min(..., 1300)`, `:2405-2406`)
   und `stHardCap = stLow + 900` (`:2455`) für die aktuell einzige
   Aufrufer-Konfiguration ausreichen: Formationsgröße `N ≤ 11`, praktischer
   Rating-Bereich 75-99 → maximale Summenspanne `11 × 24 = 264 ≪ 900`. Rein
   additiv, **keine Wertänderung** an `1300`/`900` (Auftrag: Herkunft
   belegen, nicht neu kalibrieren). Zusätzlich bei `:2503-2504`: wenn
   `stHardCap` erreicht wird, OHNE dass Phase 1 (`vBound`) je eine machbare
   Lösung fand, ein `warnings`-Flag setzen ("internes Suchfenster
   ausgeschöpft, echtes Optimum evtl. außerhalb — SBC evtl. lösbar mit
   größerem Suchfenster") statt die pauschale Meldung "Ziel-OVR X ist mit dem
   aktuellen Pool nicht erreichbar" unverändert durchzureichen für genau
   diesen Fall; der Report unterscheidet damit "SBC mit diesem Pool
   tatsächlich unlösbar" von "Suchgrenze ausgeschöpft" (RA-Rubric
   Beobachtbarkeit). Kein Eingriff in die geschützte Rating-Formel/das
   V-Maß. Erwarteter Gain: +1 Pt RA (Beobachtbarkeit — aktuell einziger
   unbelegter Magic-Number-Fall im sonst durchgängig belegten Modul).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 1 (toten Tiebreak + `counts`-Map entfernen, `makeConsumeCmp()`-Signatur kürzen, beide Aufrufer + zwei Kommentare korrigieren); Aktion 3 WARUM-Kommentar-Teil (Suchgrenzen-Herleitung, additiv, keine Wertänderung) |
| diagnose | Aktion 3 Diagnose-Teil (`warnings`-Flag bei `stHardCap`-Erschöpfung ohne `vBound`, Unterscheidung im Fehlerpfad `:2503-2504`) |
| tests | Aktion 2 (Test 6 ersetzen durch dupeScore-Rangfolge- + Kollaps-Assertions); `node solver-test.js` vor UND nach Aktion 1 als Neutralitätsbeleg; neuer Test für das Diagnose-Signal aus Aktion 3 (stHardCap-Erschöpfung triggert das Flag, ein normal-unlösbarer kleiner Pool NICHT) |
| docs | `docs/LEARNINGS.md`-Eintrag (nächster freier Abschnitt nach §32): WARUM der Tiebreak tot war und entfernt wurde (Reihenfolge-Beweis, analog §28), WARUM `900`/`1300` ausreichen (Herleitung aus `N≤11`/Rating-Bereich), WARUM die neue Diagnose-Unterscheidung eingeführt wurde. `@version`/`const VERSION` `4.45.0` → `4.46.0` |
| release | Push auf `main` (Deployment = eiserner Arbeitsablauf CLAUDE.md). Cleanup-Kind #26 beim Merge schließen |

## Shared-Item-Bedarf

`aspect-tests.md` (Iteration 0) hat einen genuinen ≥2-Feature-Kandidaten
identifiziert: `solver-test.js` UND `app/guard-test.js` implementieren beide
unabhängig voneinander "Datei einlesen, Text zwischen zwei Markern
herausschneiden" (Regex-Marker im Userscript, feste Java-String-Literale in
`MainActivity.java`) — dasselbe Grundprinzip aus
[[eingebetteten-code-exakt-testen]] (`applies_to_features:
[rating-solver, android-app-wrapper, bedienpanel-ui]`), zweimal unabhängig
gebaut. Dieser Lift-Plan selbst braucht den Helper nicht zwingend (Aktion 1-3
ändern nur Assertions/Kommentare innerhalb des bestehenden Extraktions-Codes),
aber da laut Kontext ein SI `test-extraktions-helfer` parallel geplant ist
(vermutlich vom `android-app-wrapper`-Lift), wird der Bedarf hier als
Konsument gegengezeichnet, damit `gap_aggregator.py` beide Vorschläge unter
demselben Slug bündelt. Siehe `rating-solver.shared-items.json`.

## Risiken / Edge-Cases

- **Der wichtigste Fehlerfall widerlegt die eigene Grundannahme:** Sollte
  `node solver-test.js` nach dem Schnitt in Aktion 1 NICHT mehr 354/354 grün
  sein, ist der Tiebreak entgegen der Gap-Analyse doch erreichbar — Aktion 1
  sofort zurückrollen, Gap-Report als falsifiziert markieren, NICHT den Test
  anpassen, um wieder grün zu werden (Q2: kein Symptom-Fix am Test).
- **Test-6-Umbau darf keine Deckung verlieren** (Gap-Report-Edge-Case):
  vor dem Streichen der alten Assertion prüfen, dass die 10-Duplikate-→-1-
  Kollaps-Prüfung in der neuen Assertion (a) tatsächlich weiterläuft und
  nicht nur implizit über `solver-test.js:820-855`/`:857-919` "mitgetestet"
  wird — die dortigen Szenarien sind Anker-/Rarity-getrieben, nicht die reine
  Mengen-Reduktion ohne Vorgabe wie in Test 6.
- **Das neue `warnings`-Flag (Aktion 3) kann bestehende Assertions auf
  `warnings.length` oder exakten `res.reason`-Wortlaut brechen**, falls ein
  Test aktuell auf die alte, undifferenzierte Meldung prüft — vor dem
  Hinzufügen alle bestehenden `reason`/`warnings`-Assertions in
  `solver-test.js` grep-prüfen, nicht blind ergänzen.
- **`docs/LEARNINGS.md` und der Versionsbump liegen außerhalb der
  `primary_paths`-Liste** (Vorgabe: NUR `ea-fc-sbc-optimizer.user.js` +
  `solver-test.js`), sind aber laut CLAUDE.md eiserner Arbeitsablauf für
  jede Solver-Änderung PFLICHT — die docs/release-Phasen berühren sie
  trotzdem; das ist bewusst kein primary_paths-Konflikt (kein zweiter
  Lift-Plan dieser Iteration beansprucht `docs/LEARNINGS.md`).
- **Mid-Iter-SI-Vermutung (Klasse G):** Falls beim Umbau von Test 6 auffällt,
  dass `app/guard-test.js` dieselbe Rangfolgen-Prüf-Logik (Score-Tiers statt
  linearer Werte) ebenfalls bräuchte, wäre das ein zusätzlicher Hinweis auf
  den oben genannten SI-Kandidaten — kein Grund, ihn in diesem kleinen Lift
  selbst zu bauen.

## Lift-Plan-Pre-Validation (M2)

Plugin prüft deterministisch via `plan estimate --feature=rating-solver`:
`pk_files_to_cite` ist leer (keine PK-Aktion in diesem Plan, Dimension-Fokus
ist ausschließlich RA), `score_target.RA: 90 ≤ structural_max.RA: 95`. RA ist
`manual_rubric` (kein deterministischer PK-Divisor) — die Schätzung erfolgt
hier über die Reasoning-Fallback-Bewertung des `audit-evaluator`, nicht über
`plan estimate`s PK-Formel.
