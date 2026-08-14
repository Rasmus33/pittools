---
feature: sbc-vorgaben-erkennung
analyzed_at: 2026-08-14
iteration: 0
regression: false
score_current:
  RA: 65
score_target:
  RA: 72
---

# Gap-Report — SBC-Vorgaben-Erkennung

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 65 / 80
**Schwellwert:** 56 (80 × 0.7)
**Status:** pass
**Begründung:** Der `audit-evaluator` bewertet den Deep-Scan
(`deepScanChallenge`, `findChallengeNode`, `collectChallengeNodes`,
`ea-fc-sbc-optimizer.user.js:362-476`) als generisch, mehrschichtig
fallback-gesichert (Netzwerk-Hook → Set-Challenges-Cache →
`syncSbcWithOpenChallenge` über den Live-Controller,
`ea-fc-sbc-optimizer.user.js:742-764`) und mit sauberer Abbruch-Disziplin an
mindestens einer Stelle (`resolveFreshChallengeId`, `:596-599`, meldet
Mehrdeutigkeit statt zu raten). Runtergezogen wird der Wert durch einen
realen, unbehobenen Namensdrift-Bug (`STATE.sbc.slots` wird nie geschrieben,
`:576`) und dadurch, dass die Kernlogik des Parsers (`deepScanChallenge` +
Helfer) durch keinen einzigen ausführbaren Test mit konstruierten
EA-Objekten abgedeckt ist — nur String-Regressionschecks auf den Quelltext
(`solver-test.js:1218-1235`).

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`STATE.sbc.slots`-Namensdrift macht die Slot-Disambiguierung faktisch
   tot:** `resolveFreshChallengeId()` liest `STATE.sbc.slots`
   (`ea-fc-sbc-optimizer.user.js:576`), geschrieben wird aber ausschließlich
   `STATE.sbc.formationSlots` (`:492`, `:640`, `:675`, `:691`). `wantSlots`
   ist dadurch immer `undefined`, `okSlots` in der Kandidaten-Filterung
   (`:591-592`) ist praktisch immer `true` — die im Funktionskommentar
   angekündigte Sicherung „sonst landet das Team in einer fremden SBC"
   (`:566-569`) greift für den Slot-Teil nicht. Derselbe tote Vergleich
   trifft `matchesPlannedSbc()` (`:4795`, `Number(undefined||0) !==
   Number(plan.slots||0)`) und die Anker-Übernahme beim Batch-Plan
   (`:4816`, `plan.slots = STATE.sbc.slots` übernimmt bereits beim Planen
   `undefined`) sowie die Nutzertext-Ausgabe bei Diskrepanz (`:4916`, würde
   `undefined` anzeigen). Bereits als Antipattern-Beleg dokumentiert in
   `docs/roadmap/patterns/bad/wissens-duplikate-ohne-ssot.md` (Abschnitt
   „Namensdrift als Sonderfall").
2. **Parsing-Kernlogik ohne ausführbaren Test:** `deepScanChallenge` und die
   Helfer `scopeString`/`reqValue`/`reqCount`/`reqIds`
   (`ea-fc-sbc-optimizer.user.js:317-476`) liegen komplett außerhalb der
   `// [SOLVER-BEGIN]` (`:1411`) / `// [SOLVER-END]` (`:2446`)-Marker, die
   `solver-test.js` per Marker-Extraktion aus dem Userscript zieht und real
   ausführt (Pattern `eingebetteten-code-exakt-testen`). Die einzige
   Absicherung dieser Schicht sind String-Präsenz-Checks auf den
   Rohquelltext (`solver-test.js:1218-1235`: `src.indexOf("indexOf('RARE')")
   === -1` u.ä.) — kein Aufruf von `deepScanChallenge` mit einem
   konstruierten EA-Objekt und einer Assertion auf `out.target`/
   `out.rarity`/`out.quality`/`out.playerLevel`. Die in
   `solver-test.js:1338-1353` sichtbaren `playerLevelConstraints`-Fixtures
   sind reine Solver-Eingaben (handgeschrieben), keine Verifikation des
   Parsers, der sie in der Praxis erzeugen müsste.
3. **`reqDump` dokumentiert keinen Klassifizierungspfad:** `out.reqs.push`
   (`ea-fc-sbc-optimizer.user.js:382-389`) speichert nur `scope`/`value`/
   `ids`/`count`, nicht welcher der drei sich gegenseitig ausschließenden
   Zweige (`isTeamRating` `:390-393`, `isPlayerLevel` `:401-404`,
   `isQualityScope` `:417-418`) tatsächlich gegriffen hat bzw. warum keiner
   griff. Genau diese Information fehlte live beim `PLAYER_LEVEL`-Dual-Use-
   Bug (`docs/LEARNINGS.md` §11 „Vorgaben-Parsing: Substring-Matches …" bzw.
   §6 „`PLAYER_LEVEL` ist doppelt belegt") — Rasmus musste den Report Feld
   für Feld gegen die Parser-Zweige von Hand nachvollziehen, statt dass der
   Report selbst die Zuordnung zeigt. Score-Kriterium „Beobachtbarkeit"
   (`docs/roadmap/vision/score-criteria.md`) verlangt genau das Gegenteil:
   ein Diagnose-Feld pro bekanntem Fehlerbild.
4. **Copy-Paste-Duplikat im eigenen Diagnose-Report:**
   `ea-fc-sbc-optimizer.user.js:3927-3928` deklariert `rareConstraints:
   STATE.sbc.rareConstraints || []` zweimal identisch hintereinander im
   selben Objekt-Literal des Diagnose-Reports (bereits als Beleg in
   `docs/roadmap/patterns/bad/wissens-duplikate-ohne-ssot.md` gelistet). Der
   Report ist laut CLAUDE.md-Debugging-Konvention der einzige Kanal, über
   den Rasmus Fehlerbilder am Handy sieht — ein solches Copy-Paste-Relikt im
   selben Objekt signalisiert, dass der Report selbst nicht mit derselben
   Sorgfalt gepflegt wird wie die Fachlogik, die er beobachtbar machen soll.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`STATE.sbc.slots`-Lesestellen auf `STATE.sbc.formationSlots`
   umstellen:** an den vier Fundstellen `ea-fc-sbc-optimizer.user.js:576`,
   `:4795`, `:4816`, `:4916` `STATE.sbc.slots` durch `STATE.sbc.formationSlots`
   ersetzen (SSOT-Pattern aus `wissens-duplikate-ohne-ssot.md` befolgen: eine
   Quelle statt einer nie geschriebenen zweiten). **Verhaltensändernd** —
   `resolveFreshChallengeId()` und `matchesPlannedSbc()` werden dadurch
   erstmals scharf geschaltet und können Kandidaten ablehnen, die vorher
   durchgingen. Braucht laut Pattern-Vorgabe einen eigenen, brute-force-
   artigen Testfall in `solver-test.js` (z.B. zwei simulierte
   Set-Challenge-Knoten mit unterschiedlichem `formationSlots`, Assertion,
   dass `resolveFreshChallengeId`/`matchesPlannedSbc` den passenden Knoten
   wählt bzw. den falschen ablehnt) — kein stiller Fix nebenbei. Erwarteter
   Gain: **+6 bis +8 Pt RA** (behebt exakt den im `SCORE_RESULT.reasoning`
   genannten Hauptabzug „Slot-Disambiguierung faktisch tot").
2. **`deepScanChallenge`-Cluster per Marker extrahierbar machen und real
   testen:** analog zu `// [SOLVER-BEGIN]`/`// [SOLVER-END]`
   (`ea-fc-sbc-optimizer.user.js:1411`/`:2446`) ein eigenes Marker-Paar (z.B.
   `// [SBCSCAN-BEGIN]` vor `:317` / `// [SBCSCAN-END]` nach `:476`) um
   `scopeString`/`reqValue`/`reqIds`/`reqCount`/`isDomOrWindow`/
   `deepScanChallenge` legen und in `solver-test.js` per
   `fs.readFileSync` + Regex extrahieren (Pattern
   `eingebetteten-code-exakt-testen` befolgen — kein Nachbau). Anschließend
   Testfälle mit konstruierten EA-Objekten ergänzen, die die drei
   dokumentierten Live-Bugs aus `docs/LEARNINGS.md` §6/§11 exakt
   nachstellen: `PLAYER_RARITY_GROUP`-Gruppe 4 vs. Namens-Scope mit
   „RARE"-Substring, `PLAYER_LEVEL` mit Wert 1 (Qualität) vs. Wert 87
   (Rating). **Rein additiv** (nur neue Marker-Kommentare + neue Testdatei,
   keine Änderung an der Funktionslogik selbst) — kein Regressionsrisiko,
   `node --check` und volles `solver-test.js` danach trotzdem zur
   Bestätigung laufen lassen. Erwarteter Gain: **+8 bis +10 Pt RA**
   (schließt die im `SCORE_RESULT.reasoning` genannte fehlende Testbarkeit
   der Parsing-Kernlogik).
3. **Klassifizierungs-Zweig pro `reqDump`-Eintrag sichtbar machen:** in
   `out.reqs.push(...)` (`ea-fc-sbc-optimizer.user.js:382-389`) ein
   zusätzliches Feld `matchedAs` ergänzen (`'TEAM_RATING'`,
   `'PLAYER_LEVEL'`, `'PLAYER_QUALITY'`, `'RARITY'` oder `'unclassified'`,
   abgeleitet aus denselben `isTeamRating`/`isPlayerLevel`/
   `isQualityScope`-Bedingungen, die ohnehin schon berechnet werden).
   Pattern `diagnose-feld-statt-raten` befolgen. **Rein additiv** — nur ein
   neues Feld im Diagnose-Objekt, keine bestehende Zuweisung wird verändert;
   trotzdem einen `solver-test.js`-Smoke-Check ergänzen, der für die
   LEARNINGS-§6/§11-Fixtures (`PLAYER_LEVEL` Wert 1 / Wert 87 / Wert 15) das
   erwartete `matchedAs` prüft, damit das Feld nicht seinerseits undokumentiert
   drifted. Erwarteter Gain: **+4 bis +6 Pt RA** (Beobachtbarkeits-Kriterium
   aus `score-criteria.md`).
4. **Doppelte `rareConstraints`-Deklaration im Diagnose-Report entfernen:**
   `ea-fc-sbc-optimizer.user.js:3927-3928` — eine der beiden identischen
   Zeilen im Objekt-Literal streichen. Verhaltensneutral (Duplikat-Key wird
   von JS ohnehin durch sich selbst überschrieben, keine funktionale
   Änderung), trotzdem `node --check` + volles `solver-test.js` danach
   laufen lassen. Erwarteter Gain: **+1 bis +2 Pt RA** (Sorgfalt-Signal im
   Beobachtbarkeits-Kanal selbst).

## Edge-Cases (mind. 1 — M1)

- **`PLAYER_LEVEL`/`PLAYER_QUALITY`-Werte zwischen 4 und 39 fallen durch
  beide Klassifizierungs-Zweige:** `isPlayerLevel` akzeptiert nur `v >= 40`
  (`ea-fc-sbc-optimizer.user.js:405`), `isQualityScope` nur `v` zwischen 1
  und 3 (`:419`). Ein Wert dazwischen (z.B. eine künftige EA-Variante mit
  einer 5-stufigen Qualitätsskala) landet zwar im rohen `reqDump`
  (Push-Bedingung bei `:382-389` ist unabhängig vom Wertebereich), erzeugt
  aber weder eine Rarity-/Level- noch eine Quality-Constraint und damit
  keine Warnung — die Vorgabe verschwindet lautlos, exakt das Muster, das
  beim `PLAYER_LEVEL`-Dual-Use-Bug (LEARNINGS §6/§11) bereits einmal live
  aufgetreten ist. Bei jeder Lift-Aktion an dieser Stelle (insbesondere
  Aktion 3, `matchedAs`) sollte dieser Lückenbereich (`'unclassified'` bei
  vorhandenem `scope`+`value`) explizit mitgedacht werden, sonst bleibt er
  weiterhin unsichtbar.

## Lift-Empfehlung

Vorsichtig, mit klarer Testpflicht pro Schritt: Aktion 1 (Namensdrift-Fix)
ist die einzige verhaltensändernde Maßnahme und sollte isoliert mit eigenem
Brute-Force-artigem Testfall laufen, bevor Aktion 2 (Marker-Extraktion +
Parser-Tests) folgt — Aktion 2 profitiert davon, dass die Slot-Vergleiche
dann bereits scharf sind und in den neuen Fixtures mitgetestet werden
können. Aktionen 3 und 4 sind rein additiv/kosmetisch und können parallel
oder nachgelagert ohne Abhängigkeit zu den anderen laufen. Kein Kandidat für
einen aggressiven Ein-Schritt-Umbau, da RA bereits `pass` ist (65 ≥ 56) —
die Iteration darf sich Zeit für den Brute-Force-Testfall aus Aktion 1
nehmen, statt auf Geschwindigkeit zu optimieren (Q1).
