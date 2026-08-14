---
feature: spieler-pool
analyzed_at: 2026-08-14
iteration: 0
regression: false
score_current:
  RA: 70
score_target:
  RA: 78
---

# Gap-Report — Spieler-Pool (Laden, Normalisierung, Sperren)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 70 / 85
**Schwellwert:** 59.5 (85 × 0.7)
**Status:** pass
**Begründung:** Der `audit-evaluator` bewertet die Fallback-Kette an der EA-Grenze
(`loadPool()`, `fetchClubViaHttp`) als solide — gerade der fragilste Teil (Club-Lade-Takt,
LEARNINGS §7/§23) ist über eine echte Funktionssimulation abgedeckt
(`solver-test.js:1034-1116`). Zwei strukturelle Lücken drücken den Wert unter das
strukturelle Maximum: (1) Beobachtbarkeit ist inkonsistent — mehrere reportwürdige
Catches in Pool-Lade- und Lock-Pfaden rufen nur `warn()`, kein `diagError()`
(`ea-fc-sbc-optimizer.user.js:1334`, `:1346`, `:907`); (2) Testbarkeit ist für die
Normalisierungs- und Lock-Harvest-Logik nicht eingelöst — `normalizePlayer`/`isEvolution`
werden nirgends direkt getestet, `readPaletoolsLocks`/`harvestIds`/`findLockBranches`
nur in einem isolierten Teilaspekt (`looksLikeItemId`).

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **Fehlende `diagError` an reportwürdigen Pool-Catches (Antipattern
   `fehler-unsichtbar-verschluckt`):** `ea-fc-sbc-optimizer.user.js:1334`
   (`fetchUnassignedViaHttp`) und `:1346` (`fetchStorageViaHttp`) rufen bei einem
   fehlgeschlagenen Fetch nur `warn(...)`. `loadPool()` löst bei leerem Storage bereits
   einen Toast aus (`:1391-1394` — "ACHTUNG: Pool evtl. unvollständig geladen"), aber die
   URSACHE (HTTP-Fehler, Statuscode) landet nicht in `STATE.diag.lastErrors` und damit
   nicht im kopierbaren Report — am Gerät ist sie für Rasmus unsichtbar (kein DevTools).
2. **`readPaletoolsLocks`-Gesamtcatch ohne `diagError`:** `ea-fc-sbc-optimizer.user.js:907`
   fängt die gesamte `localStorage`-Scan-Schleife mit nur `warn('Locks lesen
   fehlgeschlagen:', ...)`. Ein Abbruch mitten in der Schleife hinterließe eine
   unvollständige Sperrliste, ohne dass der Report das zeigt — sicherheitsrelevant, weil
   CLAUDE.md gesperrte Karten "NIEMALS verbauen" verlangt und ein stiller Teilausfall
   genau das unterlaufen könnte.
3. **`normalizePlayer`/`isEvolution` ungetestet gegen rohe EA-Objektformen:**
   `solver-test.js:27-47` (Helper `P()`) erzeugt Testkarten direkt im NORMALISIERTEN
   Zielschema (`isGold`, `isRare`, `isStorage`, …) — kein Testblock extrahiert und ruft
   die echte, aus der Datei stammende `normalizePlayer`/`isEvolution`
   (`ea-fc-sbc-optimizer.user.js:770-823`) mit rohen Feldern (`academyId`, `loans`,
   `concept`, `itemType`, fehlendes `rating`/`id`) auf. Die in LEARNINGS §2 (Zeile 37-59)
   dokumentierten Ausschlussregeln (Evolutions, Leihspieler, Konzept-Spieler) sind damit
   nicht per Test abgesichert, obwohl sie eine harte Produktregel sind.
4. **`readPaletoolsLocks`/`harvestIds`/`findLockBranches` nicht end-to-end getestet:**
   `solver-test.js:1237-1269` prüft nur `looksLikeItemId` isoliert (per String-Slice +
   `eval`) sowie den Pack-Ausschluss als reinen TEXT-Vorhandensein-Check
   (`/pack\/i\.test\(k\)/.test(src)` bei Zeile 1263-1265) statt als Verhalten gegen einen
   simulierten `localStorage` mit mehreren `paletools:*`-Keys, `lockedItems` als Array
   UND als Objekt-Keys, sowie `lockedPacks` parallel zu echten Lock-Zweigen. Die
   eigentliche Traversierung (`findLockBranches`, verschachtelte Zweige,
   `harvestIds`-Rekursionstiefe) bleibt ungetestet.
5. **LEARNINGS.md fehlt §23, obwohl referenziert:** `CLAUDE.md` ("Der Club-Lade-Takt
   (LEARNINGS §7 und §23)…") und `docs/roadmap/vision/features/spieler-pool.md`
   (`code_geography`: "docs/LEARNINGS.md — §2, §7, §12, §16, §23") verweisen auf einen
   Abschnitt §23; `docs/LEARNINGS.md` endet aber bei §22 (`docs/LEARNINGS.md:823-858`,
   Gesamtlänge 858 Zeilen, kein `## 23.` vorhanden). Die "Dokumentierte
   Begründung"-Anforderung der RA-Rubric ist für die jüngste Takt-Verfeinerung
   (Kommentar `ea-fc-sbc-optimizer.user.js:1247-1253` referenziert im Text nur §7) nicht
   eingelöst — die Referenz zeigt ins Leere.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`diagError` additiv an den drei Catch-Stellen ergänzen:**
   `ea-fc-sbc-optimizer.user.js:1334`, `:1346` und `:907` je um einen zusätzlichen
   `diagError(...)`-Aufruf NEBEN dem bestehenden `warn(...)` erweitern (Pfad:
   `ea-fc-sbc-optimizer.user.js`), analog zum bereits vorbildlichen Muster im
   Services-Fallback von `loadPool` (`:1372-1379`) und in `apiGet`/`apiPut`
   (`:1190,1202,1218,1231`). Rein additiv, kein Verhaltens-Umbau, keine Regression.
   Erwarteter Gain: +3 bis +5 Punkte (schließt die vom Bad-Pattern-Dokument
   `fehler-unsichtbar-verschluckt` explizit für `spieler-pool` benannte Lücke,
   Kriterium "Beobachtbarkeit").
2. **Testblock für `normalizePlayer`/`isEvolution` per Marker-Extraktion (Pfad:
   `solver-test.js`, neuer Abschnitt nach dem Vorbild `8b-2h` bei Zeile 1027-1118):**
   die echte Funktion via `indexOf('function normalizePlayer')` /
   `indexOf('function isEvolution')` aus der ausgelieferten Datei extrahieren (Muster
   `eingebetteten-code-exakt-testen`, wie bereits für `fetchClubViaHttp` gemacht) und mit
   rohen Fixtures durchspielen: `loans>0`, `concept===true`, `academyId>0`,
   `tradableBeforeAcademy` gesetzt, `itemType!=='player'`, fehlendes `rating`/`id`.
   Erwartungswerte gegen die in LEARNINGS §2 (Zeile 37-59) dokumentierten Live-Flags
   verifizieren, nicht aus dem Kopf. Erwarteter Gain: +4 bis +6 Punkte (Kriterium
   "Testbarkeit" für die harte NIEMALS-verbauen-Regel bei Evolutions).
3. **Testblock für `readPaletoolsLocks`/`harvestIds`/`findLockBranches` end-to-end
   (Pfad: `solver-test.js`, Erweiterung von Abschnitt `8b-4` bei Zeile 1237-1269):**
   die drei Funktionen zusammen extrahieren, einen simulierten `localStorage`
   (Objekt mit `getItem`/`length`/`key`) mit mehreren `paletools:*`-Keys bauen —
   `lockedItems` als Array (`[100664921, 190871, ...]`) UND als Objekt-Keys-Variante,
   `lockedPacks` mit Pack-IDs parallel dazu, sowie einen verschachtelten Zweig für
   `findLockBranches`. Erwartungswerte aus der in LEARNINGS §12 (Zeile 543-563)
   dokumentierten Live-Struktur ableiten. Erwarteter Gain: +4 bis +6 Punkte (schließt
   die im SCORE_RESULT explizit benannte Lücke "Lock-Harvest-Logik ungetestet").
4. **LEARNINGS.md um §23 ergänzen (Pfad: `docs/LEARNINGS.md`, rein additive Doku, kein
   Code-Umbau):** den bereits im Code-Kommentar (`ea-fc-sbc-optimizer.user.js:1247-1253`)
   und in `CLAUDE.md` referenzierten Club-Lade-Takt-Sachverhalt (Takt zwischen den
   Starts statt Schlafen danach, Selbstbremse bei Fehlversuchen; Commits `bb76012`,
   `27275df`) als eigenen Abschnitt `## 23.` nachtragen, damit die Referenz in `CLAUDE.md`
   und `vision/features/spieler-pool.md` nicht ins Leere zeigt. Erwarteter Gain: +2 bis
   +3 Punkte (Kriterium "Dokumentierte Begründung").

## Edge-Cases (mind. 1 — M1)

- Reihenfolge-Falle bei neuen `normalizePlayer`-Tests: ein Fixture mit SOWOHL `loans>0`
  ALS AUCH gültigem `rating` muss weiterhin ausgeschlossen werden — der Test darf die
  Check-Reihenfolge in der Funktion nicht durch eine vereinfachte Fixture-Form umgehen;
  ebenso muss `isEvolution` weiterhin VOR jeder Rare/Gold-Einstufung greifen, damit ein
  Evolutions-Item nie versehentlich mit gültiger `rareflag` in `mergeIntoPool` landet.
- Koexistenz-Falle bei `readPaletoolsLocks`-Tests: `lockedPacks` und `lockedItems` müssen
  in DERSELBEN simulierten `localStorage`-Instanz nebeneinander vorkommen (nicht nur
  isoliert getestet) — sonst könnte ein künftiger Fix für den Pack-Ausschluss
  versehentlich brauchbare Item-Locks mitverwerfen (Regression zu LEARNINGS §12).
- Club-Lade-Takt (LEARNINGS §7/§23, CLAUDE.md "Nicht anfassen ohne Grund") darf durch
  keine der obigen Aktionen berührt werden: neue Marker-Extraktionen müssen exakt an den
  bestehenden Funktionsgrenzen (`indexOf('async function fetchClubViaHttp')` /
  `indexOf('async function fetchUnassignedViaHttp')`) ansetzen, sonst bricht der bereits
  grüne Test `solver-test.js:1034-1118`.

## Lift-Empfehlung

Vorsichtig-additiv: alle vier Aktionen sind rein additive Ergänzungen (neue
`diagError`-Aufrufe, neue Testblöcke, ein neuer LEARNINGS-Abschnitt) ohne Eingriff in
bestehende Lade-/Normalisierungs-Logik oder den Club-Lade-Takt. Reihenfolge:
`diagError`-Ergänzungen zuerst (Aktion 1, geringstes Risiko, sofortiger Beobachtbarkeits-
Gewinn), danach die beiden Testblöcke (Aktionen 2+3, je nach Vorbild
`fetchClubViaHttp`-Test bei `solver-test.js:1034-1116`), zuletzt die LEARNINGS-Ergänzung
(Aktion 4, reine Doku). Kein Mid-Iter-SI nötig — keine der Aktionen hat Konsumenten
außerhalb von `spieler-pool`.
