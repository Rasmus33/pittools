---
slice: zustand-config
analyzed_at: 2026-08-14
iteration: 0
---

# Aspect — zustand-config

Rohaufnahme dessen, was im Code zur Slice tatsächlich vorkommt. Vom
`aspect-analyzer`-Subagent geschrieben (Sonnet, parallel pro Slice).
Wird pro Iteration überschrieben — Git-Log ist die Historie.

## Beobachtetes Pattern: Zentrales STATE-Objekt als Single Source of Truth für Laufzeit-Zustand

**Was passiert:** Der gesamte veränderliche Laufzeit-Zustand des Userscripts
lebt in einem einzigen `const STATE = {...}`-Objekt mit thematischen
Namespaces (`session`, `sbc`, `diag`, plus flache Felder wie `pool`,
`poolById`, `batch`, `loading`). Es gibt keine verstreuten globalen
Variablen für Fachdaten — jede Stelle, die z.B. den Pool oder die
SBC-Vorgaben braucht, liest/schreibt über `STATE.*`.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:76-113` — Deklaration von `STATE` mit den
  Namespaces `session`, `sbc`, `diag` sowie `poolById`/`pool`/`batch`.
- `ea-fc-sbc-optimizer.user.js:965` — `STATE.pool = Array.from(STATE.poolById.values());`
  (Array-Sicht wird konsistent aus der Map abgeleitet, nicht parallel gepflegt).
- `ea-fc-sbc-optimizer.user.js:4105` — `STATE.pool = [];` beim Voll-Refresh
  vor dem Neuladen des Pools.
- `ea-fc-sbc-optimizer.user.js:4828` — `STATE.batch = plan;` (Batch-Plan wird
  zentral abgelegt, damit `onBatchRunClick` denselben Stand sieht wie
  `onBatchPlanClick` ihn erzeugt hat).
- `ea-fc-sbc-optimizer.user.js:4965` — `STATE.batch = null;   // Plan verbraucht - kein zweites Abgeben`
  (explizites Invalidieren nach Verbrauch, verhindert Doppel-Abgabe).

**Wo das (noch) fehlt:** Die Panel-Konfiguration selbst (Min-Rating,
Max-Überschuss, Rating-Kosten-Bands, Checkbox-Werte) lebt NICHT in `STATE`,
sondern wird bei Bedarf live aus den DOM-Elementen (`ui.minrating.value` etc.)
und aus `localStorage` zusammengesetzt (`readConfig()`,
`ea-fc-sbc-optimizer.user.js:4034-4062`). Für Panel-Konfig gibt es also kein
äquivalentes zentrales Objekt — der DOM selbst ist hier die Quelle.

## Beobachtetes Pattern: Zentraler Reset beim Challenge-Wechsel statt verstreuter Teil-Resets

**Was passiert:** Beim Wechsel der aktiven SBC-Challenge werden ALLE
`STATE.sbc.*`-Felder, die zur alten Challenge gehören, an einer einzigen
Stelle (`setCurrentChallenge`) zurückgesetzt, bevor neue Werte einfließen.
Das verhindert, dass Vorgaben (Rarity/Level/Quality/Rare-Constraints) einer
vorherigen SBC in die neue durchsickern.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:477-478` — Kommentar zur Absicht: „Wechsel der
  aktiven Challenge: alte Anforderungen zurücksetzen, damit nichts von der
  vorherigen SBC hängen bleibt."
- `ea-fc-sbc-optimizer.user.js:479-496` — `setCurrentChallenge(cid)` setzt
  `targetOVR`, `squadId`, `rarityConstraints`, `playerLevelConstraints`,
  `qualityConstraints`, `otherScopes`, `rareConstraints`, `reqDump`,
  `formationSlots`, `squadSlotTotal`, `usableSlots` gemeinsam zurück.
- `ea-fc-sbc-optimizer.user.js:618` — Aufruf aus `parseSbcChallenge()` sobald
  eine `challengeId` aus der URL erkannt wird.
- `ea-fc-sbc-optimizer.user.js:655` — Aufruf aus `captureChallengeEntity()`
  (App-Service-Pfad), derselbe Reset-Punkt für einen zweiten Erfassungsweg.

## Beobachtetes Pattern: Defensive try/catch-Kapselung aller localStorage-Zugriffe

**Was passiert:** Jeder einzelne `localStorage`-Zugriff (Panel-Zustand,
Rating-Bands, Positionen, PaleTools-Locks) ist einzeln in `try/catch`
eingepackt. Ein fehlschlagender Zugriff (Quota, privater Modus, korruptes
JSON) legt nie das Script lahm, sondern fällt still auf einen Default zurück.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:3350-3352` — Lesen/Schreiben von
  `sbcOptAdvancedOpen`, beide in eigenem `try/catch`.
- `ea-fc-sbc-optimizer.user.js:3379` — `saveBands()`: `try { localStorage.setItem(...) } catch (e) {}`.
- `ea-fc-sbc-optimizer.user.js:3383-3385` — `initBandEditor()`: JSON-Parse-Fehler
  UND fehlender/leerer Wert fallen beide auf `defaultBands()` zurück.
- `ea-fc-sbc-optimizer.user.js:3540-3543` — Position speichern nach Drag,
  in `try/catch`.
- `ea-fc-sbc-optimizer.user.js:3852` — `fabPos` lesen, in `try/catch`.
- `ea-fc-sbc-optimizer.user.js:892` — `readPaletoolsLocks()`: `try { raw = localStorage.getItem(k); } catch (e) { continue; }`.

## Beobachteter Antipattern: Divergierende Default-Werte für dieselbe Konfiguration (Rating-Kosten-Tabelle)

**Was schiefläuft:** Es gibt für dieselbe fachliche Größe — die
Standard-Rating-Kosten-Tabelle — zwei unabhängig gepflegte Hardcode-Quellen,
die inzwischen NICHT mehr übereinstimmen:

- `DEFAULT_RATING_COST_SPEC` (Solver-Ebene) wurde auf den aktuellen Stand
  gebracht: `85-88:2` (ein Band).
- `defaultBands()` (Panel-Band-Editor, das, was ein NEUER Nutzer ohne
  gespeicherten `localStorage`-Wert tatsächlich sieht/verwendet) hat weiterhin
  den alten Wert: `85-86:5, 87-88:2` (zwei Bänder, teurer).

`readConfig()` baut `cfg.ratingCostSpec` immer aus `bandsToSpec(ratingBands)`
(Panel-Bands), NIE aus `DEFAULT_RATING_COST_SPEC` — d.h. im Live-Betrieb
(Panel vorhanden) ist `DEFAULT_RATING_COST_SPEC` faktisch tot, außer als
Fallback in Tests/direkten Solver-Aufrufen ohne Panel. Ein frisch installiertes
Script zeigt also NICHT die im Code-Kommentar dokumentierte „Aug 2026"-Korrektur
(86er nicht mehr knapp), sondern die alte, teurere Tabelle — und dieselbe alte
Tabelle ist zusätzlich noch ein drittes Mal in `solver-test.js` als Literal
festgeschrieben.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1478-1485` — Kommentar „Rasmus' Bewertung,
  Stand Aug 2026: 86er sind nicht mehr knapp und liegen jetzt auf derselben
  Stufe wie 87-88" + `DEFAULT_RATING_COST_SPEC = '0-80:0, 81-83:2, 84:1,
  85-88:2, 89-90:3, 91-92:4, 93+:12'`.
- `ea-fc-sbc-optimizer.user.js:3360-3370` — `defaultBands()` mit
  `{ lo: 85, hi: 86, cost: 5 }, { lo: 87, hi: 88, cost: 2 }` — dem ALTEN Stand,
  nicht an die Aug-2026-Korrektur angepasst.
- `ea-fc-sbc-optimizer.user.js:3383-3385` — `initBandEditor()` fällt bei
  fehlendem `localStorage`-Eintrag auf genau dieses veraltete `defaultBands()`
  zurück — trifft jede Neuinstallation und jedes „Zurücksetzen".
- `ea-fc-sbc-optimizer.user.js:3391-3395` — `ui.bandReset`-Handler setzt
  `ratingBands = defaultBands()` — der Reset-Button, den CLAUDE.md als
  einzigen Weg zu neuen Defaults nennt, liefert hier nachweislich NICHT den
  aktuellen Stand.
- `solver-test.js:440` — dritte, unabhängige Kopie derselben veralteten
  Tabelle als String-Literal (`85-86:5,87-88:2`), bestätigt die Tabelle
  wurde an mindestens drei Stellen dupliziert statt an einer gepflegt.

**Vermutete Wurzelursache:** Q5 (SSOT) — dieselbe fachliche Konfiguration
(Standard-Kostentabelle) ist an drei Stellen als Literal dupliziert
(`DEFAULT_RATING_COST_SPEC`, `defaultBands()`, `solver-test.js`-Fixture)
statt aus einer gemeinsamen Definition abgeleitet. Als die Tabelle im Aug
2026 fachlich geändert wurde, wurde nur eine der drei Stellen aktualisiert —
ein klassisches Symptom fehlender Single Source of Truth, nicht nur ein
einmaliger Flüchtigkeitsfehler.

## Beobachteter Antipattern: Namensdrift zwischen `STATE.sbc.slots` und `STATE.sbc.formationSlots`

**Was schiefläuft:** Das Feld, das die Anzahl nutzbarer SBC-Slots hält, wird
überall unter dem Namen `formationSlots` geschrieben — aber an vier Stellen
unter dem (nie existierenden) Namen `STATE.sbc.slots` gelesen. Da
`STATE.sbc.slots` nie zugewiesen wird, ist es an diesen Stellen dauerhaft
`undefined`. Betroffen ist insbesondere der Batch-Anker-Abgleich, den
CLAUDE.md als „Knackpunkt" des freigegebenen Batch-Modus bezeichnet (Anker =
Set + Ziel-OVR/Slots): der Slots-Teil dieses Vergleichs ist faktisch ein
No-Op, weil beide verglichenen Seiten (`STATE.sbc.slots` beim Planen UND beim
Prüfen) `undefined` bzw. daraus `0` sind — `matchesPlannedSbc()` prüft real
nur noch das Ziel-OVR.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:492` (schreibt `STATE.sbc.formationSlots = 11;`)
  vs. `ea-fc-sbc-optimizer.user.js:576` (`const wantSlots = STATE.sbc.slots;`
  — liest ein anderes, nie geschriebenes Feld).
- `ea-fc-sbc-optimizer.user.js:4037` — `readConfig()` liest korrekt
  `STATE.sbc.formationSlots || 11` für den Solver.
- `ea-fc-sbc-optimizer.user.js:4795` — `matchesPlannedSbc(plan)`:
  `Number(STATE.sbc.slots || 0) !== Number(plan.slots || 0)` — vergleicht
  zwei stets-`undefined`-Werte, der Vergleich kann nie `true` werden.
- `ea-fc-sbc-optimizer.user.js:4816` — `plan.slots = STATE.sbc.slots;` beim
  Planen — übernimmt bereits den falschen (undefinierten) Wert in den Plan.
- `ea-fc-sbc-optimizer.user.js:4916` — Fehlermeldungstext zeigt
  `STATE.sbc.slots` dem Nutzer an (`'/' + STATE.sbc.slots`), würde bei einer
  echten Diskrepanz `undefined` statt der tatsächlichen Slot-Zahl ausgeben.

**Vermutete Wurzelursache:** Q5 (SSOT) / strukturell — zwei Namen
(`slots` und `formationSlots`) für dasselbe Konzept, ohne dass ein Zugriff
über den falschen Namen zur Laufzeit auffällt (kein Schema/Type-Check auf dem
STATE-Objekt). Die defensiven `|| 0`/`|| 11`-Fallbacks an den Lesestellen
maskieren den Fehler zusätzlich, statt ihn sichtbar zu machen (verwandt mit
Q2 — der Fallback verdeckt hier eine echte Inkonsistenz statt nur einen
harmlosen Erstlauf-Zustand abzufangen).

## Weak Signals (zu wenige Belege für Pattern-Status)

- **localStorage-Schlüssel als duplizierte String-Literale:** `'sbcOptRatingBands'`
  taucht als Literal an `ea-fc-sbc-optimizer.user.js:3379` UND `:3383` auf,
  `'sbcOptPanelPos'` als String-Argument an `:3331` und erneut als Literal an
  `:3590`, `'sbcOptFabPos'` an `:3338` und `:3852` — kein zentrales
  Konstanten-Register für Storage-Keys. Bislang ohne erkennbaren Schaden
  (Namen sind stabil), aber ein klassischer Q4-Kandidat, sollte ein Key mal
  umbenannt werden.
- **Initiale `STATE.sbc`-Objektform unvollständig:** Das Literal
  `ea-fc-sbc-optimizer.user.js:84-96` deklariert u.a. `rarityConstraints`,
  `playerLevelConstraints`, `reqDump`, `apiPrefix`, aber NICHT
  `otherScopes`, `rareConstraints`, `qualityConstraints`, `usableSlots` —
  diese Felder entstehen erst durch Zuweisung in `setCurrentChallenge()`
  (`:486-494`) bzw. `applyScan()` (`:694-717`). Vor der ersten Challenge sind
  sie `undefined`; Aufrufer schützen sich zwar defensiv (`STATE.sbc.rareConstraints || []`),
  aber die Objektform ist nicht an einer Stelle vollständig dokumentiert.
- **Uneinheitliches Fallback-Idiom in `readConfig()`:** Manche Felder nutzen
  `!= null ? cfg.X : DEFAULT` (z.B. `ea-fc-sbc-optimizer.user.js:1872` für
  `ratingCostSpec`), andere `parseInt(...) || default` (z.B. `:4038`
  `minRating: parseInt(ui.minrating.value, 10) || 1`). Letzteres verschluckt
  einen legitimen Eingabewert `0` (würde silently zu `1`) — nur 2 Stellen
  beobachtet, daher Weak Signal statt Antipattern-Sektion.

## Zusammenfassung

- 3 Pattern-Kandidaten in dieser Slice
- 2 Antipattern-Kandidaten
- 3 Weak Signals
