---
feature: team-eintragen
analyzed_at: 2026-08-14
iteration: 0
regression: false
score_current:
  RA: 60
score_target:
  RA: 68
---

# Gap-Report — Team ins SBC eintragen (Submit-Weg)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 60 / 75 (structural_max laut `vision/features/team-eintragen.md`)
**Schwellwert:** 52.5 (75 × 0.7)
**Status:** pass
**Begründung:** `audit-evaluator` bewertet die Fallback-Ketten (Weg App →
HTTP → Services, `ea-fc-sbc-optimizer.user.js:2595-2669`) und die
Abbruch-Disziplin bei 404/475 vs. 403 (`:2618-2668`, dokumentiert in
`docs/LEARNINGS.md:708-742` §19) als vorbildlich — das trägt den Wert klar
über den Schwellwert. Abgezogen wird, weil die drei kanonischen
Helfer `getControllerChain()` (`:2692-2716`), `findSbcController()`
(`:4999-5006`) und `findLiveChallenge()` (`:4986-4996`) an mehreren
unkritischen Stellen (`submitViaApp` ist die dokumentierte Ausnahme)
inline nachgebaut statt aufgerufen werden — reales Drift-Risiko genau in
der fragilsten, EA-layoutabhängigen Zone (vgl. LEARNINGS §19: PC- vs.
Handy-Controller-Stack unterscheiden sich bereits heute).

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **Controller-Traversal zweimal nachgebaut statt `getControllerChain()`
   aufgerufen:** `controllerScan()` (`ea-fc-sbc-optimizer.user.js:2720-2744`)
   und `refreshOpenSbcView()` (`:2811-2836`) bauen exakt denselben
   `visited`-Set/`depth<14`/`chainFns`-Traversal-Block wie die kanonische
   `getControllerChain()` (`:2692-2716`) Zeile für Zeile nach, obwohl der
   Helfer zum Zeitpunkt beider Duplikate bereits definiert ist. Beleg:
   `patterns/bad/helfer-existiert-wird-umgangen.md` Abschnitt „Code-Belege",
   erster Punkt. Ein künftiger Layout-Fix wie in LEARNINGS §19 (neue
   `chainFns`/`depth`-Anpassung für den schmalen Handy-Stack) landet damit
   nur in `getControllerChain()` und driftet lautlos in Diagnose
   (`controllerScan`) und Fallback-Refresh (`refreshOpenSbcView`) auseinander.
2. **„Welcher Key trägt die Live-Challenge"-Logik dreifach dupliziert:**
   die Schleife über `['_overviewController', 'leftController',
   '_leftController']` + `oc._challenge`-Prüfung existiert als kanonischer
   Helfer `findLiveChallenge()` (`:4986-4996`, mit explizitem Kommentar
   „Helfer, die auch die Diagnose nutzt", `:4982-4985`), wird aber in
   `syncSbcWithOpenChallenge()` (`:742-753`, konkret `:748-750`) erneut
   inline gebaut. `submitViaApp()` (`:2564-2570`) dupliziert dieselbe
   Key-Liste ein drittes Mal — das ist laut Aufgabenstellung die
   dokumentierte „Nicht anfassen ohne Grund"-Ausnahme (Weg 0) und bleibt
   unangetastet, ändert aber nichts daran, dass `syncSbcWithOpenChallenge()`
   (reiner Lesezugriff, kein Submit) denselben Fund ungenutzt lässt. SSOT-
   Verletzung (Q5): drei Stellen kennen das Schema, eine einzige ist die
   deklarierte Quelle.
3. **Kein einziger Laufzeit-Test für Controller-/Submit-Helfer — nur
   Text-Grep auf den Quellcode:** `solver-test.js:954-969` und
   `solver-test.js:1157-1172` prüfen `submitChallengeToEa`,
   `resolveFreshChallengeId` und die 403/404-Behandlung ausschließlich per
   `fn.indexOf('getControllerChain') > -1` / Regex auf den Funktionstext.
   Es existiert kein Mock von `window.getAppMain`, `window.services` oder
   `window.UTItemEntityFactory` (verifiziert: keine Treffer für
   `UTItemEntityFactory|window\.services|mockController|getAppMain` in
   `solver-test.js`) und damit keine Ausführung von `getControllerChain()`,
   `findSbcController()` oder `findLiveChallenge()` gegen ein synthetisches
   Controller-Objekt. Ein Regex-Treffer sagt nur „das Wort steht im
   Quelltext", nicht „die Traversal-Logik liefert für einen gegebenen
   EA-Objektbaum den richtigen Controller" — das erfüllt die RA-Rubrik
   („Erwartungswerte verifiziert statt geraten") schlechter als der Solver
   selbst, dessen Erwartungswerte laut CLAUDE.md immer per Brute-Force
   verifiziert werden.
4. **Kein WARUM-Kommentar an der bewusst geduldeten Duplikationsstelle:**
   `submitViaApp()` (`:2556-2559`, `:2564-2570`) baut `findSbcController()`/
   `findLiveChallenge()` bewusst nicht auf, weil Weg 0 „Nicht anfassen ohne
   Grund" ist — das steht aber nirgends als Kommentar AN der Duplikatstelle
   selbst, sondern nur im separat gepflegten Pattern-Dokument
   (`patterns/bad/helfer-existiert-wird-umgangen.md`, Abschnitt
   „Wurzelursache"). Q6 verlangt genau das: die nicht-offensichtliche
   Entscheidung („warum wird der Helfer hier NICHT benutzt, obwohl er
   existiert") gehört an den Code, nicht nur in ein Nachschlage-Dokument,
   das ein künftiger Bearbeiter beim Lesen von `submitViaApp()` nicht
   zwangsläufig aufschlägt.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`controllerScan()` und `refreshOpenSbcView()` auf `getControllerChain()`
   umstellen:** in `ea-fc-sbc-optimizer.user.js:2720-2744` bzw.
   `:2811-2836` den nachgebauten Traversal-Block durch einen Aufruf von
   `getControllerChain()` (`:2692-2716`) ersetzen, die je Funktion
   spezifische Nachverarbeitung (Klassennamen sammeln bzw. `viewOf`/Squad
   binden) unverändert danach ausführen. Beide Stellen liegen NICHT auf dem
   Weg-0-Submit-Pfad (Diagnose bzw. Fallback nach gescheitertem Submit) —
   Konsolidierung ist laut Aufgabenstellung hier ausdrücklich erlaubt.
   Absicherung: neuer statischer Test in `solver-test.js`, der prüft, dass
   die Funktionsrümpfe von `controllerScan` und `refreshOpenSbcView` den
   eigenständigen `chainFns`-Literal-Block nicht mehr enthalten, sondern
   `getControllerChain()` aufrufen — plus `node solver-test.js` weiterhin
   180/180 grün. Erwarteter Gain: +4 Pt RA (Fehlertoleranz gegen EA-Wandel:
   ein Layout-Fix wie LEARNINGS §19 propagiert automatisch in Diagnose UND
   Fallback-Refresh statt nur in der einen aktualisierten Kopie).
2. **`syncSbcWithOpenChallenge()` auf `findLiveChallenge()` umstellen:**
   in `:742-753` die inline `_overviewController`/`leftController`/
   `_leftController`→`_challenge`-Auflösung durch `const ch =
   findLiveChallenge();` ersetzen (Helfer liefert bereits `STATE.sbc.entity`
   als Fallback, siehe `:4996` — Verhalten bleibt gleich oder wird sogar
   robuster). `syncSbcWithOpenChallenge()` ist reiner Lesezugriff vor jedem
   Submit (`submitCurrentResult()`, `:5017`), keine Schreiblogik von Weg 0 —
   fällt damit unter die erlaubte Konsolidierungszone. Test: neuer
   Regressionstest in `solver-test.js`, der per Quelltext-Slice prüft, dass
   `syncSbcWithOpenChallenge` `findLiveChallenge(` aufruft statt die
   Key-Liste erneut zu literalisieren, plus ein Verhaltensvergleich
   (gleiche `STATE.sbc.challengeId` bei identischem Mock-Controller vor/nach
   der Umstellung, analog zum bereits etablierten Muster in
   `solver-test.js:954-969`). Erwarteter Gain: +3 Pt RA (SSOT für die
   Challenge-Key-Liste, Q5).
3. **Laufzeit-Tests für `getControllerChain()`/`findSbcController()`/
   `findLiveChallenge()` mit synthetischem Controller-Graph ergänzen:**
   in `solver-test.js` (Marker-basierte Extraktion analog
   `patterns/good/eingebetteten-code-exakt-testen.md`, z.B. per `new
   Function(...)`-Wrapper oder `vm`-Kontext mit `window.getAppMain`-Stub)
   einen synthetischen 3-Ebenen-Controller-Baum konstruieren (analog dem
   PC-/Handy-Unterschied aus LEARNINGS §19: ein Pfad mit
   `UTSBCSquadSplitViewController` + `leftController`, ein Pfad ohne) und
   prüfen, dass `getControllerChain()` die erwartete Reihenfolge liefert,
   `findSbcController()` den richtigen (letzten passenden) Controller
   zurückgibt und `findLiveChallenge()` die Challenge über alle drei
   Key-Varianten findet. Erwarteter Gain: +5 Pt RA (Testbarkeit: ersetzt
   „Wort kommt im Quelltext vor" durch „Logik liefert für gegebenen
   EA-Objektbaum das richtige Ergebnis").
4. **WARUM-Kommentar an `submitViaApp()` ergänzen, ohne die Logik
   anzufassen:** unmittelbar vor `:2556` (Controller-Suche) und `:2564`
   (Challenge-Key-Suche) je einen Ein-/Zweizeiler einfügen, der erklärt,
   dass diese Duplikation von `findSbcController()`/`findLiveChallenge()`
   bewusst ist, weil Weg 0 laut CLAUDE.md „Nicht anfassen ohne Grund" ist
   (Verweis auf `docs/LEARNINGS.md` §5). Reine Kommentar-Ergänzung, keine
   Verhaltensänderung, kein Testrisiko. Erwarteter Gain: +2 Pt RA
   (Dokumentierte Begründung fragiler Stellen — RA-Rubrik-Kriterium
   „Dokumentierte Begründung").

## Edge-Cases (mind. 1 — M1)

- `findSbcController()` (`:4999-5006`) und die inline Controller-Suche in
  `submitViaApp()` (`:2556-2559`) iterieren OHNE `break` über die ganze
  Controller-Kette und überschreiben `ctrl`/`found` bei jedem weiteren
  Treffer — das Ergebnis ist bewusst der LETZTE passende Controller, nicht
  der erste. Jede Konsolidierung (Aktion 1–3) muss dieses „letzter Treffer
  gewinnt"-Verhalten exakt erhalten, sonst kann sich auf dem PC-Split-View-
  Stack (mehrere `sbc`-artige Controller gleichzeitig sichtbar, vgl.
  LEARNINGS §19) der Ziel-Controller ändern, ohne dass ein bestehender Test
  das bemerkt — der neue Laufzeit-Test aus Aktion 3 muss diesen Fall mit
  ≥ 2 passenden Kandidaten im synthetischen Baum abdecken, nicht nur mit
  einem einzelnen Treffer.

## Lift-Empfehlung

Vorsichtig, mit strikter Trennung: Aktionen 1–3 sind reine
Verhaltensneutral-Refactorings an unkritischen Stellen (Diagnose, Fallback-
Refresh, Pre-Submit-Sync) — jede einzeln mit `node solver-test.js` (180/180)
vor UND nach der Änderung sowie einem eigenen neuen Testfall, der genau die
Lücke abdeckt (analog zur Auflage im Bad-Pattern-Dokument für den
`reserve()`-Fund). `submitViaApp()` selbst (Weg 0) bleibt in diesem und
jedem künftigen Lift unangetastet — dort ist nur der WARUM-Kommentar
(Aktion 4) fällig. Kein Mid-Iter-SI nötig, da alle Konsumenten
(`controllerScan`, `refreshOpenSbcView`, `syncSbcWithOpenChallenge`) bereits
im selben Feature/derselben Datei liegen.
