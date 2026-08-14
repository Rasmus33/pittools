---
slice: fehler-abbruch
analyzed_at: 2026-08-14
iteration: 0
---

# Aspect — fehler-abbruch

Rohaufnahme dessen, was im Code zur Slice tatsächlich vorkommt. Vom
`aspect-analyzer`-Subagent geschrieben (Sonnet, parallel pro Slice).
Wird pro Iteration überschrieben — Git-Log ist die Historie.

## Beobachtetes Pattern: Throw an der Logik, Catch+Toast an der UI-Grenze

**Was passiert:** Innere Funktionen (Submit-Wege, Solver, Batch-Schritte)
werfen `Error`-Objekte mit einer für Rasmus verständlichen, oft mit Tipp
versehenen Nachricht. Erst an der UI-Grenze (Button-Handler) wird gefangen,
`setStatus(...)` gesetzt und `toast(..., 'error')` gezeigt — die Fehlermeldung
aus dem `throw` erscheint dabei fast wörtlich im Toast.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:2560` / `2571` / `2575` / `2577` — `submitViaApp`
  wirft spezifische Fehler ("Kein offener SBC-Squad-Controller gefunden...",
  "Keine Live-Challenge gefunden.", "Rohdaten fehlen für Karte ...").
- `ea-fc-sbc-optimizer.user.js:2640` und `2660` — `submitToSbc` baut aus
  HTTP-Status-Codes (404/475/403) lange, handlungsanweisende Fehlertexte
  ("bitte die SBC im Spiel einmal schliessen und neu öffnen").
- `ea-fc-sbc-optimizer.user.js:4156` — `onRunClick`: `catch (e) { toast('Optimierungsfehler: ' + e.message, 'error'); setStatus('Fehler'); warn(e); return; }`.
- `ea-fc-sbc-optimizer.user.js:5035`–`5040` — `submitCurrentResult`: Catch baut
  zusätzlich einen kontextabhängigen Tipp (`/460|400/.test(...)`) obendrauf.
- `ea-fc-sbc-optimizer.user.js:4831`–`4834` — `onBatchPlanClick`: dieselbe
  Struktur (`toast('Batch-Planung fehlgeschlagen: ' + e.message, 'error')`).

**Wo das (noch) fehlt:** In `onBatchPlanClick` fehlt zusätzlich der
`diagError`-Aufruf, den die strukturell identische `onBatchRunClick`-Catch hat
(siehe Antipattern unten).

## Beobachtetes Pattern: Abbruch-Disziplin im Batch — throw statt weitermachen

**Was passiert:** Der Batch-Lauf (`onBatchRunClick`) prüft vor JEDEM Schritt
eine Bedingung und wirft bei jeder Unstimmigkeit sofort, statt mit einem
Best-Effort weiterzumachen. Das setzt CLAUDE.md exakt um ("2 von 5 fertig ist
besser als eine falsch abgegebene SBC").

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:4905`–`4907` — fehlende Pool-Karte bricht die
  Runde sofort ab (`throw new Error(tag + ': ... Karte(n) nicht mehr im Pool.')`).
- `ea-fc-sbc-optimizer.user.js:4911`–`4913` — keine offene SBC-Ansicht → Abbruch.
- `ea-fc-sbc-optimizer.user.js:4914`–`4918` — offene SBC passt nicht zum
  geplanten Ziel-OVR/Slots → Abbruch mit Diff in der Meldung.
- `ea-fc-sbc-optimizer.user.js:4943`–`4954` — `openNextInstance` liefert
  `!next.ok`: entweder ein erklärender "Set erschöpft"-Fehler (kein echter
  Fehler, aber Plan-Ende) oder ein genereller Abbruch mit Diagnose-Verweis.
- `ea-fc-sbc-optimizer.user.js:4965` — `finally`: `STATE.batch = null;` — der
  Plan gilt nach Abbruch ODER Erfolg als verbraucht, kein Wiederaufsetzen mit
  Restzustand.
- `ea-fc-sbc-optimizer.user.js:4968`–`4971` — bei Abbruch zeigt der Code
  explizit den Fortschritt ("`done` von `n` abgegeben") statt nur den Fehler.

## Beobachtetes Pattern: Endkontrolle vor dem Schreibzugriff (kein stiller Fehl-Submit)

**Was passiert:** Bevor ein Team an EA geschickt wird, prüft der Solver aktiv
auf bekannte Fehlerklassen und liefert `{ ok: false, reason: ... }` statt ein
kaputtes Team einzutragen oder eine Exception zu werfen, die den Aufrufer
überraschen würde. Mehrdeutige Situationen enden in einem definierten
"nichts tun" statt einer Vermutung.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:2115`–`2147` — `finishTeam`: Endkontrolle auf
  doppelte Karten-ID, doppelte `assetId` und falsche Teamgröße; bei Treffer
  `{ ok: false, reason: 'Interner Fehler: ... Nichts eingetragen...', teamDump: dump }`
  statt eines PUT, der laut Kommentar live in HTTP 460 endete.
- `ea-fc-sbc-optimizer.user.js:596`–`599` — `resolveFreshChallengeId`: bei
  `cands.length !== 1` (mehrdeutig oder nichts gefunden) wird `null`
  zurückgegeben statt geraten — der Kommentar nennt den Grund explizit
  ("sonst landet das Team in einer fremden SBC").
- `ea-fc-sbc-optimizer.user.js:2104`–`2106` — zu wenige passende Spieler im
  Pool → `{ ok: false, reason: '... Erst "Spieler laden" ausführen oder Filter lockern.' }`.
- `ea-fc-sbc-optimizer.user.js:2248`–`2250` — Auffüll-Pfad ohne Ziel-Rating:
  reichen Vorgabe+Filler nicht für `N`, gibt es `ok:false` statt eines
  unvollständigen Teams.
- `ea-fc-sbc-optimizer.user.js:2153` — `ok: target ? ovr >= target : true` ist
  die einzige Stelle, die am Ende noch einmal das Zielkriterium selbst
  gegenprüft, unabhängig davon, wie das Team zusammengestellt wurde.

## Beobachtetes Pattern: `diagError` als Zweitkanal — kritische Fehler landen im Report, nicht nur in der Konsole

**Was passiert:** Für Fehler, die für die spätere Fehlersuche per
"Diagnose in Konsole schreiben" wichtig sind, wird zusätzlich zu `warn()`
`diagError(msg)` aufgerufen, das die Meldung (gekürzt, ohne Tokens) in
`STATE.diag.lastErrors` ablegt — dem Feld, das laut CLAUDE.md das wichtigste
im Report ist.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:116`–`122` — Definition von `diagError`
  (Ringpuffer, max. 24 Einträge, 300 Zeichen).
- `ea-fc-sbc-optimizer.user.js:1190` / `1202` / `1218` / `1231` — `apiGet`/`apiPut`
  rufen `diagError` bei jedem Netzwerkfehler bzw. Nicht-OK-Status auf, inkl.
  mitgeschnittenem Server-BODY bei PUT-Ablehnung.
- `ea-fc-sbc-optimizer.user.js:2606` / `2609` / `2615` — `submitToSbc`: alle
  drei Submit-Wege (app/http/services) loggen bei Fehlschlag `warn` UND
  `diagError` gemeinsam.
- `ea-fc-sbc-optimizer.user.js:2900`–`2901` — `refreshOpenSbcView`: derselbe
  Doppel-Aufruf.
- `ea-fc-sbc-optimizer.user.js:4960` — Batch-Abbruch: `diagError('Batch gestoppt nach ' + done + '/' + n + ': ' + stopped)`.

**Wo das (noch) fehlt:** siehe Antipattern unten — mehrere strukturell
gleichwertige Catches rufen nur `warn()`.

## Beobachtetes Pattern: Bewusst stille Catches an der Grenze zu EA-Fremdcode

**Was passiert:** Wo der Code fremde, nicht kontrollierte Objekte anfasst
(EA-Interna, `fetch`/`XHR`-Interception, die auf JEDER Seiteninteraktion
läuft), sind Catches bewusst leer. Ein Fehler dort darf die Host-Seite (die
EA Web App) nicht zum Absturz bringen — das ist etwas anderes als ein
verschlucktes Diagnose-würdiges Ereignis.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:248` und `257` — der `fetch()`-Wrapper fängt
  Fehler beim Header-Lesen bzw. Response-Klonen leer ab, damit die
  interceptete Anfrage der EA-App trotzdem durchläuft.
- `ea-fc-sbc-optimizer.user.js:280` und `302`/`305` — die `XMLHttpRequest`-
  Wrapper (`setRequestHeader`, `send`) genauso: jeder Fehler im
  Beobachtungscode darf den eigentlichen Request nicht verhindern.
- `ea-fc-sbc-optimizer.user.js:356` — `isDomOrWindow` fängt Zugriffe auf
  potenziell fremde `Node`/`Window`-Typen ab (`return false` statt Crash beim
  Tiefen-Scan über beliebige EA-Objektgraphen).
- `ea-fc-sbc-optimizer.user.js:454` / `522` / `558` — der generische
  Requirement-Scanner (`deepScanChallenge`) überspringt einzelne Properties,
  deren Zugriff wirft (`try { child = o[k]; } catch (e) { continue; }`),
  statt den ganzen Scan abzubrechen.
- `ea-fc-sbc-optimizer.user.js:793` — `normalizePlayer` fängt den Aufruf einer
  potenziell fehlenden `isConcept()`-Methode auf rohen EA-Items ab.

**Wo das (noch) fehlt:** Diese Catches sind fachlich gerechtfertigt (siehe
Antipattern-Abgrenzung), tragen aber nur, solange der übersprungene Fehler
folgenlos bleibt. Für `deepScanChallenge` gilt das (einzelne Property
übersprungen ändert nur die Vollständigkeit des Scans); nicht geprüft wurde,
ob das für JEDEN der 30 Fundstellen mit leerem Catch ebenso zutrifft.

## Beobachteter Antipattern: Inkonsistente Fehler-Sichtbarkeit — `warn()` ohne `diagError` bei reportwürdigen Fehlern

**Was schiefläuft:** Strukturell gleichwertige Catch-Blöcke behandeln
denselben Fehlertyp (fehlgeschlagener Netzwerk-/Service-Aufruf beim
Pool-Laden bzw. bei Batch-Planung) unterschiedlich: manche rufen `warn()`
UND `diagError()` auf (landen im Report), andere nur `warn()` (nur über die
App-Log-Konsole sichtbar, und die ist laut CLAUDE.md "der einzige Weg an
PaleTools-Fehler zu kommen" — für den eigenen Optimizer-Fehlerpfad also ein
Umweg über "Log teilen" statt des direkten Diagnose-Reports).

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1334` — `fetchUnassignedViaHttp`:
  `catch (e) { warn('Unassigned-Fetch Fehler:', e); }` — kein `diagError`.
- `ea-fc-sbc-optimizer.user.js:1346` — `fetchStorageViaHttp`: dieselbe Lücke
  (`warn('storagepile-Fetch Fehler:', e.message)`), obwohl ein leerer Storage
  laut `loadPool` (Zeile 1391) einen Toast auslöst — der Grund dafür bliebe im
  Diagnose-Report aber unsichtbar.
- `ea-fc-sbc-optimizer.user.js:1100` und `1118` — `fetchUnassignedViaServices`
  / `fetchStorageViaServices`: gleiches Muster im Services-Fallback.
- `ea-fc-sbc-optimizer.user.js:907` — `readPaletoolsLocks`: der äußere Catch
  um die gesamte `localStorage`-Schleife hat nur `warn()`. Ein Abbruch mitten
  in der Schleife hinterließe eine unvollständige, aber unauffällige
  Sperrliste — sicherheitsrelevant, weil CLAUDE.md verlangt, gesperrte Karten
  "NIEMALS" zu verbauen, und ein teilweise gelesener Lock-Bestand das
  unbemerkt verletzen könnte.
- `ea-fc-sbc-optimizer.user.js:4833` — `onBatchPlanClick`: `catch (e) { toast(...); warn(e); }`
  hat kein `diagError`, während die strukturell identische `onBatchRunClick`-
  Catch (Zeile 4960) es hat.
- `ea-fc-sbc-optimizer.user.js:762` — `syncSbcWithOpenChallenge`: nur `warn()`,
  obwohl ein Fehlschlag hier bedeutet, dass die SBC-Erkennung auf einem
  veralteten Stand weiterläuft (LEARNINGS §6 nennt genau dieses
  Veraltungsrisiko als wiederkehrende Fehlerquelle).

**Vermutete Wurzelursache:** Q5 (SSOT) — es gibt keine zentrale Regel/keinen
Helfer, der festlegt "dieser Fehlertyp muss immer beides tun". `diagError`
und `warn` werden an jeder Stelle einzeln von Hand kombiniert, wodurch die
Entscheidung vom Autor-Moment abhängt statt von der Fehlerklasse. Ein
gemeinsamer Wrapper (z.B. `reportError(msg, e)` = `warn` + `diagError` in
einem Aufruf) würde das strukturell verhindern, ohne die bewusst leeren
Catches an der EA-Fremdcode-Grenze (siehe Pattern oben) anzufassen.

## Weak Signals (zu wenige Belege für Pattern-Status)

- Kooperative Abbruch-Flagge `STATE.cancelLoad` (`ea-fc-sbc-optimizer.user.js:1064`,
  `1261`, `1372`, `1381`): ein zweiter, nicht-Exception-basierter
  Abbruchmechanismus nur für den Pool-Ladevorgang (Nutzer klickt "Abbrechen"
  während des Ladens) — bewusst kein `throw`, weil ein Teil-Pool danach noch
  brauchbar ist. Nur 1 Anwendungsfall, aber ein zum Batch-`throw`-Muster
  gegensätzliches, ebenfalls bewusstes Abbruch-Konzept.
- Defensives Auffangen von nicht-Error-Wurfwerten (`ea-fc-sbc-optimizer.user.js:4958`:
  `stopped = (e && e.message) || String(e);`): nur 1-2 Stellen, zeigt aber,
  dass an der Batch-Grenze auch mit "wirft irgendwas, keine Error-Instanz"
  gerechnet wird.
- `toast(msg, 'warn')` als dritter Meldungstyp neben `'error'`/`'ok'`/`''`
  (`ea-fc-sbc-optimizer.user.js:1392`, `5033`): nur 2 Fundstellen für einen
  Zwischenzustand "eingetragen, aber mit Vorbehalt" — zu wenig, um als
  eigenes Meldungs-Pattern zu gelten, aber ein Hinweis, dass der Code
  zwischen "Fehler" und "Erfolg mit Einschränkung" unterscheiden will.

## Zusammenfassung

- 5 Pattern-Kandidaten in dieser Slice
- 1 Antipattern-Kandidat
- 3 Weak Signals
