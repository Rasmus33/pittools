---
feature: rating-solver
analyzed_at: 2026-08-14
iteration: 0
regression: false
score_current:
  RA: 78
score_target:
  RA: 85
---

# Gap-Report — Rating-Solver (Team-Optimierung)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 78 / 95 (structural_max)
**Schwellwert:** 66.5 (95 × 0.7)
**Status:** pass
**Begründung:** Der `audit-evaluator` bewertet Testbarkeit (Marker-Extraktion +
Brute-Force-Parität, `solver-test.js:10-13`) und Abbruch-Disziplin
(`ea-fc-sbc-optimizer.user.js:2115-2147` — `finishTeam`-Endkontrolle vor jedem
Schreibzugriff) sowie WARUM-Kommentare mit Live-Belegen
(`:1855-1866`, `:1908-1917`, `:1958-1959`) als sehr stark. Abzug entsteht durch
zwei reale Architektur-Lecks: die `reserve()`-Invariante wird an zwei Pfaden
(Anker `:1908-1917`, manueller Rarity-Pick `:1958-1959`/`:1932-1936`) umgangen,
und derselbe Sortier-Komparator ist viermal wörtlich dupliziert statt über eine
Factory zentralisiert. Beide Befunde sind in
`docs/roadmap/patterns/bad/helfer-existiert-wird-umgangen.md` und
`docs/roadmap/patterns/aspects/aspect-solver.md` bereits mit denselben
Zeilenreferenzen belegt — die Datei ist aktuell (v4.35.0) exakt an diesen
Stellen unverändert, die Belege sind live nachvollzogen (bestätigt per Read
am 2026-08-14).

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`reserve()`-Funnel wird am Anker-Pfad umgangen:**
   `ea-fc-sbc-optimizer.user.js:1855-1866` definiert `reserve(p)` mit
   explizitem Vertrag ("Jede Reservierung MUSS hierueber laufen ... Zwei
   Karten desselben Spielers im Team sind HTTP 460"). Die Anker-Reservierung
   bei `:1910` (`used.add(anchor.id); reserved.push(anchor);`) ruft `reserve()`
   nicht auf — `usedAssets` bleibt für den Anker unbefüllt. Aktuell folgenlos,
   weil vorgelagerte Pool-Dedupe-Schritte pro `assetId` das HTTP-460-Risiko
   zufällig abfangen (Pattern-Beleg:
   `docs/roadmap/patterns/bad/helfer-existiert-wird-umgangen.md`, Abschnitt
   „Code-Belege"), aber die Invariante ist damit nur durch eine an anderer
   Stelle liegende Zufallsbedingung geschützt, nicht strukturell durch den
   Code selbst.

2. **Derselbe Bypass am manuellen Rarity-Pick:**
   `ea-fc-sbc-optimizer.user.js:1932-1936` — `used.add(pick.id);
   reserved.push(pick);` — identisches Muster wie Mangel 1, zweite
   unabhängige Stelle. Zwei Stellen bedeuten: eine künftige Änderung an
   `reserve()` (z.B. ein drittes nachzuführendes Set) muss von Hand an zwei
   weiteren Orten synchron gehalten werden, sonst bricht die Invariante
   lautlos wieder.

3. **Sortier-Komparator „Storage → Rating → Kosten → Tiebreak" viermal
   wörtlich dupliziert:** `ea-fc-sbc-optimizer.user.js:1958-1959` (Bronze/
   Silber-Quoten), `:2073-2075` (Rare-ohne-Ziel), `:2197-2198`
   (Gold-Rare-Reservierung ohne Ziel-OVR), `:2245-2246` (Auffüll-Karten ohne
   Ziel-OVR) — derselbe Ausdruck
   `((b.isStorage?1:0)-(a.isStorage?1:0)) || (a.rating-b.rating) ||
   (costOf(a)-costOf(b)) || <tiebreak>` viermal Zeichen für Zeichen kopiert,
   obwohl `makeConsumeCmp` (`:1422`) im selben Modul bereits als
   Comparator-Factory-Vorbild existiert. Eine Rangfolge-Änderung (z.B. neue
   Zwischenstufe) müsste an vier bis sechs Stellen synchron nachgezogen
   werden (Pattern-Beleg: `docs/roadmap/patterns/aspects/aspect-solver.md`,
   Abschnitt „Antipattern: Sortier-Komparator ... viermal dupliziert").

4. **Kostenformel zwischen Solver und Test-Harness nur per Kommentar
   synchron gehalten:** `costOf()` (`ea-fc-sbc-optimizer.user.js:1900-1906`)
   ist eine private Closure innerhalb der `SolverCore`-IIFE, nicht exportiert.
   `solver-test.js:71-88` (`cardCostFn`) bildet dieselbe Formel eigenständig
   nach; die einzige Absicherung gegen Drift ist der Kommentar
   `solver-test.js:69` „MUSS synchron zu costOf() im Userscript bleiben" —
   kein Mechanismus, der das erzwingt (kein Cross-Check-Test auf
   Zufallsdaten). Genau dieses Muster hat sich im Projekt bereits einmal als
   real eingetretene Drift bei der Rating-Kosten-Tabelle gezeigt
   (`docs/roadmap/patterns/bad/wissens-duplikate-ohne-ssot.md`).

5. **Zwei tote/fragliche Solver-Exports ohne WARUM-Kommentar:**
   `WASTE_WEIGHT` (`ea-fc-sbc-optimizer.user.js:1513`, exportiert `:2443`) ist
   mit einem ausführlichen Kommentar versehen, wird aber im gesamten
   Solver-Block nirgends gelesen — die tatsächliche Fenstersteuerung läuft
   über `windowV`/`cfg.maxOvershoot` (`:2288-2289`). `priorityOf`
   (`:1413`, exportiert `:2440`) wird nur intern von `makeConsumeCmp`
   (`:1429`) verwendet; kein Aufrufer außerhalb des Moduls, keine Nutzung in
   `solver-test.js`. Beides ist ein Q7-Risiko: der Kommentar bei
   `WASTE_WEIGHT` beschreibt einen Mechanismus, der nicht mehr greift, und
   `priorityOf` liegt als öffentliche API-Fläche ohne erkennbaren Grund
   offen — genau die Art Fund, die `warum-kommentare-mit-live-belegen`
   eigentlich verhindern soll, wenn konsequent angewendet.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`reserve()`-Funnel schließen (Anker + Rarity-Pick):** Beide Bypässe
   (`ea-fc-sbc-optimizer.user.js:1908-1917` und `:1932-1936`) auf einen
   Aufruf von `reserve(anchor)` bzw. `reserve(pick)` umstellen, statt
   `used`/`reserved` inline zu pflegen. Muss laut CLAUDE.md verhaltensneutral
   sein: `node solver-test.js` vorher UND nachher 180/180 grün, plus ein
   neuer, per Brute-Force verifizierter Testfall, der Anker und Rarity-Pick
   mit kollidierender `assetId` konstruiert (heute durch die zufällige
   Pool-Dedupe verdeckt) und prüft, dass der Solver das jetzt strukturell
   ablehnt/dedupliziert statt sich auf Zufall zu verlassen. Pfad:
   `ea-fc-sbc-optimizer.user.js` (SOLVER-Block), neuer Test in
   `solver-test.js`. Erwarteter Gain: **+6 bis 8 Pt RA** (schließt exakt den
   Befund, den der Score-Kommentar als Hauptgrund für den Abzug nennt).

2. **Comparator-Factory nach Vorbild `makeConsumeCmp` extrahieren:** Eine
   neue Factory (z.B. `makeFillCmp(pool)`) analog zu `makeConsumeCmp`
   (`:1422`) kapselt „Storage-Vorrang + Rating + Kosten + Tiebreak" und
   ersetzt die vier wörtlichen Duplikate (`:1958-1959`, `:2073-2075`,
   `:2197-2198`, `:2245-2246`). Verhaltensneutralität nachweisen durch
   Snapshot-Vergleich der Sortierreihenfolge vor/nach Refactor auf
   mehreren Fixtures mit Kosten-/Rating-Gleichständen (nicht nur
   aggregiertes V/Kosten-Ergebnis wie die bestehenden Brute-Force-Tests),
   danach 180/180. Pfad: `ea-fc-sbc-optimizer.user.js` nahe `:1422`, plus
   Regressionstest in `solver-test.js`. Erwarteter Gain: **+5 bis 7 Pt RA**
   (Testbarkeits- und DRY-Teil der RA-Rubric).

3. **Cross-Check-Test für `costOf()` vs. `cardCostFn()` statt Kommentar-
   Disziplin:** `costOf` (`:1900-1906`) unter einem klar als
   diagnose-/testintern markierten Schlüssel zusätzlich exportieren (z.B.
   `SolverCore._costOf`) und in `solver-test.js` einen Property-Test
   ergänzen, der `cardCostFn(pool, c)(p)` gegen `SolverCore._costOf(p, cfg)`
   auf zufällig generierten Karten/Configs vergleicht. Ersetzt „MUSS
   synchron bleiben" (Kommentar) durch eine erzwungene Prüfung — genau das
   Prinzip aus `docs/roadmap/patterns/good/eingebetteten-code-exakt-testen.md`.
   Pfad: `ea-fc-sbc-optimizer.user.js:1900-1906` (Export), `solver-test.js`
   (neuer Testblock nahe `:88`). Erwarteter Gain: **+4 bis 6 Pt RA** (schließt
   den in `wissens-duplikate-ohne-ssot.md` dokumentierten Drift-Vektor
   mechanisch statt disziplinarisch).

4. **`WASTE_WEIGHT` bereinigen oder verankern:** Entweder die Konstante
   (`:1513`) plus Export (`:2443`) entfernen, wenn sie tatsächlich tot ist
   (per Grep bereits bestätigt: kein Leser im Block), oder — falls als
   künftiger Regler gedacht — den Kommentar korrigieren und einen
   Source-Static-Check ergänzen (Pattern `eingebetteten-code-exakt-testen`,
   Technik 3), der prüft, dass `WASTE_WEIGHT` tatsächlich in der
   Kostenberechnung referenziert wird. Pfad:
   `ea-fc-sbc-optimizer.user.js:1513`/`:2443`. Erwarteter Gain: **+2 bis 3 Pt
   RA** (Q7 — Kommentar beschreibt sonst dauerhaft einen nicht wirksamen
   Mechanismus).

5. **`priorityOf`-Export auditieren:** Bestätigen (per Grep bereits getan:
   keine externen Aufrufer in `ea-fc-sbc-optimizer.user.js` oder
   `solver-test.js`), dann entweder aus dem `SolverCore`-Rückgabeobjekt
   (`:2440`) entfernen — `makeConsumeCmp` bleibt intern nutzbar — oder,
   analog zum bestehenden Helper-Vollständigkeits-Check
   (`solver-test.js:1192-1216`, der jeden Funktionsaufruf gegen eine
   Definition prüft), einen umgekehrten Check ergänzen, der jeden
   `SolverCore`-Export gegen mindestens eine Verwendungsstelle außerhalb
   seiner eigenen Definition prüft. Pfad: `ea-fc-sbc-optimizer.user.js:2440`,
   `solver-test.js`. Erwarteter Gain: **+2 bis 3 Pt RA**.

## Edge-Cases (mind. 1 — M1)

- **Reihenfolge-Abhängigkeit in `planBatch`/`usedIds`:** Bevor der
  `reserve()`-Funnel für Anker/Rarity-Pick geschlossen wird, muss geprüft
  werden, ob nachgelagerter Code (`planBatch`, `usedIds`-Tracking bei
  `:2431`) implizit auf die *Art* der Reservierung (manuell vs. automatisch)
  oder auf Objekt-Identität in `reserved` angewiesen ist — ein reiner
  Funnel-Wechsel darf diese Unterscheidung nicht verwischen, sonst wird ein
  scheinbar kosmetischer Fix zur echten Verhaltensänderung.
- **Sortierstabilität bei Kosten-Gleichstand:** Die bestehenden
  Brute-Force-Tests prüfen aggregiertes V/Kosten-Ergebnis, nicht WELCHE von
  zwei exakt kostengleichen Karten gewählt wird. Eine Comparator-Factory-
  Extraktion kann bei Gleichstand eine andere (aber laut Aggregat weiterhin
  "korrekte") Karte wählen, ohne dass ein bestehender Test das bemerkt — die
  neue Lift-Aktion 2 braucht deshalb explizit ein Fixture mit doppelten,
  kostengleichen Karten, das die exakte gewählte `id`/`assetId` prüft, nicht
  nur Summen.
- **Bronze/Silber ignoriert `minRating` bewusst (CLAUDE.md-Produktregel):**
  Die gemischten Qualitäts-Vorgaben (`qTiers`, `:1945-1968`) nutzen
  `costOf()` samt Rarity-Aufschlag/Untradeable-Rabatt genauso wie die
  Gold-Pfade. Beim Extrahieren der gemeinsamen Comparator-Factory darf keine
  neue Kopplung entstehen, die versehentlich `minRating`- oder
  Rarity-Gruppen-Logik in den Bronze/Silber-Zweig hineinzieht — das wäre eine
  stille Verletzung der Produktregel „Min-Rating wird bei Bronze/Silber
  komplett ignoriert".

## Lift-Empfehlung

Vorsichtig, in kleinen, unabhängig testbaren Schritten — nicht als ein
großes Refactoring-PR. CLAUDE.mds oberste Regel „keine Regression" gilt hier
besonders hart, weil der Solver als „Nicht anfassen ohne Grund"-Kandidat
gilt (Rating-Formel/V-Maß bleiben unangetastet) und weil alle fünf
Lift-Aktionen reine Struktur-Refactorings ohne fachliche Verhaltensänderung
sein sollen. Empfohlene Reihenfolge: (1) `reserve()`-Funnel schließen mit
eigenem Brute-Force-Testfall zuerst (höchster Gain, adressiert den vom
Score explizit genannten Hauptmangel), (2) Comparator-Factory danach separat
(eigener PR, eigener Snapshot-Test), (3) `costOf`-Cross-Check und (4)/(5)
die beiden toten Exports als kleine, risikoarme Aufräum-Schritte zuletzt.
Jeder Schritt einzeln: `node --check`, `node solver-test.js` (180/180
vorher UND nachher), Version bumpen, Push. Kein Mid-Iter-SI nötig — alle
Funde liegen vollständig innerhalb des `[SOLVER-BEGIN]`/`[SOLVER-END]`-Blocks
und `solver-test.js`, kein zweites Feature ist betroffen.
