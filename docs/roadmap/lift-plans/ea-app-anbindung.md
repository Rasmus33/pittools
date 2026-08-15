---
feature: ea-app-anbindung
iteration: 3
score_current:
  RA: 74
score_target:
  RA: 75
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
  - docs/LEARNINGS.md
patterns_required:
  - diagnose-feld-statt-raten
  - stille-catches-nur-an-der-ea-grenze
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P3-deferred
effort: S
analyzed_at: 2026-08-15
---

# Lift-Plan — EA-Web-App-Anbindung (Session & API-Zugriff)

## Marschroute

RA steht bei 74/75 (structural_max) — nur 1 Punkt Luft, der Deckel selbst ist
durch die undokumentierte EA-API begründet und nicht Teil dieses Lifts. Unter
der EA-Wandel-Linse dieser Iteration (nur additive Diagnose, KEINE Umbauten an
fetch/XHR-Wrapper, Session-Mechanik, 401-Kaskade) macht der Plan drei konkrete,
unabhängige Beobachtbarkeits-Lücken aus dem Gap-Report sichtbar:

1. Ein bisher komplett stummer JSON-Parse-Fehlschlag in `handleResponseBody`
   (neuer Beleg fürs Antipattern `fehler-unsichtbar-verschluckt`, behoben über
   das bereits vorhandene `reportError()`-Vorbild — keine neue Abstraktion).
2. Ein fehlender Zähler/Sample-Ring für unklassifizierte `/ut/game/`-URLs
   (Früherkennung neuer, unbekannter SBC-naher Endpunkte statt Zufallstreffer
   im generischen 15er-Ring).
3. Eine strukturelle Verdeckungslücke im gekürzten `rareflagHistogram`
   (Top-5-Cap verbirgt den KONKRETEN Wert eines neuen, seltenen rareflags).

Die vierte Gap-Report-Aktion (`apiBaseDetectionStuck`-Flag) bleibt bewusst
draußen — der Gap-Report selbst markiert sie als "dünn" (Gain +0.1-0.3, seltener
Praxisfall: ein Host-Match-Fehlschlag bei laufendem `utasSeen`-Zähler wäre ein
fundamentaler URL-Schema-Bruch). Die fünfte Gap-Report-Aktion (Zeit-/
Versuchszähler für den `services.SBC`-Hook-Fehlschlag) verschiebt sich ebenso
auf eine Folge-Iteration: bei nur 1 Punkt Luft sind drei saubere, unabhängige
Diagnose-Ergänzungen genug Umfang für eine `P3-deferred`-Iteration — die
`rareflagHistogram`-Lücke (Mangel 5) deckt dafür einen bisher in den
Lift-Aktionen des Gap-Reports gar nicht adressierten Mangel ab.

Jede der drei Aktionen ist ein eigener, in sich abgeschlossener Diffs-Block
(eigener Commit möglich) — Verhalten an der Netzwerk-Grenze selbst
(Interception-Reihenfolge, Header-Absorption, Promise-Kette) bleibt exakt wie
vorher, es kommen ausschließlich neue Diagnose-Zweige/-Felder hinzu.

## Aktionen pro Dimension

### RA — Robust Architecture

1. **diagError bei JSON-Parse-Fehlschlag in `handleResponseBody` (Mangel 1 /
   Gap-Aktion 1):**
   - `ea-fc-sbc-optimizer.user.js:257-258` (erster Catch, `try { json =
     JSON.parse(bodyText); } catch (e) { return; }`): den bestehenden,
     bereits im Code etablierten `reportError(label, e)`-Helfer (`:149-152`,
     `warn()` + `diagError()` in einem Aufruf) verwenden statt neue,
     duplizierte `warn`/`diagError`-Paare zu schreiben (Q4/DRY) —
     `catch (e) { reportError('handleResponseBody(' + kind + '): parse', e); return; }`.
     `kind` ist an dieser Stelle bereits bekannt (`classifyUrl(url)`-Ergebnis
     aus `:254`) und garantiert nicht `null` — die Funktion wäre sonst schon
     bei `:255` zurückgekehrt. Die Meldung landet dadurch NUR für bereits als
     SBC-relevant klassifizierte Endpunkte im Report — kein Log-Spam für
     fremde/HTML-Fehlerseiten anderer URLs (siehe Risiken).
   - `ea-fc-sbc-optimizer.user.js:277-279` (zweiter Catch, aktuell nur
     `warn('Fehler beim Verarbeiten einer Response:', e)`): durch
     `reportError('handleResponseBody(' + kind + ')', e);` ersetzen — dasselbe
     Vorbild, ein Aufruf statt zwei getrennter.
   - Kein neues `STATE.diag`-Feld nötig: `reportError`/`diagError` schreiben
     bereits ins existierende, deklarierte `lastErrors`-Feld (in der
     STATE.diag-Symmetrieprüfung als Alias-mutiertes Feld bereits gelistet).
   - Gain: schließt den im Gap-Report konkretesten „Fehler unsichtbar
     verschluckt"-Beleg direkt an der EA-Antwortgrenze, stärkt das
     Rubrik-Kriterium „Beobachtbarkeit".

2. **Eigener Zähler + 5er-Sample-Ring für unklassifizierte `/ut/game/`-URLs
   (Mangel 2 / Gap-Aktion 2):**
   - Neue Funktion `noteUnclassifiedUtas(url)` additiv INNERHALB des
     bestehenden `[URLCLS-BEGIN]/[URLCLS-END]`-Markerblocks ergänzen (direkt
     nach `classifyUrl`, vor der aktuellen `:252`-Grenze): prüft
     `/\/ut\/game\//i.test(url) && classifyUrl(url) === null`, zählt
     `STATE.diag.utasUnclassified = (STATE.diag.utasUnclassified || 0) + 1;`
     hoch und schreibt den maskierten Pfad (IDs ersetzt, gleiches Muster wie
     das bestehende `lastUtasPaths` in `:223-224`) DIREKT — ohne lokale
     Alias-Variable — via `STATE.diag.lastUnclassifiedPaths.push(path);` /
     `.shift()` bei Ring > 5. Bewusst ohne Aliasing, damit die
     STATE.diag-Symmetrieprüfung (`solver-test.js` Block 17) das
     Schreibmuster `diag.lastUnclassifiedPaths.push(` direkt findet und
     KEINE neue Ausnahme in `ALIAS_MUTATED_FIELDS` nötig wird. Kompletter
     Funktionskörper in eigenem `try {} catch (e) {}` (Fremd-Grenze: URL-String
     aus fetch/XHR, siehe `stille-catches-nur-an-der-ea-grenze`) — bewusst
     KEIN `warn`/`diagError`-Aufruf hier: das ist keine Fehlermeldung, sondern
     eine reine Beobachtung, deren Sichtbarkeit über den Report reicht (kein
     zusätzlicher Log-Kanal-Spam für regulären, aber unbekannten Traffic).
   - Zwei neue Felder additiv am Ende der `STATE.diag { ... }`-Deklaration
     (`:110-134`) ergänzen: `utasUnclassified: 0` und
     `lastUnclassifiedPaths: []`.
   - Aufrufstellen: je EINE zusätzliche Zeile `noteUnclassifiedUtas(url);`
     direkt neben der bestehenden `if (url && classifyUrl(url))`-Prüfung im
     fetch-Wrapper (`:297`, innerhalb des schon vorhandenen `try {}
     catch (e) {}` um die Response-Auswertung) und im XHR-Wrapper (`:339`,
     gleiches Muster) — der Wrapper selbst (Promise-Kette, Header-Absorption,
     Interception-Reihenfolge, `.clone().text()`-Timing) bleibt strukturell
     unverändert; es kommt nur je eine zusätzliche Anweisung in den bereits
     vorhandenen try-Block, kein Eingriff in Vertragskomponenten.
   - `buildDiagReport()` (`:3886-3891`) additiv um `counts.utasUnclassified:
     STATE.diag.utasUnclassified` und `lastUnclassifiedPaths:
     STATE.diag.lastUnclassifiedPaths` ergänzen.
   - Gain: adressiert Leitfrage 1 direkt — echte Früherkennung eines neuen,
     unbekannten SBC-nahen Endpunkts statt Zufallstreffer im generischen,
     nicht klassifikationsspezifischen 15er-Ring.

3. **Alle rareflag-Werte statt nur Top-5-Counts sichtbar machen (Mangel 5 —
   im Gap-Report beschrieben, aber ohne eigene nummerierte Lift-Aktion; PO
   ergänzt sie hier als dritte substanzielle Aktion anstelle der ausgesetzten
   `services.SBC`-Hook-Zähler-Aktion):**
   - Die anonyme IIFE in `rareflagHistogram` (`buildDiagReport()`,
     `:4114-4129`) in eine benannte, eigenständige Funktion
     `computeRareflagHistogram(pool)` extrahieren (reine Funktion, kein
     STATE-Zugriff außer dem übergebenen `pool`-Array — reines Refactoring,
     keine Verhaltensänderung an den bestehenden Feldern
     `0_common`/`1_rare`/`3_totw`/`topSpecials`/`specialFlags`/
     `specialTotal`). Aufruf in `buildDiagReport()` wird
     `rareflagHistogram: computeRareflagHistogram(STATE.pool)`. Neue Marker
     `// [RAREHIST-BEGIN]` / `// [RAREHIST-END]` direkt um die neue Funktion
     (platziert unmittelbar vor `function buildDiagReport()`, aktuell
     `:3862`) für die Marker-Extraktion im Test.
   - Zusätzliches Feld `out.allSpecialFlagValues = rest.map(x => x.f).slice(0, 30).join(',');`
     direkt nach der bestehenden `topSpecials`-Zeile (aktuell `:4125`)
     ergänzen — Liste ALLER distincten rareflag-Werte (nicht nur der
     häufigsten 5), OHNE Counts, mit einer defensiven Kappung bei 30 Werten
     (Warum-Kommentar: hält den Report auch bei einem theoretischen
     Pool-Ausreißer kompakt; in der Praxis liegt `specialFlags` deutlich
     darunter). Ein neuer, seltener rareflag (z. B. ein frisches Promo-Special
     mit 1 Karte) taucht dadurch IMMER im Report auf, auch wenn er die
     Top-5-Häufigkeitsgrenze nicht erreicht — nur sein Count bleibt implizit
     bei „1 von vielen", was für die Erstsichtung reicht.
   - `topSpecials`/`specialFlags`/`specialTotal` bleiben unverändert
     (Abwärtskompatibilität des Reports, rein additiv).
   - Gain: schließt die von Mangel 5 beschriebene Verdeckungslücke, ohne den
     Report auf die vollen ~80 Zeilen aufzublähen, die laut Kommentar
     `:4111-4113` bewusst gekürzt wurden.

## Phasen-Commit-Mapping

| Phase     | Aktionen |
|-----------|----------|
| core      | Aktion 1 komplett (Marker-Erweiterung `[URLCLS-END]` nach unten bis hinter `handleResponseBody`, beide `reportError`-Aufrufe); Aktion 3 komplett (Extraktion `computeRareflagHistogram` + `[RAREHIST-BEGIN/END]` + `allSpecialFlagValues`) |
| diagnose  | Aktion 2 komplett (neue `STATE.diag`-Felder `utasUnclassified`/`lastUnclassifiedPaths`, `noteUnclassifiedUtas`, Call-Sites in fetch-/XHR-Wrapper, `buildDiagReport()`-Wiring) |
| tests     | `solver-test.js`: erweiterter Block 25 (RESPBODY-Testfall + `noteUnclassifiedUtas`-Testfälle über den gewachsenen URLCLS-Block) plus neuer Block ~32 (RAREHIST-Testfall) — Blocknummer zum Umsetzungszeitpunkt gegen den dann aktuellen Stand prüfen (paralleles Ticket `sbc-vorgaben-erkennung` kann ebenfalls neue Blöcke anhängen) |
| docs      | `docs/LEARNINGS.md`: neuer Abschnitt (aktuell zuletzt §36, also §37 o. ä. — Nummer zum Umsetzungszeitpunkt prüfen), der die drei additiven Diagnose-Ergänzungen und die bewusst ausgesparten zwei Gap-Report-Aktionen dokumentiert; `@version`/`const VERSION`-Bump auf die dann nächste freie Version (aktuell zuletzt `4.48.0`; paralleles Ticket `sbc-vorgaben-erkennung` bumpt ebenfalls — Worker prüft unmittelbar vor dem Commit den aktuellen Header-Stand, statt eine Versionsnummer fest zu verdrahten) |
| release   | Push auf `main` (= Deployment für Tampermonkey + App) nach grünem `node --check`, `node solver-test.js` (alle Fälle inkl. neuer Blöcke grün) |

## Shared-Item-Bedarf

Keiner. Alle drei Aktionen sind reine Ein-Feature-Diagnose-Ergänzungen ohne
Cross-Feature-Nutzen (bestätigt durch den Gap-Report: „Kein Mid-Iter-SI nötig
— alle vier Aktionen sind Einzelfeatures ohne Cross-Feature-Abhängigkeit").
Sidecar-JSON ist entsprechend leer.

## Test-Absicherung

Alle drei Testfälle laufen als Verhaltenstests gegen den echten, per Marker
extrahierten Produktivcode (`patterns/good/eingebetteten-code-exakt-testen.md`
— keine separat gepflegte Kopie):

1. **Kaputtes JSON an SBC-relevanter URL → `diagError`-Eintrag (Aktion 1):**
   `[URLCLS-BEGIN]/[URLCLS-END]` wird nach unten erweitert, sodass
   `handleResponseBody` mit im Block enthalten ist (`classifyUrl` bleibt davor
   im selben Block, keine zweite Extraktion nötig). `buildUrlHelpers()` bekommt
   zwei zusätzliche `new Function(...)`-Parameter (`warn`, `diagError`) —
   `diagError` als minimaler Test-Stub, der nur `STATE.diag.lastErrors.push(...)`
   nachbildet (analog zu den bereits vorhandenen No-op-Stubs für `log`/
   `refreshDiagUI`, kein separat gepflegtes Duplikat der echten Truncation-Logik,
   die an anderer Stelle bereits abgedeckt ist). Testfall: `handleResponseBody`
   mit einer URL, die `classifyUrl` als `'sbc-challenge'` erkennt, und einem
   kaputten JSON-String (`'{invalid'`) aufrufen; Assertion:
   `STATE.diag.lastErrors.length === 1` und der Eintrag enthält
   `'handleResponseBody('`. Zweiter Testfall analog für den zweiten Catch
   (z. B. `bodyText` als valides JSON, das aber beim nachgelagerten
   `parseSbcChallenge`-Aufruf wirft — dafür genügt ein Stub, der
   `parseSbcChallenge` als zusätzlichen `new Function`-Parameter durch eine
   werfende Dummy-Funktion ersetzt, ohne die echte Parsing-Logik zu duplizieren).
2. **Unbekannte `/ut/game/`-URL → Zähler + Sample (Aktion 2):**
   `buildUrlHelpers()` exportiert zusätzlich `noteUnclassifiedUtas`; STATE-Stub
   bekommt `utasUnclassified: 0, lastUnclassifiedPaths: []`. Testfall a) eine
   synthetische, unbekannte SBC-ähnliche URL (`.../ut/game/fc26/sbx/foo`, kein
   exakter `sbs`/`sbc`-Treffer) → `STATE.diag.utasUnclassified === 1` und
   `lastUnclassifiedPaths` enthält den maskierten Pfad. Testfall b) eine
   bereits klassifizierte URL (z. B. `.../club`) → Zähler bleibt `0` (kein
   Fehlalarm für bekannten Traffic). Testfall c) 6 verschiedene unbekannte
   Pfade nacheinander → Ring bleibt bei 5 Einträgen (Cap-Verhalten wie beim
   Vorbild `lastUtasPaths`).
3. **Top-5-Cap-Sichtbarkeit im `rareflagHistogram` (Aktion 3):**
   `[RAREHIST-BEGIN]/[RAREHIST-END]` liefert `computeRareflagHistogram`
   direkt (reine Funktion, kein STATE-Stub nötig). Testfall: synthetischer
   Pool mit 5 häufigen Special-rareflags (je ≥ 3 Karten) plus EINEM neuen,
   seltenen rareflag (1 Karte) → Assertion, dass der seltene Wert NICHT in
   `topSpecials` auftaucht (Cap-Verhalten unverändert, Regression gegen
   Aktion 3 selbst), ABER als String in `allSpecialFlagValues` enthalten ist.
   Zweiter Testfall: Regression auf die bestehenden Felder
   `0_common`/`1_rare`/`3_totw`/`specialFlags`/`specialTotal` mit unverändertem
   Pool-Fixture — stellt sicher, dass die Extraktion in eine benannte Funktion
   keine Verhaltensänderung an den bereits genutzten Feldern verursacht hat.

`STATE.diag`-Symmetrieprüfung (Block 17) deckt `utasUnclassified` und
`lastUnclassifiedPaths` automatisch mit ab, sobald beide Felder deklariert,
in `buildDiagReport()` gelesen und außerhalb mit einem echten Schreibmuster
befüllt sind — kein separater Test-Code-Eingriff nötig, nur die
Produktivcode-Änderung selbst muss das Muster treffen (siehe Aktion 2, Punkt
zum bewusst fehlenden Aliasing).

## Risiken / Edge-Cases

- **Log-Spam-Risiko (explizit behandelt, wie von der Iterationslinse
  gefordert):** `reportError()` in `handleResponseBody` (Aktion 1) feuert NUR
  für URLs, die `classifyUrl()` bereits als SBC-relevant erkannt hat — die
  Funktion kehrt für alle anderen URLs schon vorher zurück (`:255`). Ein
  EA-seitiger Ausfall (502/503-HTML-Seite statt JSON auf einem SBC-Endpunkt)
  würde zwar bei jedem betroffenen Request einen neuen Eintrag erzeugen, der
  bestehende `lastErrors`-Ring (Cap 24) begrenzt das aber strukturell wie bei
  jedem anderen `diagError`-Aufruf auch — kein neues Verhalten, sondern
  dieselbe, bereits etablierte Ringpuffer-Bremse. Laut Score-Kriterium RA
  zählen EA-seitige Ausfälle ohnehin nicht gegen den Score, solange sie sauber
  erkannt/gemeldet werden. `noteUnclassifiedUtas` (Aktion 2) ruft bewusst KEIN
  `warn`/`diagError` auf (siehe Aktion 2) — dort besteht daher kein
  Log-Spam-Risiko, nur ein zusätzliches, stilles Zähl-/Ring-Feld.
- **In-Memory-Zähler überleben keinen Reload:** `utasUnclassified` und
  `lastUnclassifiedPaths` liegen wie der Rest von `STATE.diag` nur im
  Skript-Speicher — ein kurz auftretender unbekannter Endpunkt, der vor dem
  nächsten Diagnose-Klick durch F5/App-Neustart verloren geht, bleibt
  unsichtbar. Konsistent mit dem Rest von `STATE.diag`, wird aber als
  Warum-Kommentar an der neuen Feld-Deklaration festgehalten (Q7 — Doku
  beschreibt den Ist-Zustand, keine Fix-Versprechen ohne eigenes Ticket).
- **STATE.diag-Symmetrie ist scharf geprüft:** wird `lastUnclassifiedPaths`
  entgegen dem Plan doch über eine lokale Alias-Variable befüllt (wie
  `lastErrors`/`lastUtasPaths`), schlägt Block 17 fehl, bis das Feld in
  `ALIAS_MUTATED_FIELDS` nachgetragen wird — der Plan vermeidet das bewusst
  durch direktes `STATE.diag.lastUnclassifiedPaths.push(...)`.
- **Marker-Verschiebung ist ein Diff an einer bestehenden Testinfrastruktur-
  Stelle:** `[URLCLS-END]` wandert ca. 28 Zeilen nach unten. Der bestehende
  `buildUrlHelpers()`-Test-Helfer MUSS seine `new Function(...)`-Parameterliste
  und Rückgabe entsprechend erweitern, sonst bricht Block 25 (bereits
  bestehende classifyUrl/detectApiBase-Assertions) — kein Verhaltensrisiko am
  Produktivcode, aber ein Punkt für sorgfältiges Diff-Review.
- **Koordination mit `sbc-vorgaben-erkennung` (paralleles Ticket):**
  Versionsbump, LEARNINGS-Abschnittsnummer und `solver-test.js`-Blocknummer
  sind alle „nächste freie" Werte zum Umsetzungszeitpunkt — der Worker prüft
  unmittelbar vor dem jeweiligen Commit den dann aktuellen Stand von `main`,
  keine der drei Nummern wird hier fest verdrahtet.
- **Mid-Iter-Vermutung (Klasse G):** keine erwartet — alle drei Aktionen sind
  in sich abgeschlossene Diagnose-Ergänzungen ohne neue Helper/Konstanten, die
  ein zweites Feature bräuchte.

## M3-Check (Delta 1 — Gains ehrlich klein ansetzen)

RA ist eine `manual_rubric`-Dimension (audit-evaluator, semantische
Code-Read-Bewertung entlang der Rubric aus `score-criteria.md`), kein
formelbasierter Adapter wie PK — es gibt keinen Divisor/Zähler-Mechanismus,
über den sich der Gain deterministisch vorausrechnen lässt. Ambitions-Formel
(`ceiling = structural_max`, da RA keinen PK-artigen Ceiling-Begriff kennt):
`74 + (75 − 74) × 0.7 = 74.7`. Bei nur 1 Punkt struktureller Luft und einem
strukturellen Maximum von 75 wird das ehrliche Ziel dieser Iteration auf den
vollen `structural_max = 75` gesetzt (Vorgabe aus dem Feature-Briefing), NICHT
weil die drei Diagnose-Ergänzungen die EA-API robuster machen — der Deckel
bleibt EA-bedingt — sondern weil sie gezielt genau das Rubrik-Kriterium
„Beobachtbarkeit" bedienen, das laut Gap-Report-Begründung aktuell den
einzigen Punkt Abstand zum Maximum ausmacht. Der erwartete Gain ist bewusst
klein (`+1`, RA 74 → 75) und hängt am Ende vom holistischen Urteil des
`audit-evaluator` in der nächsten Bewertungsrunde ab, nicht an einer
deterministischen Formel wie bei PK — die drei Aktionen sind die konkreten,
im Gap-Report benannten Belege, die dieses Urteil stützen sollen, mehr
Sicherheit als „plausibel, nicht garantiert" gibt die Dimension strukturell
nicht her.

## Lift-Plan-Pre-Validation (M2)

Plugin prüft deterministisch via `plan estimate --feature=ea-app-anbindung`:
`score_target.RA = 75 ≤ structural_max.RA = 75` (Gleichstand, kein Verstoß).
Da RA `manual_rubric` und nicht `pattern_adoption` ist, gibt es keinen
`pk_files_to_cite`-Endwert zu schätzen (`pk_files_to_cite: []` ist hier
korrekt leer, keine PK-Aktionen geplant) — bei Alt-Plänen ohne PK-Divisor
fällt `plan estimate` laut `lift-plan-guide.md` auf Reasoning-Schätzung
zurück (`deterministic: false`, `rc=0`), kein Crash zu erwarten.
