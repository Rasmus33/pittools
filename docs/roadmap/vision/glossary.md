# Glossar

Codebase-spezifische Begriffe. Pflege fortlaufend.

| Begriff | Bedeutung im Projekt |
|---------|----------------------|
| `SBC` | Squad Building Challenge in der EA FC Web App — das Objekt, das PitTools automatisch löst. |
| `Set / Challenge / Instanz` | Ein SET enthält Challenges; jede WIEDERHOLUNG einer Challenge hat eine eigene `challengeId`. Anker für „dieselbe SBC" ist deshalb Set + Vorgaben, nie die ID (LEARNINGS §9). |
| `Ziel-OVR` | Gefordertes Team-Rating der SBC. Ziel des Solvers: minimales exaktes Dezimal-Rating darüber (84 → 84.00, 84.03 …). |
| `V-Maß` | Internes Vergleichsmaß der EA-Rating-Formel (LEARNINGS §1) — live verifiziert, nicht anfassen. |
| `Max-Überschuss` | Panel-Einstellung: erlaubtes Fenster über dem Ziel-Rating (Default 0.00 — kein Rating verschenken). Innerhalb des Fensters entscheiden Karten-Kosten. |
| `rareflag` | EA-Karten-Typ: 0 Common, 1 Rare, 3 TOTW, andere Werte = Specials. |
| `Gruppe 83` | Rarity-Gruppe TOTW/TOTS/FOF/FUTTIES — wertvoller als ihr Rating; harte Schutzregel (ohne Vorgabe keine, mit Vorgabe genau die geforderte Anzahl). |
| `Storage` | SBC-Lager. Verbrauchsmaterial: Storage-Karten werden vor Vereins-Karten verbaut. |
| `Verein / Club` | Der eigene Kartenbestand. Vereins-Specials nie in SBCs (Ausnahme: TOTW). |
| `Unverkäuflich (untradeable)` | Für den Markt wertlos, für SBCs vollwertig — wird bevorzugt verbaut (Default-Rabatt 3). |
| `Evolution / Academy` | Weiterentwickelte Karten (EA-intern „Academy") — NIEMALS verbauen. |
| `PaleTools` | Fremdes Userscript, das parallel läuft; liefert die Karten-Sperren (Schloss) und wird von der App mit injiziert. |
| `Locks` | Per PaleTools gesperrte Karten — nie verbauen, auch nicht als Anker (im Panel abschaltbar). |
| `Anker` | Manuell gesetzte Karte, die das Team enthalten MUSS. |
| `Brick-Slots` | Von der SBC gesperrte Squad-Slots — nur die per `playerRequirements` nutzbaren Indizes werden befüllt. |
| `Pool` | Der geladene Spielerbestand (Club + Unassigned + Storage), aus dem der Solver wählt; nach jedem Eintragen fliegen verbaute Karten raus. |
| `Weg 0` | Der Submit-Weg über `UTItemEntityFactory` + `saveChallenge` — einziger Weg, der die Ansicht ohne F5 aktualisiert (LEARNINGS §5). |
| `Batch` | Mehrfach-Abgabe: alle Teams planen, EINE Freigabe, dann eintragen→abgeben→nächste Runde ohne Handgriffe. Bricht bei jeder Unstimmigkeit ab. |
| `Rating-Kosten-Tabelle` | Editierbare Kosten pro Rating-Band (Panel) — steuert, welche Karten der Solver „teuer" findet. Liegt in localStorage. |
| `Diagnose-Report` | JSON-Report aus dem Panel („Diagnose in Konsole schreiben") — Kanal 1 der Debugging-Konvention. |
| `App-Log` | Ringpuffer aller Konsolenmeldungen in der Android-App (400 Zeilen) — Kanal 2; einziger Weg an PaleTools-Fehler am Gerät. |
| `Wächter (Guard)` | Java-seitig zusammengesetztes Script, das PaleTools' Bereitschaft prüft — fällt sonst still aus; von `app/guard-test.js` geprüft. |
| `Eiserner Arbeitsablauf` | implement → `node --check` → `node solver-test.js` → Version bumpen → Push (= Deployment) → bei App-Änderung guard-test + build.sh. |
