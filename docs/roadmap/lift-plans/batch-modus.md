---
feature: batch-modus
iteration: 1
score_current:
  RA: 65
score_target:                              # M3: 65 + (70-65)*0.7 = 68.5 -> 69 (vorgegeben, deckt sich)
  RA: 69
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
patterns_required:                         # formal auf batch-modus anwendbare Patterns, die die
                                           # vier Aktionen inhaltlich reinforcen. PK ist diese
                                           # Iteration NICHT das Ziel (RA-Fokus) -> keine neuen
                                           # Code-Belege, siehe Hinweis in der Marschroute.
  - abbruch-disziplin
  - diagnose-feld-statt-raten
  - strukturierte-ok-why-rueckgabe
  - stille-catches-nur-an-der-ea-grenze
pk_files_to_cite: []
citation_only: false
shared_items_required:
  - test-extraktions-helfer
priority: P2-normal                        # Override der Sigma-Gain-Heuristik (Mittelwerte
                                           # 3.5+5.5+2.5+1.5 = 13 -> Heuristik waere P3-deferred):
                                           # Aktion 2 schliesst ein "Sicherheitsnetz, das an keiner
                                           # Stelle greift" (Gap-Report) direkt am Kern-Anker der
                                           # Feature-Identitaet (jede Wiederholung hat eine eigene
                                           # challengeId, vision/features/batch-modus.md:29) und
                                           # verteidigt damit unmittelbar die "2 von 5 fertig ist
                                           # besser als falsch abgegeben"-Philosophie (CLAUDE.md) -
                                           # das rechtfertigt hoehere Prioritaet als der reine
                                           # Punkte-Gain nahelegt (Override-Klausel im Briefing:
                                           # "z.B. Security-Hotfix").
effort: M                                  # Override in die andere Richtung als die reine
                                           # Gain-Zahl nahelegt (Sigma Gain 13 waere S): Aktionen 1+2
                                           # sind laut Gap-Report echte Verhaltensaenderungen, die
                                           # JEWEILS einen eigenen vorher/nachher-verifizierten
                                           # Testfall brauchen; Aktion 3 verlangt eine Extraktion
                                           # PLUS einen Mock-basierten Ausfuehrungstest einer
                                           # async-DOM-Schleife; Aktion 4 eine Extraktion der
                                           # Ringpuffer-Logik plus Mehrrunden-Testfall. Deutlich mehr
                                           # Pruef-Aufwand als die additiven Ein-Zeiler bei
                                           # spieler-pool (dort effort:S bei aehnlichem Gain).
analyzed_at: '2026-08-15'
---

# Batch-Modus: Abgabe bestätigen, Instanz sperren, Fehlerhistorie verlängern

## Marschroute

Vier additive bis punktuell scharfe Änderungen, ausschließlich in
`ea-fc-sbc-optimizer.user.js` (Batch-Block, ca. Z. 4478–5140) und
`solver-test.js` — keine neue Datei, kein Umbau des Submit-Wegs (Weg 0 über
`UTItemEntityFactory`/`saveChallenge` bleibt unangetastet) und keine
Aufweichung der Abbruch-Philosophie ("2 von 5 fertig" > falsch abgegeben).
Reihenfolge folgt `phase_sequence` aus `vision/features/batch-modus.md`
(`core → diagnose → tests → docs → release`):

1. **`core`** — die zwei Stellen mit echtem Verhaltensrisiko: die
   `usedChallengeIds`-Sperre wird aus einer nur beobachteten in eine
   erzwungene Bedingung verwandelt (Aktion 2), und der Stuck-Recovery-Zweig
   wird verhaltensgleich in eine benannte, pur testbare Helper-Funktion
   extrahiert (Aktion 3, Extraktions-Teil).
2. **`diagnose`** — zwei neue `STATE.diag`-Felder für zwei bislang blinde
   Flecken: `submitConfirmations` (Aktion 1, additive Post-Submit-Prüfung)
   und `batchFailedSteps` (Aktion 4, verlustfreie Fehler-Historie über den
   6er-Ring hinaus).
3. **`tests`** — für Aktion 1+2 je ein Pflicht-Testfall nach der in
   `solver-test.js` Abschnitt 21 etablierten Technik (echte extrahierte
   Funktion + synthetisches `STATE`, kein Brute-Force nötig); für Aktion 3
   Assertions auf die extrahierte Funktion plus ein Mock-Ausführungstest;
   für Aktion 4 ein Mehrrunden-Testfall auf die extrahierte Ringpuffer-Logik.
4. **`docs`** — WARUM-Kommentare (Q6) direkt an den vier neuen/geänderten
   Stellen im Code selbst; ein `docs/LEARNINGS.md`-Eintrag liegt außerhalb
   der `primary_paths` dieses Plans (Vorgabe: nur die zwei Code-Dateien) —
   siehe Risiken.
5. **`release`** — Versionsbump (`@version` + `const VERSION`, aktuell
   4.45.0 im Repo-Snapshot dieses Plans — Implementer prüft vor dem Bump den
   Live-Stand und wählt die nächste freie Version), `node --check`, dann
   `node solver-test.js` komplett grün (bestehende + neue Assertions), Push
   auf `main`.

Vier der fünf formal auf `batch-modus` anwendbaren guten Patterns
([[abbruch-disziplin]], [[diagnose-feld-statt-raten]],
[[strukturierte-ok-why-rueckgabe]], [[stille-catches-nur-an-der-ea-grenze]])
leiten die vier Aktionen inhaltlich an (siehe unten je Aktion) — diese
Iteration entstehen dafür KEINE neuen Code-Belege (`pk_files_to_cite: []`,
PK ist nicht das Ziel dieser RA-fokussierten Iteration). Ein fünftes Pattern
([[ea-grenz-fallback-ketten]]) ist zwar anwendbar, wird aber von keiner der
vier Aktionen berührt (keine neue Fremd-Grenzen-Kette) und ist deshalb nicht
gelistet.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **Additive Post-Submit-Plausibilisierung** (`ea-fc-sbc-optimizer.user.js`,
   `submitChallengeToEa()`, „ohne Response"-Zweig `:4536-4539`):
   - Nach `STATE.diag.submitWithoutResponseCount = (...) + 1;` (`:4537`) und
     VOR `return { via: 'controller' };` (`:4539`) zusätzlich: kurz warten
     (`await batchWait(400)`, `batchWait` bereits definiert `:4367`), danach
     `liveSquad.isSquadEmpty()` erneut lesen — analog zum bereits
     bestehenden Muster in `openNextInstance` (`:4605-4606`,
     `try { if (sq && typeof sq.isSquadEmpty === 'function') empty = sq.isSquadEmpty(); } catch (e) {}`).
     Der `try/catch` bleibt bewusst leer (Fremd-Grenze: `liveSquad` ist ein
     EA-Objekt, [[stille-catches-nur-an-der-ea-grenze]]).
   - Ergebnis in ein neues Ringpuffer-Feld schreiben:
     `STATE.diag.submitConfirmations = (STATE.diag.submitConfirmations || []).concat([{ via: cand.w + '.' + cand.m, hadResponse: false, squadEmptyAfter: squadEmptyAfter, ms: <verstrichene ms> }]).slice(-6)`.
   - `submitConfirmations: null` in der `STATE.diag`-Deklaration ergänzen
     (neben `submitWithoutResponseCount`, `:130-131`) und in
     `buildDiagReport()` auslesen (neben `submitWithoutResponseCount`,
     `:3905-3909`) — [[diagnose-feld-statt-raten]]. Beide Ergänzungen sind
     PFLICHT: der bestehende Symmetrie-Test (`solver-test.js:1711-1773`,
     „gelesen <-> deklariert <-> zugewiesen") schlägt sonst automatisch fehl.
   - **Kein `throw`/Retry** allein wegen `squadEmptyAfter === false` — reine
     Beobachtung ([[abbruch-disziplin]] bleibt unverändert: der bestehende
     Rückgabewert `{ via: 'controller' }` ändert sich nicht). Der
     Edge-Case aus dem Gap-Report (False-Positive durch Netzwerk-Race/noch
     nicht aktualisiertes Squad-Objekt) ist damit strukturell ausgeschlossen,
     solange dieses Verbot nicht später aufgeweicht wird (siehe Risiken).
   - **Pflicht-Testfall** (`solver-test.js`, Technik aus Abschnitt 21): die
     extrahierte `submitChallengeToEa`-Logik des „ohne Response"-Zweigs mit
     einem Mock-`liveSquad` sowohl für `isSquadEmpty() === true` als auch
     `=== false` durchspielen; Assertion, dass in BEIDEN Fällen `{ via: 'controller' }`
     zurückkommt (kein Verhaltensunterschied) und `submitConfirmations`
     das jeweils korrekte `squadEmptyAfter` trägt.
   - **Erwarteter Gain: +3 bis +4** (Kriterium „Beobachtbarkeit" — schließt
     die im Post-Iter-0-Audit benannte Restlücke: „ob eine Abgabe ohne
     Response wirklich griff, bleibt offen, nur messbar statt geprüft").

2. **`usedChallengeIds` als echte Sperre in die Match-Bedingung** (`ea-fc-sbc-optimizer.user.js`,
   `openNextInstance()`, `:4607`):
   - Die vorhandene Bedingung
     `if (ctrl && sq && matchesPlannedSbc(plan) && empty !== false) {`
     um die Sperre ergänzen. **Engineering-Präzisierung gegenüber dem
     Gap-Report:** statt die Sperre als weiteren `&&`-Term direkt inline zu
     ergänzen (was für den Pflicht-Testfall entweder die Bedingung ein
     zweites Mal im Test nachbauen würde — Verstoß gegen [[strukturierte-ok-why-rueckgabe]]s
     Nachbarprinzip „keine separat gepflegte Kopie" bzw. Q4/DRY — oder
     `openNextInstance` als Ganzes mit vollem DOM-Mocking ausführen müsste),
     die kombinierte Bedingung in eine kleine, reine Helper-Funktion
     extrahieren: `function isFreshMatchingInstance(plan, sbcState, squadEmpty) { return !!(matchesPlannedSbc(plan) && squadEmpty !== false && (plan.usedChallengeIds || []).indexOf(String(sbcState.challengeId)) === -1); }`
     direkt unterhalb von `matchesPlannedSbc` (`:4951-4955`) platzieren;
     `openNextInstance` ruft dann `if (ctrl && sq && isFreshMatchingInstance(plan, STATE.sbc, empty)) {`
     auf. Reine Umformung derselben Boole'schen Logik — kein
     Verhaltensunterschied ggü. der im Gap-Report vorgeschlagenen Inline-Version,
     aber jetzt echt und ohne Duplikat testbar (Q3, Q4).
   - **Pflicht-Testfall** (Muster Abschnitt 21, echte extrahierte Funktion):
     - Sperr-Fall: `plan.usedChallengeIds = ['777']`, `STATE.sbc = { challengeId: '777', targetOVR: 84, formationSlots: 11 }`,
       `plan = { targetOVR: 84, slots: 11 }`, `squadEmpty = true` →
       `isFreshMatchingInstance(...) === false`, OBWOHL `matchesPlannedSbc`
       allein `true` liefern würde (genau die im Gap-Report geforderte
       Assertion „`false` trotz sonst passendem targetOVR/formationSlots").
     - Normalfall (Re-Plan-Edge-Case aus dem Gap-Report): `plan.usedChallengeIds = []`
       (frischer Plan, wie `onBatchPlanClick` ihn bei `:4975` initialisiert),
       gleiche sonstigen Werte → `isFreshMatchingInstance(...) === true`
       — verhindert, dass die neue Sperre den allerersten Batch-Schritt
       fälschlich blockiert.
     - Begleitender statischer Regressions-Check (Stil wie
       `solver-test.js:2019-2024`): `onBatchPlanClick`-Quelltextausschnitt
       enthält weiterhin `plan.usedChallengeIds = []` — schützt genau den
       Re-Plan-Edge-Case aus dem Gap-Report davor, dass ein künftiger
       Refactor den Reset stillschweigend entfernt.
   - **Erwarteter Gain: +5 bis +6** (schließt eine bislang nur beobachtete,
     nie erzwungene Abbruch-Disziplin-Lücke am Kern-Anker — die
     Betriebsregel „jede Wiederholung hat eine eigene `challengeId`",
     `vision/features/batch-modus.md:29`).

3. **Verhaltenstest statt String-Grep für den Stuck-Recovery-Zweig** (`ea-fc-sbc-optimizer.user.js`,
   `openNextInstance()`, `:4636-4640`):
   - Die Bedingung `if (ctrl && (i === 5 || i === 25)) {` in eine benannte,
     pure Helper-Funktion extrahieren: `function shouldTryBack(i) { return i === 5 || i === 25; }`
     (z.B. direkt vor `clickBackButton`, `:4902`), Aufrufstelle wird
     `if (ctrl && shouldTryBack(i)) {`. Reine Extraktion, KEINE
     Ablaufsemantik-Änderung (Vorher/Nachher identisch — Q2).
   - **Testfall A** (direkt, kein Extraktions-Aufwand nötig, da die
     Funktion jetzt eigenständig ist): `shouldTryBack(5) === true`,
     `shouldTryBack(25) === true`, `shouldTryBack(6) === false`,
     `shouldTryBack(0) === false`.
   - **Testfall B** (Muster Abschnitt 21/22, via `test-extraktions-helfer`
     sobald gemergt — siehe Shared-Item-Bedarf unten): den
     `openNextInstance`-Ausschnitt (dieselben Grenzen wie im bestehenden
     statischen Check, `solver-test.js:2019-2020`:
     `src.indexOf('async function openNextInstance')` bis
     `src.indexOf('function clickLike')`) mit `new Function(...)` kompilieren
     und dabei ALLE modul-eigenen Helfer als Parameter durchreichen
     (`dismissRewardPopup`, `syncSbcWithOpenChallenge`, `findSbcController`,
     `popupState`, `clickSetTile`, `clickAllFilter`, `clickChallengeRow`,
     `clickBackButton`, `setLooksRepeatable`, `matchesPlannedSbc`/
     `isFreshMatchingInstance`, `batchWait`, `STATE`) — als Mocks: `ctrl`
     bei `i===5` noch vorhanden (damit der `shouldTryBack`-Zweig überhaupt
     erreicht wird), `clickBackButton` liefert `{ ok: true }`, `ctrl`
     danach (ab `i===6`) `null` (simuliert den Rücksprung in den Hub),
     `clicked = false` gesetzt lassen. Da `wentBack` eine lokale Variable
     ohne eigenen Rückgabewert ist, wird sie INDIREKT über ihren
     dokumentierten Seiteneffekt geprüft: die Bedingung bei `:4686`
     (`(!ctrl && (clicked || wentBack) && (i === 10 || i === 25))`) darf
     `clickChallengeRow` NUR erreichen, wenn `wentBack` korrekt gesetzt
     wurde (da `clicked` hier bewusst `false` bleibt) — Assertion: der
     Mock von `clickChallengeRow` wird bei `i === 10` aufgerufen. Das ist
     eine echte, aber indirekte Verhaltens-Assertion (kein `wentBack`-Getter
     nötig, keine Produktionscode-Änderung nur für Testbarkeit).
   - Falls `test-extraktions-helfer` (SI) zum Implementierungszeitpunkt noch
     nicht gemerged ist: Fallback ist die lokale `extractFn`-Kopie aus
     Abschnitt 21 (`solver-test.js:1942-1951`) wiederverwenden/erneut
     inline definieren — MUSS nach dem SI-Merge durch den zentralen Helfer
     ersetzt werden (kein dauerhaftes Duplikat, Q4).
   - **Erwarteter Gain: +2 bis +3** (Kriterium „Testbarkeit" — ersetzt den
     reinen Text-Match `solver-test.js:2023-2024` durch eine echte
     Verhaltens-Prüfung; Rasmus' bisheriger Beleg war ein einzelner
     dokumentierter Live-Vorfall, `:4611-4617`).

4. **`batchSteps`-Ringpuffer um verlustfreie Fehler-Historie erweitern**
   (`ea-fc-sbc-optimizer.user.js`, `onBatchRunClick()`, `:5098-5100`):
   - Die bestehende Ringpuffer-Zeile
     `STATE.diag.batchSteps = (STATE.diag.batchSteps || []).concat([{round, ok: next.ok, steps: next.steps}]).slice(-6);`
     bleibt unverändert (kein Verhaltenswechsel der Batch-Logik). Additiv:
     die Aktualisierungslogik in eine kleine, reine Reducer-Funktion
     extrahieren, z.B. `function recordBatchStep(diag, round, next) { diag.batchSteps = (diag.batchSteps || []).concat([{ round: round, ok: next.ok, steps: next.steps }]).slice(-6); if (!next.ok) { diag.batchFailedSteps = (diag.batchFailedSteps || []).concat([{ round: round, ok: next.ok, steps: next.steps }]).slice(-30); } }`
     — pure Datentransformation ohne DOM-/Netzwerkabhängigkeit, dadurch
     isoliert testbar ohne den Kontrollfluss von `onBatchRunClick`
     (inkl. dessen `throw` bei Fehlschlag) nachzubauen. `onBatchRunClick`
     ruft `recordBatchStep(STATE.diag, i + 1, next)` statt der Inline-Zeile.
   - `batchFailedSteps: null` in der `STATE.diag`-Deklaration ergänzen
     (neben `batchSteps`, `:125`) und in `buildDiagReport()` auslesen
     (neben `batchSteps`, `:3889`) — dieselbe Symmetrie-Pflicht wie bei
     Aktion 1 (`solver-test.js:1711-1773`).
   - Obergrenze `30` statt „unbegrenzt": endlich, aber deutlich großzügiger
     als der 6er-Ring, analog zum bestehenden Vorbild `lastErrors`
     (Cap 24, `:138`). Bei maximal 10 Batch-Runden (`Math.min(10, ...)`,
     `:4965`, also max. 9 `openNextInstance`-Aufrufe pro Lauf) UND
     Akkumulation über mehrere Batch-Läufe hinweg (der Ring wird nie
     zurückgesetzt) bleibt damit selbst über viele aufeinanderfolgende
     Läufe in einer Session genug Headroom.
   - **Pflicht-Testfall**: `recordBatchStep` per Marker-Extraktion (Abschnitt
     21/`test-extraktions-helfer`-Technik) mit einer synthetischen Folge von
     mehr als 6 Aufrufen füttern, darunter EINER früh mit `next.ok === false`
     (simuliert Runde 2 von z.B. 9) — Assertion: nach 6+ weiteren Aufrufen
     ist Runde 2 aus `batchSteps` (6er-Ring) verschwunden, aber weiterhin in
     `batchFailedSteps` auffindbar.
   - **Präzisierung ggü. dem Gap-Report:** das dortige Beispiel „Runde 9 von
     12" ist mit dem tatsächlichen Batch-Maximum von 10 Runden (`:4965`)
     nicht exakt erreichbar (max. 9 `openNextInstance`-Aufrufe pro Lauf) —
     der Kernbefund bleibt trotzdem gültig: entweder innerhalb eines langen
     Laufs (frühe Runde mit `ok:true`, aber mit einem `stuck`/`back`-Eintrag
     in `steps`, verdrängt bevor eine spätere Runde `!ok` wird) oder über
     MEHRERE Batch-Läufe in derselben Session hinweg (der Ring wird
     zwischen Läufen nie zurückgesetzt).
   - **Erwarteter Gain: +1 bis +2** (Kriterium „Beobachtbarkeit bei langen
     Batches").

## Phasen-Commit-Mapping

| Phase    | Aktionen |
|----------|----------|
| core     | Aktion 2 (`isFreshMatchingInstance`-Extraktion + Sperre in `openNextInstance`, `:4607`), Aktion 3 Extraktions-Teil (`shouldTryBack`-Helper) |
| diagnose | Aktion 1 (`submitConfirmations`-Feld + additive Post-Submit-Prüfung), Aktion 4 (`recordBatchStep`-Extraktion + `batchFailedSteps`-Feld) |
| tests    | Aktion 1 Pflicht-Testfall (Mock-`liveSquad`), Aktion 2 Pflicht-Testfälle (Sperr-Fall + Normalfall + Re-Plan-Regression), Aktion 3 Testfälle A+B (`shouldTryBack` + Mock-Ausführung), Aktion 4 Mehrrunden-Testfall |
| docs     | WARUM-Kommentare (Q6) an den vier neuen Code-Stellen (kein `docs/LEARNINGS.md`-Eintrag in diesem Plan — außerhalb der vorgegebenen `primary_paths`, siehe Risiken) |
| release  | Versionsbump (`@version` + `const VERSION`, nächste freie Version), `node --check ea-fc-sbc-optimizer.user.js`, `node solver-test.js` (alle Tests grün), Push auf `main` |

## Shared-Item-Bedarf

**`test-extraktions-helfer`** (`extractFunction(src, startMarker[, endMarker])`
in `solver-test.js`) — Aktion 3 (Testfall B: `openNextInstance`-Extraktion
mit Mock-Helfern) und Aktion 4 (Testfall: `recordBatchStep`-Extraktion) sind
Konsumenten. Der Marker-/Literal-Extraktions-Boilerplate
(`src.indexOf('function X')` → Textblock ausschneiden → `new Function(...)`)
existiert in `solver-test.js` bereits elffach von Hand nachgebaut
(`docs/roadmap/patterns/aspects/aspect-tests.md`, Antipattern „Wiederholtes
Neu-Einlesen der Zieldatei"); ein gemeinsamer Helfer verhindert, dass dieser
Lift zwei weitere Kopien hinzufügt. Reihenfolge-Abhängigkeit: das SI muss
VOR diesem Feature-Lift gemergt sein, damit Aktion 3/4 ihn direkt nutzen
können (`depends_on` in der späteren Ticket-Erstellung); liegt das SI beim
Implementieren noch nicht vor, ist die lokale `extractFn`-Kopie aus
Abschnitt 21 (`solver-test.js:1942-1951`) der dokumentierte Übergangs-Fallback
(muss nach SI-Merge ersetzt werden, kein Dauerzustand). Details im
JSON-Sidecar `batch-modus.shared-items.json`.

## Risiken / Edge-Cases

- **Additive Plausibilisierung darf keine neue Abbruchquelle werden**
  (Aktion 1, aus dem Gap-Report übernommen): solange kein zweiter
  Live-Beleg vorliegt, dass `isSquadEmpty() === false` nach einem
  „ohne Response"-Submit tatsächlich einen Fehlschlag bedeutet, darf die
  neue Prüfung NICHT selbst zu `throw`/Retry führen — ein False Positive
  (Netzwerk-Race, Squad-Objekt noch nicht aktualisiert) würde sonst einen
  bislang erfolgreichen Batch-Lauf unnötig stoppen und die „2 von 5 fertig"-
  Philosophie ins Gegenteil verkehren. Der Implementer darf diesen Zweig NUR
  additiv (kein Rückgabewert-/Kontrollfluss-Wechsel) umsetzen; jeder Versuch,
  hier doch abzubrechen, ist ein Q2-Verstoß (Quick-Fix ohne Live-Beleg) und
  gehört als eigenes, separat begründetes Folge-Ticket behandelt, nicht in
  diesen additiven Lift gequetscht.
- **`usedChallengeIds`-Sperre darf den allerersten Plan-Schritt nicht
  blockieren** (Aktion 2, aus dem Gap-Report übernommen): der Re-Plan-Fall
  (`onBatchPlanClick` setzt `plan.usedChallengeIds = []` bei `:4975`) ist
  im Pflicht-Testfall explizit als Normalfall mitzuprüfen, nicht nur der
  Sperr-Fall — sonst könnte die neue Bedingung eine an sich passende erste
  Instanz fälschlich ablehnen.
- **Extraktion in Aktion 2/3/4 ist Verhaltens-neutral, keine Fach-Änderung**
  über die explizit gewollte Sperre in Aktion 2 hinaus: `isFreshMatchingInstance`,
  `shouldTryBack` und `recordBatchStep` dürfen NUR die bestehende Logik
  umbenennen/isolieren (plus die eine gewollte neue Bedingung in Aktion 2) —
  jede zusätzliche Verhaltensänderung während der Extraktion wäre ein
  Q2/Q3-Verstoß (ungeplanter Nebeneffekt), der Implementer muss dies als
  `aborted-quality-violation` melden statt stillschweigend mitzuliefern.
- **Zahlen-Präzisierung bei Aktion 4:** das Gap-Report-Beispiel „Runde 9 von
  12" ist mit dem realen Batch-Maximum (10 Runden, `:4965`) nicht exakt
  erreichbar — der Testfall muss die reale Konstellation abbilden (früh
  scheiternde/instabile Runde plus mehr als 6 nachfolgende Einträge, ggf.
  über mehrere simulierte Batch-Läufe hinweg, da `batchSteps`/`batchFailedSteps`
  session-weit nie zurückgesetzt werden), nicht die im Report genannte,
  faktisch unerreichbare Rundenzahl.
- **`docs/LEARNINGS.md` bleibt außerhalb der `primary_paths`:** dieser Plan
  ist auf `ea-fc-sbc-optimizer.user.js` + `solver-test.js` beschränkt
  (Vorgabe). Die RA-Rubrik „Dokumentierte Begründung" wird deshalb diese
  Iteration ausschließlich über WARUM-Kommentare direkt im Code bedient,
  nicht über einen neuen LEARNINGS-Abschnitt. Ein LEARNINGS-Eintrag (nächste
  freie Nummer, aktuell endet die Datei bei `## 32.`) wäre inhaltlich
  sinnvoll — Main kann das bei Bedarf als separaten Doku-Schritt nachziehen.
- **Submit-Weg 0 und Abbruch-Philosophie unangetastet:** keine der vier
  Aktionen ändert `submitChallengeToEa()`s Rückgabepfade, den
  `UTItemEntityFactory`/`saveChallenge`-Weg oder das Grundprinzip „bei jeder
  Unstimmigkeit sofort und erklärend abbrechen" — alle vier sind additiv
  bzw. schärfen eine bereits vorgesehene, aber bisher wirkungslose Bedingung
  (Aktion 2).
- **Kein Mid-Iter-SI außer dem bereits bekannten Kandidaten:** `gaps/_cross-cutting.md`
  markiert `test-extraktions-helfer` bereits als „SI reif" mit
  batch-modus als einem von mehreren Konsumenten — kein neuer,
  bisher unbekannter Shared-Item-Bedarf aus dieser Iteration.

## Lift-Plan-Pre-Validation (M2)

`pk_files_to_cite: []`, keine PK-Aktion enthalten — die Prüfung betrifft nur
`score_target.RA (69) ≤ min(structural_max=70, achievable_ceiling)` sowie das
Fehlen von Targets auf nicht-fokussierten Dimensionen (`FOCUSED_DIMENSIONS: ["RA"]`,
diese Dimension ist fokussiert, kein `pk_exempt`-Kandidat betroffen). Erwarteter
RA-Endwert aus Summe der Aktions-Mittelwerte (3.5 + 5.5 + 2.5 + 1.5 = 13) auf
`score_current.RA = 65` ergibt 78, komfortabel über `score_target.RA × 0.9 = 62.1` —
selbst bei konservativer Wertung (nur die unteren Bandenden 3+5+2+1 = 11) bleibt
`65 + 11 = 76 ≥ 62.1`.
