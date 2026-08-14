---
slice: ea-services
analyzed_at: 2026-08-14
iteration: 0
---

# Aspect — ea-services

Rohaufnahme dessen, was im Code zur Slice tatsächlich vorkommt. Vom
`aspect-analyzer`-Subagent geschrieben (Sonnet, parallel pro Slice).
Wird pro Iteration überschrieben — Git-Log ist die Historie.

## Beobachtetes Pattern: Observable-zu-Promise-Adapter als einzige Brücke zu EAs Service-API

**Was passiert:** EAs interne Services (`window.services.Club/.Item/.SBC`) liefern
kein Promise-Interface, sondern ein proprietäres Observable (`observe(target, cb)` /
`unobserve`). Der gesamte Code läuft diese Brücke ausschließlich über eine einzige
Funktion `obsPromise()` — inklusive eines harten 30s-Timeouts, falls `observe` nie
feuert. Kein Aufrufer baut die Observable-Bridging-Logik selbst nach.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1020` — Definition von `obsPromise()`, inkl. 30s-Timeout-Reject.
- `ea-fc-sbc-optimizer.user.js:1066` — `obsPromise(window.services.Club.search(criteria))`.
- `ea-fc-sbc-optimizer.user.js:1094` — `obsPromise(window.services.Item.requestUnassignedItems())`.
- `ea-fc-sbc-optimizer.user.js:1110` — generischer Storage-Fetch über `obsPromise(svc[fn]())`.
- `ea-fc-sbc-optimizer.user.js:2472` / `2474` — `obsPromise(sbcSvc.saveChallenge(...))` (Weg B).
- `ea-fc-sbc-optimizer.user.js:2590` — `obsPromise(sbcSvc.saveChallenge(challenge))` (Weg 0/App).
- `ea-fc-sbc-optimizer.user.js:4406` — `obsPromise(svc.submitChallenge.apply(svc, args))`.

**Wo das (noch) fehlt:** Nirgends beobachtet — jeder Observable-Aufruf im Code läuft
durch `obsPromise()`.

## Beobachtetes Pattern: `responseOk()` als Single Source of Truth für Service-Antworten

**Was passiert:** Ob ein Service-Call "erfolgreich" war, wird nie an Ort und Stelle
neu entschieden (z.B. `response.status < 400` inline), sondern immer über die eine
Funktion `responseOk()` geprüft, die `success === false` UND HTTP-Status ≥ 400
gleichermaßen abdeckt.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:1045` — Definition `responseOk()`.
- `ea-fc-sbc-optimizer.user.js:1067` — Club-Suche: `if (!responseOk(response)) throw ...`.
- `ea-fc-sbc-optimizer.user.js:2473` / `2476` — Retry-Kaskade um `saveChallenge` (Weg B).
- `ea-fc-sbc-optimizer.user.js:2591` — `saveChallenge`-Ergebnis im App-Weg (Weg 0).
- `ea-fc-sbc-optimizer.user.js:4378` — Kandidaten-Schleife in `submitChallengeToEa()`.
- `ea-fc-sbc-optimizer.user.js:5119` — Session-Keep-Alive-Check.

**Wo das (noch) fehlt:** Nirgends beobachtet.

## Beobachtetes Pattern: `getControllerChain()` als einziger, abgesicherter Einstieg in EAs View-Controller-Baum

**Was passiert:** Der Zugriff auf EAs (undokumentierten) internen View-Controller-Baum
(`getAppMain()` → `getRootViewController`/`getPresentedViewController`/…) ist mit
Zyklenschutz (`visited`-Set), Tiefenbegrenzung (`depth < 14`) und komplett in
`try/catch` gekapselt genau einmal implementiert und wird von den meisten
produktiven Aufrufstellen wiederverwendet, statt jeweils eigene Traversierung zu
schreiben.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:2692` — Definition `getControllerChain()` (visited-Set, depth-cap, try/catch).
- `ea-fc-sbc-optimizer.user.js:3566` — `inSbcView()` nutzt die Kette zur Bereichs-Erkennung.
- `ea-fc-sbc-optimizer.user.js:3783` — Diagnose `hubScan` prüft `getControllerChain().some(...)`.
- `ea-fc-sbc-optimizer.user.js:3859` — Diagnose `controllerNames` mapt die Kette.
- `ea-fc-sbc-optimizer.user.js:4286` / `4313` — `popupState()`/`dismissRewardPopup()` lesen den obersten Controller.
- `ea-fc-sbc-optimizer.user.js:4362` — `submitChallengeToEa()` sammelt Submit-Kandidaten aus der Kette.

**Wo das (noch) fehlt:** Zwei der drei Traversierungs-Konsumenten (`controllerScan`,
`refreshOpenSbcView`) bauen die Baum-Traversierung selbst noch einmal nach, statt
`getControllerChain()` aufzurufen — siehe Antipattern unten.

## Beobachteter Antipattern: Baum-Traversierung von `getControllerChain()` doppelt nachgebaut

**Was schiefläuft:** Der komplette Traversierungs-Algorithmus (chainFns-Array,
`visited`-Set, `depth`-Zähler, `while`-Schleife über `getAppMain()`) ist nicht nur
einmal in `getControllerChain()` implementiert, sondern noch zweimal Zeile für
Zeile dupliziert — in `controllerScan()` und `refreshOpenSbcView()`. Alle drei
Funktionen stehen im selben Abschnitt der Datei (Zeilen 2692–2836), `getControllerChain()`
ist zum Zeitpunkt der Duplikate bereits definiert und aufrufbar.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:2692-2716` — kanonische Implementierung in `getControllerChain()`.
- `ea-fc-sbc-optimizer.user.js:2720-2744` — identischer Traversierungs-Block, erneut in `controllerScan()`.
- `ea-fc-sbc-optimizer.user.js:2811-2836` — derselbe Traversierungs-Block ein drittes Mal in `refreshOpenSbcView()`.

**Vermutete Wurzelursache:** Q4 (DRY) — beide Duplikate liegen unmittelbar nach der
kanonischen Funktion im selben Abschnitt ("6. IN SBC EINTRAGEN"), ein Aufruf von
`getControllerChain()` hätte an beiden Stellen ausgereicht. Sieht nach organisch
gewachsenem Live-Debugging aus (Diagnose- bzw. View-Refresh-Funktionen wurden
vermutlich unter Zeitdruck an einer laufenden SBC-Störung ergänzt, siehe die
LEARNINGS-typischen Kommentare direkt über `refreshOpenSbcView`), ohne den
Rückweg zur bereits vorhandenen Hilfsfunktion zu gehen.

## Beobachteter Antipattern: Controller-/Challenge-Lookup dupliziert statt `findSbcController()`/`findLiveChallenge()` zu nutzen

**Was schiefläuft:** Es gibt zwei explizit als wiederverwendbar kommentierte Helfer
(`findSbcController()`, `findLiveChallenge()`, Kommentar: "Helfer, die auch die
Diagnose nutzt"). Trotzdem bauen `submitViaApp()` und `syncSbcWithOpenChallenge()`
exakt dieselbe Such-Logik (SBC-Controller mit `_squad`/`getSquad()` finden, dann
`_overviewController`/`leftController`/`_leftController` nach `_challenge`
absuchen) inline noch einmal nach, statt die Helfer aufzurufen.

**Code-Belege:**
- `ea-fc-sbc-optimizer.user.js:742-753` — `syncSbcWithOpenChallenge()`: eigene Challenge-Suche über dieselben drei Controller-Keys.
- `ea-fc-sbc-optimizer.user.js:2554-2559` — `submitViaApp()`: eigene Suche nach dem SBC-Controller, identisch zu `findSbcController()`.
- `ea-fc-sbc-optimizer.user.js:2564-2570` — `submitViaApp()`: eigene Challenge-Suche, identisch zu `findLiveChallenge()`.
- `ea-fc-sbc-optimizer.user.js:4986-4997` — `findLiveChallenge()` (Helfer existiert, wird von `submitViaApp`/`syncSbcWithOpenChallenge` nicht genutzt).
- `ea-fc-sbc-optimizer.user.js:4999-5006` — `findSbcController()` (Helfer existiert, wird von `submitViaApp` nicht genutzt).

**Vermutete Wurzelursache:** Vermutlich strukturell/bewusst: `submitViaApp()` ist
Teil des in CLAUDE.md als "Nicht anfassen ohne Grund" markierten Submit-Wegs 0
(LEARNINGS §5, der einzige Weg ohne F5-Reload) — ein Refactor auf die später
extrahierten Helfer hätte live verifizierten Code angefasst, ohne zwingenden
Grund. Das erklärt aber nicht `syncSbcWithOpenChallenge()`, die kein "Nicht
anfassen"-Kandidat ist — dort ist es einfacher Q4/Q3: die Helfer wurden laut
Kommentar erst "auch für die Diagnose" extrahiert, vermutlich NACH dieser
Funktion, ohne den bestehenden Aufrufer nachzuziehen.

## Weak Signals (zu wenige Belege für Pattern-Status)

- Doku/Code-Widerspruch bei der Ebenen-Präferenz: Der Abschnittskopf
  `ea-fc-sbc-optimizer.user.js:1009-1010` beschreibt Ebene A (App-Services) als
  generell "bevorzugt", `loadPool()` macht aber HTTP (`ea-fc-sbc-optimizer.user.js:1358-1360`,
  "PRIMÄR: HTTP-Club-Endpunkt") zum Primärweg und Services zum Fallback — nur
  eine Stelle, aber ein potenzieller Q7-Verstoß (Kommentar beschreibt nicht mehr
  den IST-Zustand von `loadPool`).
- Zwei verschiedene Item-Entity-Bauweisen für den Submit: `submitViaApp()`
  (`ea-fc-sbc-optimizer.user.js:2573-2579`) nutzt `UTItemEntityFactory.createItem()`,
  `toItemEntity()` (`ea-fc-sbc-optimizer.user.js:2671-2690`, genutzt von
  `submitViaServices`) baut stattdessen `new window.UTItemEntity(p.raw)` per Hand.
  Passt zur in CLAUDE.md dokumentierten additiven Fallback-Philosophie (alter Weg
  bleibt neben neuem bestehen) — nur 2 Fundstellen, daher kein Pattern-/
  Antipattern-Status, aber erwähnenswert für Cross-Slice-Vergleich mit dem
  Submit-Aspect.

## Zusammenfassung

- 3 Pattern-Kandidaten in dieser Slice
- 2 Antipattern-Kandidaten
- 2 Weak Signals
