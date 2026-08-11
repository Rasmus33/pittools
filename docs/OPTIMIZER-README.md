# EA FC SBC Rating-Optimizer

Ein Tampermonkey-Userscript für die **EA FC Ultimate Team Web App**, das für eine geöffnete SBC-Challenge automatisch das **günstigste Team rein nach Rating** findet und in die SBC-Auswahl einträgt.

> Es geht ausschliesslich um das Team-Rating. **Chemie, Formation, Positionen und die eigentlichen SBC-Aufgaben werden bewusst ignoriert** – nur Rating-Vorgaben und optionale Rarity-Vorgaben werden berücksichtigt.

---

## Neu in v2.0.0

- **Fix: SBC-Erkennung.** Die Web App nutzt `sbs/...`-Endpunkte – v1 lauschte nur auf `sbc/...` und hat deshalb nie eine Session oder Challenge erkannt.
- **Neu: App-Services-Ebene.** Das Script greift jetzt bevorzugt direkt auf die internen Services der Web App zu (`services.Club`, `services.Item`, `services.SBC`) – derselbe Weg, den auch PaleTools nutzt. Das funktioniert selbst dann, wenn die Netzwerk-Erfassung nichts sieht.
- **Neu: Challenge-Hook.** Beim Öffnen einer SBC wird die Challenge direkt vom App-Service abgegriffen (Ziel-OVR, Rarity, IDs) – kein Raten von Response-Strukturen mehr.
- **Neu: Exakter Solver.** Statt Greedy+Backtracking rechnet jetzt ein exakter DP-Solver (bounded knapsack): **garantiert minimaler Rating-Waste**, verifiziert durch Brute-Force-Vergleichstests. Storage-Priorität und Abundance-Schonung wirken als Tiebreaker bei gleichem Waste.
- **Neu: Diagnose-Button.** Schreibt einen Debug-Report in die Konsole und die Zwischenablage (ohne Session-Tokens) – falls etwas nicht funktioniert, diesen Report einfach weitergeben.
- **Fix:** Leihspieler werden ausgeschlossen; robustere Header-Erfassung; UI übersteht DOM-Umbauten der App; SBCs mit weniger als 11 Slots werden unterstützt.

---

## Was kann das Script?

- **Session & Challenge automatisch erkennen** – über App-Services-Hooks und Netzwerk-Interception (doppelt abgesichert).
- **Spieler laden** – Verein (paginiert), Unassigned-Pile und SBC-Storage; zusätzlich werden Spieler passiv erfasst, die die App ohnehin lädt.
- **Optimieren** – exakter Solver, findet das Team mit dem **geringsten Rating-Waste**, das den Ziel-OVR erreicht.
- **Eintragen** – schreibt die Spieler in die SBC-Auswahl. Du prüfst im Spiel und drückst selbst auf **Submit**.

### Auswahl-Logik

1. **Primär:** minimales exaktes Dezimal-Rating über dem Ziel (84er-SBC → 84.0x statt 84.27).
2. **Sekundär (im Überschuss-Fenster):** minimale Karten-Kosten laut der editierbaren Rating-Kosten-Tabelle – 80er (Kosten 0) werden vor 85ern (Kosten 5) verbraucht, auch bei Vorgabe-Karten.
3. **Tiebreaks:** Storage-Gold → Storage-Special → Verein-Gold; Ratings bevorzugen, von denen du **viele** Karten hast; beim gleichen Spieler wird vom größten Duplikat-Stapel konsumiert.

---

## Installation

1. **Tampermonkey** installieren (Browser-Erweiterung):
   - [Chrome / Edge](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)
2. Tampermonkey-Icon anklicken → **„Neues Skript erstellen“** (bzw. bei Update: altes Script öffnen, Inhalt komplett ersetzen).
3. Den gesamten Inhalt von `ea-fc-sbc-optimizer.user.js` einfügen.
4. **Speichern** (`Strg+S`).
5. Die EA FC Web App öffnen bzw. **neu laden** (F5).

Nach dem Login siehst du unten rechts einen ⚡-Button.

---

## Bedienung

1. **Einloggen** und einmal durch die App navigieren (z.B. Verein öffnen).
2. Die gewünschte **SBC-Challenge öffnen** – Ziel-OVR und ggf. Rarity-Vorgabe erscheinen im Panel.
3. Auf den **⚡-Button** klicken, um das Panel zu öffnen.
4. **„Spieler laden“** drücken (einmalig pro Session bzw. nach Kaderänderungen).
5. Einstellungen setzen (siehe unten).
6. **„Optimieren“** drücken → Team, Team-OVR und Waste werden angezeigt.
7. Wenn es passt: **„In SBC eintragen“** → im Spiel prüfen und selbst auf **Submit** drücken.

### Einstellungen im Panel

| Einstellung | Bedeutung | Standard |
|---|---|---|
| **Min. Rating pro Spieler** | Es werden keine Karten unter diesem Rating verwendet. | 75 |
| **Special-Karten nur aus Storage** | Wenn AN: Special-Karten aus dem regulären Verein werden ausgeschlossen (nur Storage-Specials + Gold erlaubt). | AN |
| **Max. teure Spieler begrenzen** | Begrenzt die Anzahl der Spieler ab einer Rating-Schwelle (z.B. max. 4 Spieler ab 88 OVR). Exakt im Solver berücksichtigt; wenn unerfüllbar, wird gelockert und gewarnt. | AUS |
| **Anker-Spieler** | Ein fest gesetzter Spieler, der immer verwendet wird. Über das Suchfeld filterbar. | – |

### Diagnose (bei Problemen)

Im Panel unten: **„Diagnose in Konsole schreiben“**. Der Report landet in der Browser-Konsole (F12 → Console) und in der Zwischenablage. Er enthält **keine Session-Tokens**, aber alles, was zur Fehlersuche nötig ist: erkannte API-Pfade, Zähler der abgefangenen Requests, Services-Verfügbarkeit, erkannte SBC-Daten, ein Sample der Challenge-Response. Diesen Report bei Problemen einfach in den Chat kopieren.

Die Status-Zeile im Panel zeigt zusätzlich live: `API: ✓/– · SID: ✓/– · Services: ✓/– · utas: <Anzahl>`.

---

## Team-Rating-Logik (v3: echte EA-Formel)

EA FC berechnet das Squad-Rating **nicht** als simplen Durchschnitt. Die echte (community-verifizierte) Formel:

```
avg    = summe / N
excess = SUMME( rating_i − avg )   für alle Spieler ÜBER dem Durchschnitt
rating = floor( round(summe + excess) / N )
```

Hohe Karten zählen also doppelt (Summe + Excess) – deshalb ist „eine hohe Karte + billige Füller" oft günstiger als ein flaches Team. Der Solver rechnet exakt mit dieser Formel (Band-zerlegter DP über Booster/Füller) und ist per Brute-Force-Vergleich verifiziert (`solver-test.js`).

**Ziel seit v4.0.0: das exakte Dezimal-Rating.** Der Solver minimiert das exakte Squad-Rating über dem Ziel (bei einer 84er-SBC also 84.00, 84.03, …) – die Ratingsumme ist dabei egal. Innerhalb des Fensters **„Max. Rating-Überschuss über Minimum"** (Standard 0.10) entscheidet die Karten-Kosten-Tabelle, welches Team gewählt wird. Das Panel zeigt nach dem Optimieren das exakte Rating (z.B. `84.05`) und den Überschuss (`+0.05`) an.

---

## Hinweise & Grenzen

- Das Script nutzt **inoffizielle** interne EA-Endpunkte und App-Services. EA kann diese jederzeit ändern; dann kann ein Update nötig sein.
- Die Verwendung von Tools, die mit der Web App interagieren, kann gegen die EA-Nutzungsbedingungen verstoßen. **Nutzung auf eigenes Risiko.**
- Das Script trägt das Team nur ein – **Submit drückst du immer selbst** im Spiel.
- Der SBC-Storage-Endpunkt ist noch nicht live verifiziert; falls Storage-Karten im Pool fehlen, hilft der Diagnose-Report bei der Anpassung.
- Leihspieler werden nie verwendet.

---

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Weder App-Services noch Session verfügbar“ | Seite neu laden, einloggen, einmal den Verein öffnen, dann erneut „Spieler laden“. Bleibt es dabei: Diagnose-Report ziehen. |
| „Kein Ziel-OVR erkannt“ | Die SBC-Challenge im Spiel öffnen (die Kachel wirklich anklicken, sodass das Squad-Board erscheint). Bleibt es dabei: Diagnose-Report ziehen. |
| „Ziel-OVR nicht erreichbar“ | Min. Rating senken, „Special nur aus Storage“ deaktivieren oder bessere Karten besorgen. |
| ⚡-Button fehlt | Prüfen, ob Tampermonkey aktiv ist und die Seite eine Web-App-URL ist; Seite neu laden. |
| Eintragen schlägt fehl | Diagnose-Report ziehen – vermutlich weicht der Squad-Endpunkt ab; mit dem Report lässt sich das gezielt fixen. |
