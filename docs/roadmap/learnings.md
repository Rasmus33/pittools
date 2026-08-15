# Learnings

Kumulativ. Git-Log ist die History.

## Iteration 0 — 2026-08-15

## Iteration 0 — 2026-08-15

### Score-Bewegung
- Avg Gain: +13.1 Pt über alle 9 Features (RA) · Worst: batch-modus (+5, Ziel um 2 verfehlt) · Best: android-app-wrapper (+24 auf 72, war unter Schwellwert)
- 9/9 Features pass; beide Partial-Features (android-app-wrapper 48→72, diagnose-werkzeuge 58→76) klar über ihre Schwellwerte gehoben. team-eintragen erreichte den strukturellen Deckel (76→Cap 75).
- Tests: 180 → 354 (fast verdoppelt), Userscript v4.36.0 → v4.45.0, App versionCode 10 → 11 (APK-Build durch Rasmus offen).

### Methodische Erkenntnisse
- Frische Worktrees sind auf Windows CRLF-Checkouts (autocrlf) — zeilenenden-empfindliche Test-Extraktion (Regex `$`/`.` matchen nicht um `\r`) bricht dann NUR dort. Gates vor Erstnutzung einmal im Worktree-Kontext verifizieren; Fix gehört in die Extraktion, nicht in die Quelle (#12).
- Auto-Merge + nachträglicher Commit auf denselben Branch erzeugt nicht-mergebare Folge-PRs (Post-Squash-Konflikt). Nach-Merge-Nachträge als Cherry-Pick auf main landen, nicht als zweiten PR auf dem alten Branch (#7/PR #20).
- Beleg-/Zeilen-Koordinaten verschieben sich zwischen Phasen-Commits desselben Tickets — file:line-Registrierungen immer gegen den FINALEN Stand verifizieren (Validator korrigierte :4888→:4910 bei #5).
- Verhaltensneutralität ist beweisbar, nicht behauptbar: Anker-Tests VOR der Migration schreiben und denselben Test gegen Alt-Code laufen lassen (Validator-Gegenprobe bei #10) — das Muster hat zwei heiße Pfade (URL-Klassifizierer, Controller-Traversal) regressionsfrei konsolidiert.
- Scharf geschaltete Sicherheitsnetze öffnen neue Verhaltensflächen: der slots-Fix (#4) machte ein transientes formationSlots-Reset-Fenster erstmals relevant — fail-safe by design, aber Diagnose-Protokollierung gehört im selben Zug dazu (#5).
- Ehrlichkeit im Kleinen zahlt aus: #6 wies nach, dass der reserve()-Bypass unerreichbar war, und verkaufte den Fix als Defense-in-Depth statt als Bugfix — die Tests dokumentieren Verhaltensgleichheit, nicht ein erfundenes kaputt→repariert.

### Patterns ergänzt / verändert
- Neu: keine mid-iter (Klasse F blieb leer — 1 unreifer Kandidat `symmetrie-test-lesen-schreiben-trennen` als Seed).
- Pflegebedarf: `helfer-existiert-wird-umgangen` — zwei Code-Belege durch #9 aufgelöst (Traversal-Duplikate weg), submitViaApp bleibt dokumentierte Ausnahme; `wissens-duplikate-ohne-ssot` — Rating-Kosten-Drift (#7), costOf-Test-Kopie (#6), sbs/sbc-Pfadwissen (#10) und slots-Namensdrift (#4) sind behoben.
- Adoption: `diagnose-feld-statt-raten` (reportError an 7+6 Call-Sites, App-Chokepoint reportNetError) und `eingebetteten-code-exakt-testen` (6 neue Marker-Blöcke: SBCSCAN, BANDS, CTRL, SBCCTRL, POOL, URLCLS) sind die Arbeitspferde der Iteration.

### Shared-Items
- Gemergt: `fehler-sichtbarkeit-diagerror` (#1, reportError-Kern) — Konsumenten-Adoption noch in derselben Iteration (batch #5, pool #8, team #9, ea-anbindung #10).
- Reif für nächste Iter: `test-extraktions-helfer` (extractFunction — jetzt >10 Duplikat-Stellen in solver-test.js über 4 Features).
- Nicht qualifiziert geblieben: `controller-chain-konsolidierung` (in #9 mitbehandelt).

### PO-Entscheidungen
- Klasse A (Spec-Amendments): 0
- Klasse B (Blocked/Umplanung): 1 (#1 wartete auf Gate-Fix #12)
- Klasse C (Re-Spawn nach Finding): 1 (#7 Format-Äquivalenz-Test)
- Klasse D (PARTIAL akzeptiert, Findings als Discoveries): 4 (#3, #4, #5, #8)
- Klasse F (Pattern-Discovery): 0 · Klasse G (Mid-Iter-SI): 0 · Klasse Q: 0
- Variant b (Bug-Task-Einschub): 1 (#12 guard-test-CRLF, P0 — blockierte alle Final-Gates in Worktrees)
- Eskalationen: 0 (alle Erstversuche auf Standard-Modell erfolgreich)
