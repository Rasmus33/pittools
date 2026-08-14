---
feature: bedienpanel-ui
analyzed_at: 2026-08-14
iteration: 0
regression: false
score_current:
  RA: 68
score_target:
  RA: 78
---

# Gap-Report — Bedienpanel & Einstiegspunkte

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 68 / 85 (structural_max)
**Schwellwert:** 59.5
**Status:** pass
**Begründung:** Laut `audit-evaluator` sind die Einstiegspunkte (FAB, SBC-Button,
Panel-Öffnen/-Ziehen, generische DOM-Erkennung, Fail-Open, LEARNINGS §10) robust
gegen EAs undokumentierten Wandel — das trägt den Großteil der 68 Punkte. Der
Abzug gegenüber dem strukturellen Maximum kommt konkret aus dem Band-Editor
(`defaultBands()`): er liefert nachweislich veraltete Reset-Werte, ein
SSOT-Bruch gegenüber `DEFAULT_RATING_COST_SPEC` ohne Drift-Test — also ein
Verstoß gegen die RA-Rubric-Kriterien „Dokumentierte Begründung" und
„Testbarkeit" innerhalb eines ansonsten soliden Features.

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`defaultBands()` driftet gegen `DEFAULT_RATING_COST_SPEC` (SSOT-Bruch, Q5):**
   `ea-fc-sbc-optimizer.user.js:1485` definiert die aktuelle, von Rasmus
   korrigierte Tabelle (`85-88:2`, Stand Aug 2026). `ea-fc-sbc-optimizer.user.js:3360-3370`
   (`defaultBands()`, im Reset-Button `ui.bandReset` verdrahtet über
   `initBandEditor()` bei `:3391-3395`) liefert stattdessen den alten Stand
   (`{lo:85,hi:86,cost:5}`, `{lo:87,hi:88,cost:2}`). `readConfig()` baut
   `cfg.ratingCostSpec` bei `:4054` IMMER aus `bandsToSpec(ratingBands)` — bei
   Panel-Betrieb ist `DEFAULT_RATING_COST_SPEC` damit faktisch tot, und
   „Zurücksetzen" liefert nachweislich falsche Zahlen. Siehe Pattern
   [[wissens-duplikate-ohne-ssot]] (Code-Beleg dort deckungsgleich).
2. **Kein Testfall für den Band-Editor überhaupt (Testbarkeit-Kriterium der Rubric):**
   `solver-test.js` enthält keine einzige Referenz auf `defaultBands`,
   `bandsToSpec` oder `ratingBands` (grep über die gesamte Datei: 0 Treffer).
   Damit fehlt dem Band-Editor genau die Absicherung, die
   `eingebetteten-code-exakt-testen` (`applies_to_features` listet
   `bedienpanel-ui` explizit) für den Rest der Datei längst etabliert hat
   (Marker-Extraktion für den Solver bei `:1411`/`:2446`, statische Checks für
   Panel-HTML bei `solver-test.js:380-410`) — der Band-Editor selbst blieb
   davon ausgenommen und die Drift aus Mangel 1 fiel deshalb nicht in CI auf.
3. **Ungültige Band-Eingaben scheitern lautlos statt mit `warn()`/Nutzer-Feedback (Abbruch-Disziplin):**
   `parseRatingCosts()` (`ea-fc-sbc-optimizer.user.js:1486-1503`) iteriert
   `for (let r = lo; r <= Math.min(99, hi); r++)`. Trägt ein Nutzer im
   Band-Editor (`renderBandRows()`/`upd()`, `:3441-3449`) versehentlich
   `lo > hi` ein (z.B. Zeilen per Zahlenfeld ohne Ordering-Check editiert),
   läuft die Schleife nie und die Stufe wird kommentarlos zum No-Op — kein
   `toast()`, kein `warn()`, keine visuelle Markierung der Zeile. Das ist
   KEINE legitime Fremd-Grenze im Sinne von
   [[stille-catches-nur-an-der-ea-grenze]] (eigene UI-Eingabe, keine
   EA-/`localStorage`-Grenze), sondern eine eigene Fachentscheidung, für die
   das Pattern selbst `warn()` verlangt.
4. **`buildDiagReport()` enthält keinerlei Feld zur aktiven Rating-Kosten-Spec
   (Beobachtbarkeits-Kriterium):** `ea-fc-sbc-optimizer.user.js:3727-3820`
   listet u.a. `counts`, `locks`, `clubLoad`, `submitCandidates`, aber nirgends
   `ratingCostSpec`/`ratingBands`. Bei Verdacht auf genau die in Mangel 1
   beschriebene Drift (Rasmus meldet „SBC kostet mehr Rare als erwartet")
   liefert der Diagnose-Report — laut CLAUDE.md „Debugging-Konvention" der
   einzige Kanal ohne DevTools am Handy — keinen Anhaltspunkt, welche Tabelle
   der Solver gerade tatsächlich verwendet hat.
5. **LEARNINGS.md §10 dokumentiert Einstiegspunkte ausführlich, aber nicht den
   Band-Editor als fragile Stelle (Dokumentierte-Begründung-Kriterium):**
   `docs/LEARNINGS.md:436-493` behandelt FAB/SBC-Button/Drag/Pointer-Events
   mit klarem WARUM je Incident, erwähnt aber an keiner Stelle den
   Reset-Pfad oder das SSOT-Risiko der Kosten-Tabelle — obwohl CLAUDE.md
   („Rating-Kosten-Tabelle … Tabelle UND Max-Überschuss liegen in
   localStorage: neue Defaults greifen erst nach 'Zurücksetzen'") diese
   Stelle bereits als heikel markiert. Der Drift wäre kein „Nicht anfassen
   ohne Grund"-Kandidat, sondern hätte hier als aktiver Warnhinweis stehen
   müssen.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`defaultBands()` gegen `DEFAULT_RATING_COST_SPEC` ableiten statt duplizieren:**
   `defaultBands()` (`ea-fc-sbc-optimizer.user.js:3360-3370`) so umbauen, dass
   sie aus `DEFAULT_RATING_COST_SPEC` (`:1485`) via `parseRatingCosts()` +
   Band-Rekonstruktion erzeugt wird (oder minimal: die Literal-Werte 1:1 auf
   den aktuellen Spec-String synchronisieren) — SSOT-Fix nach
   [[wissens-duplikate-ohne-ssot]]. **Nur der Reset-Pfad ändert sich**,
   `localStorage['sbcOptRatingBands']` (gespeicherte Nutzer-Bands) bleibt
   unangetastet — `initBandEditor()` (`:3382-3385`) liest weiterhin zuerst
   `saved`. Neuer statischer Testfall in `solver-test.js` (per
   Marker-Extraktion, s. Aktion 2) muss `bandsToSpec(defaultBands()) ===
   DEFAULT_RATING_COST_SPEC` verifizieren, sonst wäre dies laut Pattern eine
   stille Verhaltensänderung ohne Regressionsschutz. Erwarteter Gain: **+8 Pt
   RA** (schließt den in `SCORE_RESULT.details.reasoning` explizit genannten
   Hauptabzug).
2. **Band-Editor per Marker in `solver-test.js` extrahieren und testen
   (Pattern-Adoption `eingebetteten-code-exakt-testen`):** neue
   `// [BANDS-BEGIN]`/`// [BANDS-END]`-Marker um `defaultBands`,
   `bandsToSpec`, `parseRatingCosts` legen (analog zu den bestehenden
   `[SOLVER-BEGIN]`/`[SOLVER-END]`-Markern bei `:1411`/`:2446`), Testfälle für
   (a) `bandsToSpec(defaultBands()) === DEFAULT_RATING_COST_SPEC`, (b)
   `lo > hi` → Band bleibt No-Op (dokumentiert erwartetes Verhalten oder
   erzwingt Korrektur, je nach Aktion 3), (c) leere `ratingBands`-Liste →
   `parseRatingCosts('')` liefert durchgehend Kosten 0 (aktuelles Verhalten,
   als Testfall festgeschrieben statt überraschend). Erwarteter Gain: **+7 Pt
   RA** (Testbarkeits-Kriterium, schließt die 0-Treffer-Lücke aus Mangel 2).
3. **`warn()`+visuelles Feedback bei ungültiger Band-Eingabe:** in `upd()`
   (`ea-fc-sbc-optimizer.user.js:3441-3449`) nach dem Klemmen von `lo`/`hi`
   prüfen `if (band.lo > band.hi) { warn('Band ' + band.lo + '-' + band.hi +
   ' ist ungültig (lo>hi), wird ignoriert.'); row.classList.add('sbc-opt-bandinvalid'); }`
   — folgt der in [[stille-catches-nur-an-der-ea-grenze]] selbst gezogenen
   Grenze (eigene Fachlogik, kein Fremd-Catch). Erwarteter Gain: **+4 Pt RA**
   (Abbruch-Disziplin).
4. **`ratingCostSpec`/aktive Bands in `buildDiagReport()` aufnehmen +
   LEARNINGS.md-Eintrag ergänzen:** in `buildDiagReport()`
   (`ea-fc-sbc-optimizer.user.js:3727ff`) ein Feld `bands: { spec:
   bandsToSpec(ratingBands), count: ratingBands.length, isDefault:
   JSON.stringify(ratingBands) === JSON.stringify(defaultBands()) }`
   ergänzen (Muster wie `locks`/`clubLoad` bei `:3760`/`:3772`); zusätzlich
   `docs/LEARNINGS.md` §10 um einen Punkt „Band-Editor: `defaultBands()` MUSS
   synchron zu `DEFAULT_RATING_COST_SPEC` bleiben, Reset-Button betroffen"
   erweitern. Erwarteter Gain: **+5 Pt RA** (Beobachtbarkeit +
   Dokumentierte Begründung, zwei Rubric-Kriterien gleichzeitig).

## Edge-Cases (mind. 1 — M1)

- **Bereits gespeicherte Alt-Bands nach dem Fix:** Nutzer, die VOR dem
  SSOT-Fix schon einmal „Zurücksetzen" gedrückt haben, tragen die veralteten
  Werte (`85-86:5`, `87-88:2`) inzwischen in `localStorage['sbcOptRatingBands']`
  — laut Aufgabenstellung und CLAUDE.md („Tabelle UND Max-Überschuss liegen in
  localStorage: neue Defaults greifen erst nach 'Zurücksetzen'") darf der Fix
  diesen Storage-Key NICHT automatisch überschreiben/migrieren. Der Fix behebt
  also nur zukünftige Resets; Rasmus muss nach dem Update ggf. einmal manuell
  erneut „Zurücksetzen" drücken, um die korrigierte Tabelle zu bekommen — das
  gehört als Hinweis in die Release-Kommunikation, sonst hält sich die Drift
  für genau die Nutzer, die sie zuerst gemeldet haben.
- Zusätzlich zu beachten (nicht Pflicht-Edge-Case, aber leicht übersehen):
  leere `ratingBands`-Liste (alle Zeilen per „✕" gelöscht) liefert über
  `bandsToSpec([]) === ''` und `parseRatingCosts('')` einen Kosten-Fn, der für
  JEDES Rating 0 zurückgibt — der Solver optimiert dann nur noch nach
  Summe/Storage, ohne dass irgendwo eine Warnung erscheint.

## Lift-Empfehlung

Vorsichtig, kleiner Diff: alle vier Aktionen betreffen ausschließlich den
Reset-Pfad und Diagnose/Doku, nicht den Solver-Kern oder Submit-Wege — passt
zu CLAUDE.md „Kleine Diffs, additiv statt Ersatz". Aktion 1+2 gehören
zusammen in einen Schritt (Fix + Test im selben Commit, sonst ungeschützte
Verhaltensänderung); Aktion 3+4 können unabhängig und risikofrei folgen. Kein
Mid-Iter-SI nötig — keine der vier Aktionen hat einen zweiten Konsumenten
außerhalb von `bedienpanel-ui`.
