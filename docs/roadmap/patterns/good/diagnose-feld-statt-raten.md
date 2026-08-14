---
name: Diagnose-Feld einbauen statt raten
slug: diagnose-feld-statt-raten
applies_to_features: [diagnose-werkzeuge, ea-app-anbindung, team-eintragen, batch-modus, android-app-wrapper]
related_patterns: [strukturierte-ok-why-rueckgabe]
related_antipatterns: [fehler-unsichtbar-verschluckt]
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

Am Gerät (Android-WebView-App) hängt keine DevTools-Konsole. Rasmus liefert
Diagnosedaten ausschließlich per Copy-Paste über zwei Kanäle: den
Script-Diagnose-Report ("Diagnose in Konsole schreiben" → JSON) und das
App-Log (Ringpuffer aller Konsolenmeldungen, teilbar per WhatsApp/Mail). Wenn
für ein neues Live-Problem (z.B. ein unerwarteter Submit-Fehlschlag, ein
Rate-Limit, ein Zustand nach Kachel-Tap) die entscheidende Information fehlt,
lässt sie sich nicht per Remote-Debugging nachträglich beschaffen — die
Situation ist beim nächsten Live-Auftreten schon vorbei. Die Situation tritt
regelmäßig auf: neuer Fehlerpfad, neue Vorbedingung, neuer Submit-Weg — jedes
Mal fehlt zunächst die Sichtbarkeit auf den relevanten Zustand.

## Pattern

Statt aus der Ferne zu raten, wird zuerst Sichtbarkeit geschaffen: ein neues
Feld in der offenen `STATE.diag`-Ablage anlegen, `buildDiagReport()` (bzw. das
App-seitige Log) um dieses Feld erweitern, den Report von Rasmus anfordern —
erst danach den eigentlichen Fix schreiben. Zwei Bausteine tragen das Muster:

1. `STATE.diag` ist eine flach erweiterbare Ablage für Laufzeitzustand
   (Zähler, letzter Fehler, letzter erfolgreicher Submit-Weg, letztes Team).
2. `diagError(msg)` ist ein Zweitkanal neben `warn()`: überall wo ein Fehler
   für die spätere Fehlersuche wichtig ist, landet er zusätzlich — gekürzt und
   ohne Tokens — in `STATE.diag.lastErrors`, dem laut CLAUDE.md wichtigsten
   Report-Feld.

`buildDiagReport()` liest am Ende alle `STATE.diag.*`-Felder plus Live-Scans
in ein einziges, redigiertes JSON-Objekt; ein Klick loggt es UND kopiert es in
die Zwischenablage. Das App-Log ist das komplementäre Gegenstück für alles,
was das Script selbst nicht sieht (PaleTools-Fehler, uncaught errors).

```js
// Zweitkanal: landet gekürzt, ohne Tokens, im kopierbaren Report
function diagError(msg) {
    try {
        const arr = STATE.diag.lastErrors;
        arr.push(String(msg).slice(0, 300));
        if (arr.length > 24) arr.shift();
    } catch (e) {}
}

// An jeder reportwürdigen Fehlerstelle: warn() UND diagError() gemeinsam
try { await submitViaApp(result); }
catch (e) { warn('App-Eintrag meldete Fehler:', e.message); diagError('submitViaApp: ' + (e.message || e)); }

// buildDiagReport() zieht das Feld später ohne weiteres Zutun mit
return { lastErrors: STATE.diag.lastErrors, /* … */ };
```

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:105-112` — `STATE.diag`-Deklaration
  (`fetchSeen`, `xhrSeen`, `utasSeen`, `lastUtasPaths`, `lastErrors`,
  `evoExcluded`) als offene Ablage für Laufzeitzustand.
- `ea-fc-sbc-optimizer.user.js:116-122` — Definition von `diagError`: Ringpuffer
  auf 24 Einträge, jede Meldung auf 300 Zeichen gekürzt.
- `ea-fc-sbc-optimizer.user.js:1190,1202,1218,1231` — `apiGet`/`apiPut` rufen
  `diagError` bei jedem Fetch-Fehler bzw. Nicht-OK-Status auf, inklusive
  mitgeschnittenem Server-BODY bei PUT-Ablehnung.
- `ea-fc-sbc-optimizer.user.js:2606,2609,2615` — `submitToSbc`: alle drei
  Submit-Wege (app/http/services) rufen bei Fehlschlag `warn` UND `diagError`
  gemeinsam auf.
- `ea-fc-sbc-optimizer.user.js:3727-3768` — `buildDiagReport()` sammelt alle
  `STATE.diag.*`-Felder in ein JSON-Objekt; der Kommentar an `batchSteps`
  (`:3761-3764`) dokumentiert, dass ein fehlendes Report-Feld einmal die
  Fehlersuche erschwert hat — das begründet, warum jedes neue Problem zuerst
  ein Diagnose-Feld bekommt statt eine Vermutung.
- `ea-fc-sbc-optimizer.user.js:161,3728,3745-3746` — Redaktion: Session-Events
  werden geloggt statt der Werte, `buildDiagReport()` trägt den Kommentar
  „Bewusst OHNE Session-Token-Werte!", Session-Zustand erscheint nur als
  Boolean (`sidCaptured`, `phishingCaptured`).
- `app/java/com/sbctools/browser/MainActivity.java:89-101` — App-seitiger
  Ringpuffer (`LOG_MAX=400`, `LOG_LINE_MAX=600`) als zweiter Diagnosekanal.
- `app/java/com/sbctools/browser/MainActivity.java:104-125` — `buildLogReport()`
  stellt Kopfdaten (App-Version, Gerät, Script-Größen, `paleStatus`) vor den
  gesammelten Konsolenzeilen zusammen; `shareLog`/`copyLog` (`:136-156`)
  spiegeln die zwei Ausgabewege des Script-Reports (Share-Intent,
  Zwischenablage).
- `app/java/com/sbctools/browser/MainActivity.java:693-703` (`onConsoleMessage`)
  — fängt alle `console.*`-Ausgaben der WebView ab, inklusive der von
  PaleTools, und speist sie in denselben Ringpuffer.

## Beziehungen

- **Bezieht sich auf:** [[strukturierte-ok-why-rueckgabe]] — dort liefert der
  Solver bei erwarteten, im Vorfeld erkennbaren Ablehnungen ein strukturiertes
  `{ ok: false, reason }` statt zu werfen oder zu raten; `diagError` deckt den
  komplementären Fall ab, in dem der Fehler selbst erst über den Report
  sichtbar gemacht werden muss, bevor die Ursache überhaupt bekannt ist.
- **Widerspricht:** [[fehler-unsichtbar-verschluckt]] — ein Catch, der nur
  `warn()` ruft und `diagError()` bei einem reportwürdigen Fehler auslässt,
  hebelt genau diesen Diagnosekanal aus: die Information bleibt in der (am
  Gerät nicht erreichbaren) Konsole und taucht im kopierbaren Report nicht auf.
- **Voraussetzungen:** setzt das Zwei-Kanal-Logging (Script-Report + App-Log)
  als Transportweg voraus, da am Gerät keine DevTools zur Verfügung stehen.
