# Cross-Cutting-Aggregat — Gap-Analyse Iteration 0 (2026-08-14)

9 von 9 Features analysiert (Dimension RA). Kein Iterations-Fokus gesetzt
(erste Iteration, eine Dimension — breites Default). Keine Regressionen
markierbar (keine Velocity-Historie vor Iteration 0).

## Features unter Schwellwert (Pflicht-Kandidaten für den Plan)

| Feature | RA | Schwelle | Status |
|---------|----|----------|--------|
| android-app-wrapper | 48 | 56 | **partial** — größte Lücke im Projekt |
| diagnose-werkzeuge | 58 | 59.5 | **partial** — knapp drunter |

Alle anderen 7 Features: pass (60–78).

## Häufige Mängel über mehrere Features (Cluster)

1. **Reportwürdige Fehler nur in warn()/still verschluckt** ([[fehler-unsichtbar-verschluckt]])
   — der breiteste Cluster, in 5 Features belegt: Userscript-Fetches
   (`:1334`, `:1346`, `:1100`, `:1118`), Locks (`:907`), Sync (`:762`),
   Batch-Planung (`:4831-4833`), App-Netzwerk/Cache (`MainActivity.java:392-401`,
   `:409-432`). Korrektur überall ADDITIV (diagError/addLog ergänzen) —
   regressionssicher, hoher Gain für Beobachtbarkeit.

2. **Wissens-Duplikate mit nachgewiesener Drift** ([[wissens-duplikate-ohne-ssot]])
   — 5 Features: Rating-Kosten-Defaults ×3 (Panel-Reset liefert FALSCHE Werte),
   `(sbs|sbc)`-Pfadwissen ×7, `costOf` im Test manuell nachgebaut,
   `STATE.diag` ohne Schema (totes `uiScan`, doppelter `rareConstraints`-Key),
   Namensdrift `slots`/`formationSlots` (Batch-Anker-Slots-Check ist No-Op).

3. **Kanonische Helfer inline dupliziert** ([[helfer-existiert-wird-umgangen]])
   — 4 Features: Controller-Traversal ×3, Sichtbarkeits-Check ×5,
   401-Retry ×2, Sortier-Komparator ×4, `reserve()`-Funnel ×2 umgangen
   (latentes HTTP-460-Risiko). Konsolidierung NUR an unkritischen Stellen,
   `submitViaApp` (Weg 0) bleibt unangetastet.

4. **Test-Lücken bei eingebettetem Code** (Ausweitung von [[eingebetteten-code-exakt-testen]])
   — 5 Features: `deepScanChallenge`/Parser, `normalizePlayer`/`isEvolution`,
   `readPaletoolsLocks`, `matchesPlannedSbc`, App-Log-Ringpuffer haben keine
   echte Funktions-Extraktion in den Tests (nur String-Checks oder gar nichts).
   Das bewährte Muster (Marker-/Literal-Extraktion + verifizierte
   Erwartungswerte) ist vorhanden und nur auf den Solver + Wächter angewandt.

5. **Doku-Drift** — CLAUDE.md/Vision referenzieren LEARNINGS „§23", die Datei
   endet bei §22 (mit doppelter §11-Nummerierung); veralteter Kommentar
   `:4982-4985` beschreibt den aktiven Batch als „ausgebaut" (Q7-Verstoß).

## Konkrete Einzel-Bugs (aus den Reports, ticket-reif)

| Bug | Ort | Verhalten ändert sich? |
|-----|-----|------------------------|
| Panel-Reset liefert veraltete Kosten-Defaults | `defaultBands()` :3360-3370 vs. :1485 | JA — gewollt, auf dokumentierten Stand; Pflicht-Testfall `bandsToSpec(defaultBands()) === DEFAULT_RATING_COST_SPEC` |
| `STATE.sbc.slots` nie geschrieben → Batch-Anker-Slots-Check No-Op | :4793-4796, :576 liest; :492/:640/:675/:691 schreiben formationSlots | JA — Sicherheitsnetz wird scharf; Pflicht-Testfall |
| `reserve()`-Funnel von Anker/Rarity-Pick umgangen | :1908-1917, :1932-1936 | NEIN (strukturell), Brute-Force-Testfall Pflicht |
| Totes `uiScan`-Feld + doppelter `rareConstraints`-Key | :3758, :3927-3928 | Feld befüllen (Report-Format-Kontinuität), Duplikat raus |
| Stille App-Catches ohne addLog | MainActivity.java:392-401, :409-432 u.a. | NEIN — additiv; Build nötig |

## Stagnations-Cluster

Keine (Iteration 0 — keine Historie).

## Leitplanke für die Plan-Phase

Oberste Regel „keine Regression" (CLAUDE.md): Lift-Aktionen sind additiv oder
verhaltensneutral; die zwei gewollten Verhaltensänderungen (Reset-Fix,
slots-Fix) brauchen eigene Testfälle und klare Ticket-Beschreibung. Nicht
anfassen ohne Grund: Rating-Formel/V-Maß, Submit-Weg 0, Club-Lade-Takt,
Spieler-Eindeutigkeit pro assetId.
