# Lift-Plans-Übersicht — Iteration 0

9 Lift-Pläne, Dimension RA (einzige Score-Dimension). M3-Targets nach der
70-%-Regel; M2 per Main-Reasoning validiert (`plan estimate` ist ein
PK-Linter, keine PK-Dimension im Workspace).

| Feature | RA Ist → Ziel | Gain | Kern | Prio/Effort |
|---------|---------------|------|------|-------------|
| android-app-wrapper | 48 → 70 | +22 | addLog in stille App-Catches, reportNetError-Helfer, Log-Tests, Zustands-Setter (Build nötig) | P1/M |
| diagnose-werkzeuge | 58 → 77 | +19 | uiScan befüllen, rareConstraints-Duplikat raus, STATE.diag-Schema + Test, reportError-Kern, app/log-test.js | P1/M |
| rating-solver | 78 → 90 | +12 | reserve()-Funnel schließen, Komparator-Factory (Tiebreak parametriert!), makeCostOf-SSOT zum Test, Totcode raus | P2/M |
| bedienpanel-ui | 68 → 80 | +12 | defaultBands aus DEFAULT_RATING_COST_SPEC (Reset-Fix, Pflicht-Test), lo>hi-Feedback, ratingCostSpec im Report | P2/S |
| sbc-vorgaben-erkennung | 65 → 75 | +10 | slots→formationSlots-Fix (Pflicht-Test), [SBCSCAN]-Marker + echte Parser-Tests, matchedAs-Feld | P2/S |
| spieler-pool | 70 → 80 | +10 | diagError additiv, normalizePlayer/isEvolution- + Locks-Tests, LEARNINGS §23 | P2/S |
| team-eintragen | 60 → 70 | +10 | Traversal-Konsolidierung NUR unkritische Stellen, Laufzeit-Tests mit synthetischem Controller-Graph, Weg-0-WARUM-Kommentar | P2/M |
| ea-app-anbindung | 64 → 72 | +8 | diagError in Services-Fallbacks, sbs/sbc-Regex-SSOT mit Testblock zuerst, apiRequest-Extraktion bewusst VERSCHOBEN | P2/S |
| batch-modus | 60 → 67 | +7 | matchesPlannedSbc-Integrationstest (depends_on sbc-vorgaben-erkennung), Orchestrierungs-Regressionstest, Q7-Kommentar-Fix, submitChallengeToEa-Absicherung | P2/S |

Σ erwarteter Gain: +110 RA-Punkte über 9 Features.

## Querbezüge

- **Shared-Item:** [[fehler-sichtbarkeit-diagerror]] (4 Konsumenten) — Kern
  kommt aus dem diagnose-werkzeuge-Lift; die Feature-Lifts schließen ihre
  Stellen diese Iteration additiv, Umstellung auf `reportError()` folgt.
- **Abhängigkeit:** batch-modus `depends_on` sbc-vorgaben-erkennung
  (slots-Fix liegt dort, Batch testet ihn nur).
- **Bewusst verschoben:** apiRequest-Extraktion (ea-app-anbindung) — ohne
  Mock-Harness nicht verhaltensneutral belegbar; Kandidat Folge-Iteration.
- **Leitplanke:** oberste Regel „keine Regression" — zwei gewollte
  Verhaltensänderungen (Panel-Reset-Defaults, slots-Sicherheitsnetz) mit
  Pflicht-Testfällen, alles andere additiv/verhaltensneutral (180/180
  vorher = nachher).
