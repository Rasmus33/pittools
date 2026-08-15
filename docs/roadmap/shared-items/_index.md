# Shared-Items-Index

| Slug | Konsumenten | Bundle | Priority | Effort |
|------|-------------|--------|----------|--------|
| [[fehler-sichtbarkeit-diagerror]] | diagnose-werkzeuge, ea-app-anbindung, spieler-pool, team-eintragen | diagnose-helfer | P1-high | S |

Qualifiziert in Iteration 1:
- [[test-extraktions-helfer]] — extractFunction/extractMarkerBlock in solver-test.js (>10 Stellen, alle Test-Features) — P1/S

Nicht qualifiziert (Iteration 0, < 3 Konsumenten — als Kandidaten notiert):
- `test-extraktions-helfer` (1 Konsument: spieler-pool) — gemeinsamer
  `extractFunction()`-Test-Helfer; erneut prüfen, wenn die Test-Aktionen
  mehrerer Features gemergt sind.
- `controller-chain-konsolidierung` (1 Konsument: team-eintragen) — formale
  Erfassung der Cross-Feature-Kopplung an `getControllerChain`/`findLiveChallenge`;
  kein eigenes Artefakt, im team-eintragen-Lift-Plan mitbehandelt.
