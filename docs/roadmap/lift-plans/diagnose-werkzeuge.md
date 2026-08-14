---
feature: diagnose-werkzeuge
iteration: 0
score_current:
  RA: 58
score_target:                              # M3 (Ambitions-Regel): 58 + (85-58)*0.7 = 76.9 -> 77
  RA: 77
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
  - app/java/com/sbctools/browser/MainActivity.java
  - app/guard-test.js
patterns_required:                         # formal auf diagnose-werkzeuge anwendbare gute Patterns
                                           # (applies_to_features enthaelt diagnose-werkzeuge) - kein
                                           # PK-Ziel diese Iteration (pk_files_to_cite: []), sie leiten
                                           # die Aktionen inhaltlich an
  - diagnose-feld-statt-raten
  - warum-kommentare-mit-live-belegen
pk_files_to_cite: []
citation_only: false
shared_items_required:
  - fehler-sichtbarkeit-diagerror
priority: P3-deferred                      # Sigma Gain ~20.5 < 100 -> Heuristik-Default, keine
                                           # sicherheitsrelevante Sonderlage wie bei spieler-pool
                                           # (dort wurde readPaletoolsLocks SELBST gefixt; hier liefert
                                           # dieses Feature nur den Helfer-Kern, keinen Call-Site-Fix
                                           # an einer NIEMALS-verbauen-Stelle).
effort: S                                  # Override: phase_sequence hat 5 Glieder (fixer 5-Phasen-
                                           # Workflow, gilt fuer JEDES pittools-Feature identisch aus
                                           # CLAUDE.md), sagt hier nichts ueber den Umfang. Alle vier
                                           # Aktionen sind additiv/klein (1 Feld befuellen, 1 Zeile
                                           # loeschen, 1 Deklarationsblock erweitern, 1 neue Helfer-
                                           # Funktion, 1 neue Testdatei) - kein Umbau bestehender Logik.
analyzed_at: '2026-08-15'
---

# Lift-Plan — Diagnose-Werkzeuge (Script-Report & App-Log)

**Ticket-Titel-Vorschlag (ADR #73):** Diagnose-Report: tote Felder beheben, Schema und Fehler-Helfer nachrüsten

## Marschroute

Vier additive, unabhängig abnehmbare RA-Aktionen entlang `core → diagnose →
tests → docs → release`. `core` bleibt diese Iteration **leer** — anders als
bei den meisten anderen pittools-Features IST der Diagnose-Report selbst die
Kern-Code-Geographie dieses Features (`buildDiagReport`, `onDiagClick`,
`diagError`, `STATE.diag.*`, `ea-fc-sbc-optimizer.user.js:3701-4008` und
`:105-122`); alle vier inhaltlichen Änderungen landen deshalb konsequent in
`diagnose`.

Keine der vier Aktionen fasst Solver-, Netz- oder Submit-Logik an — reine
Beobachtbarkeits-/SSOT-Arbeit am Report selbst plus eine neue, isolierte
App-Testdatei. Der eiserne Arbeitsablauf gilt trotzdem voll: `node --check`,
`node solver-test.js` (aktuell 180/180 grün) vor und nach jeder Aktion,
Versionsbump vor Push.

Reihenfolge:

1. **`diagnose` — `uiScan` befüllen** (statt zu entfernen — Report-Format-
   Kontinuität ist laut Gap-Report bereits entschieden, siehe Risiken).
2. **`diagnose` — Duplikat-Key `rareConstraints` entfernen**, als eigener,
   kleiner Commit.
3. **`diagnose` — `STATE.diag`-Schema zentralisieren**, bewusst als
   SEPARATER, dritter Commit (nicht mit 1/2 zusammengelegt — CLAUDE.md
   „kleine Diffs", auch vom Gap-Report ausdrücklich so empfohlen), weil dies
   der Diff mit dem größten Umfang ist.
4. **`diagnose` — `reportError(label, e)`-Helferkern liefern** (SI
   `fehler-sichtbarkeit-diagerror`): dieses Feature besitzt `diagError()` und
   `STATE.diag` bereits in seiner Code-Geographie und liefert deshalb den
   HELFER-KERN, der `warn()` + `diagError()` in einem Aufruf bündelt. Die
   sieben im Gap-Report benannten Call-Sites (`fetchStorageViaHttp`,
   `fetchUnassignedViaHttp`, `fetchUnassignedViaServices`,
   `fetchStorageViaServices`, `readPaletoolsLocks`,
   `syncSbcWithOpenChallenge`, `onBatchPlanClick`) liegen NICHT in der
   Code-Geographie von `diagnose-werkzeuge`, sondern in der von
   `spieler-pool`, `ea-app-anbindung`, `team-eintragen` bzw. `batch-modus` —
   drei von vier dieser Features haben in ihren eigenen, bereits auf Platte
   liegenden Iteration-0-Lift-Plänen einen Teil dieser Stellen schon additiv
   selbst gefixt (`spieler-pool.md` Aktion 1: `:1334`/`:1346`/`:907`;
   `ea-app-anbindung.md` Aktion 1: `:1100`/`:1118`/`:762`; `team-eintragen.md`
   Aktion 3: `:762` erneut). Dieser Plan plant deshalb **keine** dieser
   Call-Site-Fixes erneut (keine Doppel-Planung derselben Zeilen), sondern
   ausschließlich den gemeinsamen Helfer, den alle vier Features in einer
   Folge-Iteration konsumieren können.
5. **`tests` — App-Log-Ringpuffer testen** (Literal-Extraktion nach
   `guard-test.js`-Vorbild, reine neue Testdatei `app/log-test.js`, **kein
   Build nötig**: die Aktion ändert `MainActivity.java` an keiner Stelle,
   sie liest die bestehende Quelle nur textuell aus — anders als jede
   Aktion, die den Java-Produktivcode selbst ändert und Rasmus' Build
   braucht).
6. **`docs`** — `docs/LEARNINGS.md` um einen Abschnitt zum neuen
   `reportError`-Helfer und dem `STATE.diag`-Schema ergänzen (Q7,
   IST-Zustand, kein „vorher/nachher").
7. **`release`** — Versionsbump (`@version` + `const VERSION`),
   `node --check` + `node solver-test.js` grün, Push auf `main`.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`uiScan` befüllen statt entfernen** (Pfad:
   `ea-fc-sbc-optimizer.user.js:3758` liest bereits `STATE.diag.uiScan ||
   null`; neue Zuweisungsstelle direkt am Kopf von `onDiagClick()`,
   `:3991`): beim Auslösen des Diagnose-Klicks ein leichtgewichtiges
   DOM-Snapshot-Objekt setzen — `inSbcView()`-Rückgabewert
   (`ea-fc-sbc-optimizer.user.js:3564`) plus Panel-/FAB-Sichtbarkeit
   (`ui.fab`/`ui.panel`, analog zu den bereits vorhandenen
   `fabVisible`/`panelOpen`-Feldern im `launcher`-Sub-Objekt,
   `:3893-3896`) — bevor `buildDiagReport()` aufgerufen wird. Rein additiv,
   kein bestehendes Verhalten ändert sich. **Erwarteter Gain: +3 bis +4 Pt**
   (Kriterium „Beobachtbarkeit" — behebt den einzigen im Report dauerhaft
   toten Feld-Fund).

2. **Duplikat-Key `rareConstraints` entfernen + Dedupe-Regressionstest**
   (Pfad: `ea-fc-sbc-optimizer.user.js:3927-3928`, verifiziert: beide Zeilen
   lesen identisch `STATE.sbc.rareConstraints || []`, das Feld selbst ist
   real und einzeln geführt — `STATE.sbc.rareConstraints` wird an genau
   einer Stelle geschrieben (`:490`, `:695`), `rarityConstraints` ist ein
   eigenständiges, unabhängiges Feld daneben; die Dopplung ist reiner
   Copy-Paste-Rest, kein zweiter Datenfluss unter gleichem Namen — Q3
   erledigt): die falsch eingerückte Zeile `:3927` entfernen, `:3928`
   bleibt. Zusätzlich in `solver-test.js` einen neuen statischen Testblock,
   der den Quelltext zwischen `function buildDiagReport` und dessen
   schließendem `}` slice't und per Regex prüft, dass im `sbc:
   {...}`-Objekt-Literal kein Property-Name doppelt vorkommt (verhindert
   Wiederholung derselben Fehlerklasse an dieser oder späteren
   Report-Erweiterungen). **Erwarteter Gain: +2 bis +3 Pt** (SSOT +
   Testbarkeit).

3. **`STATE.diag`-Schema zentralisieren** (Pfad:
   `ea-fc-sbc-optimizer.user.js:105-112`): die Deklaration von aktuell 6 auf
   alle 18 tatsächlich verwendeten Felder erweitern (per Volltextsuche
   verifiziert: `lastSquadPutBody`, `staleRecover`, `locks`, `clubLoad`,
   `submitVia`, `lastEligible`, `refreshLog`, `submitCandidates`,
   `submitChallengeVia`, `lastTap`, `batchSteps`, `lastTeam` — plus `uiScan`
   aus Aktion 1), jedes mit Kurzzweck-Kommentar analog zum bestehenden Stil
   (`lastUtasPaths: [], // letzte utas-Pfade`). Dazu ein neuer statischer
   Test in `solver-test.js`: (a) extrahiert die Feldnamen aus dem
   `diag: {...}`-Objekt-Literal der `STATE`-Deklaration, (b) extrahiert alle
   `STATE.diag.<name>`-LESE-Vorkommen aus dem `buildDiagReport()`-Funktions-
   körper, (c) prüft, dass jeder gelesene Name in der deklarierten Liste
   steht, (d) prüft zusätzlich (symmetrisch), dass jeder deklarierte Name
   an mindestens einer Stelle im gesamten File auch zugewiesen wird
   (`STATE.diag.<name>\s*=`). Das ist genau der Test, der den `uiScan`-Fund
   aus Aktion 1 künftig automatisch aufgedeckt hätte, und verhindert das
   Wiederauftreten derselben Fehlerklasse bei jedem künftigen neuen Feld.
   Bewusst als **eigener, separater Commit** (größter Diff dieses Plans,
   Q1/Q2 „kleine Diffs"). **Erwarteter Gain: +5 bis +8 Pt** (größter
   Einzelhebel: SSOT + Beobachtbarkeit gemeinsam, laut Gap-Report Wurzel-
   ursache hinter den Mängeln 1 und 3).

4. **`reportError(label, e)`-Helferkern liefern (SI
   `fehler-sichtbarkeit-diagerror`)** (Pfad:
   `ea-fc-sbc-optimizer.user.js:116-122`, direkt neben der bestehenden
   `diagError`-Definition): neue Funktion, die das an mindestens 10
   Call-Sites über 5 Features wortgleich wiederholte Paar `warn(label + ':',
   e && e.message || e); diagError(label + ': ' + (e && e.message || e));`
   in einem Aufruf bündelt — SSOT für die „dieser Fehler muss in den
   Report"-Entscheidung (Q5, Wurzelursache laut
   `patterns/bad/fehler-unsichtbar-verschluckt.md`, Abschnitt
   „Beziehungen"). Diese Iteration **migriert keine bestehende Call-Site**
   auf den neuen Helfer (reine Neu-Einführung, additiv, kein Verhaltens-
   Umbau an fremdem Feature-Code) — die vier Konsumenten-Features
   (`spieler-pool`, `ea-app-anbindung`, `android-app-wrapper`,
   `batch-modus`) migrieren ihre jeweiligen Catch-Blöcke in einer eigenen
   Folge-Iteration, sobald der Helfer gemergt ist (siehe
   Shared-Item-Bedarf). Neuer Testblock in `solver-test.js`: extrahiert
   `reportError` per Marker-Slice, ruft sie mit einem Fake-Error auf, prüft
   per `console.warn`-Spy, dass `warn()` ausgelöst wurde, UND dass
   `STATE.diag.lastErrors` den erwarteten, gekürzten String enthält.
   **Erwarteter Gain: +3 bis +5 Pt** (Kriterium „Dokumentierte Begründung"
   + Vorbereitung der Testbarkeit für die künftige Konsolidierung; kein
   PK-Gain, da PK für dieses Feature kein Ziel ist).

5. **App-Log-Ringpuffer testen** (Pfad: neue Datei `app/log-test.js`,
   referenziert `app/java/com/sbctools/browser/MainActivity.java:89-125`
   — `LOG_MAX=400`, `LOG_LINE_MAX=600`, `addLog()`, `buildLogReport()` —
   **keine Änderung an `MainActivity.java` selbst, daher kein
   Build/Signatur-Schritt nötig**): nach dem Vorbild von `app/guard-test.js`
   (Literal-Extraktion aus der Java-Quelle statt Neuschreiben) baut der
   neue Test:
   - `LOG_MAX`/`LOG_LINE_MAX` per Regex direkt aus der Java-Quelle
     extrahieren (SSOT — der Test hält keine eigene `400`/`600`-Kopie, die
     driften könnte, Q4/Q5, analog zur bereits im Projekt dokumentierten
     Rating-Kosten-Tabellen-Drift in `patterns/bad/wissens-duplikate-ohne-
     ssot.md`).
   - eine reine JS-Portierung der Ringpuffer-Logik (Zeilen-Kürzung bei
     Überschreiten von `LOG_LINE_MAX` inkl. „…[gekürzt]"-Suffix,
     FIFO-Eviction bei Überschreiten von `LOG_MAX`), parametrisiert mit den
     extrahierten Konstanten, gegen Fixtures ausführen (401 Zeilen
     schreiben → erste ist evicted; eine 700-Zeichen-Zeile → auf 600 + Suffix
     gekürzt).
   - zusätzlich einen statischen Regex-Check auf den Funktionskörper von
     `buildLogReport()`, dass die erwarteten Kopfdaten-Label
     („App-Version", „Android", „Optimizer", „PaleTools",
     „PaleTools-Status") im Quelltext vorkommen — verhindert, dass ein
     künftiger Refactor eines dieser Kopf-Felder unbemerkt entfernt.
   **Erwarteter Gain: +3 bis +5 Pt** (Testbarkeits-Rubrik geht für die
   App-Seite dieses Features von 0 % auf eine erste Abdeckung).

**Erwarteter Gesamt-Gain: ~+20 Pt RA** (58 → ~78, Summe der Mittelwerte
3.5+2.5+6.5+4+4 = 20.5; komfortabel über dem M3-Ziel 77 und über der
90-%-Miss-Risk-Schwelle von +17.1).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core     | — (leer diese Iteration: die gesamte Code-Geographie dieses Features IST bereits die Diagnose-Ebene, kein separater „Business-Logik"-Layer betroffen) |
| diagnose | Aktion 1 (`uiScan` befüllen), Aktion 2 (Duplikat-Key entfernen), Aktion 3 (`STATE.diag`-Schema, eigener Commit), Aktion 4 (`reportError`-Helferkern) |
| tests    | Regressionstest zu Aktion 2 (Dedupe-Scan), Validierungstest zu Aktion 3 (Schema-Konsistenz), Testblock zu Aktion 4 (`reportError`), Aktion 5 (`app/log-test.js`) |
| docs     | `docs/LEARNINGS.md`-Abschnitt zu `reportError` + `STATE.diag`-Schema (Q7, IST-Zustand) |
| release  | `@version`/`const VERSION` bumpen, `node --check` + `node solver-test.js` (180/180 inkl. neuer Blöcke) final, Push auf `main` |

## Shared-Item-Bedarf

Ein SI-Kandidat, Details und `rationale` im Sidecar
`diagnose-werkzeuge.shared-items.json`:

- **`fehler-sichtbarkeit-diagerror`**: dieses Feature ist der **Lieferant**
  des Helfer-Kerns (Aktion 4), nicht bloß Konsument — `diagError()` und
  `STATE.diag` liegen in seiner eigenen Code-Geographie. Die vier anderen
  Features, die laut `patterns/bad/fehler-unsichtbar-verschluckt.md`
  (`applies_to_features`) denselben Antipattern an ihren jeweiligen
  Call-Sites zeigen (`spieler-pool`, `ea-app-anbindung`,
  `android-app-wrapper`, `batch-modus`), sind die Konsumenten einer
  Folge-Iteration, die ihre Catch-Blöcke auf `reportError(...)` umstellt.
  Drei davon (`spieler-pool`, `ea-app-anbindung`, `team-eintragen`) haben
  in dieser Iteration ihre konkreten Fehlerpfade bereits eigenständig
  additiv mit `warn()`+`diagError()` (nicht dem neuen Helfer) geschlossen —
  das bleibt bestehen und wird durch den neuen Helfer nicht ungültig,
  sondern in einer Folge-Iteration konsolidierbar.

## Risiken / Edge-Cases

- **`uiScan`/`launcher`-Überlappung (Mid-Iter-Beobachtung für den
  Implementer):** das bereits bestehende `launcher`-Sub-Objekt in
  `buildDiagReport()` (`:3821-3897`) berechnet `fabVisible`/`panelOpen`
  bereits live bei JEDEM Report-Aufruf. Ein `uiScan`, das inhaltlich
  identisch wäre, würde Q4 verletzen (zwei Felder, eine Tatsache). Der
  Implementer muss beim Umsetzen von Aktion 1 entweder eine echte
  semantische Differenzierung sicherstellen (z.B. `uiScan` als Snapshot
  „zum Zeitpunkt des letzten Klicks", `launcher` als „zum Zeitpunkt des
  Report-Baus" — bei mehreren Report-Aufrufen zwischen zwei Klicks
  unterscheidbar) oder, falls keine sinnvolle Differenzierung entsteht,
  einen `aborted-quality-violation`-Befund mit Verweis auf dieses Risiko
  melden statt eine Bedeutungslose Kopie zu bauen.
- **Report-Format-Kontinuität (aus dem Gap-Report übernommen, hier
  bindend):** `uiScan` NICHT entfernen oder umbenennen — Rasmus vergleicht
  Reports per Copy-Paste über die Zeit, und
  `patterns/bad/fehler-unsichtbar-verschluckt.md` zitiert den Feldnamen
  bereits wörtlich. Jede Änderung an `buildDiagReport()` bleibt additiv.
- **Rareflag-Constraint-Semantik bereits verifiziert (kein offenes Risiko
  mehr):** `STATE.sbc.rareConstraints` wird an genau einer Stelle
  geschrieben (`:490`, `:695`) und ist ein eigenständiges Feld neben
  `rarityConstraints` — die Dedupe in Aktion 2 verliert keine zweite
  Datenquelle.
- **Cross-Feature-Überschneidung bei den 7 Fehlerpfaden ist bewusst NICHT
  Teil dieses Plans:** drei der vier anderen Konsumenten-Features
  (`spieler-pool`, `ea-app-anbindung`, `team-eintragen`) haben in ihren
  eigenen, bereits vorliegenden Iteration-0-Lift-Plänen Teile derselben
  Call-Sites bereits geplant/gefixt — dieser Plan dupliziert das nicht.
  `onBatchPlanClick` (`:4798ff`, Catch nahe `:4831-4833`) ist laut aktuell
  vorliegendem `batch-modus.md` NOCH NICHT abgedeckt — das bleibt eine
  offene Lücke für eine künftige `batch-modus`-Iteration, die den neuen
  `reportError`-Helfer dann direkt konsumieren kann, statt erneut
  `warn()`+`diagError()` von Hand zu duplizieren.
- **Zeilenangaben aus dem Gap-Report können leicht gedriftet sein:** die
  in diesem Plan zitierten Zeilennummern wurden gegen den aktuellen
  Dateistand neu verifiziert (`:105-122`, `:3701-3990`, `:3927-3928`,
  `:3991`, App-Seite `:89-125`); die sieben Fehlerpfad-Zeilen in anderen
  Features wurden NICHT neu verifiziert, da dieser Plan sie nicht editiert
  — die Verifikation obliegt den jeweiligen Feature-Lift-Plänen.
- **Testinfrastruktur ohne Gradle/Keystore-Berührung:** `app/log-test.js`
  (Aktion 5) darf keinen APK-Build/Signaturpfad anstoßen — rein
  quelltextbasiert wie `guard-test.js`, `app/build.sh` bleibt unberührt.
- **Voller eiserner Arbeitsablauf auch für „nur Diagnose"-Änderungen:**
  jede der vier Userscript-Aktionen löst `node --check`, vollen
  `solver-test.js`-Lauf und einen Versionsbump aus — jeder Push auf `main`
  ist sofort Deployment auf beide Handys (CLAUDE.md).
- **Mid-Iter-G-Vermutung:** sollte beim Bau von Aktion 4 auffallen, dass
  eine der vier Konsumenten-Iterationen (`spieler-pool`,
  `ea-app-anbindung`, `batch-modus`) noch im selben Zyklus läuft, ist ein
  vorgezogenes Mid-Iter-SI-Merge denkbar (Main entscheidet) — kein Blocker
  für diesen Plan, da Aktion 4 auch ohne sofortige Konsumenten-Migration
  eigenständig wertvoll ist (Helferkern existiert, wird getestet).

## Lift-Plan-Pre-Validation (M2)

Dimension RA ist `manual_rubric` (kein `pattern_adoption`-Adapter) —
`pk_files_to_cite` bleibt leer, `citation_only: false` (echte
Code-/Test-Änderungen, keine reine Beleg-Registrierung). `plan estimate
--feature=diagnose-werkzeuge` prüft daher nur `score_target.RA (77) ≤
min(structural_max=85, achievable_ceiling)` sowie die Abwesenheit von
Targets auf nicht-fokussierten Dimensionen (FOCUSED_DIMENSIONS ist leer,
keine Einschränkung). Erwarteter RA-Endwert aus der Summe der
Aktions-Mittelwerte (3.5+2.5+6.5+4+4 = 20.5) auf `score_current.RA=58`
ergibt ~78.5, deutlich über der 90-%-Miss-Risk-Schwelle von
`77 × 0.9 = 69.3` bzw. dem geforderten Gain `+17.1`.
