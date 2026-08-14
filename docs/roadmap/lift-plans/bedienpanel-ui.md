---
feature: bedienpanel-ui
iteration: 0
score_current:
  RA: 68
score_target:
  RA: 80
primary_paths:
  - pittools/ea-fc-sbc-optimizer.user.js
  - pittools/solver-test.js
  - pittools/docs/LEARNINGS.md
patterns_required:
  - eingebetteten-code-exakt-testen
  - stille-catches-nur-an-der-ea-grenze
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P2-normal
effort: S
analyzed_at: 2026-08-15
---

# Lift-Plan — Bedienpanel & Einstiegspunkte

## Marschroute

Reiner RA-Lift, ohne Solver-Kern- oder Submit-Wege anzufassen. Ziel: den einen
konkret nachgewiesenen SSOT-Bruch im Rating-Kosten-Band-Editor (`defaultBands()`
gegen `DEFAULT_RATING_COST_SPEC`) schließen und die vier Rubric-Lücken
(Testbarkeit, Abbruch-Disziplin, Beobachtbarkeit, Dokumentierte Begründung),
die daraus folgen, einzeln abarbeiten. Reihenfolge folgt exakt
`phase_sequence` aus dem Vision-Doc:

1. **core** — `defaultBands()` von der Literal-Kopie auf eine aus
   `DEFAULT_RATING_COST_SPEC` abgeleitete Funktion umstellen (GEWOLLTE
   Verhaltensänderung, aber NUR im Reset-Pfad) + `lo>hi`-Eingaben im
   Band-Editor sichtbar statt lautlos scheitern lassen.
2. **diagnose** — `buildDiagReport()` additiv um die aktive Rating-Kosten-Spec
   erweitern, damit ein künftiger Drift-Verdacht ohne DevTools am Handy
   nachweisbar ist.
3. **tests** — Band-Editor per Marker-Extraktion in `solver-test.js`
   verankern (Pflicht-Testfall `bandsToSpec(defaultBands()) ===
   DEFAULT_RATING_COST_SPEC`, plus die zwei in Mangel/Edge-Case genannten
   Zusatzfälle).
4. **docs** — `docs/LEARNINGS.md` §10 um den Band-Editor als fragile,
   SSOT-abhängige Stelle ergänzen.
5. **release** — Version bumpen (`@version` + `const VERSION`), Push auf
   `main`.

Kein Eingriff in `parseRatingCosts()`s Kernlogik selbst (das Verhalten „lo>hi
→ Stufe bleibt No-Op" ist danach weiterhin dasselbe, nur sichtbar statt still)
und kein Eingriff in den Solver-Kern (`SolverCore`) — passt zu CLAUDE.mds
„keine Regression" und „kleine Diffs".

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`defaultBands()` aus `DEFAULT_RATING_COST_SPEC` ableiten (SSOT-Fix,
   Reset-Pfad):** `defaultBands()` (`ea-fc-sbc-optimizer.user.js:3360-3371`)
   so umbauen, dass sie `SolverCore`-intern `parseRatingCosts(DEFAULT_RATING_COST_SPEC)`
   (`:1485-1503`) auswertet und daraus die Band-Liste rekonstruiert (Segment-
   Grenzen dort, wo sich der Kosten-Wert der Kostenfunktion ändert), statt die
   Werte `{lo:85,hi:86,cost:5}`/`{lo:87,hi:88,cost:2}` erneut als Literal zu
   schreiben. Betrifft **ausschließlich** den Reset-Button-Pfad
   (`initBandEditor()` bei `:3381-3385`, `ui.bandReset`-Handler bei
   `:3391-3395`): `localStorage['sbcOptRatingBands']` (bereits gespeicherte
   Nutzer-Bands) wird an keiner Stelle gelesen, migriert oder überschrieben —
   `initBandEditor()` liest weiterhin zuerst `saved` und fällt nur bei
   fehlendem/leerem Wert auf `defaultBands()` zurück. Erwarteter Gain: **+6 Pt
   RA** (schließt den in `gaps/bedienpanel-ui.md` explizit benannten
   Hauptabzug — SSOT + Dokumentierte-Begründung-Kriterium).
2. **`warn()` + visuelles Feedback bei `lo>hi`-Bandeingabe:** in `upd()`
   (`ea-fc-sbc-optimizer.user.js:3441-3446`), nach dem bestehenden Klemmen von
   `band.lo`/`band.hi`, ergänzen: `if (band.lo > band.hi) { warn(...); }` plus
   eine visuelle Markierung der betroffenen Zeile (z.B. CSS-Klasse auf `row`).
   Der Grund für das aktuell stille No-Op liegt in `parseRatingCosts()`
   (`:1486-1503`: `for (let r = lo; r <= Math.min(99, hi); r++)` läuft bei
   `lo>hi` nie) — das bleibt unverändert (keine Kernlogik-Änderung), aber die
   UI, die eine ungültige Eingabe erzeugt, meldet sie jetzt. Folgt
   [[stille-catches-nur-an-der-ea-grenze]]: eigene Fachentscheidung (Panel-
   Eingabe), keine Fremd-Grenze — `warn()` ist hier Pflicht, kein bewusst
   leerer Catch. Erwarteter Gain: **+3 Pt RA** (Abbruch-Disziplin-Kriterium).
3. **Band-Editor per Marker in `solver-test.js` verankern (Testbarkeit):**
   neue `// [BANDS-BEGIN]` / `// [BANDS-END]`-Marker um `defaultBands`,
   `bandsToSpec`, `parseRatingCosts`-Aufrufstellen legen (analog
   `// [SOLVER-BEGIN]`/`// [SOLVER-END]` bei `:1411`/`:2446`, Pattern
   [[eingebetteten-code-exakt-testen]]). Drei Testfälle, alle per
   Brute-Force/Ist-Verhalten statt Kopf-Rechnung verifiziert:
   - **Pflicht:** `bandsToSpec(defaultBands()) === SolverCore.DEFAULT_RATING_COST_SPEC`
     — der eigentliche Regressionsschutz für Aktion 1.
   - `lo>hi`-Band bleibt in `parseRatingCosts()` ein No-Op (dokumentiert das
     in Aktion 2 unverändert gelassene Kernverhalten als Testfall statt als
     Überraschung).
   - leere `ratingBands`-Liste → `parseRatingCosts('')` liefert für jedes
     Rating `0` (aktuelles Verhalten, Edge-Case aus dem Gap-Report, als
     Testfall festgeschrieben statt stillschweigend hingenommen).
   Erwarteter Gain: **+5 Pt RA** (schließt die 0-Treffer-Lücke: `grep` über
   `solver-test.js` findet aktuell keine einzige Referenz auf `defaultBands`/
   `bandsToSpec`/`ratingBands`).
4. **`bands`-Feld additiv in `buildDiagReport()` (Beobachtbarkeit):** in
   `buildDiagReport()` (`ea-fc-sbc-optimizer.user.js:3727ff`, Muster wie
   `locks`/`clubLoad` bei `:3760`/`:3772`) ein Feld ergänzen: `bands: {
   spec: bandsToSpec(ratingBands), count: ratingBands.length, isDefault:
   JSON.stringify(ratingBands) === JSON.stringify(defaultBands()) }`. Rein
   additiv — kein bestehendes Feld wird umbenannt oder entfernt. Erwarteter
   Gain: **+3 Pt RA** (Beobachtbarkeits-Kriterium: bei „SBC kostet mehr Rare
   als erwartet" zeigt der Report künftig, welche Tabelle der Solver
   tatsächlich verwendet hat, statt dass Rasmus raten muss).
5. **`docs/LEARNINGS.md` §10 um den Band-Editor ergänzen (Dokumentierte
   Begründung):** neuer Punkt in §10 (nach `:493`), der beschreibt: der
   Band-Editor hat eine eigene Reset-Default-Funktion (`defaultBands()`),
   die aus der Solver-Konstante (`DEFAULT_RATING_COST_SPEC`) abgeleitet wird
   — Änderungen an der Kosten-Tabelle gehören ausschließlich dort hinein,
   nicht als zweites Literal in den Band-Editor. Erwarteter Gain: **+2 Pt RA**
   (Dokumentierte-Begründung-Kriterium; ergänzt, was Mangel 5 im Gap-Report
   als fehlenden Warnhinweis benennt).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 1 (`defaultBands()` aus SSOT ableiten) + Aktion 2 (`lo>hi`-Warnung in `upd()`) |
| diagnose | Aktion 4 (`bands`-Feld in `buildDiagReport()`) |
| tests | Aktion 3 (Marker-Extraktion + 3 Testfälle in `solver-test.js`) |
| docs | Aktion 5 (LEARNINGS §10 ergänzen) |
| release | `@version`/`const VERSION` bumpen, `node --check` + `node solver-test.js` grün, Push auf `main` |

Aktion 1 und Aktion 3 gehören in denselben Feature-Branch-Zeitraum (Fix ohne
Testfall im selben Iterationslauf wäre laut [[wissens-duplikate-ohne-ssot]]
selbst wieder eine ungeschützte Verhaltensänderung), landen aber als getrennte
Phasen-Commits (`core` vor `tests`), damit `git bisect` bei einem Regressions-
verdacht sauber zwischen Logik-Änderung und Test-Ergänzung trennen kann.

## Shared-Item-Bedarf

Keins. Alle vier Aktionen betreffen ausschließlich Code, der bereits
vollständig innerhalb von `bedienpanel-ui`s `code_geography` liegt
(`defaultBands`/`bandsToSpec`/`initBandEditor` bei `:3358-3459`,
`buildDiagReport` bei `:3727ff`); kein zweites Feature konsumiert
`defaultBands()`, den Band-Editor oder `buildDiagReport()`. Deckt sich mit der
Einschätzung im Gap-Report („keine der vier Aktionen hat einen zweiten
Konsumenten außerhalb von `bedienpanel-ui`"). `<feature>.shared-items.json`
ist entsprechend eine leere Liste.

## Risiken / Edge-Cases

- **Bereits gespeicherte Alt-Bands überleben den Fix unverändert (gewollt,
  aber kommunikationspflichtig):** Nutzer (konkret Rasmus), die vor diesem
  Fix schon einmal „Zurücksetzen" gedrückt haben, tragen die veralteten Werte
  (`85-86:5`, `87-88:2`) in `localStorage['sbcOptRatingBands']` — laut
  CLAUDE.md („neue Defaults greifen erst nach ‚Zurücksetzen'") darf dieser
  Storage-Key NICHT automatisch überschrieben werden. Der Fix wirkt also erst
  nach einem erneuten manuellen Reset. Gehört als Hinweis in die
  Release-Kommunikation (Commit-Message/Versionshinweis), sonst hält sich die
  Drift genau bei der Person, die sie ursprünglich gemeldet hat.
- **Leere `ratingBands`-Liste → Kosten durchgehend 0, ohne Warnung:** löscht
  ein Nutzer im Band-Editor alle Zeilen per „✕", liefert `bandsToSpec([])`
  einen leeren String und `parseRatingCosts('')` eine Kostenfunktion, die für
  JEDES Rating `0` zurückgibt — der Solver optimiert dann nur noch nach
  Summe/Storage-Priorität. Dieser Lift-Plan macht daraus **nur** einen
  festgeschriebenen Testfall (Aktion 3), fügt aber bewusst KEINE neue
  Warnung hinzu — das wäre eine zusätzliche, hier nicht beauftragte
  Verhaltensänderung und würde den Diff über den beauftragten Umfang hinaus
  vergrößern. Kandidat für ein eigenes Folge-Ticket, falls Rasmus das live
  als Problem meldet.
- **`solver-test.js:275` und `:440` sind KEINE weiteren SSOT-Drift-Stellen,
  sondern absichtlich fixierte historische Testfälle** (Kommentare
  referenzieren explizit „Live mit v4.8.0"-Vorfälle mit der damals gültigen
  Tabelle) — dieser Plan lässt beide unverändert. Verwechslungsgefahr bei
  einer künftigen Iteration: nicht versehentlich auf `DEFAULT_RATING_COST_SPEC`
  umstellen, das würde die dort geprüften historischen Regressionsfälle
  entwerten.
- **Mid-Iter-Einschub (Klasse G):** keiner erwartet — kein zweiter
  Konsumer, kein Solver-Kern-Eingriff, Diff bleibt innerhalb der vier
  genannten Funktionen plus einem LEARNINGS-Absatz.
- **Regressionsschutz:** Aktion 1 ändert sichtbares Verhalten (Reset liefert
  andere Zahlen als bisher) — genau der Fall, den
  [[wissens-duplikate-ohne-ssot]] als „braucht einen eigenen Testfall pro
  Korrektur, kein stiller Fix nebenbei" markiert. Aktion 3 liefert diesen
  Testfall im selben Iterationsschritt, nicht später.

## Lift-Plan-Pre-Validation (M2)

RA ist `manual_rubric` (semantische Bewertung durch `audit-evaluator`, keine
PK-Formel) — `pk_files_to_cite` bleibt leer, `citation_only: false` (echte
Code-Änderung in Aktion 1/2, keine reine Beleg-Registrierung).
`score_target.RA = 80` folgt der Ambitions-Regel M3:
`68 + (85 − 68) × 0.7 = 79.9 ≈ 80`, ≤ `structural_max` (85). Die fünf
Aktionen adressieren alle fünf im Gap-Report benannten Mängel (SSOT-Drift,
fehlende Testbarkeit, stiller `lo>hi`-Fehlschlag, fehlendes Diagnose-Feld,
fehlender LEARNINGS-Eintrag) mit kumulativ **+19 Pt** geschätztem Gain
gegenüber einer geforderten Mindestdistanz von +12 Pt (90 %-Schwelle:
+10,8 Pt) — Puffer für den Fall, dass der `audit-evaluator` einzelne
Aktionen konservativer bewertet.
