---
slice: netz-api
analyzed_at: 2026-08-14
iteration: 0
---

# Aspect — netz-api

Rohaufnahme dessen, was im Code zur Slice tatsächlich vorkommt. Vom
`aspect-analyzer`-Subagent geschrieben (Sonnet, parallel pro Slice).
Wird pro Iteration überschrieben — Git-Log ist die Historie.

## Beobachtetes Pattern: Passive Session-Header-Erfassung über fetch/XHR-Interception

**Was passiert:** Die App/das Script sendet selbst keinen Login-Request. Stattdessen
wird `window.fetch` und `XMLHttpRequest.prototype` gewrappt, jede von der EA-Web-App
selbst gesetzte Header-Struktur (Headers-Instanz, Array-Paare, Plain-Objekt) wird über
eine einzige Normalisierungsfunktion gelesen und die interessanten Auth-Header
(`X-UT-SID`, `X-UT-PHISHING-TOKEN`, `X-UT-Route`, `Easw-Session-Data-Nucleus-Id`) landen
zentral in `STATE.session`. Eigene Requests (`apiGet`/`apiPut`) lesen diesen State
später wieder aus.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:126` — `pickHeader()` abstrahiert 3 Header-Formen (fetch-`Headers`, Array-Paare, Plain-Objekt) hinter einer Signatur.
- `ea-fc-sbc-optimizer.user.js:154` — `absorbSessionHeaders()` liest alle vier Auth-Header zentral aus `headersLike` in `STATE.session`.
- `ea-fc-sbc-optimizer.user.js:245` / `:246` — fetch-Wrapper ruft `absorbSessionHeaders` sowohl für `init.headers` als auch `input.headers` auf (deckt beide fetch-Aufrufvarianten ab).
- `ea-fc-sbc-optimizer.user.js:272` / `:286` — XHR-Wrapper sammelt Header über `setRequestHeader` in `this.__sbcHeaders` und übergibt sie beim `send()` an dieselbe `absorbSessionHeaders`-Funktion.
- `ea-fc-sbc-optimizer.user.js:1125` — `apiHeaders()` baut aus genau demselben `STATE.session`-Objekt die Headers für eigene Requests zurück.

**Wo das (noch) fehlt:** Keine Lücke gefunden — beide Interception-Wege (fetch und XHR) laufen konsequent über dieselben zwei Funktionen (`absorbSessionHeaders`, `pickHeader`).

## Beobachtetes Pattern: Ein zentraler URL-Klassifizierer speist einen einzigen Response-Router für beide Interception-Wege

**Was passiert:** `classifyUrl()` entscheidet anhand von Regex-Mustern, ob eine URL zu
den interessanten Endpunkten gehört (SBC-Set-Challenges, SBC-Challenge, Club,
Unassigned, Storage). `handleResponseBody()` ist der einzige Ort, der die Antwort
parst und je nach `kind` an die passende Verarbeitungsfunktion weiterreicht. Sowohl
der fetch- als auch der XHR-Wrapper rufen exakt diese beiden Funktionen auf, statt
eigene Parsing-Logik zu haben.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:193` — `classifyUrl(url)` als einzige Stelle, die URL-Muster zu einem `kind`-String klassifiziert.
- `ea-fc-sbc-optimizer.user.js:208` — `handleResponseBody(url, bodyText)` als einziger Response-Parser, der auf `kind` verzweigt.
- `ea-fc-sbc-optimizer.user.js:252` — fetch-Wrapper: `if (url && classifyUrl(url)) { resp.clone().text().then(...handleResponseBody...) }`.
- `ea-fc-sbc-optimizer.user.js:294` — XHR-Wrapper: `if (url && classifyUrl(url)) { this.addEventListener('load', ...handleResponseBody...) }`.

**Wo das (noch) fehlt:** Keine Lücke — beide Transport-Mechanismen sind konsequent an denselben Klassifizierer/Router angeschlossen.

## Beobachtetes Pattern: 401-Ursachenunterscheidung (Session abgelaufen vs. Rate-Limit) mit selbstbremsendem Takt

**Was passiert:** Ein 401 wird nicht pauschal als „Session tot" behandelt. Versuch 1
stößt über `nudgeSession()` einen App-eigenen Request an und wartet aktiv (bis 8s) auf
eine neue SID; erst Versuch 2 nimmt einen reinen Cooldown an, weil ein Rate-Limit die
Session nicht ungültig macht. Beim Club-Paging erhöht sich der Takt bei jedem
Fehlversuch selbst (nie ein fester kleiner Wert) — dokumentiert als Lehre aus einem
Live-Ausfall (LEARNINGS §4/§7, CLAUDE.md „Nicht anfassen ohne Grund").

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1147` — `nudgeSession()`: pokt über wechselnde Endpunkte (`requestUnassignedItems`/`requestTradeItems`/`requestWatchedItems`) und wartet aktiv auf SID-Wechsel statt fixem Sleep.
- `ea-fc-sbc-optimizer.user.js:1197` — `apiGet`: bei 401 und `_attempt<2` erst `nudgeSession()`, danach `sleep(3000)`, dann Retry.
- `ea-fc-sbc-optimizer.user.js:1221` — `apiPut`: identische 401-Fallunterscheidung wie in `apiGet`.
- `ea-fc-sbc-optimizer.user.js:1273` — `fetchClubViaHttp`: `gap = Math.min(900, gap + 150)` bei jedem Fehlversuch, Takt erhöht sich dauerhaft statt zurückgesetzt zu werden.
- `docs/LEARNINGS.md:73` (§4) — dokumentiert explizit die zwei 401-Ursachen und warum je Ursache anders reagiert wird.

**Wo das (noch) fehlt:** Keine Lücke — Kommentare im Code (z.B. Zeile 1178-1181) verweisen bewusst auf dieselbe Unterscheidung.

## Beobachtetes Pattern: Diagnose ohne Session-Token-Leckage

**Was passiert:** Überall wo Session-Zustand geloggt oder in den Diagnose-Report
geschrieben wird, erscheinen nur Booleans/Symbole (`✓`/`–`, `sidCaptured: !!...`),
niemals der Token-Wert selbst — auch dort, wo das Debugging naheliegend den Wert
zeigen könnte.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:161` — `log('X-UT-SID erfasst')` loggt nur das Ereignis, nicht den Wert.
- `ea-fc-sbc-optimizer.user.js:3723` — `refreshDiagUI()`: `'· SID: ' + (s.sid ? '✓' : '–')`.
- `ea-fc-sbc-optimizer.user.js:3728` — Kommentar „Bewusst OHNE Session-Token-Werte!" direkt über `buildDiagReport()`.
- `ea-fc-sbc-optimizer.user.js:3745` / `:3746` — `sidCaptured: !!STATE.session.sid`, `phishingCaptured: !!STATE.session.phishing`.

**Wo das (noch) fehlt:** Keine Lücke gefunden.

## Beobachteter Antipattern: Duplizierte Kernlogik in `apiGet`/`apiPut` (URL-Bau + 401-Retry)

**Was schiefläuft:** `apiGet` und `apiPut` bauen die Ziel-URL identisch
(`STATE.session.apiBase + path.replace(/^\//, '')`) und enthalten fast wortgleiche
401-Behandlung (Versuch 0 → `nudgeSession()`, Versuch ≥1 → `sleep(3000)`, sonst
`diagError` + `throw new Error(httpErrText(...))`). Es gibt keine gemeinsame
`apiRequest(method, path, body, attempt)`-Funktion; die Retry-Politik (Grenze
`_attempt<2`, Cooldown `3000`) lebt zweimal und muss bei jeder Anpassung synchron
gehalten werden.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1185` vs. `:1208` — identische URL-Bau-Zeile in `apiGet` und `apiPut`.
- `ea-fc-sbc-optimizer.user.js:1197-1201` vs. `:1221-1226` — nahezu wortgleicher 401-Retry-Block (Nudge → Sleep → rekursiver Aufruf mit `_attempt+1`).
- `ea-fc-sbc-optimizer.user.js:1190`/`:1202` vs. `:1218`/`:1231` — `diagError(...)`-Aufrufe für Fetch-Fehler bzw. HTTP-Fehler sind in beiden Funktionen separat formuliert (nur `'GET '`/`'PUT '`-Präfix unterscheidet sich).
- `ea-fc-sbc-optimizer.user.js:1203` vs. `:1232` — `throw new Error(httpErrText('GET'|'PUT', path, resp.status))` — gleiche Struktur, zwei Stellen.

**Vermutete Wurzelursache:** Q4 (DRY) — kein gemeinsamer HTTP-Wrapper für den
GET/PUT-Unterschied (Body vs. kein Body, `Content-Type`-Header) extrahiert. Die
Duplikation ist klein genug, dass sie bisher nicht aufgefallen ist, aber jede
zukünftige Änderung an der Retry-Politik (z.B. Cooldown-Dauer, Attempt-Grenze) muss an
zwei Stellen gemacht werden — genau das Risiko, das Q4 beschreibt.

## Beobachteter Antipattern: „sbs"/"sbc"-Pfadpräfix-Wissen an 7 Stellen dupliziert

**Was schiefläuft:** Die EA-API nutzt je nach Version/Route ein Pfadpräfix `sbs` oder
`sbc` für SBC-Endpunkte. Dieses Wissen ist nicht an einer Stelle zentralisiert
(Konstante oder eine gemeinsame Regex), sondern als Regex-Alternation `(sbs|sbc)`
wörtlich an sieben Stellen im Code dupliziert — plus der Fallback-Ausdruck
`STATE.sbc.apiPrefix || 'sbs'` an zwei weiteren Stellen.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:187` — `detectApiBase`: `u.match(/\/ut\/game\/[^/]+\/(sbs|sbc)\//i)` zur Präfix-Erkennung.
- `ea-fc-sbc-optimizer.user.js:197-200` — `classifyUrl`: drei weitere unabhängige `(sbs|sbc)`-Regexe für `sbc-set-challenges`, `sbc-challenge`, `sbc-sets`.
- `ea-fc-sbc-optimizer.user.js:205` — `classifyUrl`: eine vierte `(sbs|sbc)`-Regex für den Storage-Fallback-Pfad.
- `ea-fc-sbc-optimizer.user.js:291` — XHR-Wrapper: eine fünfte, eigenständige `(sbs|sbc)`-Regex, um den Squad-PUT-Body mitzuschneiden.
- `ea-fc-sbc-optimizer.user.js:2515` und `:2524` — zwei identische `STATE.sbc.apiPrefix || 'sbs'`-Fallback-Ausdrücke in unterschiedlichen Funktionen.

**Vermutete Wurzelursache:** Q5 (SSOT) — „sbs vs. sbc" ist eine einzige fachliche
Tatsache (welches Pfadpräfix die aktuelle EA-Route benutzt), lebt aber als
wiederholter String/Regex-Fragment an sieben Stellen statt hinter einer benannten
Konstante/Helper-Funktion (z.B. `SBC_PATH_RE` oder `isSbcPath(url)`). Ändert EA das
Präfix-Schema (z.B. ein drittes Präfix), müssten alle sieben Stellen einzeln gefunden
und angepasst werden.

## Weak Signals (zu wenige Belege für Pattern-Status)

- Zwei-Wege-Zugriff mit `sessionReady()`/`canServices`-Gate (HTTP primär, App-Services
  als Fallback): `ea-fc-sbc-optimizer.user.js:1353`, `:1360`, `:1372`, `:1381-1385` —
  vier Belege, aber alle innerhalb derselben Funktion `loadPool()`. Erwähnenswert, weil
  es das zentrale Degradationsmuster der ganzen netz-api-Slice ist; noch kein Beleg,
  dass dasselbe Gate-Muster an einer zweiten, unabhängigen Stelle wiederkehrt.
- Getrennte Basis-URL-Erkennung neben der Endpunkt-Klassifizierung: `detectApiBase()`
  (`ea-fc-sbc-optimizer.user.js:171`, Regex `^(https?:\/\/[^/]+\/ut\/game\/[^/]+\/)`)
  kodiert eigenständig, „was eine utas-URL ist", parallel zu `classifyUrl()`s
  Endpunkt-Regexen. Nur eine Stelle bisher — potenzieller Kandidat für dieselbe
  SSOT-Beobachtung wie beim `sbs|sbc`-Antipattern, falls weitere URL-Erkennungsstellen
  dazukommen.
- Derselbe App-Service-Endpunkt (`requestUnassignedItems`) wird für zwei verschiedene
  Zwecke wiederverwendet, ohne gemeinsamen Helper: als Session-„Poke" in `nudgeSession()`
  (`ea-fc-sbc-optimizer.user.js:1153`) und als Keep-Alive-Puls
  (`ea-fc-sbc-optimizer.user.js:5116`). Nur zwei Stellen — zu wenig für einen
  Antipattern-Eintrag, aber ein Kandidat, falls ein dritter Aufrufer hinzukommt.
- Dokumentations-Drift zur Referenz „LEARNINGS §23" für den Club-Lade-Takt
  (`CLAUDE.md` Abschnitt „Nicht anfassen ohne Grund"): `docs/LEARNINGS.md` hat aktuell
  nur 22 nummerierte Abschnitte (zudem zwei Abschnitte fälschlich als „## 11."
  nummeriert) — die zitierte Taktbegründung existiert inhaltlich (§4, §7), aber nicht
  unter der Nummer §23. Kein Code-Antipattern, aber ein Hinweis, dass die
  Abschnittsnummerierung in LEARNINGS.md nicht mehr verlässlich ist.

## Zusammenfassung

- 4 Pattern-Kandidaten in dieser Slice
- 2 Antipattern-Kandidaten
- 4 Weak Signals
