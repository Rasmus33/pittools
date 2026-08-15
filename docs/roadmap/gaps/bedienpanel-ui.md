---
feature: bedienpanel-ui
analyzed_at: 2026-08-15
iteration: 4
regression: false
score_current:
  RA: 82
score_target:
  RA: 84
---

# Gap-Report — Bedienpanel & Einstiegspunkte

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 82 / 85 (structural_max)
**Schwellwert:** 59.5 (85 × 0.7)
**Status:** pass
**Begründung:** Audit Iteration 3 (`docs/roadmap/audit/bedienpanel-ui.md`) bestätigt: Band-Editor-SSOT
(`defaultBands()` ← `SolverCore.DEFAULT_RATING_COST_SPEC`), Nutzer-Bands-Invariante (gespeicherte
Bands überleben Kosten-Tabellen-Änderungen bis "Zurücksetzen"), Testbarkeit für die reinen
Band-Funktionen (0..99-Äquivalenz-Sweep über `[BANDS-BEGIN]`/`[BANDS-END]`) und der
`launcher.*`-Diagnose-Block sind sauber umgesetzt. Der Restabstand zu 85 ist explizit benannt:
"EA-Fehlertoleranz-Achse bewusst nicht angefasst" — genau dort liegt bei Live-Code-Read
(diese Iteration) auch tatsächlich der einzige strukturell nennenswerte Rest: ein einziger
hartkodierter Einhänge-Selektor ohne generischen Fallback, dazu drei kleinere aber echte
Beobachtbarkeits-/Abbruchdisziplin-Lücken, die die übrigen vier RA-Achsen (Testbarkeit,
dokumentiertes Warum, Abbruch-Disziplin für alle ANDEREN Pfade) nicht schmälern, aber auch
nicht weiter heben.

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **Einziger Einhänge-Pfad zur SBC-Aktionsleiste ist ein hartkodierter Selektor ohne
   generischen Fallback** — `sbcButtonContainer()` (`ea-fc-sbc-optimizer.user.js:3832-3838`)
   sucht ausschließlich `.sbc-button-container`; benennt EA diese Klasse um, liefert die
   Funktion dauerhaft `null` und der SBC-Button verschwindet lautlos (FAB bleibt als
   Rückfallweg, aber die zweite, laut LEARNINGS §10 bevorzugte Einhänge-Fläche fällt komplett
   weg). Bemerkenswert: die Fähigkeit, den Container generisch über sichtbaren Button-Text zu
   finden, existiert bereits — aber nur als reiner Diagnose-Scan in `buildDiagReport()`
   (`ea-fc-sbc-optimizer.user.js:4119-4136`, `buttonDump`/`visibleButtons`), nicht als
   tatsächlicher Fallback-Versuch in `sbcButtonContainer()` selbst. Genau das ist die von
   `vision/features/bedienpanel-ui.md` benannte strukturelle Deckelbegründung ("Einhänge-Punkte
   in EAs Container") und der von Audit Iteration 3 explizit offen gelassene Punkt
   ("EA-Fehlertoleranz-Achse bewusst nicht angefasst").
2. **`readConfig()` hat als einziger der zentralen Panel-Helfer keinen DOM-Existenz-Guard** —
   `ea-fc-sbc-optimizer.user.js:4344-4372` liest ~15 `ui.*`-Felder ungeprüft
   (`ui.minrating.value`, `ui.applyrarity.checked`, …), während alle Nachbar-Funktionen im
   selben Block konsequent guarden: `setStatus` (`:3927`, `if (ui.status)`), `refreshSbcInfoUI`
   (`:3929`, `if (!ui.target) return;`), `renderResult` (`:4483`, `if (!ui.result) return;`),
   `showProgress`/`finishProgress` (`:4535`, `:4544`, je `if (!ui.progress) return;`). Fehlt
   ein referenziertes Element (z.B. durch eine künftige Panel-HTML-Änderung, die eine `id=`
   vergisst — LEARNINGS §10 nennt genau dieses Fehlerbild für v4.17.0), wirft `readConfig()`
   unabgefangen mitten in `onRunClick()` (`:4438-4481`); nur das `finally` (Button
   reaktivieren) läuft noch, `setStatus`/`toast`/`diagError` werden nie erreicht — der Status
   bleibt auf dem vorherigen Text ("optimiere...") stehen, ohne dass Rasmus je einen Hinweis
   auf die Ursache bekäme.
3. **Drei `localStorage`-Schreibpfade schlucken Quota-/SecurityError vollständig lautlos** —
   `saveBands()` (`ea-fc-sbc-optimizer.user.js:3594-3596`), der "Erweiterte
   Einstellungen"-Toggle (`:3554`) und die Drag-Positions-Persistenz in `makeDraggable`
   (`:3766-3769`) fangen jeweils nur mit leerem `catch (e) {}` — ohne `warn()`, ohne
   `reportError()`/`diagError()`. Das widerspricht dem im selben File etablierten Muster
   (LEARNINGS §23: `reportError()` als Choke-Point genau für diese Fehlerklasse, an anderen
   Stellen wie `apiGet`/`apiPut`/`submitToSbc` bereits verwendet). Im Private-Modus oder bei
   voller Storage-Quota "funktioniert" der Band-Editor optisch (In-Memory-Array `ratingBands`
   wird weiter aktualisiert), aber nichts überlebt den nächsten Reload — ohne jede sichtbare
   Fehlermeldung, weder im Panel noch im Diagnose-Report.
4. **Keine gegenseitige Ausschluss-Sperre zwischen "Spieler laden" und "Optimieren"** —
   `onRunClick()` (`ea-fc-sbc-optimizer.user.js:4438-4481`) prüft nur `STATE.pool.length === 0`
   (`:4448-4451`), nicht `STATE.loading`. `onLoadClick()` (`:4399-4437`) setzt bei einem
   Voll-Refresh `STATE.pool = []` und befüllt danach asynchronously neu; `loadPool()` setzt
   `STATE.loadIncomplete = false` erst bei eigenem Start (`:1424`) und `= true` erst bei einem
   tatsächlichen Fehlschlag mitten im Laden (`:1451`). Ein Klick auf "Optimieren" während eines
   laufenden Ladens sieht während der Zwischenzustände weder einen leeren Pool (Check greift
   nicht mehr) noch `loadIncomplete=true` (wird erst gesetzt, falls überhaupt ein Fehlschlag
   auftritt) — der Solver kann so unbemerkt auf einem noch unvollständigen Pool laufen, ohne
   dass die sonst übliche "Pool unvollständig geladen"-Warnung (`:4457-4460`) greift. Zusätzlich
   überschreiben sich die `setStatus()`-Aufrufe beider Flows gegenseitig (kein Sperr- oder
   Prioritätsmechanismus für den Statustext).

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **Generischen Text-Fallback für `sbcButtonContainer()` ergänzen (additiv).** Zweiter
   Versuch NACH dem bestehenden `.sbc-button-container`-Lookup: sichtbare Buttons nach Text
   durchsuchen (Muster wie bereits in `buttonDump`, `ea-fc-sbc-optimizer.user.js:4119-4136`
   vorhanden, z.B. `/squad builder|clear squad|exchange/i`) und deren gemeinsamen Elternknoten
   als Container zurückgeben, nur wenn der primäre Selektor nichts liefert — der bisherige Pfad
   bleibt Pfad 1, unverändert. Diagnose-Zähler `containerFallbackUsed` in `buildDiagReport()`
   ergänzen, damit ein Umstieg auf den Fallback sichtbar bleibt statt nur implizit zu
   funktionieren. Schließt exakt die von Audit Iteration 3 benannte Lücke.
   **Erwarteter Gain:** +2–3 Pt RA (Fehlertoleranz-Achse, direkt zielgerichtet).
2. **`readConfig()` gegen fehlende DOM-Referenzen absichern.** Entweder (a) einen Guard nach
   dem Vorbild der Nachbarfunktionen ergänzen, der bei fehlendem Kern-Element ein
   `{ ok:false, reason:'...' }` liefert (Pattern `strukturierte-ok-why-rueckgabe`), das
   `onRunClick()` dann sauber mit Toast + `setStatus('Fehler')` behandelt, oder (b) minimal den
   Aufruf in `onRunClick()` in denselben Try/Catch-Stil einbetten, der bereits um
   `SolverCore.solve()` liegt (`:4466-4467`), inklusive `reportError('readConfig', e)`.
   **Erwarteter Gain:** +2 Pt RA (Beobachtbarkeit + Abbruch-Disziplin).
3. **Die drei stillen `localStorage`-Catches auf `reportError()` umstellen.** Bestehenden
   Choke-Point (LEARNINGS §23, bereits an `apiGet`/`apiPut`/`submitToSbc` verwendet) an
   `saveBands()` (`:3595`), dem Advanced-Toggle (`:3554`) und der Drag-Positions-Persistenz
   (`:3768`) nachziehen — reine Ergänzung im Catch-Zweig, kein Verhaltensunterschied im
   Erfolgsfall. Macht Private-Mode/Quota-Fälle zum ersten Mal überhaupt sichtbar.
   **Erwarteter Gain:** +2 Pt RA (Beobachtbarkeit-Achse, schließt eine konkrete Instanz des
   dokumentierten Antipatterns `fehler-unsichtbar-verschluckt`).
4. **[dünn] `STATE.loading`-Guard am Anfang von `onRunClick()` ergänzen**, analog zum bereits
   vorhandenen Re-Entrancy-Schutz in `onLoadClick()` (`:4401-4405`): bei aktivem Laden Toast
   ("Lädt noch – bitte warten.") statt Solve-Versuch. Mechanisch klein, das Zeitfenster ist eng
   (wenige hundert ms) und führt zu keiner Datenkorruption (der Solver liest immer eine
   konsistente Array-Referenz), nur zu einem irreführenden Status-Text bzw. einem potenziell
   suboptimalen Team ohne Warnhinweis — daher als dünne, aber saubere Einzelmaßnahme markiert.
   **Erwarteter Gain:** +1 Pt RA (Abbruch-Disziplin).
5. **Fallback-Logik testbar machen (Voraussetzung: Aktion 1 zuerst).** `sbcButtonContainer()`/
   `syncLauncher()`/`inSbcView()` per Marker-Block extrahieren und nach dem Vorbild von
   `app/guard-test.js` (Fake-DOM in einer `vm`-Sandbox, bereits im selben Repo etabliert) in
   `solver-test.js` durchspielen: (a) primärer Selektor vorhanden → Attach über Pfad 1,
   (b) Selektor umbenannt/fehlt + Text-Fallback vorhanden → Attach über Pfad 2, (c) beides
   fehlt → nur FAB, kein Wurf. Adoptiert das Pattern `eingebetteten-code-exakt-testen`, das für
   `bedienpanel-ui` bereits als `applies_to_features` gelistet ist, aber für diese drei
   DOM-Helfer noch nicht genutzt wird (nur `defaultBands`/`bandsToSpec` sind aktuell per Marker
   getestet). **Erwarteter Gain:** +2 Pt RA (Testbarkeits-Achse), zieht Aktion 1 voraus.

## Edge-Cases (mind. 1 — M1)

- **`localStorage`-Wipe MITTEN in der Session statt nur beim Start.** LEARNINGS §10 dokumentiert
  bereits den Fall "Kosten-Tabelle ändert sich, gespeicherte Nutzer-Bands bleiben unberührt" —
  der Umkehrfall wird leicht vergessen: verliert der Browser/die WebView `localStorage`
  zwischen zwei Panel-Öffnungen (Low-Memory-Eviction, EA-Storage-Wipe, manuelles Leeren durch
  Rasmus), fällt `initBandEditor()` (`:3597-3601`) beim nächsten Laden lautlos auf
  `defaultBands()` zurück — korrekt und sicher, aber ohne jede sichtbare Meldung ("deine
  benutzerdefinierten Bänder wurden zurückgesetzt"). Wird bei einem Lift der Fallback-/
  Diagnose-Achse leicht übersehen, weil der Code an dieser Stelle bereits "funktioniert"
  (kein Crash, sinnvoller Default) und deshalb nicht als Mangel auffällt, obwohl er dieselbe
  Beobachtbarkeits-Lücke wie Mangel 3 hat, nur am Lesepfad statt am Schreibpfad.

## Lift-Empfehlung

Vorsichtig, additiv, gezielt: Genau EIN strukturell benannter Rest (EA-Fehlertoleranz beim
Container-Einhängen) trägt den Löwenanteil des möglichen Gains (Aktion 1, +2–3 Pt) und ist
durch die bereits vorhandene `buttonDump`-Diagnose fast fertig vorbereitet — reine
Fallback-Verdrahtung, kein Neubau. Aktionen 2–3 sind kleine, mechanische
Beobachtbarkeits-Ergänzungen nach etabliertem Muster (`reportError()`), die ohne Risiko einzeln
umsetzbar sind. Aktion 4 ist bewusst als dünn markiert — bei knappem Iterations-Budget zuerst
1–3 umsetzen, 4 nur mitnehmen wenn Zeit bleibt. Aktion 5 (Testbarkeit) sollte NACH Aktion 1
laufen, da sie deren Fallback-Verzweigung testet — kein Mid-Iter-SI nötig, klassische
Sequenz innerhalb einer Iteration.
