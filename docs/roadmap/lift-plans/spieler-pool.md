---
feature: spieler-pool
iteration: 0
score_current:
  RA: 70
score_target:                              # M3 (Ambitions-Regel): 70 + (85-70)*0.7 = 80.5 -> 80
  RA: 80
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
  - docs/LEARNINGS.md
patterns_required:                         # nur die zwei formal auf spieler-pool anwendbaren
                                           # guten Patterns (applies_to_features enthaelt
                                           # spieler-pool) - PK ist diese Iteration NICHT das
                                           # Ziel, siehe Hinweis in der Marschroute
  - ea-grenz-fallback-ketten
  - warum-kommentare-mit-live-belegen
pk_files_to_cite: []
citation_only: false
shared_items_required:
  - fehler-sichtbarkeit-diagerror
  - test-extraktions-helfer
priority: P2-normal                        # Override der Sigma-Gain-Heuristik (Sigma Gain-Mittelwerte
                                           # ~16 Punkte -> Heuristik waere P3-deferred): Aktion 1/3
                                           # schliesst eine sicherheitsrelevante Beobachtbarkeits-Luecke
                                           # an der harten "gesperrte Karten NIEMALS verbauen"-Regel
                                           # (CLAUDE.md); das rechtfertigt hoehere Prioritaet als reiner
                                           # Punkte-Gain nahelegt.
effort: S                                  # Override: phase_sequence hat 5 Glieder (fixer 5-Phasen-
                                           # Workflow, gilt für JEDES pittools-Feature identisch aus
                                           # CLAUDE.md), sagt hier nichts über den Umfang. Alle vier
                                           # Aktionen sind additiv/klein (3 diagError-Zeilen, 2 Testbloecke
                                           # nach Vorbild, 1 Doku-Abschnitt) - kein Umbau bestehender Logik.
analyzed_at: '2026-08-14'
---

# Lift-Plan — Spieler-Pool (Laden, Normalisierung, Sperren)

## Marschroute

Alle vier Aktionen sind additiv und verändern KEINE bestehende Lade-,
Normalisierungs- oder Filterlogik (Evolutions-/Leihspieler-/Konzept-Ausschluss,
PaleTools-Lock-Traversierung bleiben inhaltlich unangetastet — nur getestet).
Der Club-Lade-Takt (LEARNINGS §7, Kommentar `ea-fc-sbc-optimizer.user.js:1247-1253`)
wird von keiner Aktion berührt.

Reihenfolge folgt dem `phase_sequence` aus `vision/features/spieler-pool.md`
(`core → diagnose → tests → docs → release`), wobei `core` diese Iteration
LEER bleibt — es gibt bewusst keine Logik-Änderung, nur Beobachtbarkeit,
Tests und Doku:

1. **`diagnose`** — `diagError` additiv an drei bestehenden Catch-Blöcken
   ergänzen (schließt den größten Cluster-Antipattern
   [[fehler-unsichtbar-verschluckt]], der laut `gaps/_cross-cutting.md` in
   5 Features auftritt).
2. **`tests`** — zwei neue Testblöcke in `solver-test.js`, die die echte,
   ausgelieferte `normalizePlayer`/`isEvolution`- bzw.
   `readPaletoolsLocks`/`harvestIds`/`findLockBranches`-Logik per
   Marker-Extraktion ausführen (Vorbild: der bereits grüne
   `fetchClubViaHttp`-Test, `solver-test.js:1034-1118`).
3. **`docs`** — `docs/LEARNINGS.md` um `## 23.` ergänzen, damit die
   Referenz in `CLAUDE.md` und `vision/features/spieler-pool.md` (beide
   nennen „LEARNINGS §23") nicht mehr ins Leere zeigt (die Datei endet
   aktuell bei `## 22.`).
4. **`release`** — Versionsbump (`@version` + `const VERSION`) für den
   kombinierten Change, `node --check` + `node solver-test.js` grün, Push
   auf `main` (CLAUDE.md eiserner Arbeitsablauf).

Zwei formal auf `spieler-pool` anwendbare gute Patterns
([[ea-grenz-fallback-ketten]], [[warum-kommentare-mit-live-belegen]]) sind
bereits im bestehenden Code eingehalten (`loadPool()`-Fallback-Kette bzw. der
Club-Lade-Takt-Kommentar) — diese Iteration fügt keine neuen Code-Belege für
sie hinzu, weil kein PK-Ziel gesetzt ist (`pk_files_to_cite: []`). Zwei
weitere im Gap-Report zitierte Muster ([[diagnose-feld-statt-raten]],
[[eingebetteten-code-exakt-testen]]) leiten die Aktionen 1 bzw. 2 inhaltlich
an, sind aber in ihren eigenen `applies_to_features`-Listen aktuell NICHT auf
`spieler-pool` erweitert — das ist hier nicht zu beheben (Pattern-Docs liegen
außerhalb der `primary_paths` dieses Plans) und wird unter Risiken vermerkt.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`diagError` additiv an drei Catch-Stellen ergänzen** (Pfad:
   `ea-fc-sbc-optimizer.user.js`):
   - `:1334` (`fetchUnassignedViaHttp`, `catch (e) { warn('Unassigned-Fetch Fehler:', e); }`)
     → zusätzlich `diagError('Unassigned-Fetch Fehler: ' + (e.message || e));`
   - `:1346` (`fetchStorageViaHttp`, `catch (e) { warn('storagepile-Fetch Fehler:', e.message); }`)
     → zusätzlich `diagError('storagepile-Fetch Fehler: ' + e.message);`
   - `:907` (`readPaletoolsLocks`, äußerer Catch um die gesamte
     `localStorage`-Scan-Schleife, `catch (e) { warn('Locks lesen fehlgeschlagen:', e && e.message); }`)
     → zusätzlich `diagError('Locks lesen fehlgeschlagen: ' + (e && e.message));`
   Rein additiv (kein Verhaltens-Umbau), analog zum bereits vorhandenen
   Muster in `apiGet`/`apiPut` (`:1190,1202,1218,1231`) und im
   Services-Fallback von `loadPool` (`:1372-1379`, `diagError('Services-Fallback: ' + ...)`).
   **Erwarteter Gain: +3 bis +5** (Kriterium „Beobachtbarkeit").

2. **Testblock für `normalizePlayer`/`isEvolution` per Marker-Extraktion**
   (Pfad: `solver-test.js`, neuer Abschnitt nach dem Vorbild „8b-2h" bei
   `solver-test.js:1027-1118`): `src.indexOf('function isEvolution')` bis
   `src.indexOf('function normalizePlayer')` bzw. bis
   `src.indexOf('function resolvePlayerName')` als Grenzen nutzen (identisches
   Extraktionsprinzip wie beim `fetchClubViaHttp`-Test), beide Funktionen
   gemeinsam kompilieren (sie rufen sich gegenseitig:
   `normalizePlayer` → `isEvolution`). Fixtures mit ROHEN EA-Feldern (nicht
   dem normalisierten Zielschema):
   - `{ loans: 1, rating: 84, id: 1 }` → `null` (Leihspieler)
   - `{ concept: true, rating: 84, id: 1 }` → `null` (Konzept)
   - `{ academyId: 5, rating: 84, id: 1 }` → `null` (Evolution)
   - `{ tradableBeforeAcademy: false, rating: 84, id: 1 }` → `null` (Evolution,
     live-verifizierter Sonderfall laut Code-Kommentar `:779-780`)
   - `{ itemType: 'club', rating: 84, id: 1 }` → `null` (kein Spieler)
   - fehlendes `rating`/`id` → `null`
   - gültige Karte (`{ id: 1, rating: 84, rareflag: 1 }`) → normalisiertes
     Objekt mit `isRare === true`, `isGold === true`
   - **Reihenfolge-Fixture** (Edge-Case aus dem Gap-Report): ein Objekt mit
     SOWOHL `loans: 1` ALS AUCH gültigem `rating` MUSS weiterhin `null`
     liefern — verhindert, dass ein künftiger Refactor die Ausschluss-Checks
     umsortiert und eine geliehene Karte durchlässt.
   Erwartungswerte gegen die in LEARNINGS §2 (Zeile 37-59) dokumentierten
   Ausschlussregeln verifizieren, nicht aus dem Kopf. **Erwarteter Gain: +4
   bis +6** (Kriterium „Testbarkeit" für die harte NIEMALS-verbauen-Regel bei
   Evolutions/Leihspielern/Konzept-Karten).

3. **Testblock für `readPaletoolsLocks`/`harvestIds`/`findLockBranches`
   end-to-end** (Pfad: `solver-test.js`, Erweiterung des Abschnitts „8b-4"
   bei `solver-test.js:1237-1269`, der aktuell NUR `looksLikeItemId` isoliert
   testet): alle drei Funktionen gemeinsam extrahieren
   (`src.indexOf('function looksLikeItemId')` bis
   `src.indexOf('function readPaletoolsLocks')` + deren Funktionskörper bis
   zum schließenden `}` vor dem nächsten `// ---- Namen zur ANZEIGEZEIT`-Kommentar,
   `:917`), einen simulierten `localStorage`-Objekt bauen (`getItem`,
   `length`, `key(i)` als Attrappen wie im `fetchClubViaHttp`-Testmuster) mit
   MEHREREN `paletools:*`-Keys in EINER Instanz:
   - `paletools:locks:lockedItems` = `[100664921, 190871, 225733]` (Array-Form)
   - `paletools:profile:lockedItemsMap` = `{ '50332136': true, '83923656': false }`
     (Objekt-Form — der `false`-Eintrag darf NICHT als gesperrt zählen)
   - `paletools:packs:lockedPacks` = `[1030, 20038]` (Pack-IDs, MÜSSEN
     ausgeschlossen bleiben — Koexistenz-Test mit den Item-Locks oben in
     DERSELBEN `localStorage`-Instanz, nicht isoliert)
   - ein verschachtelter Zweig (`{ meta: { nested: { locked: [190871] } } }`)
     für `findLockBranches`' Rekursion
   Assertions: `ids` enthält alle drei echten IDs, enthält NICHT `1030`/`20038`,
   `STATE.diag.locks.found` stimmt, `keysScanned` zählt korrekt. Erwartungswerte
   aus der in LEARNINGS §12 (Zeile 543-563) dokumentierten Live-Struktur
   ableiten. **Erwarteter Gain: +4 bis +6** (Kriterium „Testbarkeit" — die
   eigentliche Traversierung war bisher ungetestet, nur `looksLikeItemId`
   isoliert).

4. **`docs/LEARNINGS.md` um `## 23.` ergänzen** (rein additive Doku, kein
   Code-Umbau): neuer Abschnitt nach `## 22.` (Datei endet aktuell dort,
   `docs/LEARNINGS.md:823-858`), der den bereits im Code-Kommentar
   (`ea-fc-sbc-optimizer.user.js:1247-1253`) beschriebenen Club-Lade-Takt
   dokumentiert — Takt zwischen den Starts statt Schlafen danach (300ms,
   wächst bei jedem Fehlversuch auf max. 900ms), mit Verweis auf die
   Commits `bb76012` und `27275df`. Schließt die Lücke, dass `CLAUDE.md`
   („Der Club-Lade-Takt (LEARNINGS §7 und §23)…") und
   `vision/features/spieler-pool.md` (`code_geography`) auf einen Abschnitt
   verweisen, den es bisher nicht gibt. **Erwarteter Gain: +2 bis +3**
   (Kriterium „Dokumentierte Begründung").

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core     | — (keine Logik-Änderung diese Iteration; alle vier Aktionen sind additiv) |
| diagnose | Aktion 1 (`diagError` an `:1334`, `:1346`, `:907`) |
| tests    | Aktion 2 (`normalizePlayer`/`isEvolution`-Testblock), Aktion 3 (`readPaletoolsLocks`/`harvestIds`/`findLockBranches`-Testblock) |
| docs     | Aktion 4 (`docs/LEARNINGS.md` `## 23.`) |
| release  | Versionsbump (`@version` + `const VERSION`), `node --check` + `node solver-test.js` grün, Push auf `main` |

## Shared-Item-Bedarf

Zwei Cross-Feature-Kandidaten aus `gaps/_cross-cutting.md` (Cluster 1 und 4),
für die `spieler-pool` einer von mehreren Konsumenten ist — Details und
Begründung im JSON-Sidecar `spieler-pool.shared-items.json`:

- **`fehler-sichtbarkeit-diagerror`** (`bundle_hint: beobachtbarkeit`): Aktion 1
  dieses Plans ist ein Konsument. Der Cluster-Befund
  (`fehler-unsichtbar-verschluckt`, `applies_to_features: [spieler-pool,
  ea-app-anbindung, android-app-wrapper, diagnose-werkzeuge, batch-modus]`)
  zeigt denselben Antipattern an mindestens 10 Stellen über 5 Features. Die
  Wurzelursache (`fehler-unsichtbar-verschluckt.md`, Abschnitt
  „Beziehungen") benennt explizit das fehlende SSOT: kein gemeinsamer
  `reportError(msg, e)`-Wrapper (`warn()` + `diagError()` in einem Aufruf),
  der die Report-Pflicht strukturell erzwingt statt sie vom Autor-Moment an
  jeder Call-Site abhängig zu machen.
- **`test-extraktions-helfer`**: Aktionen 2+3 dieses Plans sind Konsumenten.
  `gaps/_cross-cutting.md` Cluster 4 listet 5 Features mit derselben Lücke
  (Marker-Extraktion + Ausführung einer benannten Funktion aus der
  ausgelieferten Datei), von denen jedes den in `solver-test.js` bereits
  zehnfach wiederholten Boilerplate „`indexOf('function X')` → Textblock
  ausschneiden → `new Function(...)`/`eval(...)`" erneut von Hand nachbaut
  (siehe `aspect-tests.md`, Antipattern „Wiederholtes Neu-Einlesen der
  Zieldatei"). Ein gemeinsamer Test-Helfer
  (`extractFunction(src, name[, endMarker])`) würde diese Iteration UND alle
  künftigen Test-Erweiterungen an eingebettetem Code treffen.

## Risiken / Edge-Cases

- **Reihenfolge-Falle bei `normalizePlayer`-Tests:** ein Fixture mit SOWOHL
  `loans>0` ALS AUCH gültigem `rating` muss weiterhin ausgeschlossen werden —
  der Test darf die Check-Reihenfolge in der Funktion nicht durch eine
  vereinfachte Fixture-Form umgehen; `isEvolution` muss weiterhin VOR jeder
  Rare/Gold-Einstufung greifen.
- **Koexistenz-Falle bei `readPaletoolsLocks`-Tests:** `lockedPacks` und
  `lockedItems`/`lockedItemsMap` müssen in DERSELBEN simulierten
  `localStorage`-Instanz nebeneinander vorkommen, nicht nur isoliert getestet
  — sonst könnte ein künftiger Fix für den Pack-Ausschluss versehentlich
  brauchbare Item-Locks mitverwerfen (Regression zu LEARNINGS §12).
- **Club-Lade-Takt tabu:** LEARNINGS §7/§23 und CLAUDE.md „Nicht anfassen
  ohne Grund" — keine der vier Aktionen darf `fetchClubViaHttp` oder den
  bereits grünen Test `solver-test.js:1034-1118` berühren; neue
  Marker-Extraktionen (Aktion 2, 3) müssen an eigenen, nicht überlappenden
  Funktionsgrenzen ansetzen.
- **Konzept-/Locks-Filterregeln inhaltlich unverändert:** Aktionen 2 und 3
  fügen ausschließlich Tests hinzu; findet ein Test eine ECHTE Abweichung
  vom dokumentierten Verhalten (LEARNINGS §2/§12), ist das ein Klasse-D/Q2-Fall
  (Implementer meldet `aborted-quality-violation` statt die Erwartung an den
  Bug anzupassen) — kein Symptom-Fix am Test.
- **Pattern-Doc-Lücke (kein Blocker, nur Beobachtung):** `diagnose-feld-statt-raten`
  und `eingebetteten-code-exakt-testen` leiten Aktion 1 bzw. 2/3 inhaltlich an,
  führen `spieler-pool` aber (noch) nicht in ihrer eigenen
  `applies_to_features`-Liste. Das hat keine Auswirkung auf diese
  RA-Iteration (PK ist nicht Ziel), wäre aber für eine spätere PK-Iteration
  ein Pattern-Amendment-Kandidat (Main).
- **Versionsbump/Test-Gate:** wie bei jedem Change zwingend
  `node --check ea-fc-sbc-optimizer.user.js` und `node solver-test.js`
  (alle Tests grün) vor Push — bei Solver-fremden reinen Test-/Doku-Änderungen
  trotzdem voller Lauf, da `solver-test.js` eine einzige Datei ist und neue
  Blöcke bestehende nicht brechen dürfen.

## Lift-Plan-Pre-Validation (M2)

Plugin prüft deterministisch via `plan estimate --feature=spieler-pool`:
da `pk_files_to_cite: []` und keine PK-Aktion enthalten ist, betrifft die
Prüfung nur `score_target.RA (80) ≤ min(structural_max=85, achievable_ceiling)`
sowie das Fehlen von Targets auf nicht-fokussierten Dimensionen (FOCUSED_DIMENSIONS
ist leer, daher keine Einschränkung). Erwarteter RA-Endwert aus Summe der
Aktionsgains (Mittelwerte 4+5+5+2.5 = 16.5) auf `score_current.RA=70` ergibt
komfortabel ≥ `score_target.RA×0.9 = 72`.
