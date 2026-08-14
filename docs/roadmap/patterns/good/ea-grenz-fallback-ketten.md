---
name: Fallback-Ketten an jeder Fremd-Grenze
slug: ea-grenz-fallback-ketten
applies_to_features: [ea-app-anbindung, spieler-pool, batch-modus, android-app-wrapper]
related_patterns: [strukturierte-ok-why-rueckgabe]
related_antipatterns: [stille-catches-nur-an-der-ea-grenze]
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

PitTools bedient sich an drei fremden, undokumentierten Grenzen: der EA-Web-App-API
(Session-Header, Endpunkt-Formen, Antwortstrukturen), dem EA-DOM (CSS-Klassen,
Tap-Handler, Kachel-/Zeilen-Layout) und dem eigenen Netz für die Skript-Beschaffung
(Download der `.user.js`-Datei bzw. von PaleTools). An allen drei Stellen gilt: EA
kann Klassennamen, Endpunkt-Verhalten oder Rate-Limits jederzeit ohne Ankündigung
ändern, und ein Netz-Download kann schlicht scheitern (Timeout, Redirect, fehlende
Verbindung). Ein einzelner, "bester" Weg ist an keiner dieser Grenzen ausreichend —
er wird irgendwann der einzige Ausfallpunkt. Immer wenn eine neue Fremd-Grenze
angebunden wird (neuer Endpunkt, neue EA-View, neue Ressourcenquelle), tritt diese
Situation auf.

## Pattern

Jede Fremd-Grenze wird über eine geordnete Kette mehrerer Wege bedient, nicht über
einen einzelnen. Die Reihenfolge ist nach Vertrauenswürdigkeit/Kosten sortiert (z.B.
"dokumentierter Weg zuerst", "günstiger Cache vor teurem Download"). Jede Stufe fängt
ihren eigenen Fehler ab und wertet ihn NICHT als fatal — sie hinterlässt stattdessen
eine Diagnose-Spur (`warn`/`diagError`/`why`-Feld), welcher Versuch scheiterte und
warum, und reicht an die nächste Stufe weiter. Erst wenn ALLE Stufen erschöpft sind,
wird der Aufruf als gescheitert behandelt (Exception oder `{ok: false, why: ...}`).
Bei DOM-Selektoren tritt an die Stelle von "Endpunkt A/B" eine Kette von
Selektor-/Vergleichsstrategien; bei der Skript-Beschaffung eine Kette aus
Download → Cache → gebündeltem Asset.

```js
// Netz-Grenze: Ebene A bevorzugt, Ebene B nur wenn A nichts lieferte.
// Fehler jeder Stufe sind fuer sich genommen nicht fatal.
async function loadX(onProgress) {
    let result = 0;
    if (primaryAvailable()) {
        try { result = await fetchViaPrimary(onProgress); }
        catch (e) { warn('Primärweg fehlgeschlagen:', e); result = 0; }
    }
    if (!result && fallbackAvailable()) {
        try { result = await fetchViaFallback(onProgress); }
        catch (e) { diagError('Fallback fehlgeschlagen: ' + (e.message || e)); }
    }
    if (!result && !primaryAvailable() && !fallbackAvailable()) {
        throw new Error('Alle Wege erschöpft. Details: Diagnose-Button.');
    }
    return result;
}

// DOM-Grenze: Selektorkette + Diagnose bei Totalausfall statt blindem Abbruch.
function findRow() {
    let rows = query(SELECTOR_A);
    if (!rows.length) rows = query(SELECTOR_B);
    if (!rows.length) rows = query(SELECTOR_C);
    if (!rows.length) {
        return { ok: false, why: 'nichts gefunden', seen: countPerSelector() };
    }
    return { ok: clickLike(rows[0]), why: rows.length + ' Treffer, erstes geklickt' };
}
```

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:1358-1367` — `loadPool()`: HTTP-Club-Endpunkt ist
  Ebene A ("dokumentierter Weg"); scheitert er, wird `clubCount = 0` gesetzt statt
  eine Exception zu werfen — das Scheitern dieser Stufe ist erwartbar, nicht fatal.
- `ea-fc-sbc-optimizer.user.js:1369-1380` — `loadPool()`: App-Services als Ebene B
  laufen nur an, wenn Ebene A nichts geliefert hat (`!clubCount`); ein Fehler hier
  landet über `diagError` in der Diagnose statt den gesamten Ladevorgang zu stoppen.
- `ea-fc-sbc-optimizer.user.js:4719-4729` — `clickChallengeRow()`: drei
  Selektor-Fallbacks (`.ut-sbc-challenge-table-row-view` →
  `.ut-sbc-challenge-tile-view` → `.ut-sbc-challenges-view--challenges > *`); bei
  Totalausfall liefert `seen` die Elementzahl pro Selektor zur Ferndiagnose.
- `ea-fc-sbc-optimizer.user.js:4681-4707` — `clickSetTile(plan)`: dreistufiger
  Titelvergleich (exakter Titel → Titel-Anfang → Teilstring), mit Begründung im
  Kommentar (:4675-4679), warum reiner Teilstring-Vergleich falsche Kacheln träfe;
  bei Fehlschlag liefert `titles` einen Dump der sichtbaren Kacheln.
- `app/java/com/sbctools/browser/MainActivity.java:738-745` — `ScriptLoader`:
  SBC-Optimizer-Skript über Download → Cache → gebündeltes Asset (`readAsset`), in
  genau dieser Reihenfolge, keine Stufe wirft bei Fehlschlag.
- `app/java/com/sbctools/browser/MainActivity.java:748-769` — dieselbe Klasse für
  PaleTools bewusst umgekehrt: Cache zuerst (stale-while-revalidate), Download nur
  als Hintergrund-Auffrischung über `fetchUrlIfChanged` — die Kettenreihenfolge
  richtet sich nach den Kosten der jeweiligen Ressource (900 KB vs. dokumentierter
  API-Weg), nicht nach einem starren Schema.

## Beziehungen

- **Bezieht sich auf:** [[strukturierte-ok-why-rueckgabe]] — die DOM-seitigen
  Fallback-Ketten liefern ihr Ergebnis über genau dieses `{ok, why, ...}`-Format,
  wodurch jede Stufe ihre Diagnose ohne eigenen Log-Aufruf im Rückgabewert mitgibt.
- **Voraussetzungen:** [[stille-catches-nur-an-der-ea-grenze]] — jede Stufe der
  Kette fängt ihren Fehler ab, aber nie stillschweigend: `warn`/`diagError`/`why`
  halten fest, welcher Weg scheiterte und warum, bevor die nächste Stufe versucht
  wird. Ohne diese Diagnose-Pflicht würde die Kette selbst zur Blackbox.
