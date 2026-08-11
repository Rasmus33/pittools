# PitTools — EA FC SBC Rating-Optimizer

Tampermonkey-Userscript + Android-WebView-App, die für geöffnete SBC-Challenges
in der EA FC 26 Web App automatisch das günstigste Team (rein nach Rating)
findet und einträgt. Rasmus liefert FIFA-/Business-Wissen, Claude das
JS/Java-Engineering. Umgangssprache: Deutsch.

## Repo-Struktur

- `ea-fc-sbc-optimizer.user.js` — DAS Produkt. Ein einziges Userscript
  (aktuell v4.12.0). Tampermonkey aktualisiert es über `@updateURL`/`@downloadURL`
  im Header selbst; die Handy-App lädt dieselbe Datei von
  `https://raw.githubusercontent.com/Rasmus33/pittools/main/ea-fc-sbc-optimizer.user.js`
  bei jedem App-Start. **Push auf main = Deployment.**
- `solver-test.js` — Test-Suite (Node, keine Dependencies). Extrahiert den
  Solver über die Marker `// [SOLVER-BEGIN]` / `// [SOLVER-END]` aus dem
  Userscript und prüft ihn u.a. per Brute-Force-Vergleich.
- `app/` — Android-App "PitTools" (WebView-Wrapper, lädt Script + PaleTools
  von URLs). Build ohne Gradle: `app/build.sh`. Details in `app/README.md`.
- `docs/LEARNINGS.md` — alle Probleme + Lösungen der Entwicklung. **Vor
  Änderungen an Submit/Erkennung/Solver zuerst lesen** — dort steht, warum
  der Code so ist, wie er ist.
- `docs/ROADMAP.md` — offene Punkte und Ideen.

## Eiserner Arbeitsablauf (nicht verhandelbar)

1. Änderung implementieren.
2. `node --check ea-fc-sbc-optimizer.user.js` — Syntax.
3. `node solver-test.js` — ALLE Tests müssen grün sein (aktuell 67/67).
   Bei Solver-Änderungen: neuen Testfall schreiben, Erwartungswerte NIE aus
   dem Kopf — immer per Brute-Force verifizieren (Vorsicht: der Solver war
   mehrfach schlauer als die Hand-Rechnung).
4. Version bumpen: `@version` im Header UND `const VERSION = '...'`
   (ein Test prüft, dass beide übereinstimmen). In den `==UserScript==`-Block
   gehören NUR `@key value`-Zeilen — freie Kommentare darin machen die
   folgenden Metadaten unwirksam (kostete das Auto-Update in v4.11.0).
   (wird im Panel-Header angezeigt — daran erkennt Rasmus, ob Tampermonkey/
   die App wirklich die neue Version geladen hat).
5. Push auf `main` → beide Handys ziehen die Version automatisch.
6. Bei App-Änderungen: `node app/guard-test.js` (prüft den aus Java-Literalen
   zusammengesetzten PaleTools-Wächter — der fällt sonst STILL aus), dann
   `cd app && ./build.sh`, APK an Rasmus. `versionCode` UND `versionName` im
   Manifest bumpen. Signatur mit `debug.keystore` (liegt NICHT im Repo —
   Rasmus hat ihn; Passwort: android). Ohne denselben Keystore ist kein
   Update-in-place möglich; `build.sh` bricht deshalb ab, statt einen neuen
   Keystore zu erzeugen. Nach dem Build muss `apksigner verify --print-certs`
   SHA-256 `41f23895…1b17` zeigen.

## Produkt-Regeln (von Rasmus, gelten immer)

- Es zählt NUR das Team-Rating. Chemie, Positionen, SBC-Belohnungslogik:
  bewusst ignoriert. Rarity-/Level-/Qualitäts-VORGABEN werden erfüllt.
- Ziel: minimales exaktes Dezimal-Rating über dem Ziel (84er-SBC → 84.00,
  84.03 …). Die Ratingsumme ist EGAL. Innerhalb des Fensters
  "Max. Rating-Überschuss" (Default 0.10) entscheiden die Karten-Kosten.
- Karten-Prioritäten: Storage-Gold → Storage-Special → Verein-Gold.
  Verein-Specials NIE in SBCs — einzige Ausnahme: TOTW (rareflag 3).
- Unverkäufliche Karten zuerst verbauen (Default-Rabatt 3, im Panel
  einstellbar): für den Transfermarkt wertlos, für SBCs vollwertig.
- Evolutions (Academy-Items) NIEMALS verbauen.
- Rating-Kosten-Tabelle (editierbar im Panel, seine Defaults):
  0-80:0, 81-83:2, 84:1, 85-86:5, 87-88:2, 89-90:3, 91-92:4, 93+:12.
- Rarity-Schutz: Karten der Gruppe 83 (TOTW/TOTS/FOF/FUTTIES) sind wertvoller
  als ihr Rating. HARTE Regel: ohne Vorgabe keine, mit Vorgabe GENAU die
  geforderte Anzahl — lieber hohes Vereins-Gold als eine unnötige FUTTIES.
  Nur wenn die SBC sonst unlösbar ist, wird gelockert (mit Warnung). Der
  Kosten-Aufschlag (Default +8) wirkt zusätzlich innerhalb des Erlaubten.
- Ein Klick = Optimieren + Eintragen. Bei EINZEL-SBCs drückt Rasmus Submit
  selbst im Spiel.
- **Batch-Modus (ab v4.11.0) darf abgeben** — von Rasmus ausdrücklich
  freigegeben, aber nur in dieser Form: erst alle Teams planen, Vorschau
  ansehen, dann EINE Freigabe (Button + Rückfrage), danach läuft
  Eintragen→Abgeben sequenziell. Bricht bei jeder Unstimmigkeit sofort ab
  ("2 von 5 fertig" ist besser als eine falsch abgegebene SBC). Der Plan ist
  nach dem Lauf verbraucht, damit niemand zweimal abgibt.
- Der Pool lädt automatisch beim App-Start; nach jedem Eintragen fliegen die
  verbauten Karten aus dem Pool (nächste SBC ohne Neuladen).
- Panel-UI: "Spieler laden" oben, Min-Rating + Max-Überschuss prominent,
  alles andere unter "Erweiterte Einstellungen" (Zustand wird gemerkt).

## Debugging-Konvention

Zwei Kanäle vom Handy — beide liefert Rasmus per Copy-Paste in den Chat:

1. **Script-Diagnose** (im Panel): "Diagnose in Konsole schreiben" → JSON-Report.
2. **App-Log** (ab App v1.5.0, ⚙-Menü): Die App sammelt ALLE Konsolenmeldungen
   der Seite in einem Ringpuffer (400 Zeilen) — auch die von PaleTools und
   uncaught errors. "Log teilen" schickt sie per WhatsApp/Mail, "Log kopieren"
   in die Zwischenablage. Kopf enthält App-Version, Gerät, Script-Größen und
   `paleStatus`. Das ist der einzige Weg an PaleTools-Fehler zu kommen — am
   Gerät hängt keine DevTools-Konsole.

Zum Script-Report: Wichtigste Felder: `lastErrors` (inkl. Server-BODY bei PUT-Fehlern),
`refreshLog`, `submitVia` (app/http/services), `controllerScan`, `sbc.*`
(erkannte Vorgaben inkl. reqDump/usableSlots), `rareflagHistogram`,
`challengeResponseSample`. Fehlt Info für ein neues Problem: erst ein
Diagnose-Feld einbauen, Report anfordern, dann fixen — hat sich x-fach bewährt.

## Nicht anfassen ohne Grund

- Die Rating-Formel und das V-Maß (siehe LEARNINGS §1) — live verifiziert.
- Der Submit-Weg 0 über `UTItemEntityFactory` + `saveChallenge`
  (LEARNINGS §5) — der EINZIGE Weg, der die Ansicht ohne F5 aktualisiert.
- Seiten-Delay 250ms beim Club-Laden (LEARNINGS §7) — 120ms provoziert
  Rate-Limit-401er, war ein Live-Ausfall.
- Die Spieler-Eindeutigkeit pro assetId (LEARNINGS §6) — sonst HTTP 460.
