---
name: Wissens-Duplikate ohne Single Source of Truth
slug: wissens-duplikate-ohne-ssot
applies_to_features: [rating-solver, bedienpanel-ui, sbc-vorgaben-erkennung, diagnose-werkzeuge, batch-modus, ea-app-anbindung]
related_patterns: [eingebetteten-code-exakt-testen]
related_antipatterns: [helfer-existiert-wird-umgangen]
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

PitTools hat kein Build-System und keine Modul-Grenze: Solver, Panel-UI,
Netzwerk-Interception und Diagnose leben nebeneinander in einer einzigen
Datei (`ea-fc-sbc-optimizer.user.js`), ergänzt um einen separaten
Test-Läufer (`solver-test.js`), der Teile davon per Marker-Extraktion
nachbildet (siehe [[eingebetteten-code-exakt-testen]]). Dieselbe fachliche
Tatsache wird dabei an mehreren Stellen gebraucht, die historisch
unabhängig voneinander entstanden sind: der Solver-Kern (reine Rechenlogik,
über Marker extrahierbar), der Panel-Band-Editor (DOM/localStorage-Ebene,
für Nutzer editierbar), die Netzwerk-Interception (URL-Klassifizierung über
mehrere fetch-/XHR-Einstiegspunkte hinweg) und der Diagnose-Namespace
(organisch gewachsen, ein neues Feld pro Live-Vorfall). Immer wenn eine
solche Tatsache — eine Konstante, eine Formel, ein URL-Pfadmuster, ein
Feldname, ein Objekt-Schema — an einer zweiten Stelle als Literal statt als
Referenz auf die erste landet, entsteht eine Wissens-Duplikate-Situation.
Sie bleibt lange unauffällig, weil jede Kopie für sich funktioniert — bis
genau eine Stelle fachlich angepasst wird und die anderen stillschweigend
zurückbleiben.

## Pattern

Dieselbe fachliche Definition existiert als unabhängig gepflegtes Literal
an mindestens zwei Stellen im Code, ohne dass eine Stelle die andere
ableitet. Für mindestens einen Fall im Projekt ist die Drift bereits
eingetreten und nachweisbar (nicht nur theoretisch): die Rating-Kosten-
Tabelle wurde im August 2026 fachlich korrigiert (86er nicht mehr knapp,
`85-88:2` statt zweier Bänder), aber nur an einer von drei Stellen. Der
Panel-Reset-Button — laut CLAUDE.md „neue Defaults greifen erst nach
‚Zurücksetzen'" — liefert nachweislich den ALTEN Stand:

```js
// Antipattern — bitte NICHT so: dieselbe Tabelle an drei Stellen als Literal
// ea-fc-sbc-optimizer.user.js:1485 (Solver-Default, aktueller Stand)
const DEFAULT_RATING_COST_SPEC =
    '0-80:0, 81-83:2, 84:1, 85-88:2, 89-90:3, 91-92:4, 93+:12';

// ea-fc-sbc-optimizer.user.js:3360-3370 (Panel-Reset-Default, VERALTET)
function defaultBands() {
    return [
        // ...
        { lo: 85, hi: 86, cost: 5 },   // driftet gegen DEFAULT_RATING_COST_SPEC
        { lo: 87, hi: 88, cost: 2 },   // beide zusammen != '85-88:2'
        // ...
    ];
}
// readConfig() baut cfg.ratingCostSpec IMMER aus bandsToSpec(ratingBands) —
// DEFAULT_RATING_COST_SPEC ist im Live-Betrieb mit Panel faktisch tot.

// solver-test.js:440 — dritte, unabhängige Kopie derselben veralteten Tabelle
```

Weitere Ausprägungen derselben Ursache im Projekt, jeweils ohne eine
gemeinsame benannte Quelle:

- **Protokoll-Wissen dupliziert:** das EA-API-Pfadpräfix `sbs`/`sbc` ist
  eine einzige fachliche Tatsache, aber als `(sbs|sbc)`-Regex-Alternation an
  sieben Stellen wörtlich wiederholt statt hinter einer Konstante/Helper-
  Funktion.
- **Formel dupliziert zwischen Produktivcode und Test-Harness:** die
  Kosten-Formel `costOf()` ist eine private Closure innerhalb der
  Solver-IIFE (nicht exportiert) und wird deshalb in `solver-test.js`
  eigenständig nachgebaut — die einzige Absicherung gegen Drift ist ein
  Kommentar, kein Mechanismus.
- **Schema dupliziert durch Abwesenheit einer Schema-Quelle:** `STATE.diag`
  wird an der Deklarationsstelle nur mit 6 von ~21 tatsächlich verwendeten
  Feldern initialisiert; der Report-Baucode muss jedes weitere Feld von
  Hand nachziehen. Ergebnis bereits eingetreten: `uiScan` wird im Report
  gelesen, aber im gesamten File nie zugewiesen — liefert dauerhaft `null`,
  ohne dass irgendwo ein Fehler auffällt. Ein zweites Symptom derselben
  Ursache: `rareConstraints` ist im Report-Objekt-Literal zweimal
  hintereinander deklariert (Copy-Paste-Rest).
- **Namensdrift als Sonderfall derselben Ursache:** das Feld für die Anzahl
  nutzbarer SBC-Slots wird überall unter `formationSlots` geschrieben, aber
  an vier Stellen unter dem nie existierenden Namen `STATE.sbc.slots`
  gelesen — dauerhaft `undefined`. Betroffen ist der Batch-Anker-Abgleich
  (`matchesPlannedSbc`), den CLAUDE.md als Knackpunkt des freigegebenen
  Batch-Modus bezeichnet: der Slots-Teil des Vergleichs ist dadurch ein
  faktischer No-Op, weil beide verglichenen Seiten `undefined`/`0` sind.

**Stattdessen:** eine einzige benannte Quelle je Wissenseinheit (Konstante,
Helper-Funktion oder Schema-Deklaration), aus der alle Verwender ableiten —
für den Fall „Formel im Test nachgebaut" leistet das Extraktionsprinzip aus
[[eingebetteten-code-exakt-testen]] genau das (der Test liest die echte
Formel statt sie zu duplizieren). Wichtig für die bereits nachgewiesenen
Drift-Fälle (Panel-Reset-Defaults, `slots`-No-Op): eine Korrektur ändert
sichtbares Nutzerverhalten (der Reset liefert dann andere Zahlen als
bisher, der Batch-Anker-Abgleich vergleicht dann tatsächlich Slots) und
braucht deshalb einen eigenen Testfall pro Korrektur — kein stiller Fix
nebenbei, sondern ein eigenständiges, gegen Regression geprüftes Ticket.

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:1485` — `DEFAULT_RATING_COST_SPEC` mit dem
  aktuellen Stand `85-88:2`.
- `ea-fc-sbc-optimizer.user.js:3360-3370` — `defaultBands()` mit dem
  veralteten Stand `{lo:85,hi:86,cost:5}, {lo:87,hi:88,cost:2}`.
- `ea-fc-sbc-optimizer.user.js:3384-3392` — `initBandEditor()` und der
  `ui.bandReset`-Handler fallen beide auf genau dieses veraltete
  `defaultBands()` zurück.
- `solver-test.js:440` — dritte, unabhängige Literal-Kopie derselben
  veralteten Tabelle.
- `ea-fc-sbc-optimizer.user.js:187` — `detectApiBase`: erste `(sbs|sbc)`-Regex.
- `ea-fc-sbc-optimizer.user.js:197-200` — `classifyUrl`: drei weitere
  unabhängige `(sbs|sbc)`-Regexe für Set-Challenges/Challenge/Sets.
- `ea-fc-sbc-optimizer.user.js:205` — `classifyUrl`: vierte `(sbs|sbc)`-Regex
  für den Storage-Fallback-Pfad.
- `ea-fc-sbc-optimizer.user.js:291` — XHR-Wrapper: fünfte, eigenständige
  `(sbs|sbc)`-Regex für den Squad-PUT-Body.
- `ea-fc-sbc-optimizer.user.js:2515` und `:2524` — zwei identische
  `STATE.sbc.apiPrefix || 'sbs'`-Fallback-Ausdrücke.
- `ea-fc-sbc-optimizer.user.js:1900-1906` — `costOf(p)`, private
  Original-Formel innerhalb der Solver-IIFE.
- `solver-test.js:69` — Kommentar „MUSS synchron zu costOf() im Userscript
  bleiben".
- `solver-test.js:71-88` — `cardCostFn()`, eigenständige Nachbildung
  derselben Formel.
- `ea-fc-sbc-optimizer.user.js:105-112` — `STATE.diag`-Deklaration deckt nur
  6 Felder ab (`fetchSeen`, `xhrSeen`, `utasSeen`, `lastUtasPaths`,
  `lastErrors`, `evoExcluded`).
- `ea-fc-sbc-optimizer.user.js:1258,2605-2617,4371,4636,4940,5134` — weitere
  `STATE.diag.*`-Felder, jeweils erst durch spätere Zuweisung entstanden,
  nie in der Deklaration nachgezogen.
- `ea-fc-sbc-optimizer.user.js:3758` — `buildDiagReport()` liest
  `STATE.diag.uiScan || null`; keine einzige Zuweisung von `uiScan` im
  gesamten File — das Feld ist im Report tot, liefert immer `null`.
- `ea-fc-sbc-optimizer.user.js:3927-3928` — `rareConstraints` im
  `sbc`-Teilobjekt des Reports zweimal hintereinander deklariert.
- `ea-fc-sbc-optimizer.user.js:492` — schreibt `STATE.sbc.formationSlots = 11;`.
- `ea-fc-sbc-optimizer.user.js:640`, `:675`, `:691` — weitere
  Schreibstellen für `STATE.sbc.formationSlots`, nie für `STATE.sbc.slots`.
- `ea-fc-sbc-optimizer.user.js:576` — `const wantSlots = STATE.sbc.slots;`
  liest das nie existierende Feld.
- `ea-fc-sbc-optimizer.user.js:4037` — `readConfig()` liest korrekt
  `STATE.sbc.formationSlots || 11`.
- `ea-fc-sbc-optimizer.user.js:4795` — `matchesPlannedSbc(plan)`:
  `Number(STATE.sbc.slots || 0) !== Number(plan.slots || 0)` vergleicht zwei
  stets-`undefined`-Werte.
- `ea-fc-sbc-optimizer.user.js:4816` — `plan.slots = STATE.sbc.slots;`
  übernimmt den falschen Wert bereits beim Planen.
- `ea-fc-sbc-optimizer.user.js:4916` — Fehlermeldungstext zeigt dem Nutzer
  `STATE.sbc.slots` an, würde bei echter Diskrepanz `undefined` ausgeben.

## Beziehungen

- **Verschwistert mit:** [[helfer-existiert-wird-umgangen]] — dort umgeht
  Code einen vorhandenen zentralen Weg (z. B. den `reserve()`-Funnel im
  Solver) punktuell; hier fehlt der zentrale Weg von vornherein und jede
  Stelle pflegt ihre eigene Kopie. Beide Antipatterns entstehen aus
  fehlender struktureller Durchsetzung einer Invariante — der eine Fall hat
  eine Quelle, die umgangen wird, der andere hat gar keine Quelle.
- **Werkzeug gegen Test-Drift:** [[eingebetteten-code-exakt-testen]] löst
  genau die Unterklasse „Formel/Logik zwischen Produktivcode und
  Test-Harness dupliziert" (`costOf()` vs. `cardCodeFn()`), indem der Test
  den echten Code extrahiert statt ihn nachzubilden — für die anderen
  Ausprägungen (Panel-Reset-Defaults, Pfadpräfix-Wissen, Diagnose-Schema,
  Namensdrift) braucht es zusätzlich eine gemeinsame benannte Quelle
  innerhalb des Produktivcodes selbst, nicht nur eine Test-Technik.
- **Wurzelursache (Q1-Q7):** Q5 (SSOT) als durchgängige Wurzelursache aller
  fünf Ausprägungen; zusätzlich Q2 bei der Namensdrift, weil die
  defensiven `|| 0`/`|| 11`-Fallbacks an den Lesestellen die entstandene
  Inkonsistenz maskieren statt sie sichtbar zu machen.
