---
name: Fehler unsichtbar verschluckt
slug: fehler-unsichtbar-verschluckt
applies_to_features: [spieler-pool, ea-app-anbindung, android-app-wrapper, diagnose-werkzeuge, batch-modus]
related_patterns: [diagnose-feld-statt-raten]
related_antipatterns: [stille-catches-nur-an-der-ea-grenze, diag-namespace-ohne-schema]
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

Rasmus hat am Gerät keine angeschlossene DevTools-Konsole. Die einzigen zwei
Kanäle, über die ein Fehler ihn überhaupt erreicht, sind der per Copy-Paste
gelieferte Diagnose-Report (`STATE.diag.lastErrors`, gefüllt über
`diagError()`) und das App-Log (`addLog`-Ringpuffer der Android-App). Was in
keinem der beiden landet, existiert für die Fehlersuche nicht — es ist
höchstens über den Umweg "App-Log teilen" sichtbar, wenn die App die
`console.*`-Ausgabe der Seite ohnehin mitschneidet, oder gar nicht, wenn eine
Java-Exception in der App selbst gefangen wird.

Die Situation tritt auf, sobald ein neuer Catch-Block für einen fehlschlagen
könnenden Netzwerk-, Service- oder Cache-Aufruf geschrieben wird: Pool-Laden
(HTTP- und Services-Fallback), PaleTools-Lock-Liste lesen, SBC-Erkennung mit
der offenen Ansicht synchronisieren, Batch-Planung, sowie sämtliche
Netzwerk-/Cache-Pfade der Android-App (Skript-Download, bedingter GET,
Asset-/Cache-Lesen, Cache-Schreiben, App-Version ermitteln). An all diesen
Stellen existiert die Diagnose-Infrastruktur bereits und wird an strukturell
identischen Nachbarstellen auch benutzt — nur eben nicht überall.

## Pattern

Ein Catch-Block fängt einen reportwürdigen Fehler (Netzwerk-Timeout, falscher
Statuscode, IO-Fehler, kaputtes JSON) und ruft nur den Konsolen-Logger auf
(`warn()` im Script bzw. gar keinen Log-Aufruf in der App). Der Fehler wird
damit technisch nicht verschluckt — er wird nur an einen Kanal geschickt, der
am Gerät niemand liest, statt zusätzlich an den einen Kanal, der tatsächlich
kopiert und zurückgespielt wird. Am Ende landet nur das nachgelagerte Symptom
im Report ("Storage ist leer", "Optimizer=-1 Zeichen"), nicht die Ursache.

```js
// Antipattern — bitte NICHT so
async function fetchStorageViaHttp() {
    const out = [];
    try {
        const json = await apiGet('storagepile');
        for (const it of extractItems(json)) {
            const p = normalizePlayer(it, true);
            if (p) out.push(p);
        }
    } catch (e) { warn('storagepile-Fetch Fehler:', e.message); }
    // fehlt: diagError('storagepile-Fetch Fehler: ' + e.message)
    return out;
}
```

```java
// Antipattern — bitte NICHT so (MainActivity.java)
String fetchUrl(String u) {
    try {
        HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        c.setInstanceFollowRedirects(true);
        if (c.getResponseCode() != 200) return null;
        return readStream(c.getInputStream());
    } catch (Exception e) { return null; }
    // fehlt: addLog(...) mit e.getMessage() / Statuscode
}
```

**Stattdessen:** [[diagnose-feld-statt-raten]] — jeder reportwürdige
Fehlerpfad ruft zusätzlich zum Konsolen-Logger den Report-Kanal auf
(`warn(...)` + `diagError(...)` im Script, `addLog(...)` in der App), analog
zu den bereits vorhandenen Vorbildern (`apiGet`/`apiPut`,
`refreshOpenSbcView`, `onBatchRunClick`). Abzugrenzen von
[[stille-catches-nur-an-der-ea-grenze]]: dort ist ein leerer Catch bewusst
und richtig, weil er fremden, nicht kontrollierten EA-Code vor dem Absturz
schützt und der übersprungene Fehler folgenlos bleibt — hier geht es um
EIGENE Aufrufe (Netzwerk, Cache, Services), deren Fehlschlag für Rasmus'
Fehlersuche relevant ist.

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:1334` — `fetchUnassignedViaHttp`: `catch (e) { warn('Unassigned-Fetch Fehler:', e); }`, kein `diagError`.
- `ea-fc-sbc-optimizer.user.js:1346` — `fetchStorageViaHttp`: gleiche Lücke, obwohl ein leerer Storage laut `loadPool` einen Toast auslöst, dessen Ursache im Report unsichtbar bliebe.
- `ea-fc-sbc-optimizer.user.js:1100` und `1118` — `fetchUnassignedViaServices` / `fetchStorageViaServices`: dasselbe Muster im Services-Fallback.
- `ea-fc-sbc-optimizer.user.js:907` — `readPaletoolsLocks`: äußerer Catch um die gesamte `localStorage`-Schleife hat nur `warn()`; ein Abbruch mitten in der Schleife hinterließe eine unvollständige, unauffällige Sperrliste — sicherheitsrelevant wegen der "gesperrte Karten NIEMALS verbauen"-Regel.
- `ea-fc-sbc-optimizer.user.js:762` — `syncSbcWithOpenChallenge`: nur `warn()`, obwohl ein Fehlschlag bedeutet, dass die SBC-Erkennung auf veraltetem Stand weiterläuft (LEARNINGS §6 nennt genau dieses Veraltungsrisiko als wiederkehrende Fehlerquelle).
- `ea-fc-sbc-optimizer.user.js:4831`–`4833` — `onBatchPlanClick`: `catch (e) { toast(...); warn(e); }` ohne `diagError`, während die strukturell identische Catch in `onBatchRunClick` (`ea-fc-sbc-optimizer.user.js:4957`–`4960`) `diagError('Batch gestoppt nach ' + done + '/' + n + ': ' + stopped)` zusätzlich aufruft.
- `app/java/com/sbctools/browser/MainActivity.java:392`–`401` (`fetchUrl`) — `catch (Exception e) { return null; }`, kein `addLog`.
- `app/java/com/sbctools/browser/MainActivity.java:409`–`432` (`fetchUrlIfChanged`) — `catch (Exception e) { return null; }`, kein `addLog`; betrifft auch den PaleTools-Cache-Refresh.
- `app/java/com/sbctools/browser/MainActivity.java:434`–`437` (`readAsset`) und `:439`–`442` (`readCache`) — je `catch (Exception e) { return null; }`, kein `addLog`.
- `app/java/com/sbctools/browser/MainActivity.java:444`–`451` (`writeCache`) — Kommentar erklärt WARUM ignoriert wird ("Cache ist optional"), aber auch hier kein `addLog`.
- `app/java/com/sbctools/browser/MainActivity.java:130`–`134` (`appVersion`) — `catch (Exception e) { return "?"; }`, betrifft ausgerechnet den Log-Kopf selbst.

## Beziehungen

- **Wird abgelöst durch:** [[diagnose-feld-statt-raten]] — dessen Vorbild-Stellen (`apiGet`/`apiPut`, `submitToSbc`, `refreshOpenSbcView`, `onBatchRunClick`) zeigen den Zielzustand: `warn`/Konsolen-Log UND Report-Kanal gemeinsam.
- **Verschwistert mit:** [[stille-catches-nur-an-der-ea-grenze]] — dieselbe Catch-Syntax, aber gegenteilige Berechtigung: dort fremder, nicht kontrollierter Code und folgenloser Fehler; hier eigener Aufruf mit reportwürdigem Fehlschlag.
- **Verschwistert mit:** [[diag-namespace-ohne-schema]] — fehlendes SSOT für `STATE.diag` begünstigt, dass eine neue Fehlerklasse an einer Call-Site vergessen wird, weil keine zentrale Stelle festlegt, was in den Report muss.
- **Wurzelursache (Q1-Q7):** Q5 (SSOT) — es gibt keinen gemeinsamen Wrapper (z.B. `reportError(msg, e)` = `warn`/Log + Report-Ablage in einem Aufruf), der die Entscheidung "dieser Fehlertyp muss in den Report" strukturell erzwingt; sie hängt stattdessen vom Autor-Moment an jeder einzelnen Call-Site ab. Für die Android-Seite zusätzlich Q1/Q2: die `addLog`-Infrastruktur war zum Zeitpunkt dieser Methoden bereits vorhanden, wurde hier aber nicht konsequent verwendet — ein Symptom-Fix ("Absturz verhindern, `null` zurückgeben") ohne Anschluss an die andernorts bereits gelöste Frage "wie sieht Rasmus am Gerät, WARUM etwas fehlschlug?".
