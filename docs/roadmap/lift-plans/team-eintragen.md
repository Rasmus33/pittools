---
feature: team-eintragen
iteration: 0
score_current:
  RA: 60
score_target:
  RA: 70
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
patterns_required:
  - diagnose-feld-statt-raten
  - warum-kommentare-mit-live-belegen
  - eingebetteten-code-exakt-testen
pk_files_to_cite: []
citation_only: false
shared_items_required:
  - controller-chain-konsolidierung
  - fehler-sichtbarkeit-diagerror
priority: P3-deferred
effort: S
analyzed_at: 2026-08-15
---

# Lift-Plan — Team ins SBC eintragen (Submit-Weg)

## Marschroute

Diese Iteration hebt ausschließlich RA (60 → 70 von `structural_max` 75) und
lässt Submit-Weg 0 (`submitViaApp()`, LEARNINGS §5) unangetastet — der bleibt
laut Aufgabenstellung „Nicht anfassen ohne Grund". Der Hebel liegt an den
**unkritischen** Stellen, die dieselbe Controller-Traversal wie die
kanonischen Helfer `getControllerChain()` (`:2692-2716`) und
`findLiveChallenge()` (`:4986-4997`) inline nachbauen, obwohl beide Helfer
bereits existieren (`patterns/bad/helfer-existiert-wird-umgangen.md`): die
Diagnose-Funktion `controllerScan()` (`:2720-2799`), der Fallback-Refresh
`refreshOpenSbcView()` (`:2811-2904`) und der reine Lesezugriff
`syncSbcWithOpenChallenge()` (`:742-764`, Pre-Submit-Sync vor
`submitCurrentResult()`).

Reihenfolge (`phase_sequence`: core → diagnose → tests → docs → release):
zuerst die drei Konsolidierungen selbst (core), dann die fehlende
`diagError()`-Meldung in `syncSbcWithOpenChallenge()`s Catch ergänzen
(diagnose), dann Laufzeit-Tests gegen einen synthetischen Controller-Graph
plus statische Regressionstests für die Konsolidierung selbst (tests), dann
ein LEARNINGS.md-Eintrag zum IST-Zustand des Helfer-Clusters (docs), zuletzt
Versionsbump + Push (release). Jede der drei Konsolidierungen läuft einzeln
mit `node solver-test.js` (180/180) vor UND nach der Änderung — kein
Sammel-Commit über mehrere Konsolidierungen hinweg.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`controllerScan()` (`:2720-2799`) und `refreshOpenSbcView()`
   (`:2811-2904`) auf `getControllerChain()` umstellen:** in
   `controllerScan()` den Traversal-Block `:2723-2743` (eigener
   `chainFns`/`visited`/`depth<12`-Loop) durch `const chain =
   getControllerChain(); const cur = chain[chain.length - 1];` ersetzen, die
   anschließende Methoden-/Feld-Sammlung auf `cur` (`:2744-2796`) unverändert
   lassen. In `refreshOpenSbcView()` den Traversal-Block `:2815-2836` durch
   `const controllers = getControllerChain();` ersetzen — die Weiterverarbeitung
   iteriert bereits über das GANZE `controllers`-Array (`:2854-2896`), keine
   Anpassung nötig. **Verifizierte Divergenz, die die Konsolidierung bewusst
   glättet:** `controllerScan()` begrenzte bisher auf `depth<12`,
   `getControllerChain()`/`refreshOpenSbcView()` auf `depth<14` — nach der
   Umstellung gilt für alle drei einheitlich `depth<14` (zwei Ebenen mehr
   Toleranz, kein Verlust). Das ist eine bewusste, getestete Angleichung, kein
   stiller Nebeneffekt — eigener Testfall in Aktion 3 deckt einen
   Controller-Graphen mit Tiefe 13 ab, den `controllerScan()` vorher
   abgeschnitten hätte. `findSbcController()` (`:4999-5006`, „letzter Treffer
   gewinnt") bleibt von dieser Aktion unberührt — keiner der beiden
   Konsumenten ruft ihn auf. Test: neuer statischer Check in
   `solver-test.js`, der per Quelltext-Slice prüft, dass die Funktionsrümpfe
   von `controllerScan` und `refreshOpenSbcView` keinen eigenen
   `chainFns`-Literal-Block mehr enthalten, sondern `getControllerChain(`
   aufrufen, plus `node solver-test.js` weiterhin 180/180 grün. Erwarteter
   Gain: **+4 Pt RA** (Fehlertoleranz gegen EA-Wandel: ein Layout-Fix wie
   LEARNINGS §19 propagiert künftig automatisch in Diagnose UND
   Fallback-Refresh statt nur in der einen aktualisierten Kopie).

2. **`syncSbcWithOpenChallenge()` (`:742-764`) auf `findLiveChallenge()`
   umstellen:** die inline `_overviewController`/`leftController`/
   `_leftController`→`_challenge`-Auflösung (`:748-752`) durch `const ch =
   findLiveChallenge();` ersetzen. Verifiziert additiv-sicher: beide Wege
   iterieren `getControllerChain()` in derselben Reihenfolge und geben beim
   ERSTEN `/sbc/i`-Controller mit Treffer sofort zurück (kein „letzter
   Treffer gewinnt" hier, anders als bei `findSbcController()` — die
   bestehende Semantik bleibt exakt erhalten). `findLiveChallenge()` liefert
   zusätzlich `STATE.sbc.entity` als Fallback (`:4996`), den
   `syncSbcWithOpenChallenge()` bisher nicht hatte — reine Erweiterung, kein
   Verlust eines bestehenden Rückgabewerts. `findLiveChallenge()` liegt laut
   `vision/features/ea-app-anbindung.md` in dessen Code-Geographie
   (`:4982-5145`) — diese Konsolidierung macht team-eintragen zum Konsumenten
   eines fremd-geografierten Helfers, siehe Shared-Item-Bedarf. Test: neuer
   Regressionstest in `solver-test.js`, der per Quelltext-Slice prüft, dass
   `syncSbcWithOpenChallenge` `findLiveChallenge(` aufruft statt die
   Key-Liste erneut zu literalisieren, plus Verhaltensvergleich (gleiche
   `STATE.sbc.challengeId` bei identischem Mock-Controller vor/nach der
   Umstellung). Erwarteter Gain: **+3 Pt RA** (SSOT für die
   Challenge-Key-Liste, Q5).

3. **`diagError()`-Ergänzung in `syncSbcWithOpenChallenge()`s Catch
   (`:762`):** der Catch-Block ruft aktuell NUR `warn('SBC-Sync
   fehlgeschlagen:', e.message)` — ohne `diagError()`. Das widerspricht dem
   in `patterns/good/diagnose-feld-statt-raten.md` dokumentierten
   Zwei-Kanal-Muster (jeder reportwürdige Fehler landet zusätzlich in
   `STATE.diag.lastErrors`) und ist reportwürdig, weil ein gescheiterter
   Pre-Submit-Sync erklärt, warum `submitCurrentResult()`
   (`:5007ff`) mit einer veralteten Challenge-ID arbeiten könnte. Ergänzung:
   `diagError('syncSbcWithOpenChallenge: ' + (e.message || e));` direkt neben
   dem bestehenden `warn(...)`-Aufruf, analog zu den drei bereits
   konformen Stellen in `submitToSbc` (`:2606,2609,2615`) und
   `refreshOpenSbcView` (`:2901`). Kein Verhaltenstest nötig über die
   bestehende `lastErrors`-Prüfung hinaus (reine Ergänzung, kein neuer
   Rückgabepfad). Erwarteter Gain: **+1 Pt RA** (Beobachtbarkeit).

4. **Laufzeit-Tests für `getControllerChain()`/`findSbcController()`/
   `findLiveChallenge()` mit synthetischem Controller-Graph:** in
   `solver-test.js` (Marker-/Funktions-Extraktion analog
   `patterns/good/eingebetteten-code-exakt-testen.md`) einen synthetischen
   3-Ebenen-Controller-Baum konstruieren (ein Pfad mit
   `UTSBCSquadSplitViewController` + `leftController`, ein Pfad ohne, analog
   PC-/Handy-Unterschied aus LEARNINGS §19), plus **mindestens zwei**
   `/sbc/i`-matchende Kandidaten im selben Baum für den
   `findSbcController()`-Fall. Geprüft wird: `getControllerChain()` liefert
   die erwartete Reihenfolge inkl. Tiefe 13 (deckt die in Aktion 1
   harmonisierte `depth`-Grenze ab), `findSbcController()` gibt bei
   ≥ 2 Kandidaten GENAU den LETZTEN zurück (Edge-Case aus dem Gap-Report:
   „letzter Treffer gewinnt" darf durch keine Konsolidierung stillschweigend
   kippen), `findLiveChallenge()` findet die Challenge über alle drei
   Key-Varianten und über den `STATE.sbc.entity`-Fallback, wenn kein
   Controller matcht. Erwarteter Gain: **+5 Pt RA** (Testbarkeit: ersetzt
   „Wort kommt im Quelltext vor" durch „Logik liefert für gegebenen
   EA-Objektbaum das richtige Ergebnis" — vorher ausschließlich Text-Grep in
   `solver-test.js:954-969`/`:1157-1172`).

5. **WARUM-Kommentar an `submitViaApp()` ergänzen, ohne die Logik
   anzufassen:** unmittelbar vor `:2556` (Controller-Suche, „letzter Treffer
   gewinnt", KEIN `findSbcController()`-Aufruf) und vor `:2564`
   (Challenge-Key-Suche, KEIN `findLiveChallenge()`-Aufruf) je einen
   Ein-/Zweizeiler nach dem Muster aus
   `patterns/good/warum-kommentare-mit-live-belegen.md` einfügen: die
   Duplikation ist bewusst, weil `submitViaApp()` Submit-Weg 0 ist
   (CLAUDE.md „Nicht anfassen ohne Grund", LEARNINGS §5 — der einzige Weg,
   der die Ansicht ohne F5 aktualisiert) und ein Umbau auf die Helfer das
   Regressionsrisiko am kritischsten Pfad erhöhen würde, ohne einen Fehler
   zu beheben. Reine Kommentar-Ergänzung, keine Verhaltensänderung. Test:
   ein leichter statischer Check in `solver-test.js` (analog dem
   Metablock-Check `:349-378`), der prüft, dass die beiden Kommentare
   vorhanden sind und auf „LEARNINGS" bzw. „Nicht anfassen" verweisen —
   verhindert, dass ein künftiger Edit den Beleg stillschweigend entfernt.
   Erwarteter Gain: **+2 Pt RA** (dokumentierte Begründung fragiler
   Stellen).

**Erwarteter Gesamt-Gain: +15 Pt RA** (60 → ~75, komfortabel über dem
M3-Ziel von 70; Einzelaktionen sind unabhängig voneinander abnehmbar, falls
eine Aktion in der Umsetzung mehr Risiko zeigt als hier eingeschätzt).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 1 (`controllerScan`/`refreshOpenSbcView` → `getControllerChain`), Aktion 2 (`syncSbcWithOpenChallenge` → `findLiveChallenge`), Aktion 5 (WARUM-Kommentar `submitViaApp`) |
| diagnose | Aktion 3 (`diagError`-Ergänzung in `syncSbcWithOpenChallenge`s Catch) |
| tests | Aktion 4 (synthetischer Controller-Graph für die drei Helfer), statische Regressionstests aus Aktion 1/2/5 |
| docs | LEARNINGS.md-Eintrag (IST-Zustand: `controllerScan`/`refreshOpenSbcView`/`syncSbcWithOpenChallenge` rufen die kanonischen Helfer auf, `submitViaApp` bleibt bewusst die Ausnahme — Q7-konform, ohne „vorher/nachher"-Sprache) |
| release | `@version`/`const VERSION` bumpen, `node --check` + `node solver-test.js` (180/180) final, Push auf `main` |

## Shared-Item-Bedarf

Zwei SI-Kandidaten, beide mit `rationale` im Sidecar-JSON begründet:

- **`controller-chain-konsolidierung`** (Konsumenten: team-eintragen,
  ea-app-anbindung): `getControllerChain()` liegt in der Code-Geographie von
  team-eintragen, `findLiveChallenge()` in der von ea-app-anbindung. Aktion 2
  dieses Plans lässt team-eintragen direkt in einen fremd-geografierten
  Helfer hineinrufen — die Kopplung ist beabsichtigt (SSOT), aber
  Cross-Feature und sollte erfasst sein, damit ein künftiger Lift von
  ea-app-anbindung (z.B. eine neue `chainFns`-Variante) nicht unabhängig an
  denselben Zeilen arbeitet wie ein künftiger team-eintragen-Lift.
- **`fehler-sichtbarkeit-diagerror`** (Konsument: team-eintragen): Aktion 3
  behebt einen Catch, der `diagError()` vergisst — dasselbe
  `warn()`+`diagError()`-Paar ist an mindestens drei weiteren Stellen
  (`submitToSbc` `:2606,2609,2615`) wortgleich dupliziert. team-eintragen ist
  Konsument eines gebündelten `warnAndDiag()`-Helfers, der dieses Paar an
  einer Stelle hält, statt es bei jedem neuen Catch erneut von Hand zu
  wiederholen.

Kein Mid-Iter-SI-Zwang: beide Kandidaten sind unabhängig von den fünf
Aktionen dieses Plans umsetzbar — Aktion 2/3 funktionieren auch ohne die
SI-Extraktion, sie werden dadurch nur wartbarer.

## Risiken / Edge-Cases

- **180/180-vorher=nachher-Garantie pro Aktion:** jede der drei
  Konsolidierungen (Aktion 1, 2) läuft einzeln mit `node solver-test.js`
  VOR und NACH der Änderung — kein Sammel-Commit über mehrere
  Konsolidierungen. Regressionsrisiko konzentriert sich auf die
  EA-layoutabhängige, fragilste Zone des Features (LEARNINGS §19: PC- vs.
  Handy-Controller-Stack unterscheiden sich bereits heute); genau deshalb
  braucht jede Aktion einen eigenen, die Lücke exakt abdeckenden Testfall
  statt eines allgemeinen Rauchtests.
- **„Letzter Treffer gewinnt" darf nicht kippen:** `findSbcController()`
  (`:4999-5006`) und die inline Controller-Suche in `submitViaApp()`
  (`:2556-2559`, unangetastet) überschreiben `ctrl`/`found` bei jedem
  weiteren Treffer bewusst — das Ergebnis ist der LETZTE passende
  Controller. Keine der fünf Aktionen dieses Plans ruft `findSbcController()`
  auf oder ändert dessen Traversal — die Invariante bleibt strukturell
  geschützt, solange niemand versucht ist, die Konsolidierung in einer
  Folge-Iteration auf `submitViaApp()` auszuweiten. Aktion 4 deckt den
  ≥ 2-Kandidaten-Fall trotzdem testend ab, damit die Invariante nicht nur
  durch Unterlassung geschützt ist, sondern auch geprüft.
- **`depth`-Harmonisierung (12 → 14) in `controllerScan()`:** bewusst und
  getestet (Aktion 1/4), aber ein Divergenzpunkt, den ein oberflächlicher
  Diff übersehen könnte, wenn er nur auf „ruft jetzt `getControllerChain()`
  auf" statt auf den entfernten `depth<12`-Literal achtet.
- **Cross-Feature-Kopplung durch Aktion 2:** `findLiveChallenge()` gehört
  laut Vision-Doc zur Code-Geographie von ea-app-anbindung, nicht
  team-eintragen — ein künftiger, unabhängig geplanter Lift von
  ea-app-anbindung an genau dieser Funktion trifft jetzt auch
  team-eintragen. Deshalb der SI-Kandidat `controller-chain-konsolidierung`
  oben; ohne dessen Erfassung könnte ein Main-Konflikt-Check (siehe
  Konflikt-Resolution im Lift-Plan-Guide) zwei Pläne unabhängig gegen
  dieselbe Funktion laufen lassen.
- **Mid-Iter-G-Vermutung:** sollte während der Umsetzung ein DRITTER
  Aufrufer der Controller-Traversal auftauchen (z.B. bei der
  Test-Implementierung aus Aktion 4 selbst, die einen weiteren
  Mock-Consumer braucht), ist das ein Signal für einen Klasse-G-Shared-Item-
  Einschub (`controller-chain-konsolidierung` erweitern) statt einer vierten
  Inline-Kopie — Q4/Antipattern `helfer-existiert-wird-umgangen` gilt auch
  für neu entstehenden Testcode.

## Lift-Plan-Pre-Validation (M2)

Dimension RA ist kein `pattern_adoption`-Adapter (`manual_rubric`,
Score-Kriterien) — `pk_files_to_cite` bleibt leer, `citation_only: false`
(dieser Plan enthält echte Code-Änderungen, keine reine
Beleg-Registrierung). `score_target.RA = 70` liegt unter
`structural_max.RA = 75` und entspricht der Ambitions-Regel M3
(`60 + (75 − 60) × 0.7 = 70,5`, abgerundet auf das vorgegebene M3-Target 70).
Erwarteter Gain (+15, Summe der fünf Einzelaktionen) liegt deutlich über der
90-%-Miss-Risk-Schwelle von +9 Pt.
