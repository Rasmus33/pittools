---
feature: android-app-wrapper
analyzed_at: 2026-08-15
iteration: 3
regression: false
score_current:
  RA: 79
score_target:
  RA: 80
---

# Gap-Report — android-app-wrapper (Iteration 3, Fokus: RA, Linse: Test-Infrastruktur)

Bewusst enge Analyse: kein Feature-Lift der App selbst — nur zwei bekannte
Infra-Seeds (javac-Gate, markerbasierte Wächter-Extraktion) konkretisieren.
Produkt-Verhalten der App bleibt unangetastet, keine der unten genannten
Aktionen ändert die `.dex`-Bytecode-Semantik.

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 79 / 80 (structural_max laut `docs/roadmap/vision/features/android-app-wrapper.md:6-7`)
**Schwellwert:** 56 (structural_max × 0.7)
**Status:** pass
**Begründung:** Laut `docs/roadmap/audit/android-app-wrapper.md` (Iteration 2)
liegt der Ist-Wert bei 79.0/80, live bestätigt gegen `main`. Beide
Vorgänger-Iterationen haben die produktseitigen Antipattern (unbenannter
Choke-Point, ungekapselte Felder, fehlende WebView-Fehler-Diagnose, toter
Leer-Body-Guard) bereits geschlossen — verifiziert per `node
app/guard-test.js` (Tests 10-13, alle grün, s.u.) und `node app/log-test.js`
(alle grün). Die verbleibende 1-Punkt-Lücke zum strukturellen Deckel betrifft
laut Rubric (`docs/roadmap/vision/score-criteria.md:20-21`, Kriterium
"Testbarkeit") genau die Test-Infrastruktur selbst, nicht mehr den
Produktcode: kein automatisiertes Java-Compile-Gate und eine fragile
Extraktionstechnik im wichtigsten Testfall (`guard-test.js`). Beide Seeds
wurden live nachvollzogen (siehe Belege unten), keine erfunden.

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **Kein automatisiertes Java-Compile-Gate (Seed 1, bestätigt):** Der
   einzige Ort, an dem `MainActivity.java` kompiliert wird, ist
   `app/build.sh:73-74` (`javac --release 11 -classpath "$AJ" …`) — mitten in
   der vollständigen, signierten APK-Build-Pipeline. Dieser Schritt ist
   untrennbar an einen vorhandenen `app/debug.keystore` gekoppelt: fehlt der
   (er liegt bewusst nicht im Repo, `app/build.sh:46-58`), bricht das Skript
   *vor* dem Signieren zwar sauber ab, aber ein Implementer/Reviewer, der nur
   wissen will "kompiliert die Datei überhaupt", hat keinen Weg, das isoliert
   und ohne Keystore-Abhängigkeit zu prüfen. Live reproduziert: der reine
   `javac`-Aufruf aus `build.sh:73-74` läuft eigenständig in ~1s durch
   (`ANDROID_HOME` zeigt auf `android-36`, kein Keystore nötig) — das Gate
   existiert also technisch, ist aber nirgends als eigenständiges,
   wiederholbares Artefakt festgehalten.
2. **Compile-Fehler sind für die vorhandene Test-Suite unsichtbar:**
   `app/guard-test.js` und `app/log-test.js` prüfen `MainActivity.java`
   ausschließlich als TEXT (Regex/Brace-Balance-Extraktion, z.B.
   `extractBraceBlock` in `guard-test.js:83-98`) — beide laufen mit Node,
   ohne dass die Datei je durch `javac` geht. Ein Implementer, der sich an
   den eisernen Arbeitsablauf hält (`CLAUDE.md:52-53`: "`node
   app/guard-test.js` … dann `cd app && ./build.sh`") merkt einen
   Syntax-/Typfehler zwar spätestens beim vollen Build, aber nichts zwingt
   dazu, das VOR einem Commit/Review zu tun, wenn kein Keystore lokal
   verfügbar ist (Implementer-Worktrees haben laut Briefing dasselbe System,
   aber der Keystore ist personengebunden bei Rasmus, nicht Teil des Repos).
3. **Wächter-Extraktion über inzidentelle Code-Fragmente statt dedizierter
   Marker (Seed 2, bestätigt, bereits als Weak Signal notiert in
   `docs/roadmap/patterns/aspects/aspect-android-app.md:165-170`):**
   `extractGuard()` (`app/guard-test.js:46-58`) sucht den PaleTools-Wächter
   über `startMark = '"(function(){" +'` und `endMark = '"})()", null);'`
   — beide sind reine Zufalls-Fundstellen im Code
   (`MainActivity.java:349` bzw. `:424`, live per Grep bestätigt: je genau
   ein Vorkommen in der gesamten Datei). Ein Reformat der
   String-Concatenation an genau diesen zwei Zeilen (z.B. Zeilenumbruch
   verschoben, Leerzeichen anders, `"})()" , null);` mit Extra-Leerzeichen)
   lässt `indexOf` fehlschlagen oder — schlimmer — auf einen falschen,
   früheren/späteren Treffer zurückfallen und den extrahierten Block STILL
   verkürzen, ohne dass ein Test das bemerkt (die 7 Verhaltens-Szenarien
   prüfen nur das Ergebnis des extrahierten Codes, nicht dessen
   Vollständigkeit als Vorbedingung).
4. **Inkonsistente Extraktionstechnik im selben Testfile (Q4/DRY,
   Verschärfung des bestehenden Weak Signal):** Genau dieselbe Datei nutzt ab
   Zeile 83 (`extractBraceBlock`, Signatur- statt Fragment-basiert,
   Klammer-balanciert) bereits eine robustere Technik für alle SPÄTEREN
   Checks (Tests 8-13, Zeilen 262-359) — dasselbe Prinzip, das
   `app/log-test.js:32-46` für den Ringpuffer verwendet. Die ursprüngliche,
   sicherheitskritischste Extraktion (der Wächter selbst, wegen dem
   `guard-test.js` überhaupt existiert, s. Datei-Kopfkommentar Zeilen 1-15)
   wurde nie auf dieses inzwischen etablierte, robustere Muster migriert —
   zwei verschiedene Extraktionsprinzipien für strukturell denselben Zweck in
   derselben Datei.
5. **SDK-Abwesenheits-Verhalten für ein eigenständiges Compile-Gate ist
   underspezifiziert:** `build.sh:9-10` bricht hart ab, wenn kein SDK
   gefunden wird ("FEHLER: Android SDK nicht gefunden") — konsistent mit dem
   in `aspect-android-app.md:89-101` dokumentierten Fail-fast-Pattern des
   Skripts. Weil es aber noch kein eigenständiges Compile-Skript gibt, ist
   unklar, ob dieses Pattern (hart abbrechen) oder ein weicheres "Gate
   übersprungen, weil SDK fehlt" für den NEUEN, isolierten Anwendungsfall
   gelten soll — eine bewusste Entscheidung fehlt, nicht nur eine
   Implementierung.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`app/compile-check.sh` als eigenständiges, keystore-freies Gate
   extrahieren:** Neues Skript, das NUR die SDK-/Platform-Erkennung
   (`app/build.sh:8-26`) und den `javac`-Aufruf (`app/build.sh:73-74`)
   ausführt — keine `d8`/`aapt2`/`zipalign`/`apksigner`-Schritte, kein
   Keystore-Zugriff. SDK-Erkennungslogik NICHT dupliziert, sondern aus
   `build.sh` in eine gemeinsame, von beiden Skripten `source`te Datei (z.B.
   `app/sdk-env.sh`) gezogen (Q4/Q5 — sonst driftet `build.sh`s
   SDK-Fallback-Logik unbemerkt von der des Compile-Checks). Verhalten bei
   fehlendem SDK: hart abbrechen (exit 1, konsistent mit dem restlichen
   Fail-fast-Stil des Skripts, `aspect-android-app.md:89-101`) statt
   still zu überspringen — ein Implementer-Worktree auf demselben Rechner
   sollte dasselbe SDK vorfinden wie `build.sh`; ein stilles Skip wäre die
   exakt selbe Klasse von Antipattern, die bereits für die
   Netzwerk-/Cache-Pfade als Antipattern dokumentiert ist
   (`aspect-android-app.md:105-128`). Live reproduziert: der reine
   `javac`-Aufruf auf dieser Maschine läuft ohne Keystore in ~1s durch.
   **Erwarteter Gain: +1 Pt RA** (Testbarkeit — Compile-Gate erstmals ohne
   volle Signier-Pipeline reproduzierbar).
2. **Marker-Kommentare um den Wächter-Block einführen + primäre Extraktion
   darüber:** `// [PALE-GUARD-BEGIN]` vor `MainActivity.java:349` und
   `// [PALE-GUARD-END]` nach `:424` einfügen (reine Kommentarzeilen — ändern
   keine `.class`/`.dex`-Bytes, da Java-Zeilenkommentare vom Compiler
   vollständig verworfen werden). `extractGuard()` in `guard-test.js` auf
   Marker-Suche umstellen, MIT Fallback auf die bestehenden
   Fragment-Literale (`"(function(){" +` / `"})()", null);`), solange beide
   Wege existieren — analog zum bereits etablierten Fallback-Ketten-Muster
   des Repos (`docs/roadmap/patterns/good/ea-grenz-fallback-ketten.md`).
   Zusätzlich ein Vollständigkeits-Check: das Extrakt muss bekannte Anker
   enthalten (z.B. `'HARD='`, `'exec('`, `'miss()'`, `'__pt_status'`) UND
   Marker-Weg und Literal-Weg müssen — solange beide existieren — exakt
   dasselbe (bereits Java-entkommentierte/entescapte) Ergebnis liefern
   (String-Gleichheit, nicht nur Länge). **Erwarteter Gain: +1 Pt RA**
   (Testbarkeit — schließt genau die stille Verkürzungs-Lücke aus Mangel 3).
3. **`extractBraceBlock`-Konsolidierung als Q4-Notiz statt eigener Aktion:**
   Die in `guard-test.js:83-98` bereits vorhandene, robustere
   Signatur+Klammer-balancierte Technik NICHT zusätzlich auf den Wächter
   anwenden (der Wächter ist ein anonymer IIFE-Ausdruck ohne feste Methoden-
   Signatur, `extractBraceBlock` passt strukturell nicht 1:1) — stattdessen
   Aktion 2 als die zum Wächter passende Härtung behandeln und im
   Datei-Kopfkommentar von `guard-test.js` (Zeilen 1-15) kurz begründen,
   warum zwei Extraktionsprinzipien nebeneinander bestehen bleiben (Q6 —
   WARUM-Kommentar statt stiller Inkonsistenz). **Erwarteter Gain: +0.5 Pt
   RA** (Dokumentierte Begründung/Konsistenz-Kriterium der Rubric).
4. **Byte-Gleichheits-Regressionstest als eigener Schritt in
   `guard-test.js` verankern:** Unabhängig von der Migration selbst einen
   Test hinzufügen, der `extractGuard()` zweimal aufruft — einmal mit
   Marker-Pfad erzwungen, einmal mit Literal-Pfad erzwungen (z.B. über zwei
   kleine Hilfsfunktionen oder einen Parameter) — und beide Ergebnisse
   auf exakte Gleichheit prüft, solange der Literal-Pfad noch existiert.
   Das ist die konkrete Umsetzung der in Aktion 2 geforderten
   Vollständigkeits-Assertion und macht sie unabhängig überprüfbar (M1:
   jede Lift-Aktion braucht einen eigenen Testfall statt nur einer
   Absichtserklärung). **Erwarteter Gain: +0.5 Pt RA** (Testbarkeit —
   Erwartungswerte verifiziert statt angenommen, analog zur
   Solver-Test-Philosophie aus `CLAUDE.md:43-44`).

## Edge-Cases (mind. 1 — M1)

- **CRLF-Toleranz darf nicht regredieren:** `guard-test.js` ist seit
  Test 0 (`guard-test.js:174-183`) explizit CRLF-tolerant
  (`literalsFromJavaBlock` normalisiert `\r\n` → `\n` vor der
  Kommentar-Erkennung). Die neue Marker-Suche selbst ist CRLF-neutral (die
  Marker-Strings enthalten kein Zeilenende), aber der in Aktion 4 geforderte
  Byte-Gleichheits-Vergleich zwischen Marker- und Literal-Pfad MUSS auf dem
  bereits normalisierten Ergebnis beider Pfade erfolgen (beide laufen durch
  `literalsFromJavaBlock`/`unescapeJava`) — ein naiver Rohtext-Diff über die
  Java-Quelle selbst (statt über die beiden extrahierten JS-Strings) würde in
  einem CRLF-Checkout einen falschen Unterschied melden, obwohl inhaltlich
  identisch.
- **javac-Warnungen dürfen das neue Gate nicht strenger machen als den
  bestehenden Build:** Live reproduziert (`javac --release 11 …
  MainActivity.java`) erzeugt bereits heute eine Deprecation-Warnung ("veraltete
  API"), aber keinen Fehler — `build.sh` nutzt kein `-Werror` und lässt den
  Build trotzdem grün durchlaufen. `compile-check.sh` muss denselben
  Exit-Code-Vertrag übernehmen (Warnungen ≠ Fehlschlag), sonst würde das neue
  Gate strenger abbrechen als der etablierte Voll-Build — ein leicht
  übersehener, ungewollter Verhaltensunterschied zwischen den beiden
  Pipelines.
- **Reine Java-Kommentare lösen keinen Build/Release aus:** Die
  Marker-Kommentare aus Aktion 2 ändern nachweislich keine `.class`-Bytes
  (Java-Zeilenkommentare werden vom Compiler vollständig verworfen, vor der
  Bytecode-Erzeugung) — daher ist für diese Aktion KEIN
  `versionCode`/`versionName`-Bump und KEIN neuer APK-Build nötig, obwohl
  `CLAUDE.md:52-59` das für "App-Änderungen" grundsätzlich vorschreibt. Das
  ist leicht zu übersehen, weil `MainActivity.java` angefasst wird — der
  Maßstab ist aber "ändert sich beobachtbares Verhalten am Gerät", und das
  ist bei reinen Kommentarzeilen strukturell ausgeschlossen. Ein Implementer
  sollte das explizit im PR/Commit vermerken, statt reflexhaft einen
  Release-Zyklus anzustoßen.

Keine weiteren echten Infra-Lücken gefunden: `app/log-test.js` folgt bereits
konsequent dem robusteren Signatur+Brace-Balance-Prinzip (keine eigene
Baustelle), und `app/build.sh`s übriger Fail-fast-Stil (Keystore, Tool-Namen,
`zip`-Fallback) ist seit Iteration 0 unverändert und bereits als Pattern
dokumentiert (`aspect-android-app.md:89-101`) — hier besteht kein neuer,
unadressierter Mangel.

## Lift-Empfehlung

Vorsichtig/additiv, wie in Iteration 2: alle vier Aktionen sind reine
Test-/Tooling-Ergänzungen ohne Berührung von Produktcode-Pfaden (Fallback-
Ketten, Wächter-Timing-Kern, Submit-Weg bleiben unverändert) — kein
Mid-Iter-SI nötig. Die Gain-Summe (+3) trägt das 1-Punkt-Delta zum
strukturellen Deckel (80) mit Puffer, ABER: RA steht bereits bei 79/80 und
ist strukturell fast ausgeschöpft — `score_target: 80` ist hier nur
gerechtfertigt, weil beide Aktionen direkt das Rubric-Kriterium
"Testbarkeit" bedienen (`score-criteria.md:20-21`) und keine neue
Produktcode-Fläche eröffnen, die neue Mängel in anderen Kriterien
(Fehlertoleranz, Beobachtbarkeit, Abbruch-Disziplin) erzeugen könnte. Sollte
Aktion 1 (Compile-Gate) oder Aktion 2 (Marker-Extraktion) in der Umsetzung
nur teilweise gelingen (z.B. Marker eingeführt, aber Byte-Gleichheits-Test
aus Aktion 4 verschoben), bleibt 79 der ehrliche, zu haltende Wert — kein
Grund, den Zielwert nachträglich zu senken, aber auch keiner, ihn ohne
Aktion 4 als erreicht zu verbuchen.
