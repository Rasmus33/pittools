---
feature: bedienpanel-ui
iteration: 4
score_current:
  RA: 82
score_target:
  RA: 84
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
  - docs/LEARNINGS.md
patterns_required:
  - ea-grenz-fallback-ketten
  - eingebetteten-code-exakt-testen
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P3-deferred
effort: S
analyzed_at: 2026-08-15
---

# Lift-Plan — Bedienpanel & Einstiegspunkte

## Marschroute

Vier der fünf Gap-Aktionen sind solide und werden umgesetzt (Gap-Aktionen 1,
2, 3, 5 aus `docs/roadmap/gaps/bedienpanel-ui.md`); Gap-Aktion 4
(`STATE.loading`-Guard in `onRunClick()`) ist im Gap-Report selbst als
`[dünn]` markiert und wird **nicht** eingeplant — das Zeitfenster ist laut
Gap-Report eng, es entsteht keine Datenkorruption, nur ein irreführender
Statustext, und der potenzielle RA-Gain (+1) steht in keinem Verhältnis zum
Risiko, eine vierte Verhaltensänderung in denselben Lift zu drücken. Bleibt
als Kandidat für eine spätere Iteration im Gap-Report stehen.

Reihenfolge folgt der im Gap-Report benannten Abhängigkeit: Aktion 5
(Testbarkeit) testet die von Aktion 1 neu geschaffene Fallback-Verzweigung
und muss deshalb NACH Aktion 1 implementiert werden. Aktionen 2 und 3 sind
voneinander unabhängige, rein additive Diagnose-Ergänzungen und können in
beliebiger Reihenfolge parallel zu 1 entstehen.

Phasen-Reihenfolge (`phase_sequence`): core → diagnose → tests → docs →
release — der eiserne Arbeitsablauf aus `CLAUDE.md`. Alle vier Aktionen sind
rein additiv (kein bestehender Erfolgspfad ändert sein Verhalten), decken
sich aber auf verschiedene Achsen: Fehlertoleranz (1), Abbruch-Disziplin (2),
Beobachtbarkeit (3), Testbarkeit (5) — zusammen tragen sie den RA-Lift von
82 auf 84 mit Puffer (nominale Einzel-Gains summieren auf +8–9 Pt., der
Scorer rechnet nicht linear-additiv über vier Achsen desselben Mangel-Clusters,
das Ziel von +2 wird damit robust erreicht, siehe M3-Check unten).

## M3-Check (Delta 2)

`effective_max = min(structural_max, achievable_ceiling)`. Für diese Iteration
liegt keine `achievable_ceiling` im Score-Snapshot vor (Feld fehlt im
Gap-Report-Frontmatter) → `effective_max = structural_max = 85`.

`score_target = current + (effective_max − current) × 0.7`
`= 82 + (85 − 82) × 0.7 = 82 + 2.1 = 84.1` → **84** (ganzzahlig, deckt sich
mit dem im Gap-Report bereits vorgegebenen `score_target.RA: 84`).

Delta = 84 − 82 = **2 Punkte**. Kein `FOCUSED_DIMENSIONS` gesetzt (nur eine
Dimension existiert strukturell für dieses Feature) → M3 gilt normal, ohne
Halte-Modus. `score_target.RA: 84 ≤ min(structural_max=85, effective_max=85)`
— Ambitions-Regel eingehalten, kein `pk_exempt`-Vorschlag nötig (keine
PK-Dimension für dieses Feature).

## Aktionen pro Dimension

### RA — Robust Architecture

1. **Generischen Text-Fallback für `sbcButtonContainer()` ergänzen (additiv,
   Gap-Aktion 1).** `ea-fc-sbc-optimizer.user.js:3832-3838`. Primärer Pfad
   bleibt UNVERÄNDERT der bestehende `.sbc-button-container`-Loop mit
   `return all[i]` beim ersten sichtbaren Treffer. NEU: nur wenn dieser Loop
   ohne Treffer durchläuft, ein zweiter Versuch — alle sichtbaren
   `document.querySelectorAll('button')` nach Text filtern (Muster wie
   `buttonDump` in `buildDiagReport()`, `:4119-4136`, dort aber nur Diagnose,
   kein Fallback-Versuch), gegen ein Textmuster wie
   `/squad builder|clear squad|exchange/i` matchen und den gemeinsamen
   Elternknoten der Treffer als Container zurückgeben. Als eigene, kleine
   Helper-Funktion (z.B. `sbcButtonContainerByText()`) implementieren, die
   `sbcButtonContainer()` NUR aufruft, wenn der Primär-Loop `null` ergäbe —
   strukturell unmöglich, dass der Fallback den Primärpfad verdrängt, weil
   der Primär-Loop innerhalb derselben Funktion bereits per `return`
   abbricht, bevor der Fallback-Code überhaupt erreicht wird (Reihenfolge ist
   Kontrollfluss, kein Flag/Konfigurationswert, der versehentlich
   vertauscht werden könnte — siehe Risiken für den Test-Beweis).
   Diagnose-Zähler `containerFallbackUsed` (modulweites `let`, analog zu
   `btnAttachCount`/`launcherClicks`, `:3782-3783`) bei jedem Fallback-Treffer
   inkrementieren und im `launcher`-Block von `buildDiagReport()`
   (`:4150-4154`, neben `containerVisible`) ausgeben — Pattern
   `ea-grenz-fallback-ketten` (jede Stufe hinterlässt eine Diagnose-Spur,
   welcher Weg griff). **Erwarteter Gain:** +2–3 Pt RA.

2. **`readConfig()` gegen fehlende DOM-Referenzen absichern (Gap-Aktion 2,
   Option b — der bereits etablierte Try/Catch-Stil, nicht der neue
   `{ok,why}`-Vertrag).** `ea-fc-sbc-optimizer.user.js:4344-4372` und
   `onRunClick()` `:4438-4481`. Begründung für Option b statt a: der zweite
   Aufrufer von `readConfig()` — `onBatchPlanClick()` (`:5165`) — hat
   bereits exakt diesen Try/Catch-Stil samt `reportError('Batch-Planung
   fehlgeschlagen', e)` (`:5185-5187`) um seinen `readConfig()`-Aufruf; ein
   neuer `{ok:false, reason}`-Rückgabevertrag für `readConfig()` würde beide
   Aufrufer zu unterschiedlichem Umgang zwingen (einer prüft `ok`, der andere
   wirft weiter) und wäre damit ein Q4-Verstoß (zwei Fehlerkonventionen für
   dieselbe Funktion). Stattdessen: den bestehenden inneren Try/Catch in
   `onRunClick()` (aktuell nur um `res = SolverCore.solve(...)`,
   `:4466-4467`) so erweitern, dass er auch `const cfg = readConfig();`
   umschließt, inklusive `reportError('readConfig fehlgeschlagen', e)` im
   Catch-Zweig — identisch zum bereits bewährten Muster in
   `onBatchPlanClick()`. Kein neuer Vertrag, keine zweite Fehlerkonvention,
   minimaler Diff. **Erwarteter Gain:** +2 Pt RA.

3. **Die drei stillen `localStorage`-Catches auf `reportError()` umstellen
   (Gap-Aktion 3).** Reiner Ergänzungs-Diff im jeweiligen Catch-Zweig, kein
   Verhaltensunterschied im Erfolgsfall:
   - `saveBands()` `ea-fc-sbc-optimizer.user.js:3594-3596` →
     `reportError('Rating-Bänder speichern fehlgeschlagen', e)`.
   - Advanced-Toggle-Persistenz `:3553-3555` →
     `reportError('Erweiterte-Einstellungen-Zustand speichern fehlgeschlagen', e)`.
   - Drag-Positions-Persistenz in `makeDraggable` `:3766-3769` →
     `reportError('Panel-Position speichern fehlgeschlagen (' + posKey + ')', e)`
     (mit `posKey` im Label, weil `makeDraggable` sowohl für Panel als auch
     FAB verwendet wird und beide dieselbe Catch-Zeile teilen — ohne
     Unterscheidung wäre im Report nicht zu sehen, welches Element betroffen
     ist).
   Nutzt den bestehenden Choke-Point `reportError()` (LEARNINGS §23), macht
   Private-Mode/Quota-Fälle erstmals sichtbar, schließt drei konkrete
   Instanzen des Antipatterns `fehler-unsichtbar-verschluckt`.
   **Erwarteter Gain:** +2 Pt RA.

4. **Fallback-Logik testbar machen (Gap-Aktion 5, NACH Aktion 1).**
   `sbcButtonContainer()` und `inSbcView()` sind beide bereits über den
   bestehenden `extractFunction(src, name)`-Helfer aus `solver-test.js`
   (`:49-57`, kein neuer Marker nötig — beide Funktionen sind self-contained
   genug) extrahierbar. Neue Testsektion in `solver-test.js`:
   - `sbcButtonContainer()` mit einem Node-`vm`-Kontext ausführen, der
     `document.querySelectorAll` stubbt (Stil wie `app/guard-test.js:154-195`,
     bereits im Repo etabliert): (a) primärer Selektor liefert ein sichtbares
     Element UND gleichzeitig Buttons mit Fallback-Text vorhanden → Assertion
     dass die zurückgegebene Referenz IDENTISCH mit dem Primär-Element ist
     (nicht nur "ein Ergebnis") und `containerFallbackUsed` bleibt 0 — das
     ist der Reihenfolge-Beweis aus der Aufgabenstellung; (b) Primär-Selektor
     liefert nichts, Fallback-Text-Buttons vorhanden → Fallback-Container
     zurück, Zähler +1; (c) beides liefert nichts → `null`.
   - `inSbcView()` analog mit gestubbtem `getControllerChain()`: leere Kette
     → `true`, Kette mit `.constructor.name` passend zu `/sbc/i` → `true`,
     Kette ohne Treffer → `false`, werfende Kette → `true` (bestehendes
     Fail-Open-Verhalten, als Testfall festgeschrieben statt überraschend).
   - `syncLauncher()` NICHT als eigener Verhaltenstest: hängt an
     Modul-Closures (`ui.fab`, `ui.panel`, `btnAttachCount`,
     `buildSbcButton`, `togglePanel`), deren Fake-Nachbildung mehr
     Test-Infrastruktur bräuchte als sie an Regressionsschutz zurückgäbe
     (Abgrenzung laut Aufgabenstellung: "nicht in einen
     Headless-DOM-Sumpf laufen"). Stattdessen ein GÜNSTIGER statischer
     Source-Check: `extractFunction(src, 'syncLauncher')` enthält den
     String `sbcButtonContainer()` — stellt sicher, dass `syncLauncher()`
     den (jetzt fallback-fähigen) Helfer aufruft statt selbst eine
     Selektor-Logik zu duplizieren (DRY-Wächter, Q4). Das tatsächliche
     Erscheinen/Umziehen des Buttons im Live-DOM bei umbenannter EA-Klasse
     bleibt — wie der gesamte Launcher-Subsystem-Teil laut LEARNINGS §10 —
     Live-Verifikation durch Rasmus.
   Adoptiert das Pattern `eingebetteten-code-exakt-testen` für zwei DOM-Helfer,
   die bisher nicht per Marker/Extraktion getestet waren.
   **Erwarteter Gain:** +2 Pt RA (Testbarkeits-Achse).

## Phasen-Commit-Mapping

| Phase     | Aktionen |
|-----------|----------|
| core      | Aktion 1 (Fallback-Selektor + Helper `sbcButtonContainerByText()`), Aktion 2 (Try/Catch-Erweiterung in `onRunClick()`), Aktion 3 (drei `reportError()`-Umstellungen) |
| diagnose  | Aktion 1: Zähler `containerFallbackUsed` + Feld im `launcher`-Block von `buildDiagReport()` |
| tests     | `node --check`, `node solver-test.js` (bestehender Grünstand bleibt grün) + neue Testsektion für Aktion 4 (`sbcButtonContainer()`, `inSbcView()`, statischer DRY-Check für `syncLauncher()`) |
| docs      | `docs/LEARNINGS.md` — neuer Eintrag (voraussichtlich §40): Fallback-Kette am Einhänge-Punkt, `readConfig()`-Absicherung, `reportError()` an den drei Storage-Pfaden |
| release   | `@version` + `const VERSION` auf `4.52.0` (beide Stellen, per Test geprüft), Push auf `main` |

## Shared-Item-Bedarf

Keiner. Alle vier Aktionen bleiben innerhalb der bestehenden, bereits
zentralen Choke-Points des einzigen Produktfiles
(`reportError()`/`diagError()` LEARNINGS §23, `extractFunction()` in
`solver-test.js`) — keine neue Logik entsteht, die ein zweites Feature
bräuchte. `reportError()` existiert bereits vor diesem Lift und wird von
mehreren Features genutzt; Aktion 3 ist reine Konsum-Erweiterung an drei
neuen Call-Sites, kein neuer Helper. Sidecar-JSON ist entsprechend leer.

## Risiken / Edge-Cases

- **Reihenfolge-Garantie Aktion 1 ist strukturell, nicht konfigurativ.** Der
  Fallback-Code ist im Kontrollfluss NACH dem `return`-tragenden Primär-Loop
  platziert (kein Flag wie `USE_FALLBACK` o.ä., das versehentlich vertauscht
  werden könnte) — der Test unter Aktion 4 beweist das zusätzlich per
  Fixtur, in der BEIDE Wege gleichzeitig träfen: Assertion auf
  Identität des Rückgabewerts mit dem Primär-Element, nicht nur auf
  "irgendein Treffer". Ein Review sollte diese Fixtur besonders genau lesen,
  da sie der einzige automatisierte Beleg für "Fallback verdrängt Primärpfad
  nie" ist.
- **Text-Fallback kann falsche Buttons treffen**, wenn EA künftig einen
  völlig anderen Container mit Buttons benennt, deren Text zufällig auf
  `/squad builder|clear squad|exchange/i` matcht. Mitigation: das Muster ist
  bewusst eng (drei sehr spezifische EA-Begriffe aus der SBC-Aktionsleiste,
  keine generischen Wörter), und ein Fehltreffer ist nicht schlimmer als der
  heutige Status quo (Container bleibt `null`, FAB bleibt Rückfallweg) — es
  gibt keinen Pfad, auf dem der Fallback etwas KAPUTT macht, das vorher
  funktionierte.
- **`containerFallbackUsed` als modulweiter Zähler, NICHT als
  `STATE.diag`-Feld** — LEARNINGS §25 beschreibt einen symmetrischen Test in
  `solver-test.js`, der jedes gelesene `STATE.diag.*`-Feld gegen seine
  Deklaration prüft. `containerFallbackUsed` folgt stattdessen dem Muster
  von `btnAttachCount`/`launcherClicks` (modulweites `let`, nur im
  `launcher`-Diagnoseblock ausgelesen) — vermeidet, versehentlich einen
  neuen `STATE.diag`-Symmetrie-Fall auszulösen, den diese Aktion gar nicht
  braucht.
- **Mid-Iter-Vermutung (Klasse G):** Sollte sich beim Testen von Aktion 4
  herausstellen, dass `getControllerChain()` nicht sauber stubbbar ist (z.B.
  weil sie tiefer in `services`/`getAppMain()`-Ketten verzweigt als hier
  angenommen), wird der `inSbcView()`-Test auf denselben statischen
  DRY-Check reduziert wie `syncLauncher()` — kein Blocker für Aktionen 1-3,
  die davon unabhängig sind.
- **Edge-Case aus dem Gap-Report (Bänder-Wipe mitten in der Session):** wird
  in diesem Lift NICHT behoben (nicht Teil der vier Aktionen) — bewusst
  zurückgestellt, da `initBandEditor()` bereits sicher auf `defaultBands()`
  zurückfällt und der fehlende Hinweis ("Bänder wurden zurückgesetzt") eine
  reine UX-Politur ohne RA-Wert ist, die den Ambitions-Ziel-Delta von 2
  Punkten nicht braucht.
- **Batch-Modus-Kollision:** `readConfig()` läuft in derselben Iteration
  parallel für Ticket #48 (v4.51.0 im `.worktrees/48`-Baum, laut Auftrag
  bereits belegt). Vor dem Merge dieser Aktion sicherstellen, dass sich die
  Try/Catch-Erweiterung in `onRunClick()` (Aktion 2) nicht mit einer
  gleichzeitigen Änderung an derselben Funktion überschneidet — kleiner
  Diff, aber Merge-Reihenfolge beachten.

## Lift-Plan-Pre-Validation (M2)

Plugin prüft deterministisch via `plan estimate --feature=bedienpanel-ui`:
da keine PK-Dimension existiert (`pk_files_to_cite: []`, `citation_only:
false`), entfällt die PK-Endwert-Schätzung; relevant bleibt
`score_target.RA: 84 ≤ min(structural_max=85, effective_max=85)` (M3-Check
oben) und die Ziel-Erreichung ≥ 90 % über die vier RA-Aktionen (nominale
Einzel-Gains 2–3+2+2+2 decken das Delta von 2 mit deutlichem Puffer).
