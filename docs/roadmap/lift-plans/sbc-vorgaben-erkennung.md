---
feature: sbc-vorgaben-erkennung
iteration: 3
score_current:
  RA: 78
score_target:
  RA: 79
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
  - docs/LEARNINGS.md
patterns_required:
  - diagnose-feld-statt-raten
  - abbruch-disziplin
  - eingebetteten-code-exakt-testen
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P3-deferred
effort: S
analyzed_at: 2026-08-15
---

# Lift-Plan — SBC-Vorgaben-Erkennung

## Marschroute

Iterations-Linse: EA-Wandel-Toleranz. Alle drei Aktionen sind reine
Beobachtbarkeits-Ergänzungen am bereits per Marker (`// [SBCSCAN-BEGIN]` /
`// [SBCSCAN-END]`) isolierten Deep-Scan-Parser-Cluster
(`ea-fc-sbc-optimizer.user.js:362-537`) — keine der drei bestehenden,
live-verifizierten Erkennungspfade (Whitelist-Matching, Traversal-Limits,
Count-Fallback) ändert ihr Verhalten; es kommen ausschließlich neue
Rückgabe-/Report-Felder hinzu. Reihenfolge folgt der gegebenen
`phase_sequence`:

1. **core** — die additive Sammel-/Splitlogik einbauen: `allScopesSeen`
   im `deepScanChallenge()`-Traversal-Loop mitführen (Aktion 1); `reqCount()`
   intern in einen gemeinsamen `reqCountRaw()`-Helfer aufspalten, der Zahl UND
   Default-Flag in einem Durchlauf liefert (Aktion 3 — DRY, kein zweiter
   Chain-Walk).
2. **diagnose** — die drei neuen Signale bis in `STATE.sbc` /
   `buildDiagReport()` durchreichen: `scopesSeenCount`/`scopesSeenSample`,
   `scanStats` (optionaler `statsOut`-Parameter für `findChallengeNode`/
   `collectChallengeNodes`, die anders als `deepScanChallenge` keinen
   Objekt-Rückgabewert haben), `countDefaulted` an jedem `reqDump`-/
   Constraint-Eintrag plus eine Kurzsumme.
3. **tests** — drei neue, mit konstruierten Challenge-Strukturen arbeitende
   Testfälle in `solver-test.js` (Whitelist-Bypass, Traversal-Kappung,
   reqCount-Default), jeweils inkl. Gegenprobe, dass das bestehende Verhalten
   (Whitelist filtert weiter wie bisher, Limits bleiben 20000/Tiefe 6-7,
   `reqCount()`-Zahl unverändert) unangetastet bleibt. `node solver-test.js`
   muss vor und nach dem Schnitt für alle bestehenden Fälle grün bleiben.
4. **docs** — `docs/LEARNINGS.md` bekommt Eintrag §37 mit den drei additiven
   Feldern, dem Bezug zu §26/§27/§34 (verwandte Diagnose-Muster) und der
   expliziten Begründung, warum `scanStats` NICHT zu einer neuen Warnung
   führt (Rückbezug auf den in v4.34.0 zurückgenommenen Fehlalarm,
   `ea-fc-sbc-optimizer.user.js:4333-4337`).
5. **release** — `@version` (Header) und `const VERSION` gemeinsam auf die
   nächste freie Versionsnummer bumpen (aktuell `4.48.0`; ein paralleles
   Ticket `ea-app-anbindung` bumpt in derselben Iteration ebenfalls — die
   konkrete Nummer wird beim Implementieren gegen den dann aktuellen main-Stand
   koordiniert, nicht im Plan fest vorgeschrieben), Push auf `main`.

Kein Mid-Iter-Shared-Item nötig: alle drei Änderungen liegen im selben
Deep-Scan-Cluster und werden von einem Implementer-Durchlauf mit kleinen
Diffs umgesetzt (Einschätzung aus dem Gap-Report übernommen).

## Aktionen pro Dimension

### RA — Robust Architecture

1. **Aktion 1 — `scopesSeen` gegen die reqDump-Whitelist-Lücke
   (behebt Mangel 1).**
   - `deepScanChallenge()` (`ea-fc-sbc-optimizer.user.js:408-536`): direkt an
     der Stelle, an der `scope = scopeString(o)` truthy wird
     (`:424-425`, VOR der Whitelist-Prüfung bei `:488-496`), den Scope-String
     zusätzlich in ein `Set` aufnehmen — unabhängig davon, ob er anschließend
     eine der zehn Whitelist-Teilzeichenketten trifft. Deckel bei 40 Einträgen
     (Set-Größe prüfen, keine weiteren Adds darüber), analog zum bestehenden
     `out.reqs.length < 25`-Deckel bei `:489`.
   - Am Ende von `deepScanChallenge()` (vor `return out;`, `:535`) das Set in
     `out.scopesSeen` (Array) konvertieren. Reine Ergänzung des
     Rückgabeobjekts — `matchedAs`, `reqValue`, `reqCount`, die bestehende
     Whitelist-Logik bei `:488-496` bleiben unverändert.
   - `STATE.sbc` (Deklaration `:84-96`) bekommt ein neues Feld
     `scopesSeen: []`; `setCurrentChallenge()` (`:540-557`) setzt es beim
     Challenge-Wechsel zusammen mit den anderen `STATE.sbc.*`-Feldern zurück.
   - `applyScan()` (`:746-792`) übernimmt `scan.scopesSeen` UNGEACHTET des
     bestehenden `if (scan.reqs.length)`-Gates bei `:757` (das Gate gilt nur
     für `reqDump`/`otherScopes` — ein neuer Scope kann auftreten, ohne dass
     `scan.reqs` etwas enthält, genau der Bug-Fall aus Mangel 1) —
     eigener, ungegateter Zuweisungsblock: `STATE.sbc.scopesSeen = scan.scopesSeen || [];`.
   - `buildDiagReport()`-`sbc`-Block (`:4088-4107`) bekommt
     `scopesSeenCount: (STATE.sbc.scopesSeen || []).length` und
     `scopesSeenSample: STATE.sbc.scopesSeen || []` (bereits auf 40 gedeckelt,
     keine weitere Kürzung nötig).
   - Erwarteter Gain: +2-3 Pt RA (Beobachtbarkeits-Kriterium — eine komplett
     neue EA-Scope-Familie ist jetzt sichtbar, statt spurlos zu verschwinden).

2. **Aktion 2 — `scanStats` gegen die stille Traversal-Kappung
   (behebt Mangel 2).**
   - `deepScanChallenge()`: `visited`-Zähler (bereits vorhanden, `:413/419`)
     sowie eine neue `depthSkipped`-Flagge (wird `true`, sobald die
     Bedingung `d > 7` bei `:417` einen Knoten tatsächlich aussortiert —
     NICHT nur beim generellen Continue durch `seen.has`/`isDomOrWindow`)
     zusätzlich auf `out` legen:
     `out.visitedCount = visited; out.depthCapped = depthSkipped; out.budgetExhausted = (visited >= 20000 && queue.length > 0);`
     vor `return out;` (`:535`).
   - `findChallengeNode(root, cid)` (`:559-589`) und
     `collectChallengeNodes(root)` (`:596-625`) geben aktuell einen bloßen
     Knoten bzw. ein Array zurück — der Rückgabe-TYP darf sich laut
     Iterations-Linse NICHT ändern (bricht sonst `applyFromSetChallenges()`
     und `resolveFreshChallengeId()`, beide live-verifiziert). Additiver Weg:
     beide Funktionen bekommen einen optionalen dritten/zweiten Parameter
     `statsOut` (Default `undefined`, bestehende Aufrufe ohne diesen Parameter
     bleiben unverändert funktionsfähig). Ist `statsOut` gesetzt, schreiben
     die Funktionen am Ende ihres jeweiligen Loops
     `statsOut.findNode = { visitedCount, depthCapped, budgetExhausted }` bzw.
     `statsOut.collectNodes = { ... }` hinein (gleiche drei Felder, gleiche
     Kappungs-Bedingungen `d > 6` / `visited < 20000` wie bisher — nur deren
     Erreichen wird jetzt sichtbar, die Limits selbst bleiben `20000`/Tiefe
     `6`-`7`).
   - Call-Sites: `applyFromSetChallenges()` (`:666-673`) und
     `resolveFreshChallengeId()` (`:633-664`) legen vor dem jeweiligen Aufruf
     `STATE.diag.scanStats = STATE.diag.scanStats || {};` an und übergeben
     dieses Objekt als `statsOut`; `parseSbcChallenge`/`captureChallengeEntity`
     übernehmen zusätzlich `out.visitedCount/depthCapped/budgetExhausted` von
     `deepScanChallenge()` in denselben `STATE.diag.scanStats.deepScan`-Zweig.
   - `buildDiagReport()` übernimmt `scanStats: STATE.diag.scanStats || null`
     ungefiltert (Muster identisch zu `staleRecover`/`batchStuckCount`,
     `:3908-3914`). `STATE.diag`-Deklaration (`:110-134`) bekommt das neue
     Feld `scanStats: null`.
   - **Kein neues `warnings`-/Abbruch-Kriterium** — reines Beobachtungsfeld
     (siehe Edge-Case unten, v4.34.0-Rückfall vermeiden).
   - Erwarteter Gain: +2 Pt RA (Beobachtbarkeit + Fehlertoleranz-Kriterium).

3. **Aktion 3 — `reqCountDefaulted` gegen den unsichtbaren
   `return 1`-Fallback (behebt Mangel 3).**
   - `reqCount(o, parents)` (`:383-397`) intern aufspalten: neuer Helfer
     `reqCountRaw(o, parents)` mit der bestehenden Chain-Walk-Logik
     (`:387-395`), der `{ count, defaulted }` liefert (`defaulted = true`
     nur, wenn KEIN der fünf bekannten Keys traf und der `1`-Fallback griff).
     `reqCount(o, parents)` wird zum Einzeiler `return reqCountRaw(o, parents).count;`
     — exakt derselbe Rückgabewert für alle vier bestehenden Aufrufer
     (`:454, :469, :481, :495`), keine Verhaltensänderung, keine Duplikation
     der Key-Liste (Q4/DRY). Neue Funktion
     `function reqCountDefaulted(o, parents) { return reqCountRaw(o, parents).defaulted; }`.
   - An allen vier Push-Stellen in `deepScanChallenge()` zusätzlich
     `countDefaulted: reqCountDefaulted(o, par)` mitgeben:
     `out.playerLevel.push(...)` (`:454`), `out.quality.push(...)` (`:469`),
     `out.rarity.push(...)` (`:478-486`), `out.reqs.push(...)` (`:495`).
     Die `dedupe()`-Keyfunktionen (`:530-534`) bleiben unverändert (Dedupe
     läuft weiterhin über Label/Wert/Count, nicht über das neue Flag — zwei
     sonst identische Vorgaben mit unterschiedlichem `countDefaulted` sind
     inhaltlich dieselbe Vorgabe).
   - `STATE.sbc.rarityConstraints`/`playerLevelConstraints`/
     `qualityConstraints`/`reqDump` übernehmen das Flag automatisch, da sie
     direkt die `scan.*`-Arrays referenzieren (`applyScan()`, `:746-758`) —
     keine weitere Verdrahtung nötig.
   - `buildDiagReport()`-`sbc`-Block: eine Kurzsumme
     `countDefaultedTotal` (Anzahl `countDefaulted === true` über
     `reqDump` + die drei Constraint-Arrays) ergänzen — macht "Count geraten
     (nicht gefunden): N Vorgaben" auf einen Blick sichtbar, ohne den ganzen
     Report nach dem Flag durchsuchen zu müssen.
   - Solver-Verhalten (`needCount = pl.count || 1` bei `:2095`,
     `rc.count || 1` bei `:2142`) bleibt unverändert — reine
     Zusatz-Property, kein Kontrollfluss-Eingriff.
   - Erwarteter Gain: +2 Pt RA (Beobachtbarkeit + dokumentierte Begründung
     einer fragilen Stelle).

**Nicht eingeplant:** die im Gap-Report als "dünn" markierte
Rareflag-Verteilungs-Plausibilitätsnotiz — bei 1-2 Punkten realistischer
Restgain birgt eine Anomalie-Heuristik hier False-Positive-Risiko
(saisonale Verschiebung ist laut CLAUDE.md legitim) und wird auf PO-Empfehlung
weggelassen.

## Phasen-Commit-Mapping

| Phase     | Aktionen |
|-----------|----------|
| core      | `allScopesSeen`-Sammlung in `deepScanChallenge()` (Aktion 1, Sammelteil); `reqCount()` → `reqCountRaw()`-Aufspaltung + `reqCountDefaulted()` (Aktion 3, Kernlogik) |
| diagnose  | `STATE.sbc.scopesSeen` + `scopesSeenCount`/`scopesSeenSample` im Report (Aktion 1, Verdrahtung); `statsOut`-Parameter an `findChallengeNode`/`collectChallengeNodes`, `STATE.diag.scanStats`, Report-Feld `scanStats` (Aktion 2); `countDefaulted` an allen vier Push-Stellen + `countDefaultedTotal` im Report (Aktion 3, Verdrahtung) |
| tests     | Whitelist-Bypass-Test, Traversal-Kappungs-Test (deepScanChallenge + findChallengeNode/collectChallengeNodes), reqCount-Default-Test — je mit Regressions-Gegenprobe auf unverändertes Bestandsverhalten |
| docs      | `docs/LEARNINGS.md` §37 |
| release   | `@version`/`const VERSION` bump, Push auf `main` |

## Shared-Item-Bedarf

Keins. Alle drei Aktionen sind feature-intern im selben Deep-Scan-Cluster
(`ea-fc-sbc-optimizer.user.js`, SBCSCAN-Marker-Block + die beiden
Nachbar-Traversal-Funktionen) und haben keinen zweiten Konsumenten. Sidecar
bleibt leer (`[]`).

## Risiken / Edge-Cases

- **`scanStats` darf nicht zur Wiederholung des v4.34.0-Fehlers werden.**
  Erreichtes `visited >= 20000` oder die Tiefengrenze bedeutet NICHT
  zwingend, dass relevante Vorgaben fehlen — die BFS kann `TEAM_RATING`
  o.ä. bereits früh gefunden haben, bevor das Budget erschöpft war. Anders
  als bei der Solver-Suchfenster-Erschöpfung (`docs/LEARNINGS.md` §34, dort
  bewusst per unabhängiger `vBound`-Gegenrechnung als echte Ursache belegt)
  gibt es hier keine unabhängige Bestätigung, dass eine Kappung tatsächlich
  eine Vorgabe verschluckt hat. Aktion 2 bleibt deshalb strikt ein reines
  Report-/`STATE.diag`-Feld — KEIN neuer `warnings`-Eintrag, KEIN Abbruch,
  keine Bedingung, die `ok`/`reason` beeinflusst. Validierung: Testfall prüft
  explizit, dass ein Solver-Lauf mit `budgetExhausted: true` denselben
  `ok`/`reason`/Team liefert wie ohne das Feld.
- **`scopesSeen`-Deckel (40 Einträge) darf die Diagnose nicht selbst
  verschlucken.** Bei SBCs mit sehr vielen distinkten Scope-Strings (z.B.
  durch tief verschachtelte Eligibility-Metadaten) würde ein zu niedriger
  Deckel den entscheidenden neuen Scope u.U. selbst wieder aussortieren.
  Test deckt den Fall ab, dass der neue, unbekannte Scope FRÜH im Traversal
  auftaucht (realistisch, da Requirement-Knoten meist oberflächennah liegen)
  und damit vor dem Deckel im Set landet.
- **`reqCountRaw`-Refactoring ist eine Verhaltens-Nulländerung, aber
  Regressionsrisiko bei fehlerhafter Extraktion.** Da alle vier bestehenden
  Aufrufer weiterhin nur die Zahl über `reqCount()` bekommen, muss der
  Refactoring-Schritt durch einen expliziten Vorher/Nachher-Vergleich
  abgesichert werden (bestehende `solver-test.js`-Fälle für `matchedAs`/
  `reqCount`, Abschnitt 20, bleiben unverändert grün) — kein isolierter
  Unit-Test für `reqCountRaw` selbst ersetzt diesen End-to-End-Beleg.
  Mid-Iter-Vermutung: sollte der Implementer beim Refactoring auf eine
  fünfte, bisher unbekannte Count-Quelle stoßen, gehört das in einen eigenen
  Mangel/Folge-Ticket, nicht in einen stillen Verhaltenswechsel dieser
  Iteration.
- **`statsOut`-Parameter-Pattern an `findChallengeNode`/
  `collectChallengeNodes` ist ein neues Signatur-Element.** Rein additiv
  (optionaler Parameter, alle bestehenden Aufrufe ohne dritten/zweiten
  Parameter unverändert), aber die Test-Extraktion in `solver-test.js`
  Abschnitt 19 (`extractFunction(src, 'collectChallengeNodes')` /
  `'resolveFreshChallengeId'`) muss weiterhin funktionieren — der neue
  Parameter darf die Klammerzählung/Marker-Extraktion nicht stören
  (reine Text-Erweiterung der Funktionssignatur, keine Struktur-Änderung).

## Lift-Plan-Pre-Validation (M2)

Kein PK-Anteil in dieser Iteration (`structural_max` nur `RA`) —
`pk_files_to_cite` bleibt leer, `plan estimate` prüft hier nur
Ziel-Erreichung `RA` (`79`, `≤ min(structural_max=80, achievable_ceiling)`)
und Fokus-Konformität (RA ist die einzige fokussierte Dimension dieser
Iteration). Drei additive, unabhängig testbare Signale mit je eigener
konstruierter Regressions-Gegenprobe halten das Miss-Risk niedrig.
