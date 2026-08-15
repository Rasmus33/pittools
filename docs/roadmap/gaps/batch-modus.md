---
feature: batch-modus
analyzed_at: 2026-08-15
iteration: 1
regression: false
score_current:
  RA: 65
score_target:
  RA: 69
---

# Gap-Report — Batch-Modus (Mehrfach-Abgabe)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 65 / 70
**Schwellwert:** 49
**Status:** pass
**Begründung (Provenance: audit-evaluator, post-iter-0):** Anker scharf
(`matchesPlannedSbc` liest korrekt `formationSlots`, kein No-Op mehr),
echter Integrationstest inkl. transientem Brick-Slot-Fenster
(`solver-test.js:1929-1993`), Orchestrierung statisch abgesichert
(`solver-test.js:1996-2025`), zwei neue Diagnose-Zähler
(`batchStuckCount`, `submitWithoutResponseCount`), Q7-Fix und
`reportError`-Adoption. Unter dem Ziel 67 geblieben, weil die aktive
Abgabe-Plausibilisierung (Iter-0-Lift-Aktion 4) nur als
Häufigkeits-Zähler geliefert wurde — die Frage, ob eine Abgabe „ohne
Response" wirklich griff, bleibt offen, nur messbar statt geprüft.

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **Post-Submit-Plausibilisierung bleibt ein reiner Zähler, keine aktive Prüfung:**
   `ea-fc-sbc-optimizer.user.js:4529-4539` — im „ohne Response"-Zweig von
   `submitChallengeToEa()` wird `STATE.diag.submitWithoutResponseCount` nur
   hochgezählt (`:4537`) und der Aufruf gilt sofort als Erfolg
   (`return { via: 'controller' }`, `:4539`). Es folgt keine Nachprüfung, ob
   EA die Abgabe tatsächlich registriert hat (z.B. erneutes Lesen von
   `liveSquad.isSquadEmpty()`, das derselbe Code in `openNextInstance`
   bereits für einen anderen Zweck nutzt, `:4603-4606`). `onBatchRunClick`
   (`:5090-5092`) übernimmt das Ergebnis ungeprüft und zählt `done++`
   weiter — genau der im Audit benannte Rest-Mangel (SEED dieser Iteration).
2. **`usedChallengeIds` wird geführt, aber nie als Sperre durchgesetzt:**
   `plan.usedChallengeIds` wird in `onBatchRunClick` befüllt
   (`ea-fc-sbc-optimizer.user.js:5079-5081`, `push(String(STATE.sbc.challengeId))`)
   und in der `stuck`-Diagnose nur zur Anzeige gelesen
   (`:4622-4624`, `usedInstance: (plan.usedChallengeIds || []).indexOf(...)`).
   Die eigentliche Match-Bedingung in `openNextInstance`
   (`:4607`, `if (ctrl && sq && matchesPlannedSbc(plan) && empty !== false)`)
   prüft nicht, ob die gerade gefundene `STATE.sbc.challengeId` bereits in
   `plan.usedChallengeIds` steckt. Die Betriebsregel „jede Wiederholung hat
   eine eigene `challengeId`" (`docs/roadmap/vision/features/batch-modus.md:29`)
   wird damit nur beobachtet, nicht erzwungen — ein Sicherheitsnetz existiert
   dem Namen nach, greift aber an keiner Stelle.
3. **Stuck-Recovery-Zweig (`clickBackButton`, v4.36.0) nur per String-Grep getestet:**
   `solver-test.js:2019-2024` prüft ausschließlich Text-Vorkommen im
   Quellcode (`nextFn.indexOf('i === 5 || i === 25') > -1 &&
   nextFn.indexOf('clickBackButton()') > -1`), nicht das tatsächliche
   Verhalten der Fallunterscheidung in `openNextInstance`
   (`ea-fc-sbc-optimizer.user.js:4636-4640`): dass `wentBack` bei
   `b.ok === true` gesetzt wird und die Schleife danach per `continue`
   neu bewertet (statt sofort weiterzuklicken). Anders als Abschnitt 21
   (`solver-test.js:1953-1993`), das die echte extrahierte Funktion mit
   synthetischem `STATE` ausführt, bleibt der Stuck-Pfad bei einem reinen
   Text-Match — Rasmus' einziger Beleg für die Zuverlässigkeit des
   Rückwärts-Klicks ist weiterhin der eine dokumentierte Live-Vorfall
   (`:4611-4617`), kein deterministischer Test.
4. **`batchSteps`-Ringpuffer verliert frühe Runden bei längeren Batches:**
   `ea-fc-sbc-optimizer.user.js:5098-5100` —
   `STATE.diag.batchSteps = (...).concat([...]).slice(-6)` behält nur die
   letzten 6 Runden. Bricht ein Batch mit mehr als 6 geplanten
   Wiederholungen erst spät ab (z.B. Runde 9 von 12), sind die
   Diagnosedaten der ersten problematischen Runde bereits überschrieben —
   widerspricht der RA-Rubrik „Beobachtbarkeit: jedes bekannte Fehlerbild
   hat ein Diagnose-Feld" (`docs/roadmap/vision/score-criteria.md:15-16`),
   wenn gerade die früheste (oft aufschlussreichste) Information verloren
   geht, bevor der Abbruch überhaupt gemeldet wird.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **Additive Post-Submit-Plausibilisierung (SEED, oberste Priorität):**
   nach dem „ohne Response"-Zweig in `submitChallengeToEa()`
   (`ea-fc-sbc-optimizer.user.js:4529-4539`) zusätzlich — additiv, ohne den
   bestehenden Rückgabewert/Erfolgspfad zu ändern — kurz warten
   (`await batchWait(400)`) und `liveSquad.isSquadEmpty()` erneut lesen;
   Ergebnis in ein neues Feld `STATE.diag.submitConfirmations` schreiben
   (Schema analog `batchSteps`: `{via, hadResponse: false, squadEmptyAfter,
   ms}`, Ring auf z.B. 6 Einträge). Kein `throw`/Retry allein aufgrund von
   `squadEmptyAfter === false` — reine Beobachtbarkeit, wie im SEED
   gefordert ("KEINE Retry-/Abbruch-Änderung ohne klare Fail-Safe-Analyse").
   Pflicht-Testfall: extrahierte Funktion mit Mock-`liveSquad` sowohl für
   `isSquadEmpty() === true` als auch `=== false` durchspielen (Technik aus
   `solver-test.js:1953-1993`, Abschnitt 21). Erwarteter Gain: **+3 bis +4 Pt**
   (Beobachtbarkeit) — schließt exakt die im Audit benannte Restlücke.
2. **`usedChallengeIds` als echte Sperre in die Match-Bedingung aufnehmen:**
   in `openNextInstance` (`ea-fc-sbc-optimizer.user.js:4607`) die Bedingung
   um `(plan.usedChallengeIds || []).indexOf(String(STATE.sbc.challengeId)) === -1`
   ergänzen, damit eine fälschlich als „passend" erkannte, aber bereits
   abgegebene Instanz nicht ein zweites Mal für eine Team-Zuweisung
   akzeptiert wird. Das ist eine Verhaltensänderung (schärft eine bisher
   wirkungslose Bedingung) → Pflicht-Testfall nach Muster Abschnitt 21:
   echte extrahierte Funktion, synthetisches `STATE` mit einer
   `challengeId`, die bereits in `plan.usedChallengeIds` steht, erwartet
   `false` trotz sonst passendem `targetOVR`/`formationSlots`; zusätzlich
   ein Testfall für den unveränderten Normalfall (frischer Plan, leere
   Liste, erwartet weiterhin `true`), damit kein neuer False-Negative am
   allerersten Batch-Schritt entsteht. Erwarteter Gain: **+5 bis +6 Pt**
   (schließt eine bislang nur beobachtete, nie erzwungene
   Abbruch-Disziplin-Lücke am Kern-Anker).
3. **Verhaltenstest statt String-Grep für den Stuck-Recovery-Zweig:**
   die Bedingungslogik „soll bei diesem `i` zurückgeklickt werden" aus
   `openNextInstance` (`:4636-4640`) in eine kleine, separat testbare
   Helper-Funktion extrahieren (z.B. `shouldTryBack(i)` →
   `i === 5 || i === 25`), OHNE die Ablaufsemantik zu ändern (reine
   Extraktion einer Bedingung, kein Verhaltensunterschied) — mit
   Vorher/Nachher-Testfall, der zeigt, dass sich am Kontrollfluss nichts
   ändert. Danach in `solver-test.js` echte Assertions statt Text-Suche:
   `shouldTryBack(5) === true`, `shouldTryBack(6) === false`, plus ein
   Test, der die extrahierte `openNextInstance`-Schleife mit einem
   Mock-`clickBackButton` (liefert `{ok: true}`) ausführt und prüft, dass
   `wentBack` gesetzt wird. Erwarteter Gain: **+2 bis +3 Pt** (Testbarkeit).
4. **`batchSteps`-Aufbewahrung um Fehler-Runden erweitern:**
   additiv zur bestehenden `slice(-6)` (`ea-fc-sbc-optimizer.user.js:5098-5100`)
   zusätzlich jede Runde mit `!next.ok` dauerhaft behalten (z.B. getrennte
   Ablage `STATE.diag.batchFailedSteps` ohne Ringpuffer-Limit oder mit
   höherem Limit), damit ein später Abbruch nicht die früheste
   problematische Runde überschreibt. Kein Verhaltenswechsel der
   Batch-Logik selbst, nur der Diagnose-Menge. Pflicht-Testfall: Array mit
   mehr als 6 Runden simulieren, davon eine früh fehlgeschlagen, prüfen
   dass die fehlgeschlagene Runde nach der Kürzung weiterhin auffindbar
   ist. Erwarteter Gain: **+1 bis +2 Pt** (Beobachtbarkeit bei langen Batches).

## Edge-Cases (mind. 1 — M1)

- **Additive Plausibilisierung darf keine neue Abbruchquelle werden:** die
  Post-Submit-Prüfung aus Lift 1 darf, solange kein zweiter Live-Beleg
  vorliegt, dass `isSquadEmpty() === false` nach einem „ohne Response"-
  Submit tatsächlich einen Fehlschlag bedeutet, NICHT selbst zu einem
  `throw`/Retry führen (SEED-Vorgabe explizit übernommen) — sonst könnte
  ein False Positive (z.B. Netzwerk-Race, Squad-Objekt noch nicht
  aktualisiert) einen bislang erfolgreichen Batch-Lauf unnötig stoppen und
  die „2 von 5 fertig ist besser als falsch abgegeben"-Philosophie ins
  Gegenteil verkehren (jetzt bricht ein Lauf ab, der ohne die neue Prüfung
  durchgelaufen wäre). Leicht zu übersehen, weil "mehr prüfen" intuitiv nach
  "sicherer" klingt.
- **`usedChallengeIds`-Sperre (Lift 2) darf den allerersten Plan-Schritt
  nicht blockieren:** wird `plan.usedChallengeIds` beim Planen nicht sauber
  auf `[]` zurückgesetzt (z.B. bei einem Re-Plan nach vorherigem Abbruch,
  `onBatchPlanClick` setzt `plan.usedChallengeIds = []` bei
  `ea-fc-sbc-optimizer.user.js:4975`), könnte die neue Sperre eine an sich
  passende erste Instanz fälschlich ablehnen. Pflicht-Testfall aus Lift 2
  muss diesen Normalfall (leere Liste) explizit mitprüfen, nicht nur den
  Sperr-Fall.

## Lift-Empfehlung

Vorsichtiger Stil, kein Big-Bang: Lift 1 und 2 sind die einzigen Aktionen
mit echtem Verhaltensrisiko (neue Beobachtung bzw. neue Sperr-Bedingung am
Kern-Anker) und brauchen je einen eigenen, vorher/nachher verifizierten
Testfall nach der in `solver-test.js` Abschnitt 21 etablierten Technik
(echte extrahierte Funktion + synthetisches `STATE`, kein Brute-Force
nötig). Lift 3 ist eine reine Extraktion ohne Verhaltensänderung
(Testbarkeit erhöhen, ohne die Abbruch-Philosophie anzufassen). Lift 4 ist
risikoarme Diagnose-Erweiterung. Priorität nach Gain UND Risiko: 2 (Sperre
durchsetzen) vor 1 (Plausibilisierung additiv, aber mit Fail-Safe-Disziplin)
vor 3 vor 4. Kein Mid-Iter-SI nötig — alle Funde sind feature-lokal
(`batch-modus`), kein zweiter Konsument betroffen. Submit-Weg 0
(`UTItemEntityFactory`/`saveChallenge`) und die Abbruch-Philosophie selbst
bleiben in allen vier Aktionen unangetastet.
