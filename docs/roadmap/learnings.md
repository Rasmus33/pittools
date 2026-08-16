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

## Iteration 3 — 2026-08-15

## Iteration 3 — 2026-08-15

### Score-Bewegung
- Thematische Fokus-Iteration (3 von 9 Features, Linse: EA-Wandel-Toleranz + Test-Infrastruktur): sbc-vorgaben-erkennung 78→79 (Ziel 79), ea-app-anbindung 74→75 (structural_max erreicht), android-app-wrapper 79→80 (structural_max erstmals erreicht). Fokus-Verdict: hit, 3/3.
- Userscript v4.48.0 → v4.50.0 (zwei Tickets), Tests 409 → 464. App-Code unverändert bis auf 2 Kommentarzeilen (Marker) — kein APK nötig.
- Damit ist die Roadmap konvergiert: alle 9 Features stehen an oder maximal 1-3 Punkte unter ihren strukturellen Deckeln.

### Methodische Erkenntnisse
- Eine thematische Linse (EA-Wandel-Toleranz) findet auch in „fertigen" Features echte Lücken: die reqDump-Whitelist verschluckte neue Scope-Familien spurlos, gekappte Scans sahen aus wie „keine Vorgaben", JSON-Parse-Fehler an der EA-Grenze verschwanden still. Alles nur mit der Frage „was passiert, wenn EA X ändert?" gefunden — nicht mit generischem „finde Mängel".
- Früherkennung schlägt Reparatur: alle iter3-Aktionen machen EA-Änderungen SICHTBAR (Report-Felder), bevor etwas falsch gebaut wird — bewusst KEINE neuen Warn-/Abbruchkriterien (v4.34.0-Fehlalarm als Anti-Vorlage, in §37 dokumentiert).
- Validatoren müssen gegen den JEWEILS EIGENEN Lift-Plan prüfen: die vermeintliche Phasen-Abweichung bei #43 (kein release-Commit) war plankonform — zwei parallele Tickets hatten schlicht unterschiedliche Phasen-Mappings definiert.
- Implizites Gating ist verifizierbares Gating: das reportError-Gate für Fremd-URLs brauchte keinen neuen Code, der bestehende !kind-Early-Return erledigt es strukturell — am Kontrollfluss bewiesen statt behauptet.
- Byte-Gleichheits-Beweis als Standard für Testwerkzeug-Refactorings bestätigt (extractGuard Marker-Weg vs. Literal-Weg an der echten MainActivity, nach CRLF-Normalisierung) — dritte erfolgreiche Anwendung nach extractFunction (iter1) und den iter2-Checks.
- Gates wachsen mit: compile-check.sh (javac ohne Keystore) und log_test sind jetzt final_gates in config/system.yaml — Java-Syntaxfehler fallen künftig VOR dem PO-Build auf, nicht erst beim APK-Bau.

### Patterns ergänzt / verändert
- Keine neuen Patterns. fehler-unsichtbar-verschluckt weiter zurückgedrängt (handleResponseBody-Catches waren die letzten stillen an der EA-Grenze, die SBC-relevante Fehler betrafen); diagnose-feld-statt-raten um 6 neue Report-Felder vertieft (scopesSeen, scanStats, reqCountDefaulted, utasUnclassified, lastUnclassifiedPaths, allSpecialFlagValues).

### Shared-Items
- Keine (alle drei Sidecars leer, bestätigt richtig — nur sdk-env.sh als lokale DRY-Basis innerhalb eines Features).

### PO-Entscheidungen
- Validator: 3× glattes PASS ohne Findings (0 PARTIALs, 0 Re-Spawns).
- Restfund aus dem Re-Score als Seed statt Hotfix: applyFromSetChallenges ruft deepScanChallenge ohne recordDeepScanStats (Beobachtbarkeitslücke im Fallback-Pfad der NEUEN Fähigkeit) — klein, additiv fixbar, kein Anlass für eine vierte Runde jetzt.
- Bewusst verschoben: apiBaseDetectionStuck + sbcHookMisses (dünn, ea-app ist am Deckel).
- Eskalationen: 0. Post-Squash-Regel (alle Commits vor review bündeln) hielt zum zweiten Mal — 0 verwaiste PRs.

## Iteration 4 — 2026-08-15

## Iteration 4 — 2026-08-15

### Score-Bewegung
- Fokus-Iteration auf User-Wunsch (2 von 9 Features): bedienpanel-ui 82→84 (Ziel 84, größter Restspielraum des Portfolios), sbc-vorgaben-erkennung 79→80 (structural_max, via Mini-Fix #48). Fokus-Verdict: hit, 2/2.
- Userscript v4.50.0 → v4.53.0, Tests 464 → 490. Damit stehen 4 der 9 Features exakt auf ihrem strukturellen Deckel (sbc 80/80, ea-app 75/75, android 80/80, team 75/75), die übrigen 1-3 Punkte darunter mit dokumentierten Gründen.

### Methodische Erkenntnisse
- Mini-Task-Flow etabliert: kind=task ohne Score-Snapshot + Main-Verifikation statt Validator-Spawn bei Ein-Zeilen-Diff (#48) — Prüfaufwand proportional zur Diff-Größe, der Restfund aus dem iter3-Re-Score war in einer halben Stunde geschlossen.
- Re-Score-Restfunde sind das beste Seed-Material: der iter3-Abzugsgrund (scanStats-Fallback-Pfad) war präzise genug, um ohne neue Gap-Analyse direkt ein Ticket zu schneiden.
- Validator-PARTIAL noch in derselben Iteration abgeräumt: das kosmetische Doppel-Logging (warn + reportError) wurde als PO-Direktfix v4.53.0 bereinigt statt als Debt verschleppt — inklusive ehrlicherem Fehler-Label (der Catch deckt readConfig UND solve, das Label sagte nur readConfig).
- Reihenfolge-Beweis als Muster für additive Fallback-Ketten: Fixtur, in der Primär- und Fallback-Weg gleichzeitig treffen, Assertion auf Element-IDENTITÄT plus Fallback-Zähler bleibt 0 — stärker als jede truthiness-Prüfung.
- Zähler bewusst außerhalb von STATE.diag platzieren, wenn sie in einen bestehenden Report-Block gehören (containerFallbackUsed im launcher-Block wie btnAttachCount): hält den Symmetrie-Test frei von Ausnahmen.
- Q7-Drift entsteht auch durch die eigene Pipeline: der PO-Cleanup (Label-Umbenennung) machte den frisch geschriebenen §40 falsch — Doku-Angleich gehört in denselben Arbeitsgang wie der Code-Fix.

### Patterns ergänzt / verändert
- Keine neuen Patterns. ea-grenz-fallback-ketten um den Launcher-Fall vertieft (Text-Discovery aus der Diagnose wurde zur Fallback-Quelle befördert — Diagnose-Felder als Vorstufe künftiger Fallbacks bestätigt sich); fehler-unsichtbar-verschluckt: die drei letzten stillen localStorage-Catches des Panels hängen jetzt am reportError-Chokepoint.

### Shared-Items
- Keine.

### PO-Entscheidungen
- Klasse C: 2 — (1) Doppel-Logging-Cleanup als PO-Direktfix v4.53.0 nach Validator-Fund; (2) §40-Label-Angleich nach Re-Score-Fund.
- Validator: 1× PASS-mit-kosmetischem-Fund (PARTIAL), 1× Main-Verifikation (Mini-Task #48). Kein Re-Spawn.
- Bewusst offen gelassen: STATE.loading-Guard (dünn — Fenster schmal, nicht korruptierend); readConfig ohne eigenen Guard (Q4-Architekturentscheidung, beide Call-Sites gedeckt).
- Plugin-Validierungsfehler bei ticket create (task-Spec braucht target_paths + acceptance im Spec-Block) — kein Bug, Spec-Anforderung; beim zweiten Versuch sauber durch. Der rc=42-Report wurde automatisch erfasst.
- Eskalationen: 0. Post-Squash-Regel hielt zum dritten Mal.

## Iteration 5 — 2026-08-15

## Iteration 5 — 2026-08-15

### Score-Bewegung
- Letzte Polish-Runde (2 von 9 Features): bedienpanel-ui 84→85 (structural_max, via Mini-Task #52 STATE.loading-Guard), batch-modus 69→70 (structural_max, via #54 titleSource/Tap-Tests/popupDismissCount). Fokus-Verdict: hit, 2/2.
- Userscript v4.53.0 → v4.55.0, Tests 490 → 503.
- **Endstand des Portfolios: 6 von 9 Features exakt auf structural_max** (batch 70/70, bedienpanel 85/85, sbc-erkennung 80/80, ea-app 75/75, android 80/80, team 75/75). Die 3 verbleibenden Restpunkte sind ausschließlich strukturell begründet: solver 92/95 (reverse-engineerte Formel), diagnose 84/85 (inhärenter Vorlauf für unbekannte Fehlerbilder), pool 83/85 (Fehlertoleranz bewusst unangetastet — Club-Lade-Takt ist Nicht-anfassen-Zone). Die Roadmap ist fertig.

### Methodische Erkenntnisse
- Das Ehrlichkeits-Mandat an Gap-Analysten funktioniert: der Batch-Gap durfte „nichts gefunden" liefern und fand stattdessen einen präzisen echten Kern — der titleOf()-Volltext-Fallback hätte bei einem EA-Umbau der Kachel-Innenelemente still die live gefixte §9-Teilstring-Fehlerklasse reaktiviert. Die Linse „was passiert, wenn EA X ändert" bleibt das schärfste Werkzeug gegen fertige Features.
- Sichtbar machen statt abklemmen: der degradierte Fallback-Pfad wurde NICHT entfernt (kein Live-Beleg für Fehlverhalten, nachgelagertes matchesPlannedSbc-Netz existiert), sondern als titleSource beobachtbar gemacht — dieselbe Philosophie wie scanStats (§37). Diagnose-Felder sind die Vorstufe künftiger Fixes, nicht deren Ersatz.
- Re-Score-Restlücken als Ticket-Quelle bestätigt (zweite Iteration in Folge): präzise benannte Abzugsgründe (loading-Guard, scanStats-Fallback) lassen sich ohne neue Gap-Analyse direkt in Mini-Tasks übersetzen.
- git stash verliert im CRLF-Worktree still den staged/unstaged-Split — der #54-Implementer wich auf git-show-Snapshots für Phasen-Verifikation aus. Als Worktree-Eigenheit für künftige Implementer-Briefings gemerkt.
- Formänderung einer lokalen Helper-Rückgabe ({text, source} statt String) ist sicher, wenn ALLE Aufrufer per Grep bewiesen lokal liegen — die Prüfung kostet eine Minute und ersetzt Spekulation.

### Patterns ergänzt / verändert
- Keine neuen Patterns. diagnose-feld-statt-raten und abbruch-disziplin je um einen Lehrbuch-Fall vertieft (titleSource bzw. loading-Guard); eingebetteten-code-exakt-testen deckt jetzt auch den Tap-Pfad (letzter komplett ungetesteter Batch-Baustein).

### Shared-Items
- Keine.

### PO-Entscheidungen
- 2 Mini-/Kleintickets Main-verifiziert statt Validator-gespawnt (#52 Guard-Diff, #54 mit Aufrufer-Grep) — Prüftiefe proportional zum Diff, beide Diffs vollständig gelesen.
- Popup-Dismiss-Zähler (dünn markiert) wurde mitgenommen, weil er in 2 Zeilen passte — dünne Aktionen sind ok, wenn ihr Preis gegen null geht.
- Eskalationen: 0. Post-Squash-Regel hielt zum vierten Mal. Alle 29 GitHub-Issues des Projekts abgeschlossen, Backlog leer.

## Iteration 6 — 2026-08-15

## Iteration 6 — 2026-08-15

### Score-Bewegung
- Verifikations-Runde (3 Features mit Ehrlichkeits-Mandat): rating-solver 92→94, spieler-pool 83→84, diagnose-werkzeuge 84 verifiziert gehalten. Fokus-Verdict: hit.
- Userscript v4.55.0 → v4.60.0 (Tickets #56/#57/#60 + vier Live-Hotfixes am selben Abend), Tests 503 → 558. Endstand: solver 94/95, pool 84/85, diagnose 84/85, alle übrigen 6 auf structural_max.

### Methodische Erkenntnisse
- **Die Verifikations-Runde widerlegte die eigene „strukturell fertig"-Behauptung produktiv**: das Ehrlichkeits-Mandat („nichts gefunden ist legitim") lieferte zwei „substanz"-Verdicts — und das daraus beauftragte Fuzzing (#57) fand beim ERSTEN Lauf einen echten Solver-Defekt (Rarity-Reservierung ignorierte das Überschuss-Fenster). Behauptete Deckel sind Hypothesen, bis ein Fuzzing sie geprüft hat.
- **Abbruch-mit-Befund als Ticket-Erfolgsfall funktioniert**: #57 durfte explizit nicht fixen, sondern musste den Repro dreifach gegen unabhängige Enumerationen beweisen. Der Fix (#60) bekam dadurch ein fertiges Testfundament und der Implementer fand beim Fixen selbst zwei Folge-Teilfehler per Fuzzing, bevor er „fertig" meldete.
- **Charakterisierungstest-Muster**: ein bewiesener, aber noch nicht gefixter Defekt wird als BEKANNTER-BEFUND-Check gepinnt (Assertion auf das IST-Verhalten) — main bleibt grün, der Fix MUSS den Check drehen. Brücke zwischen „Befund liegt" und „Fix ist da" ohne roten Gate-Lauf.
- **Die Live-Feedback-Schleife trug einen ganzen Krisenabend**: EA hängte am 15.08. große Kit-Metadaten in die Set-Daten; sechs Reports von Rasmus führten zu vier Hotfixes in unter drei Stunden (v4.57 Daily-Same-Id-Sperre, v4.58 Scan-Priorisierung/Budget, v4.59 Solver-Fix, v4.60 elgReq-Quelle). Jeder Fix wurde von einem Diagnose-Feld aus iter3-6 geleitet (scanStats → budgetExhausted, deepScanBySource → welcher Pfad, usedInstance → Sperr-Beweis). Diagnose-Investition zahlt in Krisen aus.
- **Zwei eigene Regressionen ehrlich bilanziert**: die iter1-usedChallengeIds-Sperre brach Daily-SBCs (EAs „jede Wiederholung = neue Id"-Annahme gilt nicht universell — Fix: Same-Id + nachweislich leer = frisch), und der global gekeyte Set-Cache ließ den Vorgaben-Scan auf fremden Sets laufen. Beides waren Annahmen, die live verifiziert schienen und es nur für eine Teilmenge waren.
- **Mid-Ticket-Rebase via SendMessage an denselben Implementer** (Kontext intakt) verkraftete zwei zwischenzeitliche Hotfixes sauber — Konflikte nur an den erwarteten Stellen, Validator prüfte danach gegen den rebasten Stand.

### Patterns ergänzt / verändert
- Keine neuen Pattern-Docs. diagnose-feld-statt-raten hat sich als KRISEN-Werkzeug bewährt (siehe oben); eingebetteten-code-exakt-testen um Fuzzing-mit-unabhängiger-Referenz erweitert (Sections 46-48, 50).

### Shared-Items
- Keine.

### PO-Entscheidungen
- Klasse C: 3 — README-/Test-Kosmetik direkt (Verifikations-Gap diagnose), 4 Live-Hotfixes direkt auf main (eiserner Arbeitsablauf, alle 5 Gates je Push), #60-Rebase-Nachtrag.
- Validator: #56 PASS, #60 PASS (Formel byte-identisch verifiziert); #57 Main-verifiziert + Befund-Pinning beauftragt.
- Bewusst offen: playerLevelConstraints-Verdacht (erst fuzzen, dann fixen — §41), LEARNINGS-§30-Formulierung (Politur).
- Eskalationen: 0. Force-Push auf Ticket-Branch nach Rebase als PO-Handgriff etabliert (--force-with-lease).

## Iteration 7 — 2026-08-15

## Iteration 7 — 2026-08-15

### Score-Bewegung
- Wartezeit-Runde wurde zur Deckel-Runde: rating-solver 94→95 (= structural_max). Der einzige offene Verdacht des Portfolios (§41: playerLevel-Reservierung) wurde per Fuzzing BEWIESEN (#62, Diskrepanz dreifach verifiziert, als Charakterisierungstest gepinnt) und noch in derselben Runde gefixt (#64, v4.61.0). Fokus-Verdict: hit.
- Userscript v4.60.0 → v4.61.0, Tests 559 → 563. **Endstand: 7 von 9 Features exakt auf structural_max**, pool 84/85 und diagnose 84/85 mit dokumentierten Restgründen.

### Methodische Erkenntnisse
- Das Verdacht→Fuzzing→Pin→Fix-Protokoll ist jetzt zweimal durchlaufen und trägt: ein Analogie-Verdacht („strukturell gleicher Aufbau wie der gefixte Pfad") ist ein verlässlicher Bug-Detektor, aber erst das Fuzzing mit unabhängiger Referenz macht daraus einen beweisbaren Befund — und erst der Beweis rechtfertigt den Kern-Eingriff.
- Zweiter Fix derselben Klasse = Generalisierungs-Gelegenheit: statt reserveRarityWindowAware zu kopieren, wurde es zu reserveWindowAware(stillNeed, cands, describeCard, canShareBandCache) verallgemeinert — der Validator bewies die Neutralität des erst tags zuvor gefixten Rarity-Pfads über Byte-Vergleich der Kandidaten-Filter plus unveränderte Beweis-Sections.
- Ehrliche Test-Scope-Grenzen statt vorgetäuschter Abdeckung: der kombinierte Rarity+playerLevel-Fuzz hält die Kandidaten-Bereiche bewusst disjunkt, weil beim Testbau eine VORBESTEHENDE Architektur-Grenze auffiel (sequenzielle Reservierung optimiert nicht gemeinsam über Constraint-Typen). Die Grenze steht als „Bekannte Grenze" in §41 und als gesammeltes Debt — nicht im Test versteckt.
- Validator-PARTIAL wegen eines veralteten Konstanten-Kommentars: der dritte Fall der Serie „Doku-Drift durch die eigene Pipeline" (nach §40-Label und §25-Liste) — Kommentare an Deklarationsstellen altern schneller als Funktions-Docs, weil Refactorings sie nicht anfassen. Vor dem Publish behoben (Alle-Commits-vor-Review-Regel hielt zum fünften Mal).

### Patterns ergänzt / verändert
- Keine neuen Pattern-Docs. Das Charakterisierungstest-Muster (iter6) hat seinen Zyklus geschlossen: Befund-Pin aus #62 wurde in #64 planmäßig auf „FIX verifiziert" gedreht.

### Shared-Items
- Keine.

### PO-Entscheidungen
- Klasse C: 1 — Konstanten-Kommentar-Fix als PO-Commit im Worktree vor dem Publish (Validator-Fund).
- Validator: #64 PASS/PARTIAL-kosmetisch (Rarity-Neutralität byte-verifiziert); #62 Main-verifiziert (test-only).
- Architektur-Debt „Joint-Optimierung über Constraint-Typen" bewusst NICHT angegangen: relevant erst bei SBCs mit mehreren gleichzeitigen Vorgabe-Typen UND engen Fenstern; erst fuzzen/Live-Fall abwarten.
- Eskalationen: 0.

## Iteration 8 — 2026-08-15

## Iteration 8 — 2026-08-15

### Score-Bewegung
- Finale Mikro-Runde: spieler-pool 84→85 (removeFromPool erstmals verhaltensgetestet, §30 in Ist-Form — beide iter6-Restpunkte PO-direkt geschlossen), diagnose-werkzeuge 84→85 (Doppelzählungs-Korrektur: der inhärente Lag war bereits im Deckel eingepreist; der Krisenabend lieferte den stärksten Live-Beleg). Fokus-Verdict: hit.
- **PORTFOLIO KOMPLETT: alle 9 Features exakt auf structural_max** — solver 95/95, pool 85/85, diagnose 85/85, bedienpanel 85/85, sbc-erkennung 80/80, android 80/80, ea-app 75/75, team-eintragen 75/75, batch 70/70. Tests: 568. Script v4.61.0.

### Methodische Erkenntnisse
- Doppelzählung zwischen Deckel-Begründung und Score-Abzug erkennen: wenn dieselbe Eigenschaft (inhärenter Lag) sowohl structural_max < 100 begründet ALS AUCH den Score unter den Deckel drückt, wird sie doppelt bestraft — der Re-Scorer hat das am Rubric-Text auseinandergezogen.
- Live-Bewährung ist Evidenz erster Klasse: der Krisenabend (6 Reports → 4 Hotfixes < 3h, jede Wurzelursache per Diagnose-Feld benannt, Lag-Zyklus zweimal unter einer Stunde) hat für diagnose-werkzeuge mehr bewiesen als jeder konstruierte Test es könnte.
- Präzise benannte Re-Score-Restpunkte bleiben die billigste Ticket-Quelle: die zwei Pool-Punkte kosteten als PO-Direktarbeit unter einer halben Stunde inklusive aller Gates.

### Patterns ergänzt / verändert
- Keine.

### Shared-Items
- Keine.

### PO-Entscheidungen
- Beide Restpunkte PO-direkt (test-/docs-only, kein Version-Bump, alle 5 Gates je Commit) statt Ticket-Maschinerie — Proportionalität.
- Damit endet die Lift-Phase des Projekts: weitere Punkte gäbe es nur über Cap-Revisionen (neue Erkenntnisse, EA-Wandel, Live-Befunde), nicht über weitere Lifts. Offen außerhalb der Scores: Joint-Optimierungs-Debt (anlassgebunden), APK-1.8.0-Installation, Live-Bewährung v4.60/v4.61.
- Eskalationen: 0.

## Iteration 9 — 2026-08-16

## Iteration 9 — 16.08.2026 (Feature-Nacht auf User-Zuruf)

### Score-Bewegung
- Erste USER-getriebene Iteration (5 Wünsche in einer Nacht statt Gap-Analyse): bedienpanel-ui 85 bestätigt, batch-modus 70 bestätigt, rating-solver 95→93 (ehrliche Korrektur: der Live-Bug widerlegte die alte Bewertung), pack-opener NEU mit 46/70 (ehrlicher Erst-Score: Architektur/Tests solide, EA-Mechanik nie live verifiziert — bewusst unter der Schwelle bis zum ersten echten Lauf).
- Userscript v4.61.0 → v4.69.0 (8 Versionen), Tests 563 → 775. Geliefert: Panel-Rework (#66), Erschöpfungs-Meldung (#70), Kandidaten-Anzeige (#68), Pack-Opener Stufe 1+2 (#69/#76, NEUES Feature), Plan-Check (#73) + Hotfixes v4.66 (GameCurrency optional) und v4.67 (Verein-TOTW-Gate, TOTW-Flachkosten, Filter-Ursachen, cfgSnapshot).

### Methodische Erkenntnisse
- **Ein Live-Nutzer schlägt jede Gap-Analyse**: Rasmus fand den Verein-TOTW-Bug per eigenem Haken-Experiment und lieferte damit die Diagnose frei Haus. Die Betriebsform „User spielt, PO fixt in <1h, Diagnose-Felder leiten" hat sich als produktivste des Projekts erwiesen.
- **Eine Ausnahme-Regel muss an JEDEM Gate stehen**: die dokumentierte TOTW-Ausnahme („Verein-Specials nie — außer TOTW") stand im Reservierungs-Filter, fehlte aber im allgemeinen Storage-Filter davor — das korrekte Gate sah die Karten nie. Konsequenz für die 93 beim Solver: dokumentierte Produktregel-Gates brauchen je einen eigenen Test (systematischer Gate-Abdeckungs-Check als Seed notiert).
- **Fremdcode-Dekodierung als Mechanik-Quelle**: die PaleTools-Analyse (String-Tabellen-Dekodierung, 6 Kernfragen mit Belegen) lieferte den kompletten Pack-Opener-Bauplan in einem Agenten-Lauf — schneller und fundierter als Trial-and-Error gegen die EA-API.
- **Sicherheits-Gate durch Sicherheits-NETZ ersetzt**: das „Stufe 2 erst nach Live-Bestätigung"-Gate wurde per PO-Entscheid überstimmt (User schläft, will alles fertig), aber nur weil der Erster-Fehler-Stopp „Alle öffnen" im schlimmsten Fall zum Einzel-Test degradiert. Dokumentierte Ausnahme im Vision-Doc.
- **Rebase-Disziplin**: nach Mid-Ticket-Rebases muss der PO den Branch force-pushen BEVOR publish/review läuft — bei #73 vergessen (PR blieb stale/draft, manueller Merge nötig), bei #60/#64 korrekt. Als Prozess-Merker geseedet.
- **Scorer-Konsistenz prüfen**: ein Re-Score lieferte Zahl (69) und Begründung („bleibt am Deckel") im Widerspruch — eine Konsistenz-Rückfrage vor dem Rubric-Schreiben löste es sauber auf (70).
- **Neue Produktregel von Rasmus**: TOTW sind wertgleich — Rating-Bänder gelten für sie nicht (rating/1000-Tiebreak). Ein Alt-Test wurde mit Begründung gedreht (User-Regel schlägt alte Erwartung).

### Patterns ergänzt / verändert
- Drei Adoptionen im neuen Feature (Abbruch-Disziplin, diagnose-feld-statt-raten, ea-grenz-fallback-ketten) — vom Implementer als pattern_discovered gemeldet, Belege im Code.

### Shared-Items
- Keine.

### PO-Entscheidungen
- 2 Validator-PARTIALs vor Publish geschlossen (#69 responseOk-Verteilkette, #76 Throw-Beobachtbarkeit), 1 PARTIAL bei #66 (tote DP-Dimension + Filter-Interaktions-Test) ebenso; 3 Mini-Verifikationen durch Main (#70, #68, #73).
- 4 direkte Hotfixes auf main (eiserner Arbeitsablauf, alle 5 Gates je Push) — Live-Betrieb hatte Vorrang vor Ticket-Zeremonie.
- Stufenplan-Gate-Überstimmung (s.o.) als dokumentierte Ausnahme; Vision-Doc angepasst.
- Eskalationen: 0. Iteration lief komplett während Rasmus spielte bzw. schlief.

## Iteration 10 — 2026-08-16

## Iteration 10 — 16.08.2026 (Nacht-Nachspiel: Gate-Abdeckungs-Audit)

### Score-Bewegung
- rating-solver 93→94: der iter9-Abzug wurde mit genau der geforderten Gegenmaßnahme beantwortet — ein systematisches Audit aller 14 Solver-relevanten Produktregeln (Regel-Gate-Matrix mit file:line-Gates und Test-Referenzen). Ergebnis: **0 echte Gate-Lücken** (der TOTW-Drift war ein Einzelfall, kein Muster; die Ausnahme ist an allen 4 Berührungspunkten konsistent), 4 Test-Lücken in #78 geschlossen (arithmetisch hergeleitete Erwartungswerte, keine Defekte gefunden). Tests 775 → 784.
- Der letzte Punkt zum Deckel bleibt ehrlich offen: die Matrix ist ein manuell gepflegtes Doc-Artefakt — nichts erzwingt ihre Pflege beim nächsten Regel-Zusatz (als Seed notiert: Zähl-Kopplungs-Meta-Test, nur bei Bedarf).

### Methodische Erkenntnisse
- Ein benannter Score-Abzug mit benanntem Rückweg („Gate-Abdeckungs-Check wäre der Weg zurück") ist die produktivste Form von Kritik: die Iteration konnte den Weg exakt gehen und der Re-Scorer konnte exakt prüfen, ob er gegangen wurde.
- Ein Audit mit Ergebnis „0 Lücken" ist KEIN verschwendeter Aufwand: nach einem Live-Vorfall ist „der Drift war ein Einzelfall" nur durch systematische Prüfung belegbar — vorher war es Hoffnung.
- Die Regel-Gate-Matrix ist als pflegbares Artefakt im Gap-Report verankert: jede künftige Produktregel bekommt dort Zeile + Gates + Tests. Ihre Pflege hängt an Disziplin — bewusst nicht sofort mit einem Meta-Test erzwungen (erst bei realem Bedarf).

### Patterns ergänzt / verändert
- Keine.

### Shared-Items
- Keine.

### PO-Entscheidungen
- Test-only-Ticket Main-verifiziert (Diff nur solver-test.js + Matrix-Doc).
- Offen und extern blockiert: pack-opener-Live-Verifikation (Rasmus' erster echter Lauf), APK-1.8.0-Installation.
- Eskalationen: 0.
