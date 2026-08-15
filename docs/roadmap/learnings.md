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

## Iteration 1 — 2026-08-15

## Iteration 1 — 2026-08-15

### Score-Bewegung
- Fokus-Iteration (3 von 9 Features): batch-modus 65→69 (Ziel 69, am Deckel-1), diagnose-werkzeuge 76→84 (Ziel 82 übertroffen), rating-solver 89→92 (Ziel 90 übertroffen). Ø Gain der Fokus-Features: +8.3.
- Gehaltene 6 Features unverändert (per Konstruktion — kein Code-Change, gain N/A).
- Fokus-Verdict: hit. Tests: 354 → 409, Userscript v4.45.0 → v4.48.0, dazu App-APK v1.7.0 gebaut (Signatur verifiziert) und gebündeltes Asset aktualisiert.

### Methodische Erkenntnisse
- Fokus-Iterationen funktionieren: 3 gezielte Lifts mit Seeds aus dem Vor-Audit trafen alle Ziele bei einem Bruchteil des Aufwands einer Voll-Iteration.
- „Strukturell tot" braucht einen Reihenfolge-Beweis, keinen Wahrscheinlichkeits-Verdacht: der Duplikat-Tiebreak konnte erst entfernt werden, als belegt war, dass JEDER Aufrufer nur deduplizierte Teilmengen sieht (405/405 vor = nach dem Schnitt).
- Vakuum-wahre Tests sind gefährlicher als fehlende: Test 6 bestand jahrelang, ohne je etwas zu prüfen — Ersatz braucht eine Gegenprobe (geflippte Flags), die den Reihenfolge-Zufall ausschließt.
- Ausnahmen-Listen in Meta-Tests (Symmetrie-Checks) nur mit faktisch verifizierter Begründung pro Eintrag — der Validator hat beide Ausnahmen (lastTap-Indirektion, Alias-Mutation) am Code nachvollzogen statt geglaubt.
- Auto-Merge + Nachtrag-Commit auf denselben Branch erzeugt verwaiste Post-Squash-PRs (2×: #20, #36) — Nachträge künftig vor dem ersten `review` bündeln oder per Cherry-Pick auf main landen.
- Die Test-Infrastruktur selbst ist Sicherheitsnetz: der extractFunction-Umbau (#31) lief mit Byte-Gleichheits-Beweisen gegen unabhängige Reimplementierungen — bei Testwerkzeug-Refactorings ist das der einzige belastbare Neutralitätsnachweis.

### Patterns ergänzt / verändert
- Keine neuen Patterns (Klasse F leer). Adoption vertieft: eingebetteten-code-exakt-testen ist jetzt Infrastruktur (extractMarkerBlock/extractFunction), warum-kommentare-mit-live-belegen um zwei hergeleitete Magic-Number-Belege erweitert (1300/900).
- Pflegebedarf unverändert offen: helfer-existiert-wird-umgangen (2 aufgelöste Belege aus iter0-#9), Beleg-Registrierung weiter blockiert durch code_geography-Format (#28).

### Shared-Items
- Gemergt: test-extraktions-helfer (#31) — sofort von #32/#33/#34 konsumiert.
- Kein neuer SI-Bedarf entdeckt.

### PO-Entscheidungen
- Klasse C (Re-Spawn/Nachtrag nach Finding): 1 (#31 uiBlock-Migration + IIFE-Begründung)
- Klasse D (PARTIAL akzeptiert): 0 — drei von vier Validator-Läufen waren glatte PASS
- Cleanup-Deckung: #24 durch #33, #26 durch #34 geschlossen (abandon-Pfad, FSM erlaubt kein Backlog→Done)
- Klassen A/B/F/G/H/Q: 0 · Eskalationen: 0

## Iteration 2 — 2026-08-15

## Iteration 2 — 2026-08-15

### Score-Bewegung
- Fokus-Iteration (1 von 9 Features): android-app-wrapper 72→79 (Ziel 78 übertroffen, Deckel 80 fast erreicht). Gehaltene 8 Features unverändert (kein Produkt-Code-Touch außer app/).
- Fokus-Verdict: hit. App v1.7.0 → v1.8.0 (versionCode 12), APK gebaut + Signatur verifiziert; Userscript unangetastet (v4.48.0 bleibt).
- Tests: 409 solver-Tests unverändert grün; guard-test von 27 auf 37 Assertions (8 neue Checks für die 4 Pflicht-Aktionen).

### Methodische Erkenntnisse
- Kleine Iterationen funktionieren: 1 Ticket + Main-Doku-Runde statt Ticket-Maschinerie für Doku-Chores — die drei Cleanup-Kinder #25/#27/#28 kosteten als PO-Direktarbeit einen Bruchteil eines Ticket-Durchlaufs (#25 lief als Aktion im Feature-Lift mit).
- Das Post-Squash-PR-Problem aus iter1 wurde durch Prozess vermieden: ALLE Commits inkl. Nachträge VOR `ticket review` bündeln (Auto-Merge feuert beim Ready-Stellen). Der README-Zähler-Nachtrag lief deshalb als PO-Commit im Worktree, bevor der PR ready wurde.
- Subagenten sterben am Session-Limit: der Implementer fiel nach getaner Arbeit beim Nachtrag aus (API-Limit) — der PO kann triviale Nachträge selbst committen statt neu zu spawnen, solange alle Gates danach grün laufen.
- Hand-Zählungen in Doku driften systematisch ("(18 Tests)" war schon vor iter2 falsch): zählungsfrei formulieren statt Zahl aktualisieren.
- Ein toter Guard ist schlimmer als keiner: `body == null` nach `readStream` konnte strukturell nie greifen und gaukelte Schutz vor — der Ersatz (`isEmpty()`) brauchte den Beweis, dass kein Aufrufer sich auf leere-aber-nicht-null-Strings verlässt (Grep über alle Call-Sites).
- Statischer Regex-Check ist ein legitimer guard-test-Ersatz für vm-Sandbox, wenn die Laufzeitumgebung (HttpURLConnection) nicht simulierbar ist — aber nur mit Negativ-Tests, die beweisen, dass der Check echte Regressionen fängt.

### Patterns ergänzt / verändert
- Keine neuen Patterns. Beleg-Registrierung ist entblockt: code_geography aller 9 Vision-Docs auf reine Pfade umgestellt (#28), `pattern add-beleg` löst für Userscript-Features wieder Kandidaten auf (verifiziert: candidate_files=3).
- fehler-unsichtbar-verschluckt weiter zurückgedrängt: letzte blinde Fremd-Grenze der App (WebView-Seitenlade-Fehler) hat jetzt eine Log-Spur.

### Shared-Items
- Keine (Gap-Report empfahl explizit kein Mid-Iter-SI; bestätigt richtig).

### PO-Entscheidungen
- Klasse C (Nachtrag): 1 — README-Zähler-Fix, wegen Subagent-Ausfall vom PO selbst committet.
- Validator: glattes PASS ohne Findings (0 PARTIALs in dieser Iteration).
- Cleanup-Deckung: #25 durch #40 (Aktion 1), #27 + #28 durch PO-Doku-Commit 6572fbe — alle drei via abandon-Pfad geschlossen. Offen bleibt nur #29 im Sammelticket #30.
- LEARNINGS-Schulden getilgt: §35 (Batch-Sperre + submitConfirmations, Debt aus iter1-#32), §36 (App-1.8.0-Entscheidungen, direkt nach dem Re-Score nachgezogen — der Scorer hatte den fehlenden Eintrag als Restlücke benannt).
- Eskalationen: 0.
