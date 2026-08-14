---
feature: batch-modus
iteration: 0
score_current:
  RA: 60
score_target:
  RA: 67
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
patterns_required:
  - diagnose-feld-statt-raten
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P3-deferred
effort: S
analyzed_at: 2026-08-15
---

# Lift-Plan — Batch-Modus (Mehrfach-Abgabe)

**Ticket-Titel-Vorschlag (ADR #73):** Batch-Lauf: Sicherheitsnetz testen, Kommentar und Abgabe-Bestätigung nachziehen

## Marschroute

Fünf additive/isolierte Schritte entlang `core → diagnose → tests → docs →
release`, bewusst OHNE die eine Aktion, die dieselben Codezeilen wie ein
anderer laufender Lift-Plan anfassen würde (siehe Abhängigkeits-Hinweis unten).
Kein Big-Bang: die einzige Aktion mit echtem Verhaltensrisiko am
Sicherheitsnetz selbst (`matchesPlannedSbc` von `STATE.sbc.slots` auf
`STATE.sbc.formationSlots` umstellen, `ea-fc-sbc-optimizer.user.js:4795`,
`:4816`, `:4916`) ist bereits **Aktion 1 im Lift-Plan von
`sbc-vorgaben-erkennung`** (`docs/roadmap/lift-plans/sbc-vorgaben-erkennung.md`)
— dieselben Zeilen, derselbe Fix, dieselbe Pflicht-Testfall-Pflicht aus
CLAUDE.md. Dieser Plan plant den Code-Fix deshalb **nicht** erneut (keine
Doppel-Planung derselben Codezeilen/desselben Tickets), sondern beschränkt sich
auf den Batch-spezifischen Zusatz-Testfall, der die Konsumenten des Fixes
(`onBatchRunClick`, `openNextInstance`) auf Orchestrierungs-Ebene absichert,
plus vier eigenständige, feature-lokale RA-Aktionen ohne Zeilen-Überschneidung.

Reihenfolge: zuerst die additiven, risikofreien Schritte (Kommentar-Korrektur,
Diagnose-Zähler, additive Erfolgs-Plausibilisierung bei `submitChallengeToEa`)
— sie haben keine Abhängigkeit und können sofort committed werden. Danach die
beiden Testfälle (Batch-spezifischer Integrationstest + statischer
Regressionstest für die Orchestrierung), weil der Integrationstest erst nach
Landung des Namensdrift-Fixes aus `sbc-vorgaben-erkennung` grün wird (siehe
Risiken). `node --check` und das volle `solver-test.js` müssen vor und nach
jedem Schritt grün bleiben (CLAUDE.md, oberste Regel „keine Regression").

Die manuelle RA-Rubric (`score-criteria.md`) ist eine semantische
Gesamtwürdigung, kein additiver Punktezähler — die einzelnen Gain-Schätzungen
unten sind Richtwerte pro Rubric-Kriterium, das Gesamtziel ist der vorgegebene
M3-Wert RA 67 (aktuell 60, strukturelles Maximum 70).

## Aktionen pro Dimension

### RA — Robust Architecture

1. **Batch-spezifischer Integrationstest für `matchesPlannedSbc` im Lauf-Kontext
   (KEIN Code-Fix hier — Abhängigkeit auf `sbc-vorgaben-erkennung`):**
   `sbc-vorgaben-erkennung`s Aktion 1 testet den Comparator isoliert (zwei
   konstruierte Set-Challenge-Knoten, Boolean-Rückgabe). Dieser Plan ergänzt in
   `solver-test.js` einen zweiten, Batch-spezifischen Testfall, der die
   *konsumierenden* Stellen prüft: (a) die Abbruchmeldung in `onBatchRunClick`
   (`ea-fc-sbc-optimizer.user.js:4914-4918`) enthält nach dem Fix die
   tatsächlichen `formationSlots`-Werte im Text (nicht `undefined`/`0`) — Test
   extrahiert den Meldungstext-Ausdruck per Source-Slice und prüft, dass er
   `STATE.sbc.formationSlots` referenziert statt `STATE.sbc.slots`; (b) der
   `stuck`-Diagnose-Zweig in `openNextInstance` (`:4468-4477`, Feld `matches:
   matchesPlannedSbc(plan)`) liefert für zwei Pläne mit identischem
   `targetOVR`, aber unterschiedlichem `formationSlots`, `matches: false` —
   simuliert über eine isolierte Nachbildung der Vergleichsfunktion mit
   konstruierten `plan`/`STATE.sbc`-Objekten. **Abhängigkeit explizit benennen:**
   dieser Testfall kann erst grün werden, wenn der Namensdrift-Fix aus
   `sbc-vorgaben-erkennung` (Zeilen `:4795`, `:4816`, `:4916`) gelandet ist —
   Main muss die beiden Tickets mit `depends_on` verketten (`batch-modus`-Ticket
   NACH `sbc-vorgaben-erkennung`-Ticket einplanen), sonst schlägt der neue Test
   in CI fehl und verletzt „alle Tests grün" (CLAUDE.md Schritt 3). Erwarteter
   Gain: **+2 bis +3 Pt** (Testbarkeit-Kriterium — schließt die im Gap-Report
   benannte Lücke „keine deterministische Prüfung der Batch-Orchestrierung"
   für den konkreten Slots-Anker, ohne den Fix selbst doppelt zu planen).

2. **Statischer Regressionstest für die Batch-Orchestrierung (Kategorie-3-Technik
   ohne Pattern-Adoptionsanspruch):** analog zum bestehenden Source-Slice-Check
   für `setLooksRepeatable` (`solver-test.js:1014-1021`, Technik aus
   `docs/roadmap/patterns/good/eingebetteten-code-exakt-testen.md` — Pattern
   selbst ist laut `applies_to_features` nicht auf `batch-modus` anwendbar,
   deshalb hier nur als Stil-Vorlage übernommen, nicht als
   `patterns_required`-Eintrag deklariert). Neue Prüf-Sektion in
   `solver-test.js`, die den Quelltext zwischen `async function
   onBatchRunClick` und dem nächsten Funktionskopf sowie zwischen `async
   function openNextInstance` und dessen Ende slice't und statisch
   sicherstellt: (a) `onBatchRunClick` wirft bei fehlender Pool-Karte, fehlendem
   Controller UND bei `!matchesPlannedSbc(plan)` je einen eigenen `throw new
   Error(...)` (`:4905-4918`); (b) `STATE.batch = null` steht im `finally`
   (`:4965`, Plan-verbraucht-Prinzip); (c) der `stuck`-Diagnose-Zweig
   (`i === 2 || i === 20 || i === 45`) und der `clickBackButton`-Zweig
   (`i === 5 || i === 25`) existieren beide in `openNextInstance`
   (`:4468-4482`). Verhindert, dass ein künftiges Refactoring eine dieser
   Abbruch-/Diagnose-Stellen still entfernt, ohne dass ein Test das bemerkt —
   genau der Mangel, der laut Gap-Report erklärt, warum der Slots-No-Op
   unbemerkt blieb. Erwarteter Gain: **+2 bis +3 Pt** (Testbarkeit).

3. **Veralteten Kommentar bei `ea-fc-sbc-optimizer.user.js:4982-4985`
   korrigieren (Q7):** ersetzt „Der Lauf 'mehrere SBCs automatisch abgeben' ist
   ausgebaut (siehe LEARNINGS 9 und ROADMAP)" durch eine IST-Zustand-Beschreibung,
   z.B. „`findLiveChallenge`/`findSbcController` werden vom aktiven,
   automatischen Batch-Lauf (`onBatchRunClick`, siehe CLAUDE.md 'Batch-Modus
   darf abgeben') UND vom Diagnose-Report genutzt." Reiner Kommentar-Diff, keine
   Logik-Änderung, kein neuer Testfall nötig — `node --check` +
   `node solver-test.js` zur Bestätigung der Verhaltensneutralität. Erwarteter
   Gain: **+1 bis +2 Pt** (Kriterium „Dokumentierte Begründung" — im
   Gap-Report-Score-Ergebnis wörtlich als Minderungsgrund benannt).

4. **`submitChallengeToEa`: „ohne Response"-Erfolg additiv plausibilisieren:**
   in `ea-fc-sbc-optimizer.user.js:4382-4389` bleibt der bestehende „gilt als
   Erfolg"-Pfad unverändert Fallback (der Live-verifizierte Controller-Weg aus
   `docs/LEARNINGS.md` §9 wird NICHT angetastet — „Nicht anfassen ohne
   Grund"-Kandidat). Zusätzlich: nach einem Aufruf ohne auswertbare
   Promise/Observable-Response eine kurze Wartezeit (analog `batchWait`, wie
   `openNextInstance` es für `sq.isSquadEmpty()` bereits nutzt, `:4453-4456`)
   und ein erneutes Lesen von `liveSquad.isSquadEmpty()`/Kachel-Status
   einbauen; bestätigt der Zusatz-Check einen leeren Squad, wird
   `STATE.diag.submitChallengeVia` um `' + Squad-Check bestätigt'` ergänzt,
   liefert der Zusatz-Check nichts Auswertbares, bleibt der bestehende Text
   unverändert (rein additiv — der Zusatz-Check wirft NIE zusätzlich, er
   plausibilisiert nur, siehe Edge-Case unten). Erwarteter Gain: **+3 bis +4 Pt**
   (Beobachtbarkeit/Abbruch-Disziplin — schließt die in
   `docs/LEARNINGS.md:399-401` selbst offen gelassene Frage, ob Abgabe 4 von EA
   wirklich bestätigt wurde).

5. **Diagnose-Zähler `batchStuckCount` für den `stuck`-Diagnosezweig
   (Pattern `diagnose-feld-statt-raten` weiter adoptieren):** in `STATE.diag`
   (`ea-fc-sbc-optimizer.user.js:105-112`) ein neues Feld `batchStuckCount: 0`
   ergänzen, das bei jedem Auslösen des `stuck`-Zweigs in `openNextInstance`
   (`:4468-4477`) hochgezählt wird, und in `buildDiagReport()`
   (`:3727-3768`, analog zum bestehenden `batchSteps`-Feld `:3764`) als
   `batchStuckCount: STATE.diag.batchStuckCount || 0` aufnehmen. Macht die
   Häufigkeit des v4.36.0-Live-Vorfalls über mehrere Läufe hinweg messbar statt
   nur aus einem einzelnen LEARNINGS-Eintrag ablesbar — genau das Muster aus
   `docs/roadmap/patterns/good/diagnose-feld-statt-raten.md` (erst Sichtbarkeit
   schaffen, dann ggf. weiter fixen). **Code-Beleg-Registrierung:** die
   erweiterte `STATE.diag`-Deklaration und `buildDiagReport()` sind laut
   Pattern-Doc bereits als Code-Beleg zitiert (`:105-112`, `:3727-3768`) — die
   Zeilen bleiben dieselben, nur der Inhalt wächst; kein neuer
   `pattern add-beleg`-Schritt nötig (Divisor bewegt sich nicht, RA ist ohnehin
   nicht PK-adaptergemessen für dieses Feature). Erwarteter Gain: **+1 bis +2 Pt**
   (Beobachtbarkeit).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 4 (additive Plausibilisierung „ohne Response" in `submitChallengeToEa`, `:4382-4389`) |
| diagnose | Aktion 5 (`batchStuckCount` in `STATE.diag` + `buildDiagReport()`) |
| tests | Aktion 1 (Batch-spezifischer Integrationstest, abhängig von `sbc-vorgaben-erkennung`-Fix); Aktion 2 (statischer Regressionstest für `onBatchRunClick`/`openNextInstance`) |
| docs | Aktion 3 (Kommentar-Korrektur `:4982-4985`, Q7); `docs/LEARNINGS.md`-Eintrag, der die additive Plausibilisierung (Aktion 4) und den neuen Zähler (Aktion 5) als Fortsetzung von §9/§21 dokumentiert |
| release | `node --check ea-fc-sbc-optimizer.user.js`; `node solver-test.js` (alle Tests inkl. der neuen grün); `@version`/`const VERSION` von `4.36.0` auf `4.37.0`; Push auf `main` |

## Shared-Item-Bedarf

Keiner. Alle fünf Aktionen sind feature-lokal (`batch-modus`): der Kommentar
(`:4982-4985`), die additive Submit-Plausibilisierung (`:4382-4389`), der neue
Diagnose-Zähler (`STATE.diag.batchStuckCount`) und beide neuen Testfälle
betreffen ausschließlich die Batch-Orchestrierungs-Code-Geographie dieses
Features. Der eine Punkt mit Cross-Feature-Bezug (Namensdrift-Fix
`STATE.sbc.slots`/`formationSlots`) wird bewusst NICHT hier, sondern im
bestehenden Lift-Plan von `sbc-vorgaben-erkennung` geplant — kein
SI-Kandidat, sondern eine reine Abhängigkeit zwischen zwei Feature-Tickets
(siehe Marschroute + Risiken). `[]` in `batch-modus.shared-items.json`.

## Risiken / Edge-Cases

- **Reihenfolge-Abhängigkeit zu `sbc-vorgaben-erkennung` ist ein echter
  CI-Blocker, kein „nice to have":** Aktion 1 (Batch-Integrationstest) prüft
  Text/Feldwerte, die erst nach dem Namensdrift-Fix korrekt sind. Wird das
  `batch-modus`-Ticket vor oder parallel zu `sbc-vorgaben-erkennung`
  bearbeitet, schlägt der neue Test fehl und verletzt „alle Tests grün"
  (CLAUDE.md). Main muss die beiden Tickets explizit mit `depends_on`
  verketten und `batch-modus` NACH `sbc-vorgaben-erkennung` einplanen — sonst
  darf Aktion 1 in dieser Iteration nicht committed werden.
- **Regressionsgefahr am Sicherheitsnetz selbst (übernommen aus dem
  Gap-Report, jetzt im Kontext des Integrationstests statt des Fixes):** sobald
  der Namensdrift-Fix gelandet ist, kann ein Batch-Lauf, der bisher (mangels
  funktionierendem Slots-Vergleich) zufällig durchlief, bei einer echten
  `formationSlots`-Diskrepanz künftig neu abbrechen. Das ist gewünscht (das
  Sicherheitsnetz soll greifen), Aktion 1s Testfall muss das als
  Verhaltensänderung dokumentieren, nicht als Bugfix „ohne Nebenwirkung"
  verkaufen.
- **`submitChallengeToEa`-Härtung (Aktion 4) darf den Live-verifizierten „ohne
  Response"-Erfolgspfad nicht nachträglich zum Fehler machen:** eine zu
  strenge Nachprüfung könnte einen bislang funktionierenden Controller-Weg
  (live bestätigt, `docs/LEARNINGS.md` §9) fälschlich als Fehlschlag werten
  und einen vorher erfolgreichen Batch-Lauf unnötig abbrechen lassen — eine
  Verschärfung der Abbruch-Philosophie, die Rasmus nicht gefordert hat. Der
  Zusatz-Check muss rein additiv bleiben: bestätigt oder bleibt neutral, wirft
  aber nie selbst einen Fehler.
- **Gleicher `targetOVR`, unterschiedliche `formationSlots` im selben Set
  (übernommen aus dem Gap-Report):** der Edge-Case, den der Namensdrift-Fix
  überhaupt erst korrekt erkennbar macht — zwei Wiederholungen/Varianten
  desselben Sets mit identischem Ziel-Rating, aber unterschiedlicher Slotzahl
  (z.B. 10 vs. 11), müssen künftig als NICHT zueinander passend erkannt
  werden. Aktion 1 deckt genau diesen Fall auf Orchestrierungs-Ebene ab; ohne
  den Fix aus `sbc-vorgaben-erkennung` bleibt er unentdeckt.
- **Mid-Iter-Vermutung (Klasse G, aber kein SI):** falls beim Bau von Aktion 4
  auffällt, dass die additive Squad-Check-Logik identisch zu einem Muster in
  `openNextInstance` (`empty !== false`-Prüfung, `:4457`) ist, wäre eine
  gemeinsame Helper-Funktion denkbar — bleibt aber feature-lokal
  (`batch-modus` ist der einzige Konsument beider Stellen), also kein
  Shared-Item, sondern höchstens eine interne Extraktion innerhalb derselben
  Datei.

## Lift-Plan-Pre-Validation (M2)

Kein PK-Anteil in diesem Plan (`structural_max` des Features enthält nur RA,
`pk_files_to_cite: []`). `plan estimate --feature=batch-modus` prüft daher nur:
`score_target.RA (67) ≤ min(structural_max.RA, achievable_ceiling.RA)` (= 70,
keine Ceiling-Unterschreitung bekannt) und dass keine Ticket-Aktion
`docs/roadmap/**` in `primary_paths` trägt (hier: nur
`ea-fc-sbc-optimizer.user.js`, `solver-test.js`). Miss-risk-Hinweis für einen
möglichen Re-Spawn: sollte Main die `depends_on`-Verkettung zu
`sbc-vorgaben-erkennung` nicht abbilden können, muss Aktion 1 aus diesem Plan
entfernt oder auf eine spätere Iteration verschoben werden, bevor das Ticket
erstellt wird.
