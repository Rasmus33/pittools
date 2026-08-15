---
feature: android-app-wrapper
iteration: 3
score_current:
  RA: 79
score_target:
  RA: 80
primary_paths:
  - app/build.sh
  - app/sdk-env.sh
  - app/compile-check.sh
  - app/guard-test.js
  - app/java/com/sbctools/browser/MainActivity.java
  - app/README.md
  - docs/LEARNINGS.md
patterns_required:
  - abbruch-disziplin
  - eingebetteten-code-exakt-testen
  - diagnose-feld-statt-raten
pk_files_to_cite:
  - app/compile-check.sh
  - app/sdk-env.sh
  - app/guard-test.js
citation_only: false
shared_items_required: []
priority: P3-deferred    # Heuristik: Sigma Gain (1+1+0.5+0.5=3) < 100 -> P3-deferred
effort: M                # Heuristik: len(phase_sequence) = 5 (core..release) -> Bracket 5-8 -> M
analyzed_at: '2026-08-15'
---

# Lift-Plan — Android-App (WebView-Wrapper mit Script-Injection)

## Marschroute

RA steht bei 79/80 (Schwelle 56, Status pass) — der Gap-Report (Iteration 3)
findet ausschließlich Test-/Tooling-Lücken, keine neuen Produktcode-Mängel:
Iteration 2 hat die Antipattern in `MainActivity.java` bereits geschlossen.
M3-Rechnung: `79 + (80−79) × 0,7 = 79,7` → aufgerundet auf `80` (den
strukturellen Deckel), weil der einzige verbleibende Punkt exakt das
Rubric-Kriterium „Testbarkeit" betrifft und keine neue Produktcode-Fläche
eröffnet, die neue Mängel in anderen Kriterien erzeugen könnte (Gap-Report,
Abschnitt „Lift-Empfehlung"). Beide Seeds sind reine Test-Infrastruktur:

1. **Compile-Gate ohne Keystore** — `app/compile-check.sh` (neu) führt nur
   SDK-Erkennung + `javac` aus, keine `d8`/`aapt2`/`zipalign`/`apksigner`-
   Schritte, kein `debug.keystore`-Zugriff. Die SDK-Erkennung wandert dafür
   aus `build.sh` in ein gemeinsames `app/sdk-env.sh` (Q4/Q5 — sonst driftet
   `build.sh`s Fallback-Logik unbemerkt von der des neuen Gates).
2. **Marker-basierte Wächter-Extraktion** — `// [PALE-GUARD-BEGIN]`/
   `// [PALE-GUARD-END]` um den PaleTools-Wächter in `MainActivity.java`,
   `extractGuard()` in `guard-test.js` sucht primär über die Marker, fällt
   auf die bestehenden Fragment-Literale zurück, solange beide Wege
   existieren — abgesichert durch einen Vollständigkeits- und einen
   Byte-Gleichheits-Test.

Reihenfolge folgt dem eisernen Arbeitsablauf: erst die Skript-/Kommentar-
Änderungen selbst (core), dabei sofort die Fehlermeldungen der neuen
Extraktionslogik klarziehen (diagnose), danach `app/guard-test.js` um die
neuen Checks erweitern und grün bekommen (tests), README + LEARNINGS auf den
neuen Ist-Stand bringen (docs), zuletzt bewusst OHNE `versionCode`/
`versionName`-Bump und OHNE neuen APK-Build committen/pushen (release) — die
einzige Java-Änderung sind zwei reine Zeilenkommentare, die der Compiler vor
der Bytecode-Erzeugung vollständig verwirft (Gap-Report, Edge-Case 3).

Alle vier Aktionen sind additiv: kein Eingriff in Fallback-Ketten,
Wächter-Timing-Kern oder Submit-Weg. Kein Mid-Iter-Shared-Item nötig (siehe
„Shared-Item-Bedarf").

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`app/sdk-env.sh` extrahieren + `app/compile-check.sh` neu (Aktion 1 aus
   dem Gap-Report).**
   - *Zielpfad(e):* `app/build.sh:8-26` (SDK-/build-tools-/Platform-
     Erkennung inkl. der beiden Echo-Zeilen), `app/build.sh:73-74`
     (`javac`-Aufruf); neu: `app/sdk-env.sh`, `app/compile-check.sh`.
   - *Schritte:*
     1. `app/build.sh:8-26` unverändert (keine Logikänderung, keine
        geänderten Variablennamen) in eine neue Datei `app/sdk-env.sh`
        verschieben. `build.sh` sourced diese Datei ab Zeile 8
        (`source "$(dirname "$0")/sdk-env.sh"`) statt die Logik selbst zu
        enthalten — dieselben Variablen (`$SDK`, `$BTV`, `$BT`, `$PLATV`,
        `$AJ`), dieselben Fehlermeldungen/Exit-Codes, `bt()` (Zeilen 28-40,
        Tool-Namen-Auflösung für `d8`/`aapt2`/`zipalign`/`apksigner`) bleibt
        in `build.sh`, weil `compile-check.sh` diese Tools nicht braucht.
     2. Neues `app/compile-check.sh`: `cd "$(dirname "$0")"`,
        `source ./sdk-env.sh`, danach NUR
        `javac --release 11 -encoding UTF-8 -classpath "$AJ" -d build/classes-check java/com/sbctools/browser/MainActivity.java`
        (eigenes Ausgabeverzeichnis `build/classes-check`, damit ein
        parallel laufendes `build.sh` seinen `build/`-Baum nicht verliert)
        + eine Erfolgsmeldung. Kein `-Werror` — deckungsgleich mit
        `build.sh`, das ebenfalls keins setzt (Edge-Case: die bereits heute
        live reproduzierte Deprecation-Warnung darf das neue Gate nicht
        strenger machen als den bestehenden Build).
     3. SDK fehlt: `sdk-env.sh` bricht hart ab (`exit 1`, unverändert aus
        `build.sh` übernommen) — bewusst KEIN stilles Überspringen. Ein
        Implementer-Worktree auf demselben Rechner findet dasselbe SDK vor
        wie `build.sh`; ein stilles Skip wäre dieselbe Antipattern-Klasse
        wie die bereits geschlossenen stillen Netz-/Cache-Skips
        (`aspect-android-app.md:105-128`).
   - *Test-Absicherung:* `bash app/compile-check.sh` läuft ohne Keystore
     lokal in ~1s durch (live reproduziert laut Gap-Report); zusätzlich
     `bash app/build.sh` bleibt nach der Extraktion komplett grün
     (Regressionsbeleg: die verschobene SDK-Erkennung darf sich nicht
     verhalten). Kein neuer Node-Test nötig — `guard-test.js`/`log-test.js`
     prüfen ausschließlich `MainActivity.java`-Inhalt, kein Shell-Verhalten;
     die Ausführung selbst ist der Test, analog zum bisherigen,
     unautomatisierten Status von `build.sh` (kein Test-Harness für Shell im
     Repo, keine neue Baustelle über die zwei benannten Seeds hinaus
     eröffnen).
   - *Risiken/Rollback:* Regressionsrisiko liegt an `build.sh` selbst (voller
     Signier-Pfad, kritisch) — Rollback: `sdk-env.sh`-Extraktion isoliert in
     einem eigenen Phasen-Commit, bei Fehlschlag NUR diesen Commit revertieren
     (Original-Inhalt aus Git-Historie), `compile-check.sh` und
     `guard-test.js`-Änderungen sind unabhängig davon lauffähig.
   - **Erwarteter Gain: +1 Pt RA** (Testbarkeit — Compile-Gate erstmals ohne
     volle Signier-Pipeline reproduzierbar).

2. **Marker `// [PALE-GUARD-BEGIN]`/`// [PALE-GUARD-END]` + `extractGuard()`
   primär über Marker (Aktion 2 aus dem Gap-Report).**
   - *Zielpfad(e):* `MainActivity.java:348-425` (Wächter-Aufruf), `guard-test.js:46-58`
     (`extractGuard()`).
   - *Schritte:*
     1. `// [PALE-GUARD-BEGIN]` als eigene Zeile unmittelbar vor
        `MainActivity.java:349` (`web.evaluateJavascript("(function(){" + ...`)
        einfügen, `// [PALE-GUARD-END]` unmittelbar nach `:424`
        (`"})()", null);`) — reine Java-Zeilenkommentare, keine
        `.class`/`.dex`-Wirkung.
     2. `extractGuard()`: zuerst `src.indexOf('[PALE-GUARD-BEGIN]')` /
        `'[PALE-GUARD-END]'` versuchen; nur wenn einer der beiden Marker
        fehlt, Fallback auf die bestehenden Fragment-Literale
        (`"(function(){" +` / `"})()", null);`). Beide Pfade liefern
        weiterhin den rohen Block-String, der unverändert durch
        `literalsFromJavaBlock()`/`unescapeJava()` läuft — die Marker-
        Kommentarzeilen selbst enthalten keine Anführungszeichen und werden
        vom Pro-Zeile-Kommentar-Strip vollständig verworfen, daher liefern
        Marker- und Literal-Pfad identischen Output (Grundlage für Aktion 4).
     3. Vollständigkeits-Check direkt nach der Extraktion: das Ergebnis muss
        die bekannten Anker (`'HARD='`, `'exec('`, `'miss()'`,
        `'__pt_status'`) enthalten — schließt eine STILLE Verkürzung durch
        verschobene/entfernte Marker oder Literale aus (Mangel 3 im
        Gap-Report).
   - *Test-Absicherung:* alle bestehenden Tests 1-13 in `guard-test.js`
     laufen unverändert gegen das `extractGuard()`-Ergebnis weiter (Regressions-
     beleg: identisches Extrakt vor/nach der Umstellung, weil Marker- und
     Literal-Pfad denselben String liefern).
   - *Risiken/Rollback:* Marker-Zeilen müssen exakt an den zwei bestehenden
     Fragment-Ankern kleben (direkt vor `:349` / direkt nach `:424`) — sonst
     schließen Marker- und Literal-Pfad nicht mehr dieselbe Codespanne ein.
     Rollback: beide Marker-Zeilen entfernen, `extractGuard()` fällt automatisch
     auf den reinen Literal-Pfad zurück (Fallback bleibt bestehen, solange
     Aktion 4 nicht den Literal-Pfad entfernt).
   - **Erwarteter Gain: +1 Pt RA** (Testbarkeit — schließt die stille
     Verkürzungs-Lücke aus Mangel 3).

3. **Diagnose-Ergänzung zu Aktion 2: klare Fehlermeldung bei
   Marker-/Literal-Mismatch.**
   - *Zielpfad(e):* `guard-test.js` → `extractGuard()`.
   - *Schritte:* Schlägt weder der Marker- noch der Literal-Pfad vollständig
     an (keiner der beiden liefert einen Block, der alle vier Anker aus
     Aktion 2 enthält), wirft `extractGuard()` eine Fehlermeldung, die BEIDE
     Suchstrategien benennt und sagt, welche fehlgeschlagen ist ("Marker
     nicht gefunden" vs. "Literal-Fallback ebenfalls unvollständig") statt
     eines generischen "nicht gefunden". Das ist dieselbe Idee wie
     `diagnose-feld-statt-raten`: statt zu raten, WARUM die Extraktion
     scheiterte, nennt die Meldung den genauen Zustand.
   - *Test-Absicherung:* Teil desselben `guard-test.js`-Laufs — keine
     eigene Assertion nötig, da dies eine Fehlermeldungs-Qualität betrifft
     (wird bei jedem echten Fehlschlag der Extraktion sichtbar, nicht bei
     grünem Lauf).
   - *Risiken/Rollback:* Keins — reine Erweiterung der Exception-Message,
     ändert kein Testergebnis bei grünem Lauf.
   - **Erwarteter Gain: enthalten in Aktion 2 (kein separater Posten).**

4. **Q4-Notiz statt eigener Code-Änderung (Aktion 3 aus dem Gap-Report).**
   - *Zielpfad(e):* `guard-test.js:1-15` (Datei-Kopfkommentar).
   - *Schritte:* Im Kopfkommentar ergänzen, WARUM `extractGuard()`
     (Fragment-/Marker-basiert) und `extractBraceBlock()` (Signatur +
     Klammer-balanciert, seit Test 8 im selben File) nebeneinander bestehen
     bleiben: der Wächter ist ein anonymer IIFE-Ausdruck ohne feste
     Methoden-Signatur, `extractBraceBlock` passt strukturell nicht 1:1
     darauf. Reiner Kommentarzusatz (Q6 — WARUM statt stiller
     Inkonsistenz), keine Funktionsänderung.
   - *Test-Absicherung:* keine (reiner Kommentar) — `node app/guard-test.js`
     bleibt unverändert grün.
   - *Risiken/Rollback:* Keins.
   - **Erwarteter Gain: +0.5 Pt RA** (dokumentierte Begründung/Konsistenz-
     Kriterium der Rubric).

5. **Byte-Gleichheits-Regressionstest Marker- vs. Literal-Pfad (Aktion 4 aus
   dem Gap-Report).**
   - *Zielpfad(e):* `guard-test.js` (neuer Testfall, nahe der bestehenden
     Test-0-CRLF-Regression).
   - *Schritte:* `extractGuard()` um zwei kleine, testinterne Hilfsfunktionen
     erweitern, die je einen der beiden Pfade erzwingen (Marker-Suche
     erzwingen bzw. sofort auf Literal-Suche springen), ohne die
     Produktionslogik (Marker-primär-mit-Fallback) zu ändern. Neuer Test
     ruft beide erzwungenen Pfade auf und prüft `marker-Ergebnis ===
     literal-Ergebnis` (String-Gleichheit) — SOLANGE der Literal-Pfad noch
     existiert (wird der Literal-Fallback später entfernt, entfällt dieser
     Test mit derselben Begründung).
   - *Edge-Case CRLF:* der Vergleich erfolgt auf dem bereits durch
     `literalsFromJavaBlock()`/`unescapeJava()` normalisierten Ergebnis
     beider Pfade — kein Rohtext-Diff über die Java-Quelle selbst (der würde
     in einem CRLF-Checkout einen falschen Unterschied melden, obwohl
     inhaltlich identisch).
   - *Test-Absicherung:* der neue Test selbst ist die Absicherung; er läuft
     als Teil von `node app/guard-test.js`.
   - *Risiken/Rollback:* Keins — reine Testergänzung. Rollback: Test entfernen,
     Produktionslogik (Aktion 2) bleibt unberührt.
   - **Erwarteter Gain: +0.5 Pt RA** (Testbarkeit — Erwartungswerte
     verifiziert statt angenommen).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 1 (`app/sdk-env.sh` extrahieren, `build.sh` darauf umstellen, `app/compile-check.sh` neu), Aktion 2 Schritt 1 (`// [PALE-GUARD-BEGIN]`/`// [PALE-GUARD-END]` in `MainActivity.java` einfügen) |
| diagnose | Aktion 2 Schritt 2-3 (`extractGuard()` auf Marker-primär mit Literal-Fallback + Vollständigkeits-Check umstellen), Aktion 3 (klare Fehlermeldung bei Marker-/Literal-Mismatch) |
| tests | Aktion 2 (bestehende Tests 1-13 als Regressionsbeleg gegen das neue `extractGuard()`), Aktion 5 (Byte-Gleichheits-Test Marker- vs. Literal-Pfad), Regressionslauf `node app/log-test.js` |
| docs | Aktion 4 (Q4-Notiz im `guard-test.js`-Kopfkommentar), `app/README.md` um `compile-check.sh` + Marker-Konvention ergänzen, neuer `docs/LEARNINGS.md`-Eintrag (§37: javac-Compile-Gate ohne Keystore + markerbasierte Wächter-Extraktion) |
| release | Kein `versionCode`/`versionName`-Bump, kein neuer APK-Build (Gap-Report Edge-Case 3: reine Java-Zeilenkommentare + Shell-/Node-Tooling ändern kein beobachtbares Geräteverhalten) — Commit/PR-Body vermerkt das explizit; finaler Lauf `node app/guard-test.js && node app/log-test.js` beide grün, dann Push |

## Shared-Item-Bedarf

Kein Shared-Item-Bedarf in dieser Iteration. `app/sdk-env.sh` wird zwar aus
`build.sh` extrahiert, aber ausschließlich von den zwei Skripten DIESES
Features (`build.sh`, `compile-check.sh`) konsumiert — es gibt keine zweite
Android-App/kein zweites Feature im Workspace, das dieselbe SDK-Erkennung
bräuchte. Sidecar entsprechend leer (`[]`).

## Risiken / Edge-Cases

- **CRLF-Toleranz darf nicht regredieren:** die neue Marker-Suche selbst ist
  CRLF-neutral (Marker-Strings enthalten kein Zeilenende), aber der
  Byte-Gleichheits-Vergleich aus Aktion 5 MUSS auf dem bereits normalisierten
  Ergebnis beider Pfade erfolgen (beide laufen durch
  `literalsFromJavaBlock()`/`unescapeJava()`) — ein naiver Rohtext-Diff über
  die Java-Quelle selbst würde in einem CRLF-Checkout einen falschen
  Unterschied melden, obwohl inhaltlich identisch. Bestehende Test-0-Regression
  (`guard-test.js:174-183`) bleibt unverändert grün als zusätzlicher Beleg.
- **javac-Warnungen dürfen `compile-check.sh` nicht strenger machen als
  `build.sh`:** live reproduziert erzeugt `javac --release 11 …
  MainActivity.java` bereits heute eine Deprecation-Warnung, aber keinen
  Fehler — `build.sh` nutzt kein `-Werror`. `compile-check.sh` übernimmt
  denselben Exit-Code-Vertrag (Warnungen ≠ Fehlschlag), sonst bräche das neue
  Gate strenger ab als der etablierte Voll-Build.
- **Reine Java-Kommentare lösen keinen Build/Release aus:** die Marker aus
  Aktion 2 ändern nachweislich keine `.class`-Bytes (Java-Zeilenkommentare
  werden vom Compiler vor der Bytecode-Erzeugung vollständig verworfen) —
  daher KEIN `versionCode`/`versionName`-Bump und KEIN neuer APK-Build,
  obwohl `MainActivity.java` angefasst wird. Maßstab ist "ändert sich
  beobachtbares Verhalten am Gerät" — bei reinen Kommentarzeilen strukturell
  ausgeschlossen. Explizit im PR/Commit vermerken statt reflexhaft einen
  Release-Zyklus anzustoßen.
- **Marker-Drift bei künftigen Reformats:** verschiebt ein späterer Edit die
  Marker-Zeilen relativ zu den Fragment-Ankern (z.B. Marker bleibt stehen,
  während der Wächter-Code darunter umgebaut wird), fängt Aktion 5s
  Byte-Gleichheits-Test das ab, solange der Literal-Pfad noch existiert — das
  ist der konkrete Wert dieses Tests über die reine Existenzprüfung hinaus.
  Kein Handlungsbedarf in DIESER Iteration, nur als Betriebs-Hinweis für
  künftige Wächter-Änderungen festgehalten.
- **Geography-Refresh nötig für `pk_files_to_cite`:** `app/compile-check.sh`
  und `app/sdk-env.sh` sind neue Dateien, die noch nicht in
  `vision/features/android-app-wrapper.md → code_geography` stehen. Dieser
  Lift-Plan zitiert sie trotzdem in `pk_files_to_cite`, weil sie DIESE
  Iteration als Code-Beleg (`abbruch-disziplin`) registriert werden sollen —
  Main müsste dafür die Geography um genau diese zwei Pfade erweitern
  (Divisor-Disziplin: kein unzitierter Refresh).
- **Rollback-Isolation:** die vier Aktionen sind unabhängig voneinander
  rollback-fähig (siehe Einzel-Risiken oben) — ein Fehlschlag bei Aktion 1
  (SDK-Env-Extraktion, berührt den kritischen `build.sh`-Vollpfad) erzwingt
  kein Zurückrollen von Aktion 2/4/5 (reine `guard-test.js`-Änderungen).

## Lift-Plan-Pre-Validation (M2)

Ziel-Delta: 80 − 79 = 1. Aktionen 1+2 allein summieren sich bereits auf +2
(rechnerisch 79 + 2 = 81, gecappt auf `structural_max` 80), Aktionen 4+5
liefern zusätzlich +1 Puffer (Gain-Summe gesamt +3) — 2 ≥ 1 (Ziel-Delta)
erfüllt die M3-Ambitionsregel mit deutlichem Puffer, selbst wenn nur EINE der
beiden Hauptaktionen vollständig gelingt. `plan estimate
--feature=android-app-wrapper` sollte auf Basis von `pk_files_to_cite`
(`app/compile-check.sh`, `app/sdk-env.sh`, `app/guard-test.js`) einen
Zielwert = 80 (`structural_max`, RA bereits `pass`) bestätigen. Gelingt nur
Aktion 2 (Marker) ohne Aktion 4/5 (Byte-Gleichheits-Test verschoben), bleibt
79 gemäß Gap-Report-Empfehlung der ehrliche, zu haltende Wert — kein Grund,
das Ziel nachträglich zu senken, aber auch keiner, es ohne den
Regressionstest als erreicht zu verbuchen.
