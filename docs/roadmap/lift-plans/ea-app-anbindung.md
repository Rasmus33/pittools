---
feature: ea-app-anbindung
iteration: 0
score_current:
  RA: 64
score_target:
  RA: 72
primary_paths:
  - pittools/ea-fc-sbc-optimizer.user.js
  - pittools/solver-test.js
patterns_required:
  - diagnose-feld-statt-raten
  - warum-kommentare-mit-live-belegen
  - eingebetteten-code-exakt-testen
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P3-deferred
effort: S
analyzed_at: 2026-08-14
---

# Lift-Plan — EA-Web-App-Anbindung (Session & API-Zugriff)

## Marschroute

Vorsichtige, rein additive Iteration entlang des eisernen Arbeitsablaufs
(core → diagnose → tests → docs → release). Kein Verhaltens-Umbau an
Submit-Weg 0 (`submitViaApp`) oder am Club-Lade-Takt (`fetchClubViaHttp`) —
beide bleiben laut CLAUDE.md „Nicht anfassen ohne Grund" unangetastet.

Reihenfolge:

1. **`core`** — `(sbs|sbc)`-Wissen hinter eine benannte Konstante ziehen,
   Call-Sites EINZELN umziehen (SSOT, Q5).
2. **`diagnose`** — `diagError` additiv in die drei Fehler-Catches ergänzen,
   die aktuell nur `warn()` rufen (Beobachtbarkeits-Lücke, Q5/Antipattern
   `fehler-unsichtbar-verschluckt`).
3. **`tests`** — neuer, extraktionsbasierter Testblock für
   `detectApiBase`/`classifyUrl` (bislang **keine** Coverage in
   `solver-test.js`), da die SSOT-Migration sonst nicht „einzeln getestet"
   im Sinne des Gap-Reports verifiziert werden kann; danach `node --check`
   + `node solver-test.js` komplett grün nach jedem Migrationsschritt.
4. **`docs`** — `LEARNINGS.md` §3/§4 um den Verweis auf die neue
   Präfix-Konstante ergänzen; WARUM-Kommentare an der neuen Konstante UND
   an der bewusst NICHT extrahierten `apiGet`/`apiPut`-Retry-Kaskade
   (Begründung: fehlende Test-Coverage für die Kaskade, siehe Risiken).
5. **`release`** — Version bumpen (`@version` + `const VERSION`), Push auf
   `main`.

Die im Gap-Report vorgeschlagene `apiRequest(method, path, body, _attempt)`-
Extraktion ist **NICHT** Teil dieser Iteration: sie ist innerhalb der
verfügbaren Testinfrastruktur nicht verhaltensneutral belegbar (Details unter
Risiken). Ebenso NICHT Teil dieser Iteration: die Controller-Helfer-Nutzung
in `syncSbcWithOpenChallenge`/`submitViaApp` (Gap-Aktion 4) — vom Auftrag
für diese Iteration nicht angefordert, würde zudem den kritischen
Submit-Pfad berühren.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`diagError` additiv in die drei Services-/Sync-Fehler-Catches
   ergänzen:** In `fetchUnassignedViaServices`
   (`ea-fc-sbc-optimizer.user.js:1090-1101`, Catch `:1100`) und
   `fetchStorageViaServices` (`:1103-1120`, Catch `:1118`) je einen
   `diagError('Unassigned via Service: ' + (e.message || e))` bzw.
   `diagError('Storage via Service: ' + (e.message || e))` NEBEN das
   bestehende `warn()` setzen. Gleiches additiv in
   `syncSbcWithOpenChallenge` (`:742-764`, Catch `:762`):
   `diagError('SBC-Sync fehlgeschlagen: ' + e.message)`. Reine Ergänzung,
   kein Kontrollfluss-Umbau — kein neuer Testfall zur
   Verhaltensprüfung nötig, nur `node --check` + `node solver-test.js`
   (aktuell 95/95) grün halten. Erwarteter Gain: +4-6 Pt (schließt die
   „Beobachtbarkeitslücke im Services-Fallback"-Kritik aus der
   Score-Begründung direkt, deckungsgleich mit dem Antipattern
   `fehler-unsichtbar-verschluckt`).
2. **`(sbs|sbc)`-Regex hinter eine benannte Konstante ziehen, Call-Sites
   EINZELN umziehen — MIT vorgeschalteter Test-Lücken-Schließung:**
   Zuerst `const SBS_SBC_PREFIX_RE_SRC = 'sbs|sbc';` direkt vor
   `detectApiBase` (`ea-fc-sbc-optimizer.user.js:168`) einführen. Da
   `solver-test.js` aktuell **keine** einzige Assertion für
   `detectApiBase`/`classifyUrl` enthält (verifiziert: kein Treffer für
   `classifyUrl`/`detectApiBase`/`apiPrefix` in `solver-test.js`), zuerst
   einen neuen Testblock ergänzen, der beide Funktionen per
   Marker-/Slice-Extraktion einliest (Muster
   `eingebetteten-code-exakt-testen`) und bekannte `sbs`- und `sbc`-Varianten
   aller vier Endpunkt-Formen (`sbc-set-challenges`, `sbc-challenge`,
   `sbc-sets`, `storage`-Fallback) korrekt klassifiziert. Erst danach
   NACHEINANDER migrieren: `detectApiBase` (`:187`), die vier Vorkommen in
   `classifyUrl` (`:197`, `:198`, `:200`, `:205`), XHR-Wrapper-Body-Check
   (`:291`) — jede Umstellung einzeln gegen den neuen Test UND
   `node solver-test.js` (dann 96+/96+ grün) verifizieren, weil
   `classifyUrl` das Response-Routing steuert und ein Fehlgriff Pool/SBC-
   Erkennung STUMM falsch befüllen würde. Erwarteter Gain: +3-5 Pt
   (SSOT-Kritik behoben, macht künftige EA-Präfix-Änderungen an einer
   Stelle statt an sechs robust; zusätzlich schließt der neue Test eine
   bislang unentdeckte Testbarkeits-Lücke — beides direkt
   rubric-relevant: „Testbarkeit" + „Fehlertoleranz gegen EA-Wandel").
3. **`apiRequest`-Extraktion — AUSGESCHLOSSEN aus dieser Iteration, als
   Risiko dokumentiert:** Die im Gap-Report vorgeschlagene gemeinsame
   `apiRequest(method, path, body, _attempt)`-Kern-Extraktion aus `apiGet`
   (`:1184-1206`) und `apiPut` (`:1207-1235`) wird NICHT umgesetzt. Prüfung
   ergab: `solver-test.js` hat aktuell KEINE Coverage der 401-Retry-Kaskade
   (der einzige `apiGet`-Treffer in `solver-test.js:1054` ist eine
   Attrappe für den Pagination-Loader-Test, nicht die Kaskade selbst) —
   „verhaltensneutral" ist damit nicht automatisiert belegbar, nur über
   einen manuellen 401-Smoke-Test am Gerät (kein Bestandteil des
   `node solver-test.js`-Laufs). Zusätzliches Risiko: der `_attempt`-Zähler
   muss PRO Methode/Pfad zählen (siehe Edge-Case im Gap-Report) — eine
   gemeinsame Kern-Funktion darf einen laufenden GET- und PUT-Retry nicht
   denselben Zähler teilen lassen. Statt der Extraktion: WARUM-Kommentar an
   `apiGet`/`apiPut` ergänzen, der die bewusste Nicht-Extraktion und den
   fehlenden Test-Unterbau benennt (Q6, analog zur dokumentierten
   Nicht-Anfassen-Begründung von `submitViaApp`). Gain dieser Iteration:
   0 Pt aus der Extraktion selbst; der WARUM-Kommentar trägt zum
   „Dokumentierte Begründung"-Kriterium bei (in Aktion 4 mitgezählt).
   Kandidat für eine Folge-Iteration, sobald ein Mock-Testharness für
   `apiGet`/`apiPut` (analog zum bestehenden `fetchClubViaHttp`-Test,
   `solver-test.js:1034-1069`) existiert.
4. **WARUM-Kommentar-Nachrüstung + `LEARNINGS.md`-Verweis:** Sobald Aktion
   1/2 umgesetzt sind: (a) WARUM-Kommentar an `SBS_SBC_PREFIX_RE_SRC`, der
   auf LEARNINGS §3 verweist und die vorher sechsfache Duplikation nennt;
   (b) WARUM-Kommentar an `apiGet`/`apiPut` (siehe Aktion 3), der die
   bewusst unterlassene Extraktion und den Grund (fehlende
   Retry-Kaskaden-Coverage) festhält; (c) `LEARNINGS.md` §3 („API-Zugriff")
   um einen Absatz ergänzen, dass `sbs`/`sbc`-Erkennung jetzt zentral über
   `SBS_SBC_PREFIX_RE_SRC` läuft, UND §4 um den Hinweis, dass die
   401-Retry-Kaskade in `apiGet`/`apiPut` bewusst dupliziert bleibt (Verweis
   auf diesen Lift-Plan als Grund). Erwarteter Gain: +1-2 Pt
   (Rubric-Kriterium „Dokumentierte Begründung fragiler Stellen" laut
   `score-criteria.md`, Voraussetzung dafür, dass Aktion 2 und die
   bewusste Nicht-Aktion 3 nicht wieder aus dem Gedächtnis geraten).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 2: `SBS_SBC_PREFIX_RE_SRC`-Konstante einführen, `detectApiBase`/`classifyUrl` (4×)/XHR-Wrapper einzeln umziehen |
| diagnose | Aktion 1: `diagError` in `fetchUnassignedViaServices`, `fetchStorageViaServices`, `syncSbcWithOpenChallenge` ergänzen |
| tests | Neuer `detectApiBase`/`classifyUrl`-Testblock in `solver-test.js` (Voraussetzung für Aktion 2); `node --check` + `node solver-test.js` nach jedem Schritt aus core/diagnose |
| docs | Aktion 4: WARUM-Kommentare (Konstante + `apiGet`/`apiPut`-Nicht-Extraktion) und `LEARNINGS.md` §3/§4-Ergänzung |
| release | `@version`/`const VERSION` bumpen, Push auf `main` |

## Shared-Item-Bedarf

Die `diagError`-Nachrüstung aus Aktion 1 löst dasselbe Antipattern
(`fehler-unsichtbar-verschluckt`) wie in `spieler-pool`, `diagnose-werkzeuge`
und `batch-modus` — dort existiert laut Pattern-Doc dieselbe Lücke (u.a.
`fetchUnassignedViaHttp`/`fetchStorageViaHttp`, `onBatchPlanClick`,
Android-`MainActivity.java`-Netz-/Cache-Pfade). Die Wurzelursache laut
Pattern-Beziehungen: „es gibt keinen gemeinsamen Wrapper (z.B.
`reportError(msg, e)` = `warn`/Log + Report-Ablage in einem Aufruf), der die
Entscheidung ‚dieser Fehlertyp muss in den Report' strukturell erzwingt."
SI-Kandidat `fehler-sichtbarkeit-diagerror` (Details im Sidecar
`ea-app-anbindung.shared-items.json`) schlägt genau diesen Wrapper vor.
Für DIESE Iteration bleiben die drei Ergänzungen aus Aktion 1 bewusst
feature-lokal (kein Blocker durch die SI, kein `depends_on`) — sobald die SI
gebündelt und gemergt ist, können die drei Stellen in einer Folge-Iteration
auf `reportError(...)` umgestellt werden, ohne dass diese Iteration darauf
wartet.

## Risiken / Edge-Cases

- **Club-Lade-Takt tabu:** `fetchClubViaHttp` (`:1236-1253`, 300ms zwischen
  den Starts, wächst bei Fehlversuch selbst) wird von keiner Aktion berührt.
  Kein Diff dieser Iteration darf `gap`/`clubLoad`-Logik anfassen — Live-
  Ausfallrisiko laut CLAUDE.md.
- **Submit-Weg 0 tabu:** `submitViaApp` (`:2548-...`) bleibt unangetastet;
  die dortige Controller-Traversal-Duplikation wird NICHT auf
  `findSbcController`/`findLiveChallenge` umgestellt (das wäre Gap-Aktion 4,
  nicht Teil dieses Auftrags).
- **Regex-Migration kann Response-Routing stumm brechen:** `classifyUrl`
  entscheidet, ob eine Response überhaupt geparst wird (Pool-Befüllung,
  SBC-Erkennung). Ohne den neuen Testblock (Aktion 2) wäre ein Fehlgriff bei
  der Migration erst live sichtbar — deshalb Test VOR Migration, jede
  Call-Site EINZELN.
- **`apiRequest`-Extraktion bewusst ausgeschlossen:** siehe Aktion 3 —
  fehlende Retry-Kaskaden-Coverage in `solver-test.js` und das
  `_attempt`-Zähler-Risiko (muss PRO Methode/Pfad zählen, sonst stören sich
  ein parallel laufender GET- und PUT-Retry gegenseitig) machen die
  Extraktion in dieser Iteration nicht verhaltensneutral belegbar. Für eine
  Folge-Iteration: zuerst ein Mock-Testharness für `apiGet`/`apiPut`
  (analog `fetchClubViaHttp`-Test) bauen, DANN extrahieren.
- **Mid-Iter-SI (Klasse G) denkbar:** Falls Main während der Iteration
  feststellt, dass `spieler-pool`, `diagnose-werkzeuge` oder `batch-modus`
  im selben Zyklus ebenfalls `diagError`-Nachrüstungen brauchen, ist ein
  vorgezogener `reportError(msg, e)`-Wrapper (SI `fehler-sichtbarkeit-
  diagerror`) ein Kandidat für einen Mid-Iter-Einschub. Für diese Iteration
  ist das kein Blocker (Aktion 1 bleibt feature-lokal umsetzbar).

## Lift-Plan-Pre-Validation (M2)

Keine `pk_files_to_cite` (Feature hat keine PK-Dimension in dieser
Iteration) — `plan estimate --feature=ea-app-anbindung` prüft daher nur
`score_target (RA: 72) ≤ structural_max (75)` und die Abwesenheit von
Targets auf nicht-fokussierten Dimensionen. Erwarteter RA-Endwert:
`64 + (Aktion 1: +4-6) + (Aktion 2: +3-5) + (Aktion 4: +1-2) ≈ 72-77`,
konservativ auf `min(75, ...)` gecappt — deckt das M3-Ziel 72 mit Puffer,
auch wenn Aktion 3 (apiRequest) planmäßig 0 Pt beiträgt.
