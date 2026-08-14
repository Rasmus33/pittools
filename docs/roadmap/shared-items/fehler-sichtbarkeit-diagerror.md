---
slug: fehler-sichtbarkeit-diagerror
repo: pittools
target_paths:
  - ea-fc-sbc-optimizer.user.js
test_paths:
  - solver-test.js
enforcement_rule_paths: []
consumers: [diagnose-werkzeuge, ea-app-anbindung, spieler-pool, team-eintragen]
bundle_topic: diagnose-helfer
priority: P1-high
effort: S
last_updated: 2026-08-15
---

# Shared Item — fehler-sichtbarkeit-diagerror

## Zweck

Ein `reportError(label, e)`-Helfer direkt neben der bestehenden
`diagError()`-Definition (ea-fc-sbc-optimizer.user.js:116-122), der
`warn()` + `diagError()` in EINEM Aufruf bündelt. Ersetzt das Antipattern
[[fehler-unsichtbar-verschluckt]]: an ≥ 10 Call-Sites über 5 Features ruft
ein Catch nur `warn()` (nur Konsole) statt zusätzlich `diagError()` (landet
in `STATE.diag.lastErrors` → kopierbarer Report). Am Handy hängen keine
DevTools — was nicht im Report ist, existiert für die Fehlersuche nicht.
Der Helfer erzwingt die Report-Pflicht strukturell statt pro Call-Site.

## API

```js
/** warn() + diagError() in einem Aufruf — für reportwürdige eigene Fehler.
 *  NICHT für die bewusst stillen Catches an der EA-Grenze
 *  (siehe patterns/good/stille-catches-nur-an-der-ea-grenze.md). */
function reportError(label, e) {
    warn(label + ':', e);
    diagError(label + ': ' + ((e && e.message) || String(e)));
}
```

## Konsumenten

| Feature | Wo verwendet | Bisher inline (Antipattern-Stelle) |
|---------|--------------|-------------------------------------|
| `diagnose-werkzeuge` | liefert den Helfer-Kern + Testblock | — (Eigentümer der Report-Infrastruktur) |
| `ea-app-anbindung` | Services-Fallbacks + Sync | `ea-fc-sbc-optimizer.user.js:1100`, `:1118`, `:762` |
| `spieler-pool` | Pool-/Lock-Laden | `ea-fc-sbc-optimizer.user.js:1334`, `:1346`, `:907` |
| `team-eintragen` | warn+diagError-Paare im Submit-Pfad | `ea-fc-sbc-optimizer.user.js:2606`, `:2609`, `:2615` |

Hinweis: `batch-modus` (`onBatchPlanClick` :4831-4833) ist fünfter Kandidat —
sein Lift-Plan dieser Iteration deckt die Stelle nicht ab; Folge-Iteration.

## Drift-Schutz (optional)

Statischer Test in `solver-test.js` (Source-Regex): kein neuer
`catch (e) { warn(` -Block in den bekannten reportwürdigen Zonen ohne
`reportError`/`diagError` — mindestens aber ein Test, dass `reportError`
existiert und beide Kanäle bedient.

## Migration

Pro Konsument (Feature-Lift-Tickets dieser Iteration schließen ihre Stellen
teils schon additiv mit warn+diagError — die Umstellung auf `reportError()`
ist dann ein mechanischer Folgeschritt):
1. `reportError(label, e)` statt nacktem `warn(...)` an reportwürdigen Catches.
2. Kein Verhalten ändern: gleiche Log-Zeile, zusätzlich Report-Eintrag.
3. Tests: 180/180 vorher = nachher grün.
