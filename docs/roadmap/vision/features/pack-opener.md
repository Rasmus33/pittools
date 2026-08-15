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
Unumkehrbarkeit gilt zusätzlich ein zweistufiger Rollout: Stufe 1 =
Enumeration + Einzel-Pack-Testlauf + Diagnose-Felder (Live-Verifikation der
vier offenen Mechanik-Fragen), Stufe 2 = „Alle öffnen" erst nach bestätigter
Stufe 1.

## Notizen

Mechanik-Quelle: PaleTools-Analyse vom 16.08. (dekodierter packsOpener-Plugin,
Konfidenz hoch auf allen sechs Kernfragen). Offen bis zur Live-Diagnose:
(a) pack.open()-Semantik bei N Instanzen derselben id, (b) isDuplicate()/
duplicateId auf fc26-Unassigned-Entities, (c) echte Storage-Kapazität
(PaleTools hartkodiert 100), (d) Fehlerform von open() bei Entitlement-Fehlern.
Produktregeln: Karten → Verein, Duplikate → SBC-Storage, Storage voll → Stopp,
Zieh-Liste sortiert; Takt nicht schneller als PaleTools' „Fast"
(~300-700ms zwischen Moves, ~500-1400ms zwischen Packs — LEARNINGS-§30-Logik).
