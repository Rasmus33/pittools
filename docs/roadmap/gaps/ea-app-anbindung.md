---
feature: ea-app-anbindung
analyzed_at: 2026-08-15
iteration: 3
regression: false
score_current:
  RA: 74
score_target:
  RA: 75
---

# Gap-Report — EA-Web-App-Anbindung (Session & API-Zugriff)

**Linse dieser Iteration:** EA-Wandel-Toleranz — nur additive Toleranz-Fallbacks,
Früherkennungs-Diagnose, Degradations-Pfade. Keine Umbauten an fetch/XHR-Wrapper,
Session-Header-Absorption oder 401-Retry-Kaskade (Vertrag).

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 74 / 75 (structural_max)
**Schwellwert:** 52.5
**Status:** pass
**Begründung:** `docs/roadmap/audit/ea-app-anbindung.md` (Iteration 2) begründet
den Wert mit der abgeschlossenen `SBS_SBC_PREFIX_RE_SRC`-SSOT-Migration (alle
sieben Call-Sites, ~35 neue Assertions in `solver-test.js` Block 25), der
strukturellen Schließung der Beobachtbarkeit über `reportError()` und der
Q2-konformen `apiRequest`-Dokumentation. Nur **1 Punkt Luft** bis zum
strukturellen Maximum von 75 — der Deckel selbst ist durch die undokumentierte,
jederzeit änderbare EA-API begründet (`vision/features/ea-app-anbindung.md`).
Unter der EA-Wandel-Linse bestätigt sich dieses Bild: die drei größten
Fremd-Grenzen (URL-Klassifikation, API-Base-Erkennung, Service-Objekt-Zugriff)
sind bereits mit Fallback-Ketten UND teilweiser Diagnose abgesichert — die
verbleibenden Lücken sind an EINZELNEN Stellen konkret, aber klein.

## Mängel (≥ 3 — M1)

### RA — Robust Architecture

1. **JSON-Parse-Fehlschlag in `handleResponseBody` ist komplett stumm, der
   zweite Catch nur `warn()` ohne `diagError()`:**
   `ea-fc-sbc-optimizer.user.js:257-258` — `try { json = JSON.parse(bodyText); }
   catch (e) { return; }` läuft OHNE jeden Log-/Report-Aufruf; ändert EA das
   Response-Format eines bereits klassifizierten SBC-Endpunkts (z.B. anderes
   Encoding, BOM, HTML-Fehlerseite statt JSON), verschwindet die Requirement-
   Erkennung lautlos — Rasmus sieht am Handy nichts. Der zweite Catch
   (`:277-279`, `warn('Fehler beim Verarbeiten einer Response:', e)`) ruft
   ebenfalls kein `diagError()` — anders als der sonst durchgängig befolgte
   Zweikanal-Standard (`apiGet`/`apiPut`, `submitToSbc`). Neuer, bisher nicht
   in `patterns/bad/fehler-unsichtbar-verschluckt.md` gelisteter Beleg für
   genau dieses Antipattern, direkt an der EA-Antwort-Grenze.
2. **Kein getrennter Zähler für unklassifizierte `/ut/game/`-URLs
   (Leitfrage 1):** `ea-fc-sbc-optimizer.user.js:221-234` (`detectApiBase`)
   und `:237-251` (`classifyUrl`) — `classifyUrl(url) === null` (neuer,
   unbekannter SBC-relevanter Endpunkt) hinterlässt KEIN eigenes Signal.
   `STATE.diag.lastUtasPaths` (`:224-229`) ist ein 15-Slot-Ring, der ALLE
   `/ut/game/`-Pfade unabhängig von ihrer Klassifikation aufnimmt und nur
   gegen den unmittelbar VORHERIGEN Eintrag dedupliziert — häufiger bekannter
   Traffic (Club-Pagination, Storage-Laden) kann einen seltenen neuen,
   unklassifizierten Pfad aus dem Ring verdrängen, bevor je ein Diagnose-Report
   gezogen wird. `solver-test.js` Block 25 (Z. 2396-2406) testet zwar, dass
   `classifyUrl` für Fremd-URLs/Beinahe-Treffer `null` liefert — aber nirgends,
   dass dieser Fall auch GEZÄHLT/SICHTBAR wird.
3. **`detectApiBase`-Fehlschlag selbst ist still (Leitfrage 2):**
   `ea-fc-sbc-optimizer.user.js:212-235` — matcht der Marker-Regex
   `/^(https?:\/\/[^/]+\/ut\/game\/[^/]+\/)/i` bei einer neuen Host-/
   Pfad-Struktur nicht mehr, bleibt `STATE.session.apiBase` dauerhaft `null`.
   `buildDiagReport()` (`:3876-3891`) liefert zwar `apiBaseDetected: null` UND
   `counts.utasSeen` getrennt — aber kein abgeleitetes Flag, das genau DIESEN
   Fall ("utas-Traffic beobachtet, aber kein Marker-Match") von "noch gar kein
   Traffic" unterscheidet. Rasmus müsste das manuell aus zwei Zahlen im Report
   kombinieren.
4. **`installServicesHooks()` pollt ohne Zeit-/Versuchszähler auf
   `window.services.SBC` (Leitfrage 3):** `ea-fc-sbc-optimizer.user.js:5307-5324`,
   Intervall bei `:5356` (`setInterval(installServicesHooks, 1000)`) — bleibt
   `.SBC` dauerhaft aus (EA benennt den Service um), gibt es anders als beim
   strukturell analogen Club-Ladelauf (`STATE.diag.clubLoad.retries`, `:1353`)
   oder dem Batch-Stuck-Zähler (`STATE.diag.batchStuckCount`, Deklaration
   `:127`) KEINEN Zähler, der einen dauerhaften Hook-Fehlschlag von "App noch
   nicht vollständig gestartet" unterscheidet. `servicesKeys`
   (`buildDiagReport`, `:3864-3868`/`:3884`) listet zwar die vorhandenen
   Top-Level-Keys von `window.services` — aber ohne Abgleich/Warnung, wenn
   `SBC` darunter fehlt; Rasmus müsste die Liste selbst durchsuchen.
5. **`rareflagHistogram` kann einen neuen, seltenen rareflag-Wert verdecken
   (Leitfrage 4):** `ea-fc-sbc-optimizer.user.js:4114-4129` — "Specials"
   werden auf die Top-5 nach Häufigkeit gekürzt, der Rest landet nur
   aggregiert in `specialTotal`/`specialFlags` (Anzahl DISTINCT-Werte, aber
   ohne deren konkrete Zahlenwerte). Ein von EA neu eingeführter, zunächst
   seltener rareflag (neues Promo-Special mit wenigen Karten im Pool) kann von
   häufigeren bestehenden Specials aus den Top-5 verdrängt werden und bleibt
   damit ohne seinen konkreten Wert im Report unsichtbar — nur die Zählung
   `specialFlags` steigt unauffällig mit.

## Lift-Aktionen (≥ 3 — M1)

### RA — Robust Architecture

1. **`diagError` bei JSON-Parse-Fehlschlag ergänzen:** in `handleResponseBody`
   (`ea-fc-sbc-optimizer.user.js:257-258` und `:277-279`) additiv
   `diagError('handleResponseBody(' + kind + '): ' + (e.message || e))` in
   BEIDE Catches aufnehmen (analog zum bestehenden `reportError()`-Muster,
   `:149-152`) — reiner Diagnose-Zusatz, keine Verhaltensänderung am
   Interception-Pfad selbst. Neuer Testfall in `solver-test.js` Block 25:
   `handleResponseBody` mit einem klassifizierten URL + kaputtem JSON-Body
   aufrufen, Assertion auf einen neuen Eintrag in `STATE.diag.lastErrors`.
   Gain: schließt die konkreteste "Fehler unsichtbar verschluckt"-Lücke im
   Anbindungscode, stärkt Rubrik-Kriterium "Beobachtbarkeit" direkt; +0.3-0.5.
2. **Eigener Unclassified-Zähler + kleiner Sample-Ring für `/ut/game/`-Traffic:**
   additiv zwei neue Felder in `STATE.diag` (`:110-134`-Deklaration ergänzen,
   damit die dort dokumentierte Deklarations-Symmetrie-Prüfung nicht bricht):
   `utasUnclassified` (Zähler) + `lastUnclassifiedPaths` (eigener 5er-Ring,
   NUR Pfade mit `classifyUrl(url) === null`, IDs maskiert wie beim
   bestehenden `lastUtasPaths`). Füllung an der bestehenden `classifyUrl`-
   Aufrufstelle im fetch-/XHR-Wrapper (`:296-300` bzw. `:339`), OHNE die
   Wrapper-Struktur selbst zu verändern — nur ein zusätzlicher Zweig im
   bereits vorhandenen `try {} catch (e) {}`. In `buildDiagReport()`
   (`:3886-3891`) zwei Felder ergänzen. Neuer Test in `solver-test.js`
   Block 25 mit einer synthetischen, unbekannten SBC-ähnlichen URL. Gain:
   adressiert Leitfrage 1 direkt und ist der wirksamste der vier Hebel für
   "Fehlertoleranz gegen EA-Wandel" (echte Früherkennung eines neuen
   Endpunkts statt Zufallstreffer im generischen Ring); +0.5-1.
3. **Abgeleitetes `apiBaseDetectionStuck`-Flag im Report:** additiv in
   `buildDiagReport()` (`:3876-3891`) ein berechnetes Feld
   `apiBaseDetectionStuck: (STATE.diag.utasSeen > 20 && !STATE.session.apiBase)`
   ergänzen (Schwelle als benannte Konstante mit Warum-Kommentar, kein Eingriff
   in `detectApiBase` selbst nötig, da rein aus zwei bereits vorhandenen
   Werten abgeleitet). Neuer Test in `solver-test.js` Block 25 mit einer
   Fake-Host-URL, die den Marker-Regex nicht trifft, prüft dass das Flag
   korrekt kippt, sobald `utasSeen` künstlich über die Schwelle gesetzt wird.
   Gain: macht Leitfrage 2 explizit "sichtbar" statt "still"; **dünn** — sehr
   kleiner, unmittelbarer Effekt (+0.1-0.3), da der Fall in der Praxis selten
   ist (ein Host-Match-Fehlschlag bei laufendem `utasSeen`-Zähler wäre ein
   fundamentaler URL-Schema-Bruch durch EA).
4. **Zeit-/Versuchszähler für den `services.SBC`-Hook-Fehlschlag:** additiv,
   ohne den Hook-Mechanismus selbst (`installServicesHooks`, `:5307-5324`) zu
   verändern, einen Tick-Zähler nach dem Vorbild von `STATE.diag.clubLoad.retries`
   einführen (z.B. `STATE.diag.sbcHookMisses`), der bei jedem erfolglosen
   Intervall-Durchlauf hochzählt, SOBALD `window.services` bereits existiert
   ABER `.SBC` fehlt (unterscheidet "App startet noch" von "Service dauerhaft
   weg/umbenannt"). Report ergänzt um ein daraus abgeleitetes
   `sbcServiceMissingAfterBoot`-Flag ab einer Schwelle (z.B. 30 Ticks = 30s).
   Neuer Test in `solver-test.js` mit einer Attrappe für `window.services`
   ohne `.SBC` über mehrere simulierte Intervall-Ticks. Gain: adressiert
   Leitfrage 3 (Existenz-Guard + Report-Signal) für den bisher unbeobachteten
   Dauerausfall-Fall; +0.3-0.5.

## Edge-Cases (mind. 1 — M1)

- **In-Memory-Zähler überleben keinen Reload:** Alle vier oben vorgeschlagenen
  Diagnosefelder (`utasUnclassified`, `apiBaseDetectionStuck`,
  `sbcHookMisses`, `lastUnclassifiedPaths`) liegen wie der Rest von
  `STATE.diag` nur im Skript-Speicher. Tritt ein neuer, unbekannter Endpunkt
  NUR kurz während eines laufenden Batch-Laufs auf und wird das Script danach
  neu geladen (F5, App-Neustart, Absturz), bevor Rasmus "Diagnose in Konsole
  schreiben" klickt, ist genau das Ereignis wieder verloren, das die neue
  Diagnose eigentlich einfangen sollte — kein anderer Diagnose-Kanal
  (`STATE.diag`-Felder) übersteht das aktuell, das ist konsistent mit dem
  Rest der Datei, sollte aber im Lift-Schritt nicht übersehen werden (z.B.
  durch einen Hinweis im Report-Kommentar, dass diese Felder NUR die laufende
  Session abdecken).
- **`STATE.diag`-Symmetrie-Prüfung:** Jedes neue Feld MUSS gemäß dem
  Kommentar an der `STATE.diag`-Deklaration (`ea-fc-sbc-optimizer.user.js:105-109`)
  gleichzeitig deklariert, gelesen UND zugewiesen werden, sonst schlägt die in
  `solver-test.js` bestehende symmetrische Prüfung fehl (bzw. das Feld bleibt
  bei seinem Initialwert unbemerkt stehen, siehe `uiScan`-Vorfall in
  LEARNINGS). Bei der Umsetzung der vier additiven Felder oben ist das
  explizit einzuplanen, nicht nachträglich.

## Lift-Empfehlung

Vorsichtig, additiv, in kleinen Diffs — passend zur knappen 1-Punkt-Luft bis
zum strukturellen Maximum: kein Umbau, nur vier unabhängige
Diagnose-Ergänzungen (je eigener Commit möglich), jede mit eigenem
`solver-test.js`-Fall. Aktion 3 ist ehrlich als **dünn** markiert (kleiner
Gain, seltener Praxisfall) — falls die Iteration nur Kapazität für zwei bis
drei Aktionen hat, zuerst Aktion 1 (JSON-Parse-Diagnose) und Aktion 2
(Unclassified-Zähler) umsetzen, die adressieren die unter der
EA-Wandel-Linse konkretesten und am ehesten live auftretenden Lücken. Kein
Mid-Iter-SI nötig — alle vier Aktionen sind Einzelfeatures ohne
Cross-Feature-Abhängigkeit.
