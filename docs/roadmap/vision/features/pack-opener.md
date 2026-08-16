---
slug: pack-opener
name: Pack-Opener (Store-Batch)
primary_repo: pittools
secondary_repos: []
structural_max:
  RA: 70
phase_sequence:
- core
- diagnose
- tests
- docs
- release
confidence: 0.6
code_geography:
- ea-fc-sbc-optimizer.user.js
- docs/LEARNINGS.md
last_updated: '2026-08-16'
---

# Pack-Opener (Store-Batch)

## Zweck

Besessene Packs (My Packs) in einem Rutsch öffnen statt einzeln: Pack-Typ
wählen → „Alle öffnen" → jede gezogene Karte in den Verein, Duplikate in den
SBC-Storage, bei vollem Storage stoppen, am Ende eine sortierte Zieh-Liste.
Von Rasmus beauftragt (16.08.), weil das manuelle Öffnen (auch via PaleTools)
langsam ist und eine lange Klickstrecke hat.

## Code-Geographie

- `ea-fc-sbc-optimizer.user.js` — Store-Erkennung, Pack-Enumeration
  (services.Store.getPacks → isMyPack), Öffnen (pack.open()), Einsammeln
  (requestUnassignedItems nach setDirty), Verteilen (services.Item.move nach
  CLUB/STORAGE, isDuplicate()), Zieh-Liste, Diagnose-Felder (packScan)
- `docs/LEARNINGS.md` — Mechanik-Herkunft (PaleTools-Analyse) + Live-Befunde

## Strukturelle Maxima — Begründung

- **RA 70**: Hängt vollständig an undokumentierten EA-Services (Store/Item)
  und deren Entity-Methoden (open/isDuplicate/move); Pack-Öffnen ist
  UNUMKEHRBAR (verbrauchte Packs, gezogene Karten) — die Abbruch-Disziplin
  kann Schäden begrenzen, aber nicht rückgängig machen. Gleiches Risikoprofil
  wie der Batch-Modus (70), dieselbe Deckel-Logik.

## Phasen

core → diagnose → tests → docs → release — eiserner Arbeitsablauf. Wegen der
Unumkehrbarkeit lief ein zweistufiger Rollout: Stufe 1 (#69) = Enumeration +
Einzel-Pack-Testlauf + packScan-Diagnose; Stufe 2 (#76) = „Alle öffnen".
Das ursprüngliche Gate „Stufe 2 erst nach live bestätigter Stufe 1" wurde
per PO-Entscheid (Nacht 16.08., Rasmus' „mach alles fertig"-Auftrag) durch
ein technisches Sicherheitsnetz ersetzt: die Schleife nutzt pro Pack exakt
den Stufe-1-Ablauf und stoppt beim ERSTEN Fehler jeder Art (inkl. Throw,
beobachtbar) — ein „Alle öffnen" degradiert damit im schlimmsten Fall zum
Einzel-Testlauf. Die Live-Verifikation der Mechanik-Fragen steht weiterhin
aus und passiert beim ersten echten Lauf.

## Notizen

Mechanik-Quelle: PaleTools-Analyse vom 16.08. (dekodierter packsOpener-Plugin,
Konfidenz hoch auf allen sechs Kernfragen).

**LIVE VERIFIZIERT am 16.08. (erster echter Testlauf, LEARNINGS §50):** Der
Ablauf funktioniert Ende-zu-Ende — 10 Karten, 8 Duplikate → Storage (+8
gemessen), 2 → Verein, kein Fehler. Damit beantwortet: (b) `isDuplicate()`
funktioniert; (d) die open()-Antwort trägt das erwartete `success`-Flag;
(a) das Öffnen klappt, ABER `getPacks()` meldet den Bestand danach
unverändert — die Fresh-Enumeration taugt nicht als Abbruchkriterium (für
"Alle öffnen" ungefährlich: die Rundenzahl ist auf den Anfangsbestand
gedeckelt). Weiter offen: (c) die echte Storage-Kapazität (PaleTools
hartkodiert 100, die Grenze war nie in Sicht).

Zwei Anzeige-Fehler des Laufs sind in v4.72.0 behoben: Pack-Namen kommen als
Lokalisierungs-Key (`services.Localization.localize` löst auf) und die
gezogenen Karten sind Entities, deren Name in den Stammdaten liegt
(`getStaticData()`/`_staticData`/`getStaticDataByDefId`, Schlüssel
`definitionId` statt `assetId`).
Produktregeln: Karten → Verein, Duplikate → SBC-Storage, Storage voll → Stopp,
Zieh-Liste sortiert; Takt nicht schneller als PaleTools' „Fast"
(~300-700ms zwischen Moves, ~500-1400ms zwischen Packs — LEARNINGS-§30-Logik).
