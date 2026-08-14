---
name: Abbruch-Disziplin — bei Unstimmigkeit sofort, erklärend und ohne Halbzustand abbrechen
slug: abbruch-disziplin
applies_to_features: [batch-modus, rating-solver, android-app-wrapper, team-eintragen]
related_patterns: [strukturierte-ok-why-rueckgabe, diagnose-feld-statt-raten]
related_antipatterns: []
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

Mehrere Stellen im Projekt führen einen Schritt aus, der nicht rückgängig
gemacht werden kann oder dessen Fehlschlag am Gerät nicht per DevTools
nachvollziehbar ist: ein Team an EA abgeben, eine SBC-Wiederholung öffnen und
befüllen, eine APK signieren und ausliefern. Vor jedem solchen Schritt prüft
der Code eine Bedingung, die eigentlich immer erfüllt sein sollte (Karte noch
im Pool, offene SBC passt zum Plan, `debug.keystore` liegt vor, Quell-Script
existiert) — und die trotzdem gelegentlich nicht zutrifft, weil sich der
externe Zustand (EA-Ansicht, Set-Wiederholbarkeit, lokales Dateisystem)
zwischen Planung und Ausführung ändern kann. Die Situation tritt überall dort
auf, wo "einfach mit dem letzten bekannten Stand weitermachen" schlimmer wäre
als "hier abbrechen und den erreichten Fortschritt melden".

## Pattern

Bei jeder Unstimmigkeit sofort abbrechen (`throw` bzw. `exit 1` bzw.
`{ ok: false, reason }`) statt mit einem Best-Effort oder einer Vermutung
weiterzumachen — auch mitten in einer Mehrschritt-Sequenz. Drei Eigenschaften
machen den Abbruch zum Feature statt zum rohen Fehler:

1. **Erklärend statt kryptisch:** Die Meldung nennt den konkreten Grund (oft
   mit Ist/Soll-Diff oder Diagnose-Verweis), nie nur "Fehler".
2. **Fortschritt bleibt sichtbar:** Bereits erledigte Teilschritte werden
   nicht zurückgerollt und nicht verschwiegen ("2 von 5 fertig" statt eines
   nackten Abbruchs).
3. **Kein Wiederaufsetzen mit Halbzustand:** Nach Abbruch (oder Erfolg) gilt
   der Plan als verbraucht — ein erneuter Lauf startet sauber neu, statt an
   einem unklaren Zwischenstand weiterzumachen.

```js
// Vor jedem irreversiblen Schritt den Ist-Zustand gegen den Plan prüfen.
// Bei Unstimmigkeit sofort abbrechen statt mit Best-Effort weiterzumachen -
// eine falsch abgegebene SBC lässt sich nicht zurücknehmen.
let done = 0;
try {
    for (const round of plan.rounds) {
        if (!stateMatchesPlan(round)) {
            throw new Error('Runde ' + (done + 1) + ': Zustand passt nicht ' +
                'zum Plan (Diagnose schicken). Nichts eingetragen.');
        }
        await doIrreversibleStep(round);
        done++;
    }
} catch (e) {
    diagError('Gestoppt nach ' + done + '/' + plan.rounds.length + ': ' + e.message);
} finally {
    plan.consumed = true; // kein zweites Abgeben mit Restzustand
    report(done + ' von ' + plan.rounds.length + ' erledigt' + (e ? ' · ' + e.message : ''));
}
```

Dasselbe Prinzip gilt außerhalb von Schleifen: Funktionen mit
Ergebnis-Rückgabe (statt Exception) liefern bei erkannter Unstimmigkeit
`{ ok: false, reason }` und schreiben nichts — das ist die Objekt-Variante
desselben Abbruchs, siehe [[strukturierte-ok-why-rueckgabe]]. Und außerhalb
der Laufzeit gilt es auch im Build-Skript: ein fehlender Keystore oder ein
fehlendes Quell-Asset führt zu `exit 1` mit erklärendem Text, nicht zu einer
stillschweigenden Ersatzhandlung (neuer Keystore, veraltetes Bundle).

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:4905-4907` — `onBatchRunClick`: fehlende
  Pool-Karte(n) brechen die Batch-Runde sofort ab
  (`throw new Error(tag + ': ... Karte(n) nicht mehr im Pool.')`).
- `ea-fc-sbc-optimizer.user.js:4914-4918` — offene SBC passt nicht zum
  geplanten Ziel-OVR/Slots → Abbruch mit Ist/Soll-Diff in der Meldung.
- `ea-fc-sbc-optimizer.user.js:4943-4954` — `openNextInstance` liefert
  `!next.ok`: entweder ein erklärender "Set erschöpft"-Abbruch (Plan-Ende,
  kein echter Fehler) oder ein genereller Abbruch mit Diagnose-Verweis.
- `ea-fc-sbc-optimizer.user.js:4965-4969` — `finally`: `STATE.batch = null`
  (Plan nach Abbruch oder Erfolg verbraucht) plus explizite Fortschrittsanzeige
  ("`done` von `n` abgegeben") statt eines nackten Fehlers.
- `ea-fc-sbc-optimizer.user.js:2115-2147` — `finishTeam`: Endkontrolle auf
  doppelte Karten-ID/`assetId` und falsche Teamgröße vor dem Schreibzugriff;
  bei Treffer `{ ok: false, reason: 'Interner Fehler: ... Nichts eingetragen ...' }`
  statt eines PUT, der laut Kommentar live in HTTP 460 endete.
- `ea-fc-sbc-optimizer.user.js:596-599` — `resolveFreshChallengeId`: bei
  mehrdeutigem oder fehlendem Kandidaten `null` zurückgeben statt zu raten
  ("sonst landet das Team in einer fremden SBC").
- `app/build.sh:46-58` — Keystore fehlt → harter Abbruch (`exit 1`) mit
  Erklärung, statt still einen neuen zu erzeugen (macht Update-in-place
  unmöglich); nur mit explizitem `ALLOW_NEW_KEYSTORE=1` umgehbar.
- `app/build.sh:63-67` — fester Pfad zum Quell-Script mit hartem Fehler, wenn
  er fehlt, statt eines `|| true`, das das gebündelte Offline-Asset unbemerkt
  veralten ließe.

## Beziehungen

- **Bezieht sich auf:** [[strukturierte-ok-why-rueckgabe]] — die
  Objekt-Variante desselben Abbruchs für Funktionen ohne Exception-Vertrag
  (`{ ok: false, reason }` statt `throw`).
- **Bezieht sich auf:** [[diagnose-feld-statt-raten]] — jeder Abbruch, der für
  die spätere Fehlersuche relevant ist, landet zusätzlich über `diagError`
  im Report, nicht nur als Toast/Exception-Text.
- **Voraussetzungen:** Der Aufrufer muss den Abbruch tatsächlich als Endstand
  behandeln (Plan verbrauchen, UI zurücksetzen) statt ihn zu schlucken und
  denselben Lauf erneut zu versuchen.
