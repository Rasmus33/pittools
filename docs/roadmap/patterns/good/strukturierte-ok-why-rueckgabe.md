---
name: Strukturierte {ok, why/reason, ...}-Rückgabe pro riskanter Aktion
slug: strukturierte-ok-why-rueckgabe
applies_to_features: [batch-modus, rating-solver, sbc-vorgaben-erkennung, team-eintragen]
related_patterns: [diagnose-feld-statt-raten, abbruch-disziplin]
related_antipatterns: []
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

Riskante Einzelaktionen — ein Tap gegen eine EA-View (Kachel, Zeile, Filter,
Zurück-Pfeil), die Endkontrolle eines Solver-Teams vor dem Schreibzugriff,
das Auflösen einer nach jeder Wiederholung neuen `challengeId` — können auf
mehr als eine Art scheitern: Selektor nicht gefunden, falsche Kachel
getroffen, Team ungültig, Kandidat mehrdeutig. Am Gerät hängt keine
DevTools-Konsole; der einzige Weg zur Ursache ist der Diagnose-Report bzw.
das App-Log (CLAUDE.md, Debugging-Konvention). Ein nackter Boolean oder ein
`throw` verlieren genau die Information, die zur Ferndiagnose gebraucht
würde — welche der mehreren möglichen Fehlerursachen es war und mit welchem
Kontext (welche Kacheln waren sichtbar, welche Karte war doppelt).

## Pattern

Jede Funktion, die eine solche riskante Einzelaktion kapselt, gibt statt
eines Booleans oder eines `throw` ein Objekt mit `ok: boolean` und einer für
Rasmus lesbaren `why`/`reason`-Begründung zurück. Erfolg und Misserfolg
teilen dieselbe Form; der Misserfolgsfall trägt zusätzliche Kontextfelder
(z.B. `tiles`, `seen`, `titles`, `teamDump`), die exakt die Information
liefern, die zur Ferndiagnose nötig ist. Extra Logging ist dafür nicht
nötig — die Rückgabe wird unverändert in den Batch-Verlauf bzw.
Diagnose-Report übernommen (`STATE.diag.batchSteps`, `buildDiagReport`).
Aufrufer entscheiden anhand von `.ok`, ob sie fortfahren, einen Fallback
versuchen oder abbrechen; ein `throw` passiert erst eine Ebene höher, wenn
kein sinnvoller Fallback mehr bleibt (siehe `[[abbruch-disziplin]]`).

```js
function clickSomething(target) {
    const candidates = visibleAll('.ea-some-view');
    if (!candidates.length) {
        return { ok: false, why: 'keine Kandidaten sichtbar', seen: 0 };
    }
    const hit = candidates.find(c => matches(c, target));
    if (!hit) {
        return { ok: false, why: 'kein Treffer', want: target,
                 titles: candidates.slice(0, 8).map(titleOf) };
    }
    return { ok: clickLike(hit), why: 'geklickt', hitTitle: titleOf(hit) };
}

// Aufrufer: bekommt Diagnose-Kontext geschenkt, ohne selbst zu loggen
const r = clickSomething(plan.name);
steps.push({ ms: Date.now() - t0, ...r });   // landet 1:1 im Report
if (!r.ok) throw new Error('...: ' + r.why);
```

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:4663-4673` — `clickAllFilter()`: drei
  `{ok, why}`-Rückgaben (schon auf All / gestellt / kein Filter gefunden).
- `ea-fc-sbc-optimizer.user.js:4681-4717` — `clickSetTile(plan)`: `why`
  unterscheidet Trefferart (`exakt`/`Anfang`/`enthalten`), liefert bei
  Fehlschlag einen `titles`-Dump der sichtbaren Kacheln.
- `ea-fc-sbc-optimizer.user.js:4719-4733` — `clickChallengeRow()`: bei
  Fehlschlag ein `seen`-Objekt mit Elementzahlen pro Fallback-Selektor.
- `ea-fc-sbc-optimizer.user.js:4744-4754` — `clickBackButton()`: `why`
  unterscheidet „Overlay offen" von „kein Button gefunden" von Erfolg.
- `ea-fc-sbc-optimizer.user.js:2115-2147` — `finishTeam(team)`: Endkontrolle
  auf doppelte Karten-ID/`assetId`/Teamgröße liefert bei Treffer
  `{ ok: false, reason: '...', teamDump: dump }` statt eines PUT.
- `ea-fc-sbc-optimizer.user.js:596-599` — `resolveFreshChallengeId()`: bei
  mehrdeutigem oder fehlendem Kandidaten `null` statt eines geratenen
  Treffers ("sonst landet das Team in einer fremden SBC").
- `ea-fc-sbc-optimizer.user.js:4479-4481` und `:4940-4942` — der Aufrufer
  reicht die Rückgabe von `clickBackButton()`/`openNextInstance()`
  unverändert in `steps`/`STATE.diag.batchSteps` weiter (`steps.push({ ms:
  ..., back: b })`), das wiederum über `buildDiagReport()` (`:3764`) im
  Diagnose-Report landet — die `why`-Strings sind für Rasmus'
  Copy-Paste-Debugging gedacht, nicht für den Code selbst.

## Beziehungen

- **Bezieht sich auf:** [[diagnose-feld-statt-raten]] — die `why`/`reason`-
  Strings und Zusatzfelder dieses Patterns sind die Nutzlast, die dort ins
  Diagnose-Feld einfließt.
- **Bezieht sich auf:** [[abbruch-disziplin]] — `ok: false` ist der
  Auslöser, an dem der Batch-Lauf sofort mit `throw` abbricht statt mit
  einer Vermutung weiterzumachen.
- **Widerspricht:** stilles `return false`/`return null` ohne Begründung
  sowie ein `throw` direkt aus der Einzelaktion heraus, wenn der Aufrufer
  noch einen Fallback hätte versuchen können.
- **Voraussetzungen:** keine.
