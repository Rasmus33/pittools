---
feature: spieler-pool
analyzed_at: 2026-08-15
iteration: 6
regression: false
score_current:
  RA: 83
score_target:
  RA: 83-84
---

# Gap-Report — Spieler-Pool (Laden, Normalisierung, Sperren) — Iteration 6 (Verifikations-Runde)

## Auftrag dieser Runde

Iteration 5 hält RA bei 83/85 (Deckel 85) mit der Begründung "Fehlertoleranz/
Abbruch-Disziplin bewusst nicht angefasst". Diese Runde prüft NUR, ob in den
verbleibenden 2 Punkten etwas additiv Behebbares steckt — ohne den
Club-Lade-Takt (`fetchClubViaHttp`, LEARNINGS §7/§30, CLAUDE.md
"Nicht anfassen ohne Grund") zu berühren. Ergebnis: ja, drei konkrete,
additive Beobachtbarkeits-Lücken entlang der drei Prüffragen — keine davon
verlangt einen Eingriff in Takt, Solver oder Submit-Logik.

## Ist-Stand

### RA — Robust Architecture

**Wert:** 83 / 85 (Deckel). **Status:** pass.
**Begründung:** Iteration 5 hat den `reportError`-Wrapper an allen 7
Pool-/Lock-/Batch-Catches nachgezogen und die Normalisierungs-/Lock-Logik
end-to-end abgesichert (`solver-test.js` Abschnitte 8b-5/8b-6). Diese
Verifikations-Runde findet daneben drei ENGERE, bisher unadressierte
Beobachtbarkeits-Lücken, die exakt in die vom Audit benannte
Fehlertoleranz-/Abbruch-Disziplin-Kategorie fallen, aber additiv (kein
Logik-Umbau) behebbar sind.

## Prüffrage 1 — Club-Load-Selbstbremse eskaliert bis Timeout: sichtbar & batch-sicher?

**Befund: teilweise nein.**

- `STATE.loadIncomplete` wird bei einem dauerhaften Fehlschlag mitten in der
  Club-Pagination gesetzt (`ea-fc-sbc-optimizer.user.js:1453`, im
  `while`-Loop von `fetchClubViaHttp`) — der Takt/die Selbstbremse selbst
  bleiben dabei unangetastet (nur der resultierende Zustand wird geprüft).
- Der einzige Weg, wie das den Nutzer erreicht, ist ein `toast(...)`-Aufruf
  (`ea-fc-sbc-optimizer.user.js:1560-1563` in `loadPool()` und erneut
  `:4509-4511` in `onRunClick()`). `toast()` (`:3323-3336`) manipuliert
  ausschließlich das DOM — es ruft an keiner Stelle `console.*` auf.
- Damit ist die Warnung in BEIDEN offiziellen Debug-Kanälen unsichtbar:
  nicht im Script-Diagnose-JSON (`buildDiagReport()`, `:4014-4400+`, enthält
  `clubLoad: STATE.diag.clubLoad` mit Seiten/Takt/Retries, aber KEIN Feld
  für `STATE.loadIncomplete` selbst), und nicht im App-Log-Ringpuffer
  (`SbcChromeClient.onConsoleMessage`, `app/java/.../MainActivity.java:805`,
  fängt nur echte `console.*`-Aufrufe ab — ein reiner DOM-Toast erzeugt
  keinen).
- `onBatchPlanClick()` (`:5227-5264`) prüft vor dem Planen nur, ob der Pool
  LEER ist (`:5235`) — anders als `onRunClick()` (`:4509-4511`) gibt es dort
  KEINE `STATE.loadIncomplete`-Prüfung. Ein Batch lässt sich also auf einem
  durch Rate-Limit-Abbruch unvollständigen Pool planen und abgeben, ohne
  dass an dieser Stelle irgendein Hinweis (auch kein flüchtiger Toast)
  erscheint — der ursprüngliche Toast aus dem vorangegangenen "Spieler
  laden" ist zu diesem Zeitpunkt (oft mehrere Minuten später) längst
  verschwunden (4,3s Anzeigedauer, `:3334-3335`).

## Prüffrage 2 — removeFromPool: Doppelverplanung sichtbar?

**Befund: der Erfolgsfall ist korrekt gegen Doppelverplanung abgesichert,
der Fehlerfall ist im JSON-Report unsichtbar.**

- `removeFromPool()` (`:1131-1144`) wird in beiden Abgabe-Pfaden erst NACH
  einer vom SERVER bestätigten Übernahme aufgerufen
  (`submitCurrentResult():5481`, nach `verifySquadCount(...) >= need` in
  `submitToSbc()`; Batch-Loop `:5374`, nach erfolgreichem `submitToSbc`).
  Schlägt das Eintragen selbst fehl, bleibt die Karte im Pool — das ist
  KORREKT (Karte wurde nicht verbaut).
- ABER: `removeFromPool()`s eigener Catch (`:1143`,
  `catch (e) { warn('removeFromPool:', e.message); }`) ruft nur `warn()`,
  nicht `reportError()`/`diagError()` — im Unterschied zu allen anderen
  Pool-Catches, die Iteration 5 laut Audit konsistent auf `reportError()`
  umgestellt hat (`fetchUnassignedViaHttp`, `fetchStorageViaHttp`,
  Gesamt-Catch von `readPaletoolsLocks`, LEARNINGS §29). Ein Fehlschlag
  HIER (z.B. während `refreshSbcInfoUI()`, `:3961-3976`, das `ui.rarity`/
  `ui.poolcount` ungeschützt anspricht) landet zwar im App-Log
  (`console.warn` wird von `onConsoleMessage` erfasst), aber NICHT in
  `STATE.diag.lastErrors` und damit nicht im kopierbaren Script-Diagnose-
  Report — dem Kanal, den Rasmus laut CLAUDE.md primär nutzt. Die
  tatsächliche Konsequenz ist begrenzt (die Karte bleibt fälschlich im
  Pool, ein erneutes Verplanen würde beim nächsten Abgabeversuch mit dem
  bekannten 460/400-Hinweis "Pool veraltet, Spieler laden" auffallen,
  `:5490-5491`) — aber der ROOT CAUSE (der ursprüngliche removeFromPool-
  Fehlschlag) bliebe im JSON-Report unbelegt, nur im App-Log auffindbar.

## Prüffrage 3 — readPaletoolsLocks: vollständig sichtbar oder stille Zweige?

**Befund: stille Zweige vorhanden — der iter5-Audit-Satz "locks.error macht
sicherheitsrelevante Teilausfälle sichtbar" stimmt nur für den
GESAMT-Abbruch der Schleife, nicht für Teilausfälle pro Schlüssel.**

- `readPaletoolsLocks()` (`:1023-1075`) hat einen äußeren Try/Catch um die
  gesamte `for`-Schleife (`:1034-1065`), der bei einem Abbruch mitten in der
  Traversierung `scanError` setzt und `reportError()` ruft (`:1062-1064`)
  — das ist getestet (`solver-test.js:1634-1655`, `brokenLocalStorage` wirft
  in `localStorage.key(i)`).
- ZWEI innere Try/Catches greifen aber VOR diesem äußeren Catch und
  verschlucken PRO SCHLÜSSEL still, ohne `reportError`/`diagError` UND ohne
  einen Zähler im `STATE.diag.locks`-Objekt:
  - `:1047`, `try { raw = localStorage.getItem(k); } catch (e) { continue; }`
    — schlägt `getItem` für genau diesen einen Key fehl, wird der Key
    komplett übersprungen (kein Lock-Fund aus ihm), `keysScanned` wurde
    bereits hochgezählt, aber nichts zeigt, dass er nicht ausgewertet wurde.
  - `:1050`, `try { obj = JSON.parse(raw); } catch (e) { continue; }` — ein
    Wert, der kein valides JSON ist (z.B. ein beschädigter oder aus einer
    anderen PaleTools-Version stammender `paletools:*`-Key), wird ebenso
    still übersprungen.
- `solver-test.js` Abschnitt 8b-6 (`:1572-1656`) deckt beide Zweige NICHT
  ab: der einzige negative Testfall ist der Gesamt-Loop-Abbruch
  (`localStorage.key()` wirft), keiner simuliert einen einzelnen kaputten
  `paletools:*lock*`-Wert (nicht-JSON) oder einen key-spezifischen
  `getItem`-Fehler.
- Sicherheitsrelevanz: CLAUDE.md verlangt "Per PaleTools gesperrte Karten
  (Schloss) NIEMALS verbauen". Ein einzelner unlesbarer/korrupter Lock-Key
  bedeutet HEUTE: die darin enthaltenen gesperrten Spieler werden STILL
  NICHT als gesperrt erkannt, ohne jede Spur im Report — exakt der
  Fehlerklasse, die der äußere Catch laut eigener Begründung (`:1027-1031`)
  verhindern sollte, aber nur für den Loop-Abbruch tatsächlich abdeckt.

## Mängel (M1)

1. **`STATE.loadIncomplete` fehlt komplett in `buildDiagReport()`**
   (`ea-fc-sbc-optimizer.user.js:4014-4400`, kein `loadIncomplete`-Key im
   Rückgabeobjekt) — der einzige Träger der Information ist ein
   nicht-loggender `toast()` (`:1560-1563`, `:4509-4511`, `:3323-3336`).
2. **`onBatchPlanClick()` prüft `STATE.loadIncomplete` nicht**
   (`:5227-5264`, Kontrast zu `onRunClick():4509-4511`) — ein Batch kann auf
   einem durch Rate-Limit-Abbruch unvollständigen Pool geplant und
   abgegeben werden, ohne jede erneute Warnung an dieser Stelle.
3. **`removeFromPool()`s Catch nutzt nur `warn()`, nicht `reportError()`**
   (`:1143`) — inkonsistent zum in Iteration 5 etablierten Muster (LEARNINGS
   §29: alle Pool-/Lock-Catches über `reportError()`), macht einen
   Fehlschlag im Script-Diagnose-JSON unsichtbar (nur im App-Log via
   `console.warn` auffindbar).
4. **`readPaletoolsLocks()`: zwei innere Catches (`:1047`, `:1050`)
   verschlucken Pro-Key-Fehler still**, ohne Zähler/Feld in
   `STATE.diag.locks` und ohne `reportError`/`diagError` — nur der
   Gesamt-Loop-Abbruch ist sichtbar/getestet (`:1062-1064`,
   `solver-test.js:1634-1655`), nicht der wahrscheinlichere Fall eines
   einzelnen kaputten `paletools:*lock*`-Werts.

## Lift-Aktionen (M1, alle additiv, kein Eingriff in Club-Lade-Takt/Solver/Submit)

1. **`buildDiagReport()` um `poolLoadIncomplete: !!STATE.loadIncomplete`
   ergänzen** (Pfad: `ea-fc-sbc-optimizer.user.js`, ein neuer Key neben
   `poolSize`/`clubLoad` in der bestehenden Rückgabe, `:4283` als
   Einfügepunkt). Rein additiv, kein Verhaltens-Umbau. Erwarteter Gain:
   +2 bis +3 Punkte (schließt exakt die von Prüffrage 1 benannte Lücke:
   der Teil-Pool-Zustand wird im kopierbaren Report sichtbar, ohne den
   Takt anzufassen).
2. **`onBatchPlanClick()` um dieselbe `STATE.loadIncomplete`-Warnung
   ergänzen, die `onRunClick()` bereits hat** (Pfad:
   `ea-fc-sbc-optimizer.user.js:5227-5235`, unmittelbar nach dem
   Pool-leer-Check, analog zu `:4509-4511`). Additiv, non-blocking (nur ein
   zusätzlicher `toast()`-Aufruf plus, in Kombination mit Aktion 1, ein
   `diagError`-Eintrag), lässt "Batch darf abgeben" unangetastet. Erwarteter
   Gain: +2 bis +3 Punkte.
3. **`removeFromPool()`s Catch auf `reportError()` umstellen** (Pfad:
   `ea-fc-sbc-optimizer.user.js:1143`, `warn('removeFromPool:', e.message)`
   → `reportError('removeFromPool', e)`), exakt das in LEARNINGS §29
   etablierte Muster auf die vierte, bisher inkonsistente Stelle
   ausgedehnt. Ein-Zeilen-Änderung, keine Logik-Änderung. Erwarteter Gain:
   +1 bis +2 Punkte (DRY/SSOT-Konsistenz, Q4/Q5).
4. **`readPaletoolsLocks()`s zwei innere Catches zählen statt nur
   `continue`n** (Pfad: `ea-fc-sbc-optimizer.user.js:1047`, `:1050`): pro
   Fehlschlag einen Zähler erhöhen (z.B. `unreadableKeys`/`parseErrors`) und
   in `STATE.diag.locks` (`:1066-1073`) mit ausgeben, plus je einen
   `reportError()`-Aufruf mit dem betroffenen Key-Namen. Dazu zwei neue
   Testfälle in `solver-test.js` Abschnitt 8b-6 (Vorbild: der bestehende
   `brokenLocalStorage`-Block, `:1638-1655`) — ein Key mit nicht-JSON-Wert
   und ein Key, dessen `getItem` wirft. Erwarteter Gain: +2 bis +3 Punkte
   (schließt die von Prüffrage 3 aufgedeckte Lücke in der als "vollständig
   getestet" geltenden Lock-Erkennung, sicherheitsrelevant wegen der
   NIEMALS-verbauen-Regel).

## Edge-Case (M1)

- Aktion 2 (Batch-Warnung) darf NICHT zu einem Abbruch/Block werden — CLAUDE.md
  gibt dem Batch explizit die Freigabe abzugeben ("Batch darf abgeben"); die
  Warnung muss wie bei `onRunClick()` rein informativ bleiben (Toast +
  Diagnose-Feld), sonst würde ein unvollständiger, aber für die konkrete SBC
  ausreichender Pool blockiert, wo vorher gar keine Prüfung existierte —
  das wäre eine Verschlechterung, keine Verbesserung.
- Aktion 4 darf den bestehenden, bereits grünen Test für den
  Gesamt-Loop-Abbruch (`solver-test.js:1634-1655`) nicht verändern — die
  neuen Zähler müssen NEBEN `scanError`/`error` stehen, nicht ihn ersetzen,
  sonst verliert der Report den bereits funktionierenden "kompletter
  Abbruch"-Fall zugunsten des neuen "einzelner Key kaputt"-Falls.

## Honest Verdict

**Substanz.** Alle drei Prüffragen dieser Runde haben einen konkreten,
mit `file:line` belegten Befund ergeben — keiner davon verlangt einen
Eingriff in den Club-Lade-Takt, den Solver oder die Submit-Wege. Die vier
Lift-Aktionen sind rein additiv (ein neues Report-Feld, eine übernommene
Warnung an einer zweiten Stelle, ein Catch-Umbau auf ein bereits etabliertes
Muster, zwei neue Zähler + Tests) und tragen zusammen schätzungsweise +7 bis
+11 Punkte — genug, um RA von 83 auf den in dieser Iteration angepeilten
Bereich 83-84 zu heben, ohne die Nicht-anfassen-Zone zu berühren. "Nichts
Actionables" wäre hier NICHT die ehrliche Antwort gewesen — die drei
Beobachtbarkeits-Lücken waren real und bisher unadressiert.
