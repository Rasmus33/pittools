---
feature: batch-modus
analyzed_at: 2026-08-15
iteration: 5
regression: false
score_current:
  RA: 69
score_target:
  RA: 70
---

# Gap-Report — Batch-Modus (Mehrfach-Abgabe)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 69 / 70 (structural_max)
**Schwellwert:** 49 (70 × 0.7)
**Status:** pass
**Begründung:** `audit/batch-modus.md` (Iteration 4) bestätigt alle 4 zuvor geplanten Aktionen als exakt umgesetzt (echte Verhaltenstests statt String-Grep, `usedChallengeIds`-Sperre + Submit-Plausibilisierung additiv, Abbruch-Philosophie unangetastet) und benennt den verbleibenden 1 Punkt explizit als „EA-Wandel-Toleranz bewusst nicht adressiert". Diese Iteration prüft genau diesen Rest unter der EA-Wandel-Linse (Tap-Navigation: `clickSetTile`/`clickAllFilter`/`clickChallengeRow`/`clickBackButton`, `openNextInstance`).

**Vorab-Befund zur Abbruch-Disziplin selbst:** Sie hält. `openNextInstance()` (ea-fc-sbc-optimizer.user.js:4802-4923) bricht bei DOM-Totalausfall (z.B. `.ut-sbc-set-tile-view` liefert 0 Treffer, weil EA die Klasse umbenennt) nach dem vollen 60×300ms-Fenster mit `exhausted`-Klassifizierung + `steps`-Dump ab; `onBatchRunClick()` (5301-5392) wirft daraufhin eine erklärende Meldung („Die nächste Runde liess sich nicht öffnen (Diagnose schicken: batchSteps)." bzw. die freundlichere Set-erschöpft-Variante), verbraucht den Plan im `finally` und zeigt „`done` von `n`". Popup-Erkennung läuft bereits über eine generische Wildcard (`[class*="dialog"],[class*="popup"],[class*="overlay"],[class*="modal"]`, popupState():4610-4644) plus einen strukturellen Kanal (`gPopupClickShield`), nicht über hartkodierte Einzelklassen — das ist genau die Art Fehlertoleranz, die die RA-Rubric positiv bewertet. Der reale Rest-Gap liegt NICHT in der Abbruch-Disziplin, sondern in einer einzelnen, konkret lokalisierbaren Stelle, an der EAs DOM-Wandel NICHT zu einem Abbruch führt, sondern zu einem unauffälligen Fallback-Treffer.

## Mängel (RA)

1. **`clickSetTile()`s Titel-Fallback reaktiviert die 2023 gefixte "falsche Kachel"-Klasse, wenn EA nur die INNEREN Elemente umbaut** (ea-fc-sbc-optimizer.user.js:5069-5073, Nutzung 5074-5099): `titleOf(t)` sucht `.tileTitle, .tileHeader, h1`; existiert keines dieser drei (Klasse umbenannt, Markup umstrukturiert — die Kachel selbst `.ut-sbc-set-tile-view` bleibt aber bestehen), fällt die Funktion auf `t.textContent` zurück — den GESAMTEN Kachel-Text inkl. Beschreibung und Belohnungen. Genau dieses Verhalten war laut LEARNINGS §9 (v4.23.0) live der Fehler ("Teilstring-Matching trifft die falsche SBC"), der Anlass für die dreistufige exakt→Anfang→Teilstring-Reihenfolge UND die Beschränkung auf `.tileTitle`/`.tileHeader` war. Der Fallback bricht NICHT ab und liefert `ok: true` — es wird eine Kachel angeklickt, ohne dass unterscheidbar ist, ob der Treffer über den echten Titel oder über den degradierten Volltext zustande kam.
2. **Dieser Fallback-Pfad ist ungetestet** (solver-test.js — Grep auf `titleOf`/`tileTitle` findet nur den vorhandenen Kommentar-Treffer bei :1859, keinen Testfall; :2736 stubbt `clickSetTile` komplett weg statt seine interne Matching-Logik zu prüfen). Getestet sind `matchesPlannedSbc`, `isFreshMatchingInstance`, `shouldTryBack` und die Orchestrierung um `openNextInstance` (solver-test.js:1976-2145, 2646-2760) — nicht aber `clickSetTile`s eigene Titel-Vergleichslogik. Die „Testbarkeit"-Rubric-Spalte ist damit ausgerechnet für den EA-Wandel-relevantesten Codeteil eine Lücke.
3. **Kein Häufigkeits-Diagnosefeld für Popup-Dismiss-Aktivität während eines Batch-Laufs** (dismissRewardPopup():4645-4676, Aufruf in der 300ms-Schleife bei 4825): `popupState()`s generische Erkennung ist bereits robust (s.o.), aber es wird nirgends gezählt, WIE OFT `dismissRewardPopup()` in einem Lauf tatsächlich etwas geschlossen hat — nur der letzte Snapshot landet im `exhausted`-Zweig (4918-4920). Tritt ein NEUER, wiederkehrender Popup-Typ auf, der die generische Erkennung zwar korrekt schliesst, aber wiederholt neu erscheint (und dadurch Takt/Zeit des 18s-Fensters auffrisst, ohne das Set als erschöpft zu markieren), unterscheidet der Report „kein Popup-Problem" nicht von „Popup X-mal aufgetreten und geschlossen" — anders als bei den bereits mit genau diesem Muster geschützten Fällen `batchStuckCount` (§27) und `submitWithoutResponseCount` (§27/§9).

## Lift-Aktionen (RA)

1. **`titleSource`-Flag an `clickSetTile()`s Rückgabe ergänzen** (additiv, ea-fc-sbc-optimizer.user.js:5069-5099): neben dem bestehenden `how` ('exakt'/'Anfang'/'enthalten') zusätzlich mitgeben, ob `h` (das Titel-Sub-Element) gefunden wurde oder der Volltext-Fallback griff — z.B. `titleSource: 'sub-element' | 'full-tile'`. Ändert NICHTS an der Klick-Entscheidung selbst, macht aber im Report sofort sichtbar, wenn ein Treffer über den fragilen Fallback statt über den echten Titel zustande kam. Erwarteter Gain: +1 Pt RA (Beobachtbarkeit — schliesst die vom Audit benannte Lücke direkt an der einen konkret gefundenen Stelle).
2. **Testfall für `titleOf()`s Fallback-Zweig in solver-test.js ergänzen** (Muster analog `setLooksRepeatable`-Source-Slice-Tests): DOM-Mock ohne `.tileTitle`/`.tileHeader`/`h1`, prüft dass `clickSetTile` auf Volltext zurückfällt UND (nach Aktion 1) `titleSource: 'full-tile'` meldet. Reine Testbarkeits-Absicherung, keine Verhaltensänderung. Erwarteter Gain: +0,5-1 Pt RA (Testbarkeit).
3. **`STATE.diag.popupDismissCount` nach dem Vorbild von `batchStuckCount`/`submitWithoutResponseCount` (§27/§37) ergänzen**: Zähler in `dismissRewardPopup()`, jedes Mal wenn `closed` auf `true` gesetzt wird; in `buildDiagReport()` mitgeführt. Rein additiv (kein Kontrollfluss-Eingriff), macht die Häufigkeit eines potenziell neuen/wiederkehrenden Popup-Typs über die Laufzeit sichtbar statt nur den letzten Snapshot. Erwarteter Gain: +0,5 Pt RA (Beobachtbarkeit, schwächster der drei Befunde — die generische Erkennung selbst funktioniert bereits, hier fehlt nur die Häufigkeits-Historie).

## Edge-Cases (mind. 1)

- **Lokalisierungs-Inkonsistenz innerhalb derselben Datei:** `clickAllFilter()` (ea-fc-sbc-optimizer.user.js:5049-5050) behandelt bereits explizit deutsche UI-Texte (`t === 'all' || t === 'alle'`), während `setLooksRepeatable()` (5166, 5173) NUR die englischen Wörter "repeatable"/"complete" erkennt. Kein Korruptions-Risiko (nicht erkannter Text fällt sicher auf `repeatable: null` zurück → kein Abbruch, es wird wie bisher weiterversucht), aber bei einem nicht-englischen Client verschwindet die freundliche „Set nicht mehr wiederholbar"-Abbruchmeldung leise zugunsten der generischen „liess sich nicht öffnen"-Meldung. Leicht zu übersehen, weil alle bisherigen Live-Reports (LEARNINGS §9/§21/§27/§35) aus einem englischsprachigen Client stammen und diese Asymmetrie deshalb nie auffiel.

## Lift-Empfehlung

Vorsichtig, additiv, sehr klein geschnitten — passend zu einem 1-Punkt-Rest-Gap. Alle drei Aktionen sind reine Diagnose-/Test-Ergänzungen ohne Eingriff in die funktionierende Tap-Navigation oder die Abbruch-Philosophie; Aktion 1+2 gehören zusammen (derselbe Fund: Fallback-Pfad sichtbar machen, dann testen) und sind die einzigen mit greifbarer Substanz, Aktion 3 ist bewusst als die schwächste der drei benannt. Kein Mid-Iter-SI nötig — Einzelfeature-Umfang, kein Cross-Feature-Bezug. Sollte der Lift-Planner nur 1-2 der drei umsetzen wollen, sind Aktion 1+2 die Priorität.
