---
slug: test-extraktions-helfer
repo: pittools
target_paths:
  - solver-test.js
test_paths:
  - solver-test.js
enforcement_rule_paths: []
consumers: [batch-modus, diagnose-werkzeuge, rating-solver, spieler-pool, sbc-vorgaben-erkennung, bedienpanel-ui, team-eintragen, ea-app-anbindung]
bundle_topic: test-infrastruktur
priority: P1-high
effort: S
last_updated: 2026-08-15
---

# Shared Item — test-extraktions-helfer

## Zweck

Ein gemeinsamer `extractFunction(src, name)` / `extractMarkerBlock(src, beginMarker,
endMarker)`-Helfer in `solver-test.js`, der den >10-fach duplizierten
Extraktions-Boilerplate (indexOf/slice/Klammer-Zählung + `new Function`)
konsolidiert. Setzt das Pattern [[eingebetteten-code-exakt-testen]] als
Infrastruktur um statt pro Testblock neu — beseitigt zugleich das in
aspect-tests.md dokumentierte wiederholte Datei-Neueinlesen (`src` einmal
lesen, überall reichen).

## API

```js
// Marker-Block extrahieren (SOLVER, SBCSCAN, BANDS, CTRL, SBCCTRL, POOL, URLCLS)
function extractMarkerBlock(src, beginMarker, endMarker) -> string
// Benannte Funktion per Klammer-Zählung ausschneiden
function extractFunction(src, functionName) -> string
```

Verhaltens-Vertrag: liefert EXAKT denselben Text wie die heutigen
Inline-Extraktionen (Migrations-Test: alte und neue Extraktion byte-gleich
für jeden bestehenden Testblock, 354/354 vorher = nachher grün).

## Konsumenten

| Feature | Wo verwendet | Bisher inline |
|---------|--------------|----------------|
| alle 8 mit Testblöcken | solver-test.js (>10 Stellen: Blöcke 8b-2, 8b-5, 8b-6, 17, 19–25) | indexOf/slice/Klammer-Boilerplate je Block |
| batch-modus (iter1) | Stuck-Recovery-Verhaltenstest | — (neu) |
| diagnose-werkzeuge (iter1) | Symmetrie-Test-Ausbau + submitInfo-Regressionstest | — (neu) |

## Drift-Schutz (optional)

Statischer Check: kein neues `readFileSync(__dirname` außerhalb des
Kopfbereichs von solver-test.js (eine Quelle, ein Einlesen).

## Migration

1. Helfer oben in solver-test.js definieren (nach dem einmaligen src-Read).
2. Bestehende Blöcke EINZELN umziehen; nach jedem Umzug voller Testlauf.
3. Byte-Gleichheits-Migrations-Test hält alte/neue Extraktion äquivalent.
