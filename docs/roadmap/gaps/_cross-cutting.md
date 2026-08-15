# Cross-Cutting-Aggregat — Gap-Analyse Iteration 1 (2026-08-15)

Fokus-Iteration (ADR #79, soft-regression-guard): volle Analyse nur für
**batch-modus, diagnose-werkzeuge, rating-solver** (Iteration-0-Seeds +
Restpotenzial). Die 6 übrigen Features werden gehalten.

## Regressions-Scan (nicht-fokussierte Features)

Kein Regression-Marker: Seit dem Post-Iter-0-Audit (heute Nacht) gab es keine
Code-Änderungen — die Audit-Scores (android-app-wrapper 72, bedienpanel-ui 82,
ea-app-anbindung 74, sbc-vorgaben-erkennung 78, spieler-pool 83,
team-eintragen 75/Cap) sind unverändert gültig.

## Fokus-Befunde (Kurzfassung; Details in gaps/<feature>.md)

| Feature | RA | Ziel | Kern |
|---|---|---|---|
| batch-modus | 65 | 69 | Post-Submit-Plausibilisierung fehlt (nur Zähler); usedChallengeIds beobachtet statt erzwungen; Stuck-Recovery nur String-Grep-getestet; batchSteps-Ringpuffer verliert frühe Runden (>6) |
| diagnose-werkzeuge | 76 | 82 | lastEligible nie im Report; Symmetrie-Test 2 von 3 Richtungen; NEU: submitInfo-Block im Report selbst ohne Try/Catch — das Diagnose-Tool könnte bei Controller-Wandel lautlos ausfallen |
| rating-solver | 89 | 90 (konservativ) | Toter Duplikat-Tiebreak (live bewiesen: Dedupe kollabiert vorher; Test 6 vakuum-wahr); irreführende Kommentare; unbelegte Suchgrenzen-Magic-Numbers |

## Querbezüge für die Plan-Phase

- **SI reif:** `test-extraktions-helfer` (extractFunction — >10 Duplikat-Stellen
  in solver-test.js über 4 Features) — eigenes SI-Ticket.
- **Cleanup-Deckung:** Die Lifts decken die Cleanup-Kinder #24 (lastEligible,
  via diagnose-werkzeuge) und #26 (toter Tiebreak, via rating-solver) mit ab —
  bei deren Merge die Kinder schließen. #25/#27/#28/#29 bleiben im Sammelticket
  #30 für später.
- **Leitplanke unverändert:** oberste Regel „keine Regression"; Submit-Weg 0,
  Rating-Formel/V-Maß, Club-Lade-Takt tabu; „2 von 5 fertig"-Philosophie
  unantastbar — die Batch-Plausibilisierung ist NUR Beobachtung + sauberer
  Abbruch, kein Retry-Umbau.
