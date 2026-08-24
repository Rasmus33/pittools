# PitTools — EA FC SBC Rating-Optimizer

Tampermonkey-Userscript, das für geöffnete SBC-Challenges in der EA FC Web App
automatisch das günstigste Team **rein nach Rating** findet und einträgt.

Dieses Repository ist das **Auslieferungs-Regal**: hier liegt nur das fertige
Script. Entwicklung, Tests, Dokumentation und die Android-App liegen in einem
privaten Repository.

## Installation (Tampermonkey)

Neues Script anlegen und diese URL als Quelle verwenden — Tampermonkey holt
Updates dann selbst:

```
https://raw.githubusercontent.com/Rasmus33/pittools/main/ea-fc-sbc-optimizer.user.js
```

Die Version steht im Panel-Header, daran ist erkennbar, ob die neueste Fassung
geladen wurde.

## Was es macht

- Erkennt Ziel-OVR und Vorgaben (Rarity, Qualität, Spieler-Level) der offenen
  SBC automatisch.
- Findet das **minimale exakte Dezimal-Rating** über dem Ziel; innerhalb des
  eingestellten Überschuss-Fensters entscheiden die Karten-Kosten.
- Bevorzugt Storage-Karten, meidet knappe Rarities, verbaut keine Evolutions
  und keine per PaleTools gesperrten Karten.
- Ein Klick: optimieren und eintragen. Abgegeben wird von Hand — nur der
  Batch-Modus gibt nach ausdrücklicher Freigabe selbst ab.

Chemie, Positionen und Belohnungslogik werden bewusst ignoriert: es zählt allein
das Team-Rating.

## Lizenz

[PolyForm Noncommercial 1.0.0](LICENSE) — Nutzung, Änderung und Weitergabe sind
erlaubt, **kommerzielle Verwertung nicht**. Wer dieses Werk oder daraus
abgeleitete Arbeiten verkauft oder kostenpflichtig anbietet, hat dafür keine
Lizenz.

© 2026 Rasmus Risse
