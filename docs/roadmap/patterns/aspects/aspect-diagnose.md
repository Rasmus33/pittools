---
slice: diagnose
analyzed_at: 2026-08-14
iteration: 0
---

# Aspect — diagnose

Rohaufnahme dessen, was im Code zur Slice tatsächlich vorkommt. Vom
`aspect-analyzer`-Subagent geschrieben (Sonnet, parallel pro Slice).
Wird pro Iteration überschrieben — Git-Log ist die Historie.

## Beobachtetes Pattern: Diagnose-Feld einbauen statt raten

**Was passiert:** `STATE.diag` ist eine offene, flach erweiterbare Ablage.
Sobald ein neues Live-Problem auftaucht, wird dafür ein neues Feld ergänzt
(Zähler, letzter Fehler, letzter Zustand), `buildDiagReport()` nimmt es in den
JSON-Report auf, und der Report wird von Rasmus per Copy-Paste zurückgespielt.
Das deckt sich exakt mit der in `CLAUDE.md` dokumentierten Debugging-Konvention
("Fehlt Info für ein neues Problem: erst ein Diagnose-Feld einbauen, Report
anfordern, dann fixen").

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:105-112` — initiale `STATE.diag`-Deklaration
  (fetchSeen, xhrSeen, utasSeen, lastUtasPaths, lastErrors, evoExcluded)
- `ea-fc-sbc-optimizer.user.js:3727-3990` — `buildDiagReport()` sammelt alle
  `STATE.diag.*`-Felder plus Live-DOM-Scans in ein einziges JSON-Objekt
- `ea-fc-sbc-optimizer.user.js:3763-3764` — Kommentar direkt am Feld
  `batchSteps`: „in v4.18.0 fehlte das Feld im Report, mein Fehler" — belegt,
  dass das Einbauen-vor-Fixen-Vorgehen aus einem echten Vorfall gelernt wurde
- `ea-fc-sbc-optimizer.user.js:1258,2605-2617,4371,4636,4940,5134` — neue
  Felder (`clubLoad`, `submitVia`, `submitCandidates`, `lastTap`,
  `batchSteps`, `lastTeam`) wurden nacheinander für je ein konkretes Problem
  ergänzt (Club-Ladetakt, Submit-Weg-Erkennung, Kachel-Tap, Batch-Fortschritt)
- `ea-fc-sbc-optimizer.user.js:3991-4001` (`onDiagClick`) — ein Button-Klick
  baut den Report, loggt ihn komplett in die Konsole UND kopiert ihn in die
  Zwischenablage — der Report ist für Copy-Paste an Rasmus optimiert

**Wo das (noch) fehlt:** kein zentrales Schema für `STATE.diag` (siehe
Antipattern unten) — das Hinzufügen funktioniert, aber ohne Struktur.

## Beobachtetes Pattern: Report bewusst redigiert und größenbegrenzt

**Was passiert:** Diagnose-Ausgaben werden konsequent auf Token-freie,
kopierbare Größe zurechtgestutzt: Fehlertexte werden getrimmt, IDs in URLs
maskiert, Session-Header nie mitgeloggt, und mehrfach wurden Report-Felder
nachträglich gekürzt, weil der volle Report am Gerät nicht mehr vollständig
kopierbar war.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:3728` — Kommentar „Bewusst OHNE
  Session-Token-Werte!" direkt über `buildDiagReport()`
- `ea-fc-sbc-optimizer.user.js:110,119` — `lastErrors` explizit als „ohne
  Tokens" deklariert, `diagError()` kappt jede Meldung auf 300 Zeichen
- `ea-fc-sbc-optimizer.user.js:179-180` — utas-Pfade werden mit
  `.replace(/\d{4,}/g, '{id}')` maskiert, bevor sie in `lastUtasPaths` landen
- `ea-fc-sbc-optimizer.user.js:292` — `lastSquadPutBody` wird auf 3000 Zeichen
  gekappt; `ea-fc-sbc-optimizer.user.js:1230` kappt den PUT-Fehler-Body auf
  200 Zeichen
- `ea-fc-sbc-optimizer.user.js:3902,3941,3964,3978` — vier separate
  „GEKUERZT"-Kommentare, die dokumentieren, dass Report-Felder (Squad-Body,
  Rareflag-Histogramm, High-Card-Samples, Challenge-Response) nachträglich
  verkleinert wurden, weil „der Report zu lang zum Kopieren" war bzw. „live
  mitten in diesem Feld" abbrach
- `app/java/com/sbctools/browser/MainActivity.java:89-101` — App-seitiges
  Gegenstück: Ringpuffer `LOG_MAX=400` Zeilen, jede Zeile auf `LOG_LINE_MAX=600`
  Zeichen gekappt

**Wo das (noch) fehlt:** keine automatisierte Prüfung/kein Test, der die
Report-Gesamtgröße gegen ein Limit verifiziert — die Kürzungen entstanden
reaktiv nach Live-Vorfällen, nicht präventiv.

## Beobachtetes Pattern: Zwei-Kanal-Logging mit gemeinsamem Empfänger

**Was passiert:** Script-Report (Konsole/Clipboard) und App-Log (Ringpuffer
über alle Konsolenmeldungen der Seite, inkl. PaleTools) sind zwei getrennte,
aber komplementäre Mechanismen, die beide auf denselben Zweck einzahlen: Rasmus
kann ohne angeschlossene DevTools am Gerät Diagnosedaten per Copy-Paste liefern.

**Code-Belege:**
- `app/java/com/sbctools/browser/MainActivity.java:693-703`
  (`onConsoleMessage`) — fängt ALLE `console.*`-Ausgaben der WebView ab,
  inklusive der von PaleTools und uncaught errors
- `app/java/com/sbctools/browser/MainActivity.java:105-125`
  (`buildLogReport`) — Kopf mit App-Version, Gerät, Script-Größen und
  `paleStatus`, gefolgt vom kompletten Ringpuffer
- `app/java/com/sbctools/browser/MainActivity.java:136-156`
  (`shareLog`/`copyLog`) — zwei Ausgabewege (Share-Intent, Zwischenablage),
  exakt wie im Script (`onDiagClick` loggt UND kopiert)
- `app/java/com/sbctools/browser/MainActivity.java:649-668` (`PalePoll`) —
  `paleStatus` wird nur bei tatsächlicher Änderung geloggt (`!status.equals(a.paleStatus)`),
  Warteschleifen nur alle 12 Versuche — bewusste Lärmreduktion im Ringpuffer,
  spiegelt die Größenbegrenzung im Script-Report

## Beobachteter Antipattern: Diag-Namespace ohne Schema/SSOT

**Was schiefläuft:** `STATE.diag` wird an der Deklarationsstelle nur mit 6
Feldern initialisiert; mindestens 12 weitere Felder werden über die gesamte
Datei verteilt ad-hoc per Zuweisung erzeugt, ohne dass es eine zentrale Stelle
gibt, die die vollständige Form von `STATE.diag` beschreibt. `buildDiagReport()`
muss jedes Feld einzeln von Hand nachziehen (`STATE.diag.xyz || null`) — vergisst
das jemand, bleibt der Report unvollständig, ohne dass irgendwo ein Fehler
auftritt (stiller Fehlschlag).

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:105-112` — Deklaration deckt nur `fetchSeen`,
  `xhrSeen`, `utasSeen`, `lastUtasPaths`, `lastErrors`, `evoExcluded` ab
- `ea-fc-sbc-optimizer.user.js:292,582,908,1258,2605-2617,2659,2816,2897,4371,4387,4408,4636,4940,5134` —
  mindestens 15 weitere `STATE.diag.*`-Zuweisungen außerhalb der Deklaration
  (`lastSquadPutBody`, `staleRecover`, `locks`, `clubLoad`, `submitVia`,
  `lastEligible`, `refreshLog`, `submitCandidates`, `submitChallengeVia`,
  `lastTap`, `batchSteps`, `lastTeam`)
- `ea-fc-sbc-optimizer.user.js:3758` — `buildDiagReport()` liest
  `STATE.diag.uiScan || null`; eine Suche nach `uiScan` im gesamten File
  findet KEINE einzige Zuweisung — das Feld ist im Report tot und liefert
  immer `null`, ohne dass das auffällt
- `ea-fc-sbc-optimizer.user.js:3763-3764` — der Kommentar am Feld `batchSteps`
  dokumentiert selbst den bereits eingetretenen Schaden: „in v4.18.0 fehlte
  das Feld im Report, mein Fehler" — exakt das Fehlerbild, das ein fehlendes
  Schema begünstigt
- `ea-fc-sbc-optimizer.user.js:3926-3928` — `rareConstraints` wird im
  `sbc`-Teilobjekt des Reports zweimal hintereinander deklariert (Zeile 3927
  falsch eingerückt, Zeile 3928 korrekt) — Copy-Paste-Rest, der nicht entfernt
  wurde; harmlos zur Laufzeit (letzter Wert gewinnt), aber ein direktes Symptom
  dafür, dass niemand die Gesamtform von `buildDiagReport()` gegenprüft

**Vermutete Wurzelursache:** Q5 (SSOT) — es gibt keine einzige Stelle, die
die vollständige Form von `STATE.diag` (und des davon abgeleiteten Reports)
beschreibt oder typisiert; Lesen und Schreiben liegen über ~5000 Zeilen
verteilt. Das ist im aktuellen Umfang tolerierbar (der v4.18.0-Vorfall wurde
schnell per Live-Report entdeckt und behoben), aber jedes neue Feld erhöht das
Risiko eines weiteren stillen Lücken-Falls.

## Weak Signals (zu wenige Belege für Pattern-Status)

- Direkter `console.log`-Aufruf statt `log()`-Wrapper: `ea-fc-sbc-optimizer.user.js:3993-3995`
  umgeht den vorhandenen `log()`-Helper (`ea-fc-sbc-optimizer.user.js:114`) für
  die drei Diagnose-Banner-Zeilen — nur 3 Stellen, wirkt aber wie eine bewusste
  Ausnahme (der Report muss vollständig und unverändert erscheinen, `log()`
  würde den `LOG_PREFIX` nur als erstes Argument voranstellen, was hier ohnehin
  reicht) — zu schwach für ein Antipattern-Urteil ohne weitere Fälle.
- `warn()`-Funktion (`ea-fc-sbc-optimizer.user.js:115`) wird an vielen Stellen
  parallel zu `diagError()` aufgerufen (z.B. `:1181`, `:1378`, `:2606`), aber
  nur `diagError()`-Aufrufe landen im kopierbaren Report — `warn()`-Inhalte
  bleiben nur in der (am Gerät nicht erreichbaren) Konsole, außer die App fängt
  sie über `onConsoleMessage` zusätzlich ab. Erwähnenswert, weil es die
  Redundanz zwischen Script-Diagnose und App-Log erklärt, aber nicht genug
  Einzelbelege für ein eigenes Pattern.

## Zusammenfassung

- 3 Pattern-Kandidaten in dieser Slice
- 1 Antipattern-Kandidat
- 2 Weak Signals
