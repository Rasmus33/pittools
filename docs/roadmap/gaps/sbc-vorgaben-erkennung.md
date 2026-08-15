---
feature: sbc-vorgaben-erkennung
analyzed_at: 2026-08-15
iteration: 3
regression: false
score_current:
  RA: 78
score_target:
  RA: 80
---

# Gap-Report — SBC-Vorgaben-Erkennung

**Fokus dieser Iteration:** EA-Wandel-Toleranz (RA, alleinige fokussierte Dimension). Nur additive Toleranz-Fallbacks, Früherkennungs-Diagnose und Degradationspfade — keine Umbauten an live-verifiziertem Parsen.

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 78 / 80 (capped)
**Schwellwert:** 56 (80 × 0.7)
**Status:** pass
**Begründung:** Laut `audit/sbc-vorgaben-erkennung.md` (Iteration 2) ist der Batch-Anker-Vergleich scharf und getestet, der Deep-Scan-Parser-Cluster ist per Marker (`// [SBCSCAN-BEGIN]`/`// [SBCSCAN-END]`) isoliert testbar, und `matchedAs` schließt die Dual-Use-Beobachtbarkeitslücke (PLAYER_LEVEL 1..3 vs. 40..99) inkl. Edge-Case. Der verbleibende strukturelle Deckel (2 Punkte unter Maximum) ist laut `vision/features/sbc-vorgaben-erkennung.md` bewusst, weil EAs Response-Form undokumentiert bleibt. Diese Iteration prüft gezielt, ob unter der EA-Wandel-Linse noch unbeobachtete Stellen existieren, die den Deckel rechtfertigen bzw. günstig anheben lassen.

## Mängel (≥ 3 — RA)

1. **`reqDump`-Whitelist blendet komplett neue EA-Scope-Familien aus, statt sie als `unclassified` sichtbar zu machen.** `deepScanChallenge()` berechnet `matchedAs` für JEDEN Knoten mit erkanntem `scopeString()` (`ea-fc-sbc-optimizer.user.js:436-495`), aber der Eintrag landet nur dann in `out.reqs` (und damit im Report unter `sbc.reqDump`), wenn der Scope-String zusätzlich eine der zehn festen Teilzeichenketten enthält (`RATING`, `RARITY`, `PLAYER`, `OVR`, `LEVEL`, `QUALITY`, `CLUB`, `LEAGUE`, `NATION`, `CHEM` — Zeilen 488-496). Führt EA einen komplett neuen Scope-Namen ein, der keines dieser Wörter enthält (z.B. „ARCHETYPE_GROUP" oder „SQUAD_OVERALL_MIN" — enthält weder RATING noch OVR), verschwindet der Knoten spurlos: kein `unclassified`-Eintrag, kein Diagnose-Hinweis, nichts im kopierbaren Report. Der existierende Test (`solver-test.js:2041-2042`, „matchedAs fuer Wert 15 ist unclassified") deckt nur den Fall ab, in dem der Scope ohnehin die Whitelist passiert (`PLAYER_LEVEL`) — der Whitelist-Bypass selbst ist ungetestet. Damit ist Leitfrage 2 („Diagnose-Signal bei unbekannter Struktur?") für genau die gefährlichste Kategorie — eine ganz neue Vorgaben-Familie — mit „Nein" zu beantworten.
2. **Traversal-Limits von `deepScanChallenge`/`findChallengeNode`/`collectChallengeNodes` sind intern gezählt, aber nirgends im Report sichtbar.** Alle drei BFS-Scanner führen einen `visited`-Zähler mit harter Obergrenze `visited < 20000` sowie eine Tiefenbegrenzung (`d > 7` bei `deepScanChallenge:417`, `d > 6` bei `findChallengeNode:567` und `collectChallengeNodes:605`). Wird eine Antwortstruktur durch EA breiter/tiefer (mehr verschachtelte Objekte, größere Arrays), sieht ein durch das Limit abgeschnittener Scan im Report identisch aus wie „SBC hat wirklich keine weiteren Vorgaben" — `targetOVR`/`rarityConstraints` bleiben einfach leer, ohne dass irgendein Feld zwischen „nichts gefunden" und „Suche vorzeitig abgebrochen" unterscheidet. Kein `STATE.diag`-Feld, kein `buildDiagReport()`-Eintrag trägt `visited`, `queue.length` am Ende oder einen „Tiefenlimit erreicht"-Marker.
3. **`reqCount()`-Fallback (`return 1` bei `ea-fc-sbc-optimizer.user.js:396`) ist von einem echten geparsten Wert 1 nicht unterscheidbar.** Die Funktion durchsucht Objekt + bis zu zwei Eltern-Knoten nach fünf möglichen Count-Feldnamen (`count`, `requirementCount`, `keyCount`, `amount`, `minimum`, `_count`) und fällt sonst auf `1` zurück (Zeilen 383-397). Für `PLAYER_RARITY_GROUP == 4` (Rare) ist die Unzuverlässigkeit bereits durch die „gilt für ALLE Slots ohne Ziel-Rating"-Regel abgefangen (LEARNINGS §11), für `playerLevel`-Vorgaben nur, wenn `target` (Ziel-OVR) fehlt (`ea-fc-sbc-optimizer.user.js:2085`: `if (!target && (pl.count || 1) < N)`). Bei einer Gold-SBC MIT Ziel-OVR (`target` gesetzt) und einer `PLAYER_OVERALL_RATING_MIN`-Vorgabe, deren Count-Feldname EA anders benennt als die fünf bekannten, greift kein Boost — `needCount` (Zeile 2095) wird still zu `1` statt der tatsächlich geforderten Anzahl, und der Solver reserviert zu wenige hochwertige Spieler, ohne dass Warnung oder Diagnose-Feld den Fallback markiert.

## Lift-Aktionen (≥ 3 — RA)

1. **`allScopesSeen`-Zähler additiv in `deepScanChallenge()` einführen.** Ein neues, von der bestehenden Whitelist unabhängiges `Set`, das JEDEN via `scopeString()` erkannten Scope-String sammelt (gedeckelt auf z.B. 40 Einträge), zurückgegeben als `out.scopesSeen` und im Report unter `sbc.scopesSeenCount`/`sbc.scopesSeenSample` sichtbar. Reine Ergänzung des Rückgabeobjekts (`out.*`), keine Änderung an `matchedAs`, `reqValue`, `reqCount` oder der bestehenden Whitelist-Logik — behebt Mangel 1 direkt, indem eine klaffende Lücke zwischen „Scopes gesehen" und „Scopes im reqDump" sofort auffällt, sobald EA eine neue Familie einführt. Erwarteter Gain: +2-3 Pt RA (Beobachtbarkeits-Kriterium der Rubric).
2. **Traversal-Erschöpfung als eigenes Diagnose-Feld exponieren.** `deepScanChallenge`/`findChallengeNode`/`collectChallengeNodes` geben zusätzlich `{ visitedCount, depthCapped, budgetExhausted }` zurück (analog zum bereits etablierten Muster `staleRecover`/`batchStuckCount` aus LEARNINGS §26/§27); `buildDiagReport()` übernimmt die Felder ungefiltert unter `sbc.scanStats`. Rein additiv — die Limits selbst (20000/Tiefe 6-7) bleiben unverändert, nur ihr Erreichen wird erstmals sichtbar. Wichtig laut Pattern `abbruch-disziplin`: NUR als Diagnose-Feld, KEIN automatischer Abbruch/Warnung beim Nutzer (Wiederholung des v4.34.0-Fehlers vermeiden, s. Edge-Case unten). Erwarteter Gain: +2 Pt RA (Beobachtbarkeit + Fehlertoleranz-Kriterium).
3. **`reqCount()`-Fallback markieren statt nur zurückgeben.** `reqCount(o, parents)` liefert zusätzlich ein zweites Flag (z.B. via Objekt-Rückgabe `{ count, defaulted }` oder separates `reqCountDefaulted(o, parents)`), das genau dann `true` ist, wenn KEINER der fünf bekannten Count-Schlüssel in der Eltern-Kette traf und der `1`-Fallback griff. Jeder `reqDump`-Eintrag sowie `playerLevelConstraints`/`qualityConstraints`/`rarityConstraints` tragen das Flag zusätzlich mit; `buildDiagReport()` zeigt eine Kurzliste „Count geraten (nicht gefunden): N Vorgaben". Reine Zusatz-Property, `reqCount()` selbst liefert weiterhin denselben Zahlenwert wie bisher — kein Verhaltensunterschied für den Solver. Erwarteter Gain: +2 Pt RA (Beobachtbarkeit + dokumentierte Begründung fragiler Stelle), behebt die Blackbox in Mangel 3.
4. *(dünn — nur als Ergänzung, kein eigenständiger dritter Beleg)* **Rareflag-Verteilungs-Sample im Report um eine grobe Plausibilitäts-Notiz ergänzen** (z.B. „Common:Rare-Verhältnis X:Y, letzter bekannter Bereich Z" als reiner Kommentar/Info-Feld, keine Warnung). Da sich das Verhältnis laut CLAUDE.md saisonal legitim verschiebt („86er nicht mehr knapp, 85er reichlich"), wäre jede automatische Anomalie-Erkennung hier fehleranfällig (False Positives) — deshalb nur als rein informatives Zusatzfeld sinnvoll, kein belastbarer Gain-Beitrag zu erwarten. Explizit als dünn markiert, nicht als vollwertige dritte Aktion gezählt.

## Edge-Cases (mind. 1 — RA)

- **Traversal-Diagnose darf nicht zur Wiederholung des v4.34.0-Fehlers werden.** Das Erreichen von `visited >= 20000` oder der Tiefengrenze bedeutet NICHT zwingend, dass relevante Vorgaben fehlen — die BFS kann die entscheidenden Knoten (z.B. `TEAM_RATING`) bereits früh gefunden haben, bevor das Budget erschöpft wurde. Ein reflexhaftes „Warnung/Abbruch bei Budget erschöpft" würde exakt den in `ea-fc-sbc-optimizer.user.js:4333-4337` dokumentierten Fehler wiederholen (Vorab-Warnung aus Strukturindizien, die auch bei tadellos laufenden SBCs feuerte, wurde in v4.34.0 eingeführt und wieder zurückgenommen). Die Lift-Aktion 2 muss deshalb rein informativ bleiben (Report-Feld), nicht als neue Nutzer-Warnung oder gar Abbruch-Bedingung — sonst wird ein struktureller Fortschritt (Beobachtbarkeit) durch einen neuen Q2-Verstoß (Symptom-Fix/Fehlalarm) erkauft.

## Lift-Empfehlung

Vorsichtig, rein additiv: alle drei vollwertigen Aktionen fügen ausschließlich neue Report-/Rückgabe-Felder hinzu (`out.scopesSeen`, `scanStats`, `reqCountDefaulted`) und ändern keine bestehende Matching-, Zähl- oder Solver-Logik — Regressionsrisiko minimal, `solver-test.js` bleibt für die bestehenden Fälle unverändert grün, neue Tests kommen rein additiv hinzu (analog zum `matchedAs`-Muster aus §26). Kein Mid-Iter-SI nötig, da alle drei Änderungen im selben Deep-Scan-Cluster (`// [SBCSCAN-BEGIN]`/`// [SBCSCAN-END]`) liegen und von einem einzigen Implementer-Durchlauf mit kleinen Diffs umgesetzt werden können.
