---
name: Bewusst stille Catches nur an der Grenze zu Fremd-Code
slug: stille-catches-nur-an-der-ea-grenze
applies_to_features: [ea-app-anbindung, sbc-vorgaben-erkennung, bedienpanel-ui, batch-modus]
related_patterns: [diagnose-feld-statt-raten]
related_antipatterns: [fehler-unsichtbar-verschluckt]
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

Das Userscript läuft als Gast in EAs Web App: `fetch`/`XHR`-Interception,
Traversierung beliebiger EA-Objektgraphen (Challenge-Entities, Response-JSON)
und DOM-Zugriffe auf EA-Views laufen bei JEDER Seiteninteraktion mit, nicht
nur wenn Rasmus aktiv eine SBC bearbeitet. Ebenso ist jeder
`localStorage`-Zugriff (Panel-Zustand, Rating-Bands, PaleTools-Locks) von
außen beeinflussbar (Quota, privater Modus, korruptes JSON durch ein anderes
Script). An all diesen Stellen gilt: ein Fehler im eigenen Beobachtungs-/
Lesecode darf niemals die Host-Seite zum Absturz bringen oder eine fremde
Anfrage blockieren. Das ist etwas fundamental anderes als ein Fehler in
eigener Fachlogik (Solver, Submit-Entscheidung), der für Rasmus sichtbar
werden MUSS.

## Pattern

Ein Catch bleibt nur dann bewusst leer (kein `warn`, kein `diagError`, kein
`toast`), wenn beide Bedingungen zutreffen:

1. **Fremd-Grenze:** Der try-Block fasst ein Objekt an, das nicht vom eigenen
   Script kontrolliert wird — EA-Interna (Response-Objekte, Challenge-Bäume),
   der native `fetch`/`XHR`-Mechanismus der Seite, oder `localStorage`, dessen
   Verfügbarkeit die Laufzeitumgebung entscheidet, nicht das Script.
2. **Folgenlos bei Überspringen:** Der übersprungene Einzelfehler beschädigt
   höchstens die Vollständigkeit einer Traversierung/eines Lesevorgangs
   (eine Property wird nicht gescannt, ein Storage-Key bleibt ungelesen) —
   er verhindert nicht, dass die eigentliche Anfrage/Aktion durchläuft, und
   er wird nicht als „hat funktioniert“ missverstanden.

Sobald einer der beiden Punkte nicht zutrifft — der Fehler kommt aus eigener
Logik, oder ein übersprungenes Ergebnis würde eine falsche Fachentscheidung
nach sich ziehen (z.B. ein nur teilweise gelesener PaleTools-Lock-Bestand,
der CLAUDE.mds „NIEMALS verbauen“ unterlaufen könnte) — gehört mindestens
`warn()`, bei Report-Relevanz zusätzlich `diagError()` in den Catch (siehe
Gegenstück [[diagnose-feld-statt-raten]] und Antipattern
[[fehler-unsichtbar-verschluckt]]).

```js
// Fremd-Grenze: EA-Response-Objekt, Fehler darf den Request nicht blockieren
try {
    const url = (typeof input === 'string') ? input : (input && input.url);
    if (url) { detectApiBase(url); }
} catch (e) {} // bewusst leer — Interception darf EAs fetch nie stören

// Fremd-Grenze: Traversierung eines beliebigen EA-Objektgraphen
for (const k in o) {
    let child;
    try { child = o[k]; } catch (e) { continue; } // eine Property übersprungen ≠ Scan-Abbruch
    if (child && typeof child === 'object') queue.push({ o: child, d: d + 1 });
}

// Fremd-Grenze: localStorage kann jederzeit nicht verfügbar/korrupt sein
try { localStorage.setItem('sbcOptRatingBands', JSON.stringify(ratingBands)); } catch (e) {}

// NICHT diese Regel: eigene Fachentscheidung — hier bleibt warn()+diagError() Pflicht,
// weil ein stiller Fehlschlag eine gesperrte Karte unbemerkt verbaubar machen könnte.
```

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:248` / `257` — `fetch()`-Wrapper: leerer Catch
  beim Header-Lesen bzw. Response-Klonen, damit die interceptete EA-Anfrage
  in jedem Fall durchläuft.
- `ea-fc-sbc-optimizer.user.js:280` / `302` / `305` — `XMLHttpRequest`-Wrapper
  (`setRequestHeader`, `send`, Response-Auswertung): dieselbe Absicherung.
- `ea-fc-sbc-optimizer.user.js:356` — `isDomOrWindow(o)`: Zugriff auf
  potenziell fremde `Node`/`Window`-Typen liefert `false` statt Crash.
- `ea-fc-sbc-optimizer.user.js:454` / `522` / `558` — `deepScanChallenge` /
  `findChallengeNode` / `collectChallengeNodes`: `try { child = o[k]; } catch
  (e) { continue; }` beim Durchlaufen beliebiger EA-Objektbäume — eine
  übersprungene Property ändert nur die Vollständigkeit des Scans.
- `ea-fc-sbc-optimizer.user.js:4279` — `popupState()`: `getBoundingClientRect`/
  Sichtbarkeits-Check auf EA-DOM-Elementen innerhalb eines umschließenden
  `try { ... } catch (e) {}`.
- `ea-fc-sbc-optimizer.user.js:3379` — `saveBands()`: `localStorage.setItem`
  in eigenem `try/catch`, fällt bei Fehlschlag folgenlos auf den
  vorherigen In-Memory-Stand zurück.
- `ea-fc-sbc-optimizer.user.js:3383`–`3385` — `initBandEditor()`: sowohl
  JSON-Parse-Fehler als auch fehlender Wert landen still bei
  `defaultBands()`.
- `ea-fc-sbc-optimizer.user.js:892` — `readPaletoolsLocks()`: einzelner
  `localStorage.getItem`-Aufruf pro Key in eigenem `try/catch (e) { continue;
  }` — nur dieser eine Key wird übersprungen, nicht die ganze Sperrliste.

## Beziehungen

- **Bezieht sich auf:** [[diagnose-feld-statt-raten]] — die Grenze dieses
  Patterns: sobald ein Fehler für Rasmus reportwürdig ist (eigene Logik,
  Netzwerk-/Service-Aufrufe, Submit-Pfade), gilt statt stillem Catch die
  `warn()`+`diagError()`-Pflicht.
- **Widerspricht:** [[fehler-unsichtbar-verschluckt]] — dort werden
  strukturell gleichwertige Catches an der EIGENEN Fehlergrenze (Pool-Laden,
  Batch-Planung, `syncSbcWithOpenChallenge`) fälschlich wie Fremd-Grenzen
  behandelt und bleiben ohne `diagError`.
- **Voraussetzungen:** keine — dieses Pattern ist die Grundregel, an der sich
  jeder neue Catch-Block zuerst einordnen muss (Fremd-Grenze vs. eigene
  Logik), bevor entschieden wird, ob `warn`/`diagError` folgen.
