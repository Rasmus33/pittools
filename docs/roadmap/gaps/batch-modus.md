---
feature: batch-modus
analyzed_at: 2026-08-14
iteration: 0
regression: false
score_current:
  RA: 60
score_target:
  RA: 65
---

# Gap-Report — Batch-Modus (Mehrfach-Abgabe)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 60 / 70
**Schwellwert:** 49
**Status:** pass
**Begründung:** Der `audit-evaluator` würdigt die disziplinierte Fehlertoleranz/
Beobachtbarkeit/Abbruch-Struktur (Selektor-Fallbacks in `clickSetTile`/
`clickChallengeRow`, `{ok, why}`-Rückgaben, `STATE.diag`-Report, "Plan
verbraucht"-Prinzip) — das ist der Kern der 60 von 70 möglichen Punkten.
Gemindert wird der Wert durch zwei konkrete, code-belegte Funde: einen
bestätigten ungetesteten Bug im Kern-Anker (`matchesPlannedSbc` vergleicht
nie belegtes `STATE.sbc.slots` statt `STATE.sbc.formationSlots` — der
Slots-Teil des Sicherheitsnetzes ist ein faktischer No-Op, siehe
`ea-fc-sbc-optimizer.user.js:4793-4796`) und einen veralteten Kommentar
(`ea-fc-sbc-optimizer.user.js:4982-4985`), der den aktiven automatischen
Mehrfach-Lauf fälschlich als "ausgebaut" beschreibt (Q7-Verstoß).

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`matchesPlannedSbc`-Slots-Vergleich ist ein No-Op (SSOT-Drift):**
   `ea-fc-sbc-optimizer.user.js:4795` vergleicht
   `Number(STATE.sbc.slots || 0) !== Number(plan.slots || 0)` — `STATE.sbc.slots`
   wird im gesamten File nie geschrieben (die reale Vorgabe heißt
   `STATE.sbc.formationSlots`, siehe Schreibstellen `:492`, `:640`, `:675`,
   `:691` und den korrekten Leser in `readConfig()` bei `:4037`). Beide Seiten
   des Vergleichs sind damit `undefined`/`0`, der Vergleich liefert immer
   "gleich". Betroffen sind zwei Aufrufstellen des Sicherheitsnetzes:
   `onBatchRunClick` (`:4914-4918`, inkl. Fehlermeldungstext `:4916`, der bei
   echter Diskrepanz `undefined` anzeigen würde) und `openNextInstance`
   (`:4457`, `:4474`). Belegt im Antipattern-Dokument
   `docs/roadmap/patterns/bad/wissens-duplikate-ohne-ssot.md:83-89,139-152`
   (Abschnitt "Namensdrift als Sonderfall derselben Ursache") — dort explizit
   als "Batch-Anker-Abgleich ... faktischer No-Op" benannt.
2. **Kein Testfall für die Batch-Orchestrierung, nur für den reinen Solver:**
   `solver-test.js:542-580` prüft ausschließlich `SolverCore.planBatch` (reine
   Rechenlogik). `matchesPlannedSbc` taucht in `solver-test.js` nur als
   String-Slice-Grenze für einen anderen Test auf (`solver-test.js:1016`),
   nicht als geprüfte Einheit. Dasselbe gilt für `openNextInstance`,
   `clickBackButton`, `clickSetTile`, `submitChallengeToEa` — die gesamte
   DOM-/Controller-Orchestrierung des Batch-Laufs hat keine deterministische
   Prüfung. Genau das erklärt, warum der Slots-No-Op (Mangel 1) unbemerkt
   blieb — RA-Kriterium "Testbarkeit" (`docs/roadmap/vision/score-criteria.md:20-21`)
   ist für den Kern-Anker faktisch nicht erfüllt.
3. **Veralteter Kommentar über den Lauf-Status (Q7):**
   `ea-fc-sbc-optimizer.user.js:4982-4985` behauptet "Der Lauf 'mehrere SBCs
   automatisch abgeben' ist ausgebaut (siehe LEARNINGS 9 und ROADMAP)". Das
   ist der historische Zwischenstand aus `docs/LEARNINGS.md:283` ("SBC abgeben
   + warum der Batch ausgebaut wurde"), nicht der IST-Zustand: `onBatchRunClick`
   (`:4888-4981`) tut aktiv genau das — eine Schleife über `plan.rounds`, die
   pro Runde `submitChallengeToEa()` aufruft und danach `openNextInstance`
   ausführt. CLAUDE.md dokumentiert das Verhalten explizit als freigegeben
   ("Batch-Modus darf abgeben — von Rasmus freigegeben"). Der Kommentar wurde
   beim Wiedereinbau nicht nachgezogen und verstößt gegen Q7 (Doku beschreibt
   IST-Zustand) — genau der Punkt, den der Score-Adapter als zweiten
   Minderungsgrund nennt.
4. **`submitChallengeToEa`: "ohne Response"-Erfolg bleibt unverifiziert:**
   `ea-fc-sbc-optimizer.user.js:4382-4388` dokumentiert per WARUM-Kommentar
   selbst, dass ein Aufruf ohne auswertbare Promise/Observable-Response als
   Erfolg gilt, obwohl `docs/LEARNINGS.md:399-401` (Ende §9, v4.36.0-Vorfall)
   offen lässt, "ob Abgabe 4 von EA wirklich bestätigt wurde". Der Report
   macht den Zustand seit v4.36.0 sichtbar (`submitChallengeVia: '... (ohne
   Response)'`), aber die Abbruch-Disziplin greift hier nicht — ein
   stillschweigend fehlgeschlagenes Abgeben würde als erfolgreiche Runde
   gezählt und der Plan liefe (fälschlich) weiter.
5. **Stuck-Diagnose/`clickBackButton` (v4.36.0) ohne zweiten Live-Beleg:**
   `ea-fc-sbc-optimizer.user.js:4468-4482` (neuer `stuck`-Diagnose-Zweig) und
   die `clickBackButton`-Nutzung bei `i === 5 || i === 25` sind Reaktion auf
   genau EINEN dokumentierten Live-Vorfall (`docs/LEARNINGS.md:380-401`, "TOTW-
   Batch nach 4/5 gestoppt"). Es gibt noch keinen zweiten unabhängigen
   Diagnose-Beleg, der bestätigt, dass der Rückwärts-Klick zuverlässig aus dem
   Squad-View zurückführt — die Robustheit dieses konkreten Pfads ist bislang
   einmalig verifiziert, nicht wiederholt.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **SSOT-Fix `matchesPlannedSbc` auf `formationSlots` umstellen + Pflicht-Testfall:**
   `ea-fc-sbc-optimizer.user.js:4795` (Vergleich), `:4816` (`plan.slots =
   STATE.sbc.slots` → `STATE.sbc.formationSlots`), `:4916` (Fehlermeldungstext)
   konsistent auf `STATE.sbc.formationSlots` umstellen. Zwingend zusammen mit
   einem neuen `solver-test.js`-Testfall (Pflicht laut CLAUDE.md "Oberste Regel:
   keine Regression" — der Fix ändert sichtbares Sicherheitsnetz-Verhalten),
   der zwei Pläne mit gleichem `targetOVR`, aber unterschiedlichem
   `formationSlots` baut und prüft, dass `matchesPlannedSbc` danach `false`
   liefert (vorher/nachher-Vergleich, kein Brute-Force nötig, da reiner
   Feld-Vergleich). Erwarteter Gain: **+6 bis +8 Pt RA** — behebt den im
   Score-Ergebnis explizit genannten Hauptminderungsgrund und stärkt zugleich
   "Testbarkeit" und "Abbruch-Disziplin" der Rubric gemeinsam.
2. **Statischer Regressionstest für den Slots-No-Op-Vorfall nach
   Pattern `eingebetteten-code-exakt-testen` (Kategorie 3):** analog zu den
   bestehenden statischen Source-Checks in `solver-test.js:995-1025`
   (`setLooksRepeatable`) einen Check ergänzen, der sicherstellt, dass
   `matchesPlannedSbc` NICHT mehr `STATE.sbc.slots` referenziert und
   stattdessen `formationSlots` liest — mit Kommentarverweis auf den
   auslösenden Fund (analog `docs/roadmap/patterns/bad/wissens-duplikate-ohne-ssot.md`).
   Gain: **+3 Pt** (Testbarkeit) — verhindert, dass ein künftiges Refactoring
   den Fix stillschweigend rückgängig macht.
3. **Veralteten Kommentar bei `ea-fc-sbc-optimizer.user.js:4982-4985`
   korrigieren (Q7):** den "ist ausgebaut"-Satz durch eine IST-Zustand-Beschreibung
   ersetzen (z.B. "`findLiveChallenge`/`findSbcController` werden vom aktiven
   automatischen Batch-Run [`onBatchRunClick`] UND vom Diagnose-Report
   genutzt"). Kleinster Diff, kein Verhaltensrisiko, keine Testanpassung nötig.
   Gain: **+2 Pt** ("Dokumentierte Begründung"-Kriterium der Rubric, aktuell
   im Score-Ergebnis wörtlich als Minderungsgrund benannt).
4. **`submitChallengeToEa` additiv absichern statt nur zu melden:** nach
   einem Aufruf ohne auswertbare Response einen Zusatz-Check ergänzen, der den
   Erfolg *zusätzlich* plausibilisiert (z.B. kurze Wartezeit + erneutes Lesen
   von `liveSquad.isSquadEmpty()`/Kachel-Status, wie `openNextInstance` es für
   `empty` bereits tut) — additiv im Sinn von CLAUDE.md: der bestehende
   "gilt als Erfolg"-Pfad bleibt Fallback, wenn auch der Zusatz-Check nichts
   Auswertbares liefert; der Live-verifizierte Controller-Weg selbst wird
   nicht angetastet. Pfad: `ea-fc-sbc-optimizer.user.js:4382-4389`. Gain:
   **+4 Pt** (Beobachtbarkeit/Abbruch-Disziplin) — schließt die in
   `docs/LEARNINGS.md:399-401` selbst benannte offene Frage.
5. **Diagnose-Feld für Häufigkeit des `stuck`-Zweigs ergänzen:**
   `STATE.diag`-Zähler (z.B. `batchStuckCount`), der mitzählt, wie oft der
   neue `stuck`-Diagnosezweig (`ea-fc-sbc-optimizer.user.js:4468-4482`)
   auslöst, in `buildDiagReport()` aufnehmen — macht die Live-Bewährung von
   v4.36.0 über mehrere Läufe hinweg messbar statt nur anekdotisch aus einem
   LEARNINGS-Eintrag ablesbar. Pattern-Adoption:
   `docs/roadmap/patterns/good/diagnose-feld-statt-raten.md`. Gain: **+2 Pt**
   (Beobachtbarkeit).

## Edge-Cases (mind. 1 — M1)

- **Regressionsgefahr am Sicherheitsnetz selbst:** der Slots-Fix (Lift 1)
  ändert sichtbares Verhalten von `matchesPlannedSbc` — ein Batch-Lauf, der
  bisher (zufällig, weil der Slots-Vergleich nie griff) durchlief, kann nach
  dem Fix bei einer echten Slots-Diskrepanz neu abbrechen. Das ist gewünscht
  (das Sicherheitsnetz soll ja greifen), muss aber im Testfall explizit als
  Verhaltensänderung dokumentiert werden, nicht als Bugfix "ohne Nebenwirkung"
  verkauft werden — leicht zu übersehen, weil die Änderung selbst nur zwei
  Zeilen umfasst.
- **`submitChallengeToEa`-Härtung darf den Live-verifizierten "ohne
  Response"-Erfolgspfad nicht nachträglich zum Fehler machen:** eine zu
  strenge Nachprüfung (Lift 4) könnte einen bislang funktionierenden
  Controller-Weg (der schon vor v4.36.0 ohne Response lief und live bestätigt
  ist, siehe LEARNINGS §9) fälschlich als Fehlschlag werten und dadurch einen
  vorher erfolgreichen Batch-Lauf unnötig abbrechen lassen — das wäre eine
  Verschärfung der Abbruch-Philosophie ("2 von 5 fertig"), die Rasmus nicht
  gefordert hat. Der Zusatz-Check muss rein additiv bleiben (bestätigt oder
  bleibt neutral, wirft aber nie zusätzlich).
- **Gleicher `targetOVR`, unterschiedliche `formationSlots` im selben Set:**
  der Edge-Case, den Lift 1 überhaupt erst korrekt erkennbar macht — zwei
  Wiederholungen/Varianten desselben Sets mit identischem Ziel-Rating, aber
  unterschiedlicher Slotzahl (z.B. 10 vs. 11) müssen künftig als NICHT
  zueinander passend erkannt werden; dieser Fall fehlt aktuell komplett in
  `solver-test.js` und ist leicht zu vergessen, weil er vorher durch den
  No-Op maskiert war.

## Lift-Empfehlung

Vorsichtiger Stil, kein Big-Bang-Refactor: Lift 1+2 gehören zusammen und sind
die einzige Aktion mit echtem Verhaltensrisiko am Sicherheitsnetz — Pflicht-
Testfall vorher/nachher, kleiner Diff, kein Umbau der Abbruch-Philosophie.
Lift 3 ist ein risikofreier Doku-Fix (kann isoliert und sofort). Lift 4 ist
additiv und muss so geschnitten sein, dass der bestehende Controller-Weg
(LEARNINGS §9, "Nicht anfassen ohne Grund"-Kandidat) unangetastet bleibt.
Lift 5 ist reine Diagnose-Erweiterung ohne Risiko. Kein Mid-Iter-SI nötig —
alle Funde sind feature-lokal (`batch-modus`), kein zweiter Konsument
betroffen.
