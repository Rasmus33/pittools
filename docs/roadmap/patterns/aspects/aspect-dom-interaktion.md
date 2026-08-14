---
slice: dom-interaktion
analyzed_at: 2026-08-14
iteration: 0
---

# Aspect — dom-interaktion

Rohaufnahme dessen, was im Code zur Slice tatsächlich vorkommt. Vom
`aspect-analyzer`-Subagent geschrieben (Sonnet, parallel pro Slice).
Wird pro Iteration überschrieben — Git-Log ist die Historie.

## Beobachtetes Pattern: Vollständige Tap-Nachbildung statt `el.click()`

**Was passiert:** Die EA-Views hängen ihre Tap-Handler an ein eigenes
Event-System (Touch-Kette), das kein nacktes `el.click()` erreicht. Der
zentrale Helper `clickLike()` bildet einen echten Tap in fünf Schritten nach:
`scrollIntoView` → Mittelpunkt-Koordinaten aus `getBoundingClientRect()`
berechnen → `Touch`-Objekte + `touchstart`/`touchend` feuern → nur falls kein
Touch-Handler `preventDefault` aufgerufen hat, zusätzlich Pointer-/Maus-Kette
(`pointerdown/up`, `mousedown/up`, `click`) → danach `elementFromPoint`-Check,
ob an der Tap-Stelle wirklich das Zielelement (oder ein Kind/Parent davon)
liegt.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:4578-4646` — `clickLike(el)`: scrollIntoView,
  Koordinatenberechnung, Touch-Objekte, Fallback-Kette, `elementFromPoint`-
  Deckungscheck, Ablage in `STATE.diag.lastTap`.
- `ea-fc-sbc-optimizer.user.js:4600-4613` — bedingte Touch-Emulation nur wenn
  `window.Touch`/`window.TouchEvent` existieren, mit `identifier`, `pageX/Y`
  in den `Touch`-Objekten.
- `ea-fc-sbc-optimizer.user.js:4615-4623` — Pointer-/Maus-Fallback wird NUR
  gefeuert, wenn `touchHandled` (aus `preventDefault` auf `touchend`) false
  ist — vermeidet doppelte Navigation.
- `ea-fc-sbc-optimizer.user.js:4554-4577` — Kommentarblock, der die drei
  live gefundenen Fehlerursachen (fehlende Touch-Events, Koordinaten 0/0,
  fehlendes scrollIntoView) dokumentiert und mit der Lösung verknüpft.
- `docs/LEARNINGS.md:782-821` (§21) — Live-Beleg (`batchSteps`-Auszug), der
  exakt zu diesem Code führte; Ursache wird explizit als „dieselbe
  Fehlerklasse wie `element.click()`, nur eine Schicht tiefer" eingeordnet.

**Wo das (noch) fehlt:** Alle Aufrufer (`clickAllFilter`, `clickSetTile`,
`clickChallengeRow`, `clickBackButton`) nutzen ausnahmslos `clickLike()` —
kein abweichender Klick-Weg im Slice gefunden.

## Beobachtetes Pattern: Strukturierte `{ ok, why, ... }`-Rückgabe pro DOM-Aktion

**Was passiert:** Jede DOM-Interaktionsfunktion, die eine EA-Ansicht bedient,
gibt statt eines nackten Booleans ein Objekt mit `ok` und einer für Menschen
lesbaren `why`-Begründung (plus Zusatzfeldern wie `tiles`, `seen`, `tap`)
zurück. Das speist direkt den Diagnose-Report (`buildDiagReport`) und die
`batchSteps`-Historie, ohne dass dafür extra Log-Aufrufe nötig sind.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:4663-4673` — `clickAllFilter()`: drei
  `{ok, why}`-Rückgaben (schon auf All / gestellt / kein Filter gefunden).
- `ea-fc-sbc-optimizer.user.js:4681-4717` — `clickSetTile(plan)`: `why`
  unterscheidet Trefferart (`exakt`/`Anfang`/`enthalten`) und liefert bei
  Fehlschlag `titles`-Dump der sichtbaren Kacheln zur Ferndiagnose.
- `ea-fc-sbc-optimizer.user.js:4719-4733` — `clickChallengeRow()`: bei
  Fehlschlag `seen`-Objekt mit Elementzahlen pro Fallback-Selektor.
- `ea-fc-sbc-optimizer.user.js:4744-4754` — `clickBackButton()`: `why`
  unterscheidet „Overlay offen" von „kein Button gefunden" von Erfolg.
- `ea-fc-sbc-optimizer.user.js:4434-4437` — `openNextInstance()` nutzt
  dieselbe Konvention für den Abbruchgrund „Set nicht mehr wiederholbar".

**Wo das (noch) fehlt:** Keine Ausnahme im Slice gefunden — alle 14
`why:`-Stellen folgen der Konvention.

## Beobachtetes Pattern: Fallback-Selektorketten gegen wechselnde/uneindeutige EA-Klassen

**Was passiert:** Weil EA-CSS-Klassen sich zwischen Formfaktoren (Hoch-/
Querformat, PC/Handy) oder FC-Versionen unterscheiden können, probieren
mehrere Stellen eine Kette von Selektoren/Vergleichsstrategien statt sich auf
einen zu verlassen.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:4720-4722` — `clickChallengeRow()`: erst
  `.ut-sbc-challenge-table-row-view`, dann `.ut-sbc-challenge-tile-view`,
  dann `.ut-sbc-challenges-view--challenges > *`.
- `ea-fc-sbc-optimizer.user.js:4692-4703` — `clickSetTile()`: Titelvergleich
  in drei Stufen (exakter Titel → Titel-Anfang → Teilstring), mit Kommentar,
  warum reiner Teilstring-Vergleich falsche Treffer produziert hätte
  ("Upgrade" steckt in vielen Kachel-Titeln).
- `ea-fc-sbc-optimizer.user.js:4749-4750` — `clickBackButton()`: zwei
  Selektoren (`.ut-navigation-button-control`, `.ut-navigation-bar-view
  .btn-navigation`) hintereinander.
- `ea-fc-sbc-optimizer.user.js:3829-3850` — `buildDiagReport().launcher`:
  wenn `.sbc-button-container` in einer FC-Version anders heißt, liefert ein
  Dump ALLER sichtbaren Buttons mit Text als Diagnose-Ersatz.
- `ea-fc-sbc-optimizer.user.js:4708-4713` — `clickSetTile()` klickt erst die
  Kachel, dann zusätzlich ihr Titel-Kind-Element, weil manche Views den
  Tap-Handler am Kind statt am Container registrieren.

**Wo das (noch) fehlt:** Kein Gegenbeispiel gefunden.

## Beobachteter Antipattern: Sichtbarkeits-Check dupliziert statt `visibleAll()` zu nutzen

**Was schiefläuft:** Der Ausdruck
`el.offsetParent !== null || el.getClientRects().length` (Sichtbarkeits-Test
für DOM-Elemente, die mehrfach unsichtbar im DOM verdoppelt vorliegen können)
ist an fünf Stellen inline geschrieben, obwohl mit `visibleAll(sel)` bereits
ein Helper existiert, der genau das kapselt. Nur eine der fünf Stellen ist
`visibleAll()` selbst — die anderen vier duplizieren die Logik statt sie
aufzurufen.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:4653` — `visibleAll(sel)` (der Helper selbst,
  einzige kanonische Implementierung).
- `ea-fc-sbc-optimizer.user.js:3609` — `sbcButtonContainer()`: identischer
  Ausdruck inline statt `visibleAll('.sbc-button-container')[0]`.
- `ea-fc-sbc-optimizer.user.js:4279` — `popupState()`: identischer Ausdruck
  inline bei der Overlay-Erkennung.
- `ea-fc-sbc-optimizer.user.js:3794` — `buildDiagReport().hubScan`:
  identischer Ausdruck inline beim Abscannen der Set-Kacheln.
- `ea-fc-sbc-optimizer.user.js:3839` — `buildDiagReport().launcher.buttonDump`:
  identischer Ausdruck inline beim Abscannen aller Buttons.

**Vermutete Wurzelursache:** Q4 (DRY) — `visibleAll()` wurde vermutlich erst
später (im Rahmen der Tap-Fixes, LEARNINGS §21) als eigenständiger Helper
extrahiert, die älteren/parallelen Stellen (`sbcButtonContainer`,
`popupState`, die beiden Diagnose-Scans) wurden nicht nachträglich darauf
umgestellt. Funktional unauffällig (alle fünf Stellen sind konsistent),
aber ein künftiger Fix an der Sichtbarkeitslogik (z.B. andere Heuristik für
"sichtbar") müsste an fünf Stellen statt einer nachgezogen werden.

## Weak Signals (zu wenige Belege für Pattern-Status)

- **Popup-/Shield-Gating vor Navigationsklicks:** `clickBackButton()`
  (`ea-fc-sbc-optimizer.user.js:4744-4748`) verweigert den Klick, wenn
  `popupState()` ein offenes Overlay meldet ("nie blind in einen Dialog").
  Nur eine Stelle im Slice führt diese Vorab-Prüfung vor einem Klick aus
  (andere Klick-Funktionen wie `clickSetTile`/`clickChallengeRow` prüfen das
  nicht) — zu wenige Belege für ein Pattern, aber ein klarer Sicherheits-
  Gedanke, der bei künftigen Klick-Funktionen relevant werden könnte.
- **EA-Klassennamen gegen PaleTools-Bundle verifiziert:**
  `ea-fc-sbc-optimizer.user.js:3554` und `:4548` kommentieren, dass die
  verwendeten EA-CSS-Klassen (`.sbc-button-container`,
  `.ut-sbc-set-tile-view`, `.ut-sbc-challenge-table-row-view`) nicht geraten,
  sondern in PaleTools' Bundle gegengeprüft wurden. Nur zwei Belegstellen,
  aber es erklärt, warum die Selektoren trotz fehlender offizieller EA-Doku
  vertrauenswürdig sind.
- **Panel-eigene `querySelector`-Verdrahtung (kein EA-View):** Die große
  `ui = { ... panel.querySelector('#sbc-opt-...') }`-Blockliste
  (`ea-fc-sbc-optimizer.user.js:3289-3324`) betrifft ausschließlich vom
  Script selbst erzeugte Elemente, nicht EA-Views — thematisch am Rand der
  Slice ("DOM-Interaktion mit EAs Views"), da hier keine Tap-Nachbildung,
  Sichtbarkeits-Unsicherheit oder Popup-Konkurrenz besteht. Erwähnt zur
  Abgrenzung, nicht als Pattern-Kandidat für diese Slice.

## Zusammenfassung

- 3 Pattern-Kandidaten in dieser Slice
- 1 Antipattern-Kandidat
- 3 Weak Signals
