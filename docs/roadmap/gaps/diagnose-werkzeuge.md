---
feature: diagnose-werkzeuge
analyzed_at: 2026-08-14
iteration: 0
regression: false
score_current:
  RA: 58
score_target:
  RA: 72
---

# Gap-Report — Diagnose-Werkzeuge (Script-Report & App-Log)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 58 / 85 (structural_max)
**Schwellwert:** 59.5 (structural_max × 0.7)
**Status:** partial
**Begründung:** Der `audit-evaluator` bewertet beide Kanäle (Script-Report,
Android-App-Log) strukturell solide und ungewöhnlich stark WARUM-dokumentiert
(LEARNINGS-Verweise, Live-Beleg-Kommentare — siehe Pattern
`warum-kommentare-mit-live-belegen`). Der Wert bleibt trotzdem knapp unter der
Schwelle, weil der Kern-Artefakt (`buildDiagReport()`) drei verifizierte
Defekte enthält, die genau die Rubrik-Punkte „Beobachtbarkeit" und „SSOT"
treffen (kein Schema für `STATE.diag`, ein permanent totes Report-Feld, ein
doppelt deklarierter Objekt-Key), und weil die App-seitige Log-Infrastruktur
(`addLog`/`buildLogReport`/`onConsoleMessage`) komplett ohne Testabdeckung ist
— `app/guard-test.js` prüft ausschließlich den PaleTools-Wächter, keine Zeile
davon berührt den Log-Ringpuffer.

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **Totes Report-Feld `uiScan`:** `ea-fc-sbc-optimizer.user.js:3758` liest
   `STATE.diag.uiScan || null` in `buildDiagReport()`. Im gesamten File gibt es
   keine einzige Zuweisung von `STATE.diag.uiScan` (verifiziert per
   Volltextsuche) — das Feld liefert im kopierten Report dauerhaft `null`,
   ohne dass irgendwo ein Fehler auftritt. Direkter Verstoß gegen die
   Beobachtbarkeits-Rubrik: ein Feld täuscht Sichtbarkeit vor, die nicht
   existiert (Pattern-Beleg: `patterns/bad/wissens-duplikate-ohne-ssot.md`,
   Abschnitt „Schema dupliziert durch Abwesenheit einer Schema-Quelle").
2. **Doppelt deklarierter Key `rareConstraints`:** `ea-fc-sbc-optimizer.user.js:3927-3928`
   deklariert `rareConstraints: STATE.sbc.rareConstraints || []` zweimal
   hintereinander im `sbc`-Teilobjekt des Reports (Zeile 3927 falsch
   eingerückt, Zeile 3928 korrekt) — ein nicht entfernter Copy-Paste-Rest.
   Zur Laufzeit harmlos (letzter Wert gewinnt), aber ein direktes Symptom
   dafür, dass niemand die Gesamtform von `buildDiagReport()` gegenprüft; bei
   zwei tatsächlich unterschiedlich gemeinten Feldern wäre eines davon
   still verloren gegangen.
3. **Kein Schema für `STATE.diag`:** `ea-fc-sbc-optimizer.user.js:105-112`
   deklariert nur 6 Felder (`fetchSeen`, `xhrSeen`, `utasSeen`,
   `lastUtasPaths`, `lastErrors`, `evoExcluded`); mindestens 15 weitere
   Felder (`lastSquadPutBody`, `staleRecover`, `locks`, `clubLoad`,
   `submitVia`, `lastEligible`, `refreshLog`, `submitCandidates`,
   `submitChallengeVia`, `lastTap`, `batchSteps`, `lastTeam`, u.a.) entstehen
   ad-hoc über ~5000 Zeilen verteilt per Zuweisung, ohne zentrale
   Schema-Stelle. `buildDiagReport()` muss jedes Feld einzeln von Hand
   nachziehen — der `uiScan`-Defekt (Mangel 1) und der bereits im Code
   dokumentierte `batchSteps`-Vorfall aus v4.18.0
   (`ea-fc-sbc-optimizer.user.js:3763-3764`: „in v4.18.0 fehlte das Feld im
   Report, mein Fehler") sind beides Symptome derselben Wurzelursache
   (Q5/SSOT, siehe `patterns/aspects/aspect-diagnose.md`, Abschnitt „Diag-
   Namespace ohne Schema/SSOT").
4. **Fehlende `diagError`-Aufrufe an eigenen Fehlerpfaden trotz vorhandener
   Infrastruktur** (Antipattern `patterns/bad/fehler-unsichtbar-verschluckt.md`):
   `fetchStorageViaHttp` (`:1346`), `fetchUnassignedViaHttp` (`:1334`),
   `fetchUnassignedViaServices` (`:1100`), `fetchStorageViaServices` (`:1118`),
   `readPaletoolsLocks` (`:907` — sicherheitsrelevant wegen der Regel
   „gesperrte Karten NIEMALS verbauen"), `syncSbcWithOpenChallenge` (`:762`)
   und `onBatchPlanClick` (`:4831-4833`) rufen im Catch nur `warn()`, obwohl
   die strukturell identische Nachbarstelle `onBatchRunClick`
   (`:4957-4960`) bei gleichem Fehlerbild zusätzlich `diagError(...)`
   aufruft. Diese Fehler erreichen Rasmus am Gerät (keine DevTools) faktisch
   nie — direkter Abzug auf der Beobachtbarkeits-Rubrik.
5. **Keine Testabdeckung der Android-Log-Infrastruktur:** `app/guard-test.js`
   extrahiert und prüft ausschließlich den PaleTools-Wächter-Block aus
   `MainActivity.java`. `addLog`/`buildLogReport`/`onConsoleMessage`
   (`app/java/com/sbctools/browser/MainActivity.java:93-125` und `:693-703`)
   — inklusive der Ringpuffer-Grenzen `LOG_MAX=400`/`LOG_LINE_MAX=600` — haben
   keinen einzigen Testfall (verifiziert: `addLog`/`buildLogReport` kommen in
   keiner `.js`-Testdatei unter `app/` vor). Testbarkeits-Rubrik: 0 % Abdeckung
   auf der App-Seite des Features, während die Script-Seite über
   `solver-test.js` zumindest indirekt mitläuft.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`uiScan` befüllen statt entfernen:** Laut Arbeitsauftrag gilt für den
   Report-Output dieselbe „keine Regression"-Leitplanke wie fürs übrige
   Produkt — bestehende Feldnamen dürfen nicht verschwinden, weil Rasmus
   vergangene und künftige Reports per Copy-Paste vergleicht und Analysen auf
   Feldnamen verweisen (`fehler-unsichtbar-verschluckt.md` referenziert
   `uiScan` bereits namentlich). **Entscheidung: befüllen, nicht entfernen.**
   Konkret: `STATE.diag.uiScan` an eine echte, leichtgewichtige DOM-Momentaufnahme
   binden, analog zu den bereits vorhandenen `hubScan`/`launcher`-Sub-Objekten
   in `buildDiagReport()` (`ea-fc-sbc-optimizer.user.js:3781-3898`) — z.B.
   Panel-/FAB-Sichtbarkeit plus `inSbcView()`-Status zum Zeitpunkt des letzten
   Klicks, gesetzt an der Stelle, an der `onDiagClick` ausgelöst wird
   (`:3991`). Pfad: `ea-fc-sbc-optimizer.user.js:3758` + neue Zuweisungsstelle
   nahe `onDiagClick`. **Gain: +3–4 Pt RA** (behebt einen der drei
   verifizierten Defekte, direkter Beobachtbarkeits-Gewinn).
2. **Duplikat-Key deduplizieren + Report-Form testen (Q5):** Zeile
   `ea-fc-sbc-optimizer.user.js:3927` entfernen (die falsch eingerückte,
   redundante Deklaration), Zeile 3928 bleibt. Zusätzlich einen kleinen
   Regressionstest in `solver-test.js` ergänzen, der `buildDiagReport()`
   über die vorhandene Marker-Extraktionstechnik (wie beim Solver) aufruft
   und prüft, dass das `sbc`-Objekt-Literal keine doppelt vorkommenden
   Property-Namen im Quelltext enthält (statischer Regex-Scan reicht, kein
   DOM nötig). Pfad: `ea-fc-sbc-optimizer.user.js:3927-3928`,
   `solver-test.js` (neue Testgruppe). **Gain: +2–3 Pt RA** (SSOT +
   Testbarkeit, verhindert Wiederholung derselben Fehlerklasse).
3. **`STATE.diag`-Schema zentralisieren:** Eine benannte Liste aller
   tatsächlich verwendeten `STATE.diag.*`-Felder (mit Kurzzweck als Kommentar)
   direkt bei der Deklaration ergänzen (`ea-fc-sbc-optimizer.user.js:105-112`),
   und `buildDiagReport()` (oder ein begleitender Test) gegen diese Liste
   validieren lassen, statt dass jedes neue Feld nur an der Zuweisungsstelle
   entsteht und in `buildDiagReport()` von Hand nachgezogen werden muss. Das
   ist der größte Einzelhebel, weil er die Wurzelursache hinter Mangel 1 und
   Mangel 3 gemeinsam adressiert. Pfad: `ea-fc-sbc-optimizer.user.js:105-112`
   und `:3727-3990`. **Gain: +5–8 Pt RA** — aber als separater, kleiner Diff
   umsetzen (CLAUDE.md „kleine Diffs"), nicht in einem Rutsch mit den anderen
   Fixes.
4. **`diagError` an den 7 named Fehlerpfaden nachrüsten:** An
   `fetchStorageViaHttp` (`:1346`), `fetchUnassignedViaHttp` (`:1334`),
   `fetchUnassignedViaServices` (`:1100`), `fetchStorageViaServices`
   (`:1118`), `readPaletoolsLocks` (`:907`), `syncSbcWithOpenChallenge`
   (`:762`) und `onBatchPlanClick` (`:4831-4833`) jeweils `diagError(...)`
   neben dem bestehenden `warn(...)` ergänzen — exakt das Muster, das
   `onBatchRunClick` (`:4957-4960`) bereits vorlebt. Rein additiv, ändert kein
   Verhalten (Q1/Q2-konformer Refactor). Pfad: siehe Zeilen oben. **Gain:
   +4–6 Pt RA** (schließt 7 Beobachtbarkeits-Lücken auf einmal, direkter
   Treffer auf die Rubrik-Zeile „Hat jedes bekannte Fehlerbild ein
   Diagnose-Feld?").
5. **Minimale Testabdeckung für die Android-Log-Infrastruktur:** Nach dem
   Vorbild von `app/guard-test.js` (Extraktion von Java-String-Literalen in
   ein Fake-DOM/VM) die reine Puffer-Logik von `addLog`
   (`MainActivity.java:93-102`: Zeilen-Kürzung auf `LOG_LINE_MAX=600`,
   Ring-Eviction bei `LOG_MAX=400`) und den Kopfaufbau von `buildLogReport`
   (`:104-125`) in einem neuen `app/log-test.js` deterministisch prüfen —
   ohne Gradle/Instrumentation, rein aus dem Java-Quelltext extrahiert oder
   als Portierung der reinen Logik nach Node. Pfad: neue Datei
   `app/log-test.js`, referenziert `MainActivity.java:93-125`. **Gain: +3–5
   Pt RA** (Testbarkeits-Rubrik geht von 0 % auf eine erste Abdeckung).

## Edge-Cases (mind. 1 — M1)

- **Report-Format-Kontinuität:** Jede Änderung an `buildDiagReport()` — auch
  ein reines Dedupe oder Befüllen eines bisher toten Feldes — muss additiv
  bleiben. Rasmus kopiert Reports direkt in den Chat und vergangene Analysen
  verweisen auf konkrete Feldnamen (z.B. `uiScan` wird in
  `patterns/bad/fehler-unsichtbar-verschluckt.md` bereits namentlich
  zitiert) — ein entferntes oder umbenanntes Feld bricht diese Referenzen
  stillschweigend. Deshalb ausdrücklich: `uiScan` NICHT entfernen, nur
  befüllen (siehe Lift-Aktion 1 und deren Begründung).
- **Voller eiserner Arbeitsablauf auch für „nur Diagnose"-Änderungen:** Fixes
  an `buildDiagReport()`/`STATE.diag` ändern kein SBC-Solver-Verhalten, lösen
  aber trotzdem `node --check`, `node solver-test.js` (aktuell 180/180 grün)
  und den Versionsbump aus — leicht zu vergessen, weil die Änderung „nur"
  Diagnosecode betrifft, aber jeder Push auf `main` ist laut CLAUDE.md sofort
  Deployment auf beide Handys.
- **Testinfrastruktur ohne Gradle/Keystore-Berührung:** Ein neuer Test für
  die Android-Log-Infrastruktur (Lift-Aktion 5) darf keinen echten
  APK-Build/Signaturpfad anstoßen — `app/build.sh` bricht bewusst ab, wenn
  der Rasmus-Keystore fehlt (der nicht im Repo liegt); der Test muss rein
  quelltextbasiert wie `guard-test.js` funktionieren.
- **Rareflag-Constraint-Semantik vor dem Dedupe klären:** Bevor Zeile 3927
  gelöscht wird, kurz verifizieren, dass `STATE.sbc` wirklich nur EIN
  `rareConstraints`-Feld führt und die Dopplung tatsächlich reiner
  Copy-Paste-Rest ist (Q3 — vollständige Analyse vor Aktion) und nicht zwei
  ursprünglich verschieden gemeinte Datenquellen unter gleichem Namen
  zusammengefallen sind.

## Lift-Empfehlung

Vorsichtig und additiv zuerst: RA liegt mit 58 knapp unter der Schwelle
(59.5) — schon die drei bereits verifizierten Kleindefekte (uiScan befüllen,
Duplikat-Key entfernen, die 7 fehlenden `diagError`-Aufrufe nachrüsten;
Lift-Aktionen 1, 2, 4) sollten für sich genommen über die Schwelle reichen,
sind einzeln klein und reine additive/no-behavior-change-Fixes im Sinne von
Q1/Q2. Das `STATE.diag`-Schema (Lift-Aktion 3) ist der größte Hebel, aber
auch der mit dem größten Diff — als eigener, separater Schritt vormerken
(ggf. Mid-Iter-SI, falls weitere Features denselben Diagnose-Namespace
mitbenutzen), nicht im selben Durchgang wie die Kleinfixes, um CLAUDE.md
„kleine Diffs" nicht zu verletzen. Die Android-Testlücke (Lift-Aktion 5)
kann parallel und unabhängig laufen, da sie eine reine Testdatei ohne
Produktivcode-Änderung ist.
