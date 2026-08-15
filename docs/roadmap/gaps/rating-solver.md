---
feature: rating-solver
analyzed_at: 2026-08-15
iteration: 1
regression: false
score_current:
  RA: 89
score_target:
  RA: 90
---

# Gap-Report — Rating-Solver (Team-Optimierung)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 89 / 95
**Schwellwert:** 66.5
**Status:** pass
**Begründung:** Post-Iteration-0-Audit (`docs/roadmap/audit/rating-solver.md`):
alle vier Struktur-Refactorings live verifiziert — `reserve()`-Funnel jetzt an
jedem Reservierungspfad (inkl. Anker/Rarity-Pick), Komparator-Factory
(`makeFillCmp`) statt viermaliger Wort-Duplikation, `makeCostOf()` als
mechanische SSOT (Test ruft denselben Code statt `cardCostFn()` nachzubilden),
`WASTE_WEIGHT`/`priorityOf`-Export als verifiziert-toter Code entfernt. Distanz
zum strukturellen Maximum 95: laut `vision/features/rating-solver.md` bleiben
"die letzten 5 Punkte offen, weil die Rating-Formel selbst reverse-engineered
ist" — der realistische Deckel für rein strukturelle/prozessuale Verbesserungen
liegt damit bei ca. 90, nicht bei 95. Iteration 0 hatte selbst als Ziel 90
gesetzt und 89 erreicht (91.7% Reach).

Diese Gap-Analyse (Iteration 1) wurde mit v4.45.0 des Userscripts live
verifiziert (Datei gelesen, `node solver-test.js` ausgeführt: 354/354 grün;
zusätzlich eine gezielte Reproduktion außerhalb der Testsuite, siehe M1/M2).

## Mängel (≥ 3 — M1)

### RA — Robust Architecture

1. **Toter Duplikat-Stapelgrößen-Tiebreak in `makeConsumeCmp`, an zwei Stellen
   fälschlich als lebendiges Verhalten dokumentiert
   (`ea-fc-sbc-optimizer.user.js:1493-1509`, `:1677`):**
   `makeConsumeCmp(list)` zählt pro `assetId` (Fallback `p.name`) die
   Stapelgröße in `list` und nutzt sie als zweiten Tiebreak nach der
   Prioritäts-Reihenfolge ("vom GRÖSSTEN Stapel zuerst", Kommentar
   `:1493-1495`; wortgleich wiederholt bei `:1677` in `buildDp`). Beide
   Aufrufer — `makeConsumeCmp(pool)` bei `:1982` und `makeConsumeCmp(avail)`
   bei `:2212` (`avail` ist ein reiner Teilmengen-Filter von `pool`, `:2200`)
   — bekommen jedoch garantiert eine bereits pro `assetId` deduplizierte
   Liste: die SPIELER-EINDEUTIGKEIT (`:1930-1953` für `pool`, `:1960-1978`
   für `poolAll`) lässt strukturell genau eine Karte pro `assetId` übrig,
   *bevor* `makeConsumeCmp` je aufgerufen wird — und für echte Spielerdaten
   ist `assetId` nie `null` (Fallback auf die eindeutige `id`, `:859`:
   `assetId: raw.assetId || raw.definitionId || raw.resourceId || id`), der
   `p.name`-Fallback-Zweig in `makeConsumeCmp` (`:1499`, `:1505-1506`) ist
   damit für Produktionsdaten ebenfalls unerreichbar. `counts.get(k)` ist
   also für jeden Schlüssel in jeder Aufruf-Liste konstant `1` — die
   Differenz `counts.get(kb) - counts.get(ka)` ist immer `0`, der Tiebreak
   fällt strukturell nie ins Gewicht. **Live-Beleg (Reproduktion außerhalb
   der Testsuite, identischer Solver-Aufruf wie `solver-test.js:220-231`):**
   ein Pool mit 10 Karten desselben Spielers (`assetId 111`, alle Rating 88)
   plus 15 weiteren Karten liefert `res.poolInfo.count === 17` statt `26` —
   die Dedupe kollabiert die 10 Duplikate VOR jeder Tiebreak-Entscheidung auf
   1 Eintrag. Zwei Kommentarstellen behaupten weiterhin unwidersprochen ein
   Verhalten, das strukturell nicht eintreten kann (Q6/Q7-Verstoß) — ein
   Muster, das dieselbe Iteration bei `WASTE_WEIGHT`/`priorityOf`
   (LEARNINGS §28) bereits einmal korrekt als tot erkannt und entfernt hat,
   hier aber nicht mitgezogen wurde.

2. **`solver-test.js:220-231` ("Duplikat-Stapel: vom größten Stapel zuerst")
   prüft nicht, was der Titel behauptet — die Assertion ist vakuum-wahr:**
   Der Test baut `many(10, 88, {storage:true, assetId:111})` +
   `[P(88, {storage:true, assetId:222})]` und prüft
   `used88.every(p => p.assetId === 111)`. Wegen der SPIELER-EINDEUTIGKEIT
   (siehe M1) bleibt von den 10 Karten mit `assetId 111` nach der Dedupe nur
   noch EINE übrig — die Assertion ist damit trivial erfüllt, unabhängig
   davon, ob der Stapelgrößen-Tiebreak je feuert. Der Test würde also auch
   dann grün bleiben, wenn `makeConsumeCmp`s Tiebreak-Zweig komplett entfernt
   oder invertiert würde — er verifiziert de facto nur die (bereits an
   anderer Stelle getestete, `solver-test.js:820-855`/`:857-919`)
   Spieler-Eindeutigkeits-Dedupe, nicht die im Namen versprochene
   Stapelgrößen-Präferenz. Verstößt gegen den Testbarkeits-Grundsatz "keine
   geratenen/vakuumen Erwartungswerte" aus CLAUDE.md und dem Pattern
   [[eingebetteten-code-exakt-testen]].

3. **Hardcodierte Solver-Suchgrenzen ohne WARUM-Kommentar/Live-Beleg und ohne
   Diagnose-Unterscheidung bei Erschöpfung
   (`ea-fc-sbc-optimizer.user.js:2405-2406`, `:2455`, `:2504`):**
   `sMaxLow`/`sMaxHigh` sind bei `:2405-2406` hart auf `1300` gedeckelt
   (`Math.min(k * 99, 1300)`), die Summensuche bei `:2455` auf
   `stHardCap = stLow + 900`. Beide Zahlen tragen — anders als praktisch
   jeder andere magische Wert im selben Modul (Club-Lade-Takt `300ms` mit
   LEARNINGS-§7-Verweis bei `:1247-1253`, Rarity-Aufschlag `+8` mit
   Rechenbeispiel bei `:1758-1764`, Untradeable-Bonus `3` mit Begründung bei
   `:1626-1631`) — keinen Kommentar, der herleitet, warum `900`/`1300`
   ausreichen (Pattern [[warum-kommentare-mit-live-belegen]] wird hier nicht
   angewandt, obwohl es exakt für diese Art Stelle im selben Feature
   dokumentiert ist). Wird `stHardCap` je erreicht, ohne dass eine Lösung
   gefunden wurde, liefert `:2504` ausnahmslos "Ziel-OVR X ist mit dem
   aktuellen Pool nicht erreichbar" — der Fehlertext unterscheidet nicht
   zwischen "SBC ist mit diesem Pool tatsächlich unlösbar" und "internes
   Suchfenster ausgeschöpft, echtes Optimum evtl. außerhalb". Für die
   aktuell einzige Aufrufer-Konfiguration (Gold-Zielrating, `N ≤ 11`, üblicher
   Rating-Bereich 75-99) bleibt die Suchfläche zwar rechnerisch weit
   innerhalb der Grenzen (max. Spannweite ≈ `11 × 24 = 264 ≪ 900`), aber genau
   diese Herleitung steht nirgends im Code — ein späterer Refactor (z.B.
   größere Formationen, weiterer Rating-Bereich) könnte die Grenze
   stillschweigend unterschreiten, ohne dass der Report das je unterscheiden
   könnte.

## Lift-Aktionen (≥ 3 — M1)

### RA — Robust Architecture

1. **Toten Tiebreak bereinigen ODER als bewusst-tot dokumentieren
   (`ea-fc-sbc-optimizer.user.js:1493-1509`, `:1677`, `:1982`, `:2212`):**
   Da beide Aufrufer nachweislich (strukturell + per Reproduktion, siehe M1)
   ausschließlich assetId-deduplizierte Listen erhalten, folgt die
   naheliegende Aktion demselben Muster wie `WASTE_WEIGHT`/`priorityOf`
   (LEARNINGS §28): den `counts`-Block aus `makeConsumeCmp` entfernen und die
   beiden Kommentare (`:1493-1495`, `:1677`) auf die tatsächlich lebendige
   Prioritäts-Reihenfolge kürzen. Pflicht dabei (CLAUDE.md-Workflow):
   `node solver-test.js` muss vor UND nach dem Schnitt grün bleiben, neuer
   Testfall statt des angepassten Test 6 (siehe Aktion 2), Erwartungswerte
   nie aus dem Kopf. Alternative, falls ein Aufrufer mit nicht-dedupliziertem
   Input für denkbar gehalten wird: den Tiebreak stehen lassen, aber mit
   einem WARUM-Kommentar nach dem Vorbild der `reserve()`-Kollisionswarnung
   (LEARNINGS §28, "aktuell folgenlos, weil ... strukturell ungeschützt")
   explizit als Defense-in-Depth kennzeichnen. Erwarteter Gain: +1 Pt RA
   (schließt einen live-verifizierten Q6/Q7-Verstoß an zwei Stellen).

2. **Test 6 (`solver-test.js:220-231`) umbauen, damit er etwas Reales prüft:**
   Entweder den Test auf die tatsächlich lebendige `dupeScore`-Priorität der
   SPIELER-EINDEUTIGKEIT (`ea-fc-sbc-optimizer.user.js:1932-1952`) umstellen —
   z.B. zwei Duplikate desselben Spielers mit unterschiedlichem
   Storage-/Rating-Status konstruieren und brute-force-frei, aber gezielt
   prüfen, dass `dupeScore` die dokumentierte Rangfolge (Anker/Rarity-Pick >
   Rarity-Match > Storage > Rating > kleinste id) tatsächlich durchsetzt
   (aktuell nur indirekt über `solver-test.js:820-855`/`:857-919`
   mitgetestet) — oder, falls Aktion 1 den Doku-Pfad wählt, den Testnamen/
   -kommentar so anpassen, dass er explizit als Regressionswächter für den
   (aktuell unerreichbaren) Fallback-Zweig gekennzeichnet ist, statt
   fälschlich ein lebendiges Verhalten zu suggerieren. Erwarteter Gain:
   +0.5-1 Pt RA (Testbarkeit: keine vakuum-wahren Assertions mehr im Solver-
   Suite).

3. **WARUM-Kommentar + Diagnose-Unterscheidung für die Suchgrenzen
   (`ea-fc-sbc-optimizer.user.js:2405-2406`, `:2455`, `:2504`):**
   Einen Kommentar nach dem Muster von [[warum-kommentare-mit-live-belegen]]
   ergänzen, der herleitet, warum `1300`/`900` für die aktuelle Formations-
   größe (`N ≤ 11`) und den praktischen Rating-Bereich ausreichen (rein
   additiv, keine Verhaltensänderung, `solver-test.js` bleibt unverändert
   grün). Zusätzlich bei Erreichen von `stHardCap` ohne Lösung ein
   `warnings`-Flag setzen, das `finishTeam`/der Fehlerpfad bei `:2504` in den
   Diagnose-Report durchreicht ("internes Suchfenster ausgeschöpft" statt
   unspezifisch "nicht erreichbar") — analog zum bereits etablierten Muster
   der `reserve()`-Kollisionswarnung. Kein Eingriff in die geschützte
   Rating-Formel selbst (CLAUDE.md "Nicht anfassen ohne Grund"), rein additive
   Beobachtbarkeit. Erwarteter Gain: +1 Pt RA (Beobachtbarkeit/
   Fehlertoleranz-Rubrik: aktuell einziger unbelegter Magic-Number-Fall im
   sonst durchgängig belegten Modul).

## Edge-Cases (mind. 1 — M1)

- **Beim Umbau von Test 6 (Aktion 2) nicht versehentlich Deckung verlieren:**
  Test 6 testet aktuell — unbeabsichtigt, aber faktisch — auch ein Stück der
  SPIELER-EINDEUTIGKEIT-Dedupe (10 Duplikate kollabieren korrekt auf 1). Wird
  der Test ersatzlos gestrichen statt umgebaut, bleibt zwar
  `solver-test.js:820-855`/`:857-919` als explizite Dedupe-Abdeckung übrig —
  vor dem Streichen sollte trotzdem geprüft werden (Diff der Test-Coverage),
  dass keine Kombination (z.B. Dedupe-Verhalten OHNE Rarity-Vorgabe/Anker,
  nur reine Mengen-Reduktion wie in Test 6) durch den Wegfall unbeobachtet
  wird. CLAUDE.md verlangt an dieser Stelle ohnehin einen neuen/angepassten
  Testfall statt eines stillen Wegfalls.

## Lift-Empfehlung

Vorsichtig, kleinteilig: Das Feature steht bei 89 von einem strukturell
durch die reverse-engineered Rating-Formel auf ~90 gedeckelten Maximum (siehe
`vision/features/rating-solver.md`) — nach ehrlicher Prüfung existieren für
diese Iteration nur die drei oben genannten, eng verwandten Hygiene-Funde
(ein toter Tiebreak, ein dadurch vakuum-wahrer Test, ein unbelegtes
Magic-Number-Paar), keine weiteren substanziellen RA-Lücken. Alle drei
Aktionen sind additiv/entfernend ohne Eingriff in die geschützte
Kern-Formel, brauchen aber trotzdem den vollen CLAUDE.md-Workflow
(Brute-Force-Verifikation, `node solver-test.js` grün, Versions-Bump) — kein
Mid-Iter-SI, kein aggressiver Lift-Plan gerechtfertigt. `score_target: 90`
ist bewusst konservativ (nur +1 gegenüber 89) und spiegelt den dokumentierten
Deckel wider, nicht mangelnden Ehrgeiz.
