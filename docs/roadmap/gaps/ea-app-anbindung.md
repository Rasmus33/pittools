---
feature: ea-app-anbindung
analyzed_at: 2026-08-14
iteration: 0
regression: false
score_current:
  RA: 64
score_target:
  RA: 70
---

# Gap-Report — EA-Web-App-Anbindung (Session & API-Zugriff)

## Ist-Stand pro Dimension

### RA — Robust Architecture

**Wert:** 64 / 75 (structural_max)
**Schwellwert:** 52.5 (75 × 0.7)
**Status:** pass
**Begründung:** Der `audit-evaluator` bewertet die doppelt abgesicherte
Fremd-Grenze (Netzwerk-Interception UND App-Services, siehe
`ea-fc-sbc-optimizer.user.js:1236-1253`, `:1184-1235`) sowie disziplinierte
Fehlermeldungen und WARUM-Kommentare mit Live-Belegen (`:187`, `:1100`)
positiv. Dem steht ein klar nachweisbares Cluster aus SSOT-/DRY-Verstößen
gegenüber: duplizierte `sbs`/`sbc`-Regex, duplizierte 401-Retry-Logik,
duplizierte Controller-Traversal statt Helfer-Nutzung, sowie
Beobachtbarkeits-Lücken im Services-Fallback ohne `diagError`
(`ea-fc-sbc-optimizer.user.js:4986-5006`). `pass`, aber mit klarem
Verbesserungsspielraum bis zum strukturellen Maximum (EA-API ist
undokumentiert — 75 ist bereits der branchen-/produktbedingte Deckel, siehe
`vision/features/ea-app-anbindung.md`).

## Mängel (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`sbs`/`sbc`-Präfix-Wissen fünffach als Regex-Literal dupliziert (Q5/SSOT):**
   `ea-fc-sbc-optimizer.user.js:187` (`detectApiBase`), `:197`, `:198`, `:200`,
   `:205` (`classifyUrl`, vier eigenständige `(sbs|sbc)`-Alternationen) und
   `:291` (XHR-Wrapper, PUT-Body-Erkennung) — dieselbe fachliche Tatsache
   (EA nutzt wahlweise `sbs`/`sbc` als API-Präfix, LEARNINGS §3) ohne
   gemeinsame Konstante/Helper. Pattern-Ref: `wissens-duplikate-ohne-ssot`.
   Ändert EA das Präfix-Schema oder kommt ein drittes Präfix hinzu, müssen
   alle sechs Stellen synchron nachgezogen werden — bislang keine
   Cross-Validation, die eine vergessene Stelle sichtbar macht.
2. **401-Retry-Kaskade in `apiGet`/`apiPut` wortgleich dupliziert (Q4/DRY):**
   `ea-fc-sbc-optimizer.user.js:1184-1206` (`apiGet`) und `:1207-1235`
   (`apiPut`) bauen dieselbe Nudge→Sleep(3000)→rekursiver-Retry-Kaskade
   (Grenze `_attempt<2`) unabhängig voneinander nach — inklusive derselben
   Kommentar-Begründung. Pattern-Ref: `helfer-existiert-wird-umgangen`. Ein
   künftiger Fix an der Retry-Logik (z.B. Cooldown-Anpassung nach einem
   neuen Rate-Limit-Vorfall wie LEARNINGS §7/§23) muss an zwei Stellen
   identisch nachgezogen werden — genau die Fehlerklasse, die den
   Club-Lade-Takt schon einmal getroffen hat.
3. **Controller-Traversal (`getControllerChain`-Konsument) dreifach inline
   nachgebaut statt über `findSbcController`/`findLiveChallenge` (Q4/DRY):**
   `ea-fc-sbc-optimizer.user.js:4986-5006` (`findLiveChallenge`/
   `findSbcController`, explizit als "Helfer, die auch die Diagnose nutzt"
   kommentiert) vs. `:742-763` (`syncSbcWithOpenChallenge`) und `:2554-2571`
   (`submitViaApp`) — beide bauen dieselbe Such-Schleife über
   `_overviewController`/`leftController`/`_leftController` Zeile für Zeile
   erneut. Pattern-Ref: `helfer-existiert-wird-umgangen`. Ändert sich die
   EA-Controller-Struktur (neuer Key, umbenannter Controller — genau das
   Fehlerbild, das RA laut Rubric "Fehlertoleranz gegen EA-Wandel" misst),
   muss die Anpassung an drei statt an einer Stelle erfolgen; die Diagnose-
   Helfer (`findLiveChallenge`) könnten dann sogar einen anderen (veralteten)
   Stand zeigen als der tatsächlich benutzte Submit-Pfad.
4. **Beobachtbarkeits-Lücke im Services-Fallback (Rubric-Kriterium
   "Beobachtbarkeit"):** `ea-fc-sbc-optimizer.user.js:1100`
   (`fetchUnassignedViaServices`) und `:1118` (`fetchStorageViaServices`)
   fangen Service-Fehler nur mit `warn()`, ohne `diagError()` — anders als
   der strukturell gleichwertige HTTP-Fallback in `apiGet`/`apiPut`
   (`:1190`, `:1202`, `:1218`, `:1231`), der jeden Fehler zusätzlich in
   `STATE.diag.lastErrors` einträgt. Pattern-Ref:
   `fehler-unsichtbar-verschluckt`. Schlägt Ebene A (Services) fehl, sieht
   Rasmus im Copy-Paste-Report nur das nachgelagerte Symptom ("Storage ist
   leer"), nie die Ursache — obwohl die Diagnose-Infrastruktur dafür bereits
   existiert und an der Nachbarstelle auch genutzt wird.
5. **`syncSbcWithOpenChallenge` meldet Fehlschläge nur über `warn()`, nicht
   über `diagError()`:** `ea-fc-sbc-optimizer.user.js:762` — ein Fehlschlag
   bedeutet laut Kommentar (`:735-740`), dass die SBC-Erkennung auf
   veraltetem Stand weiterläuft (LEARNINGS §6 nennt genau dieses
   Veraltungsrisiko als wiederkehrende Fehlerquelle bei dieser
   Fremd-Grenze), landet aber nicht im Report. Pattern-Ref:
   `fehler-unsichtbar-verschluckt`.

## Lift-Aktionen (≥ 3 pro Dimension — M1)

### RA — Robust Architecture

1. **`diagError` in den zwei Services-Fallback-Catches ERGÄNZEN (additiv,
   kein Verhaltens-Umbau):** In `fetchUnassignedViaServices`
   (`ea-fc-sbc-optimizer.user.js:1100`) und `fetchStorageViaServices`
   (`:1118`) je einen `diagError('Unassigned via Service: ' + ...)` bzw.
   `diagError('Storage via Service: ' + ...)`-Aufruf NEBEN das bestehende
   `warn()` setzen — reine Ergänzung, ändert keinen Kontrollfluss, kein
   neuer Testfall zur Verhaltensprüfung nötig (nur `node --check` +
   `node solver-test.js` grün halten). Gleiches additiv für
   `syncSbcWithOpenChallenge` (`:762`). Erwarteter Gain: +4-6 Pt für RA
   (schließt die "Beobachtbarkeits-Lücken im Services-Fallback"-Kritik aus
   der Score-Begründung direkt).
2. **`(sbs|sbc)`-Regex hinter eine benannte Konstante/Helper ziehen, Call-Sites
   EINZELN umziehen:** Eine Konstante `const SBS_SBC_PREFIX_RE_SRC =
   'sbs|sbc';` (oder eine `matchesSbcPath(url, suffixRe)`-Helper-Funktion)
   einführen, dann NACHEINANDER `detectApiBase` (`:187`), die vier
   Vorkommen in `classifyUrl` (`:197-205`) und den XHR-Wrapper (`:291`)
   umstellen — jede Umstellung einzeln mit `node solver-test.js` (95/95 grün)
   verifizieren, da `classifyUrl` das Response-Routing steuert und ein
   Fehlgriff hier den Pool/die SBC-Erkennung stumm falsch befüllen würde.
   Erwarteter Gain: +3-5 Pt für RA (SSOT-Kritik direkt adressiert, macht
   künftige Präfix-Änderungen EA-seitig an einer Stelle robust statt an
   sechs).
3. **`apiRequest(method, path, body, _attempt)`-Kern extrahieren, `apiGet`/
   `apiPut` darauf umstellen:** Die identische Nudge→Sleep→Retry-Kaskade aus
   `apiGet` (`:1184-1206`) und `apiPut` (`:1207-1235`) in eine gemeinsame
   private Funktion ziehen, die Methode/Body als Parameter nimmt; `apiGet`
   und `apiPut` werden zu dünnen Wrappern. Verhaltensneutral, da Diff nur
   die Kaskade selbst betrifft — vorher/nachher mit `node solver-test.js`
   und einem manuellen 401-Smoke-Test (Diagnose-Report vor/nach Vergleich)
   absichern. Erwarteter Gain: +3-4 Pt für RA (DRY-Kritik behoben, sichert
   zugleich, dass ein künftiger Rate-Limit-Fix wie LEARNINGS §7/§23 nur an
   EINER Stelle nachgezogen werden muss).
4. **Diagnose-Helfer `findLiveChallenge`/`findSbcController` tatsächlich in
   `syncSbcWithOpenChallenge` und `submitViaApp` NUTZEN statt die
   Controller-Traversal erneut zu inlinen:** Da beide Aufrufer laut
   `helfer-existiert-wird-umgangen`-Pattern ("Nicht anfassen ohne Grund"-Pfad
   `submitViaApp`) mit Vorsicht zu behandeln sind, additiv vorgehen: zuerst
   `findSbcController()`/`findLiveChallenge()` um die in `submitViaApp`
   benötigten Zusatzfelder (`_squad`/`getSquad()`) ERGÄNZEN, dann NUR
   `syncSbcWithOpenChallenge` (unkritischer, da reine Diagnose-Synchronisation)
   auf den Helfer umstellen und mit `node solver-test.js` grün verifizieren;
   `submitViaApp` als Live-verifizierter Submit-Weg 0 zunächst NICHT anfassen,
   sondern die Duplikation mit einem WARUM-Kommentar (Q6) explizit als
   bewusst begründen (Verweis auf CLAUDE.md "Nicht anfassen ohne Grund").
   Erwarteter Gain: +2-3 Pt für RA (reduziert eine von drei Duplikationsstellen
   ohne den kritischsten Pfad zu risikieren).
5. **LEARNINGS.md §3/§4 um die 401-Retry-Symmetrie und das Präfix-Wissen als
   EINE dokumentierte Quelle ergänzen:** Sobald Aktion 2/3 umgesetzt sind,
   einen Verweis in LEARNINGS §3 ("API-Zugriff") ergänzen, dass
   `sbs`/`sbc`-Erkennung und Retry-Kaskade jetzt zentral in
   `apiRequest`/der Präfix-Konstante liegen — macht die "Dokumentierte
   Begründung fragiler Stellen"-Rubrik (score-criteria.md) direkt greifbar
   für künftige Bearbeiter. Erwarteter Gain: +1-2 Pt für RA (Doku-Kriterium
   der Rubric, geringer eigenständiger Gain, aber Voraussetzung dafür, dass
   Aktion 2/3 nicht erneut auseinanderdriften).

## Edge-Cases (mind. 1 — M1)

- **Club-Lade-Takt ist "Nicht anfassen ohne Grund" (LEARNINGS §7/§23,
  CLAUDE.md):** Keine der obigen Lift-Aktionen darf den Zeittakt zwischen
  den Club-Seiten-Starts (300ms, wächst bei Fehlversuch selbst) anfassen —
  auch nicht "im Vorbeigehen" bei der `apiRequest`-Extraktion. Der Takt lebt
  in `fetchClubViaHttp` (`:1236-1253`), NICHT in `apiGet`/`apiPut` selbst,
  ist also von Aktion 3 baulich nicht betroffen — das muss beim Refactoring
  aber explizit geprüft werden (Diff darf `gap`/`clubLoad`-Logik nicht
  berühren), da ein Merge-Fehler hier laut CLAUDE.md ein Live-Ausfallrisiko
  ist. Zusätzlicher, leicht übersehener Edge-Case: `nudgeSession()` wird
  aktuell nur aus `apiGet`/`apiPut` heraus aufgerufen — bei einer
  `apiRequest`-Extraktion muss der `_attempt`-Zähler weiterhin PRO
  Methode/Pfad-Aufruf zählen (nicht global), sonst würde ein GET- und ein
  parallel laufender PUT-Retry sich gegenseitig den Zähler kaputt machen.

## Lift-Empfehlung

Vorsichtig, additiv, kleine Diffs — passend zur "keine Regression"-Regel
und zur strukturellen Nähe zum Live-verifizierten Submit-Weg 0
(`submitViaApp`). Reihenfolge: zuerst die beiden reinen `diagError`-Ergänzungen
(Aktion 1, null Risiko), dann die Regex-Zentralisierung (Aktion 2, Call-Sites
einzeln mit Tests), dann `apiRequest`-Extraktion (Aktion 3, mit explizitem
401-Smoke-Test), erst zuletzt und mit Vorsicht die Controller-Helfer-Nutzung
(Aktion 4) — `submitViaApp` bleibt vorerst unangetastet und wird stattdessen
kommentiert begründet. Kein Kandidat für einen aggressiven Lift-Plan in einer
Iteration; eher zwei kleine Iterationen mit Testlauf dazwischen. Mid-Iter-SI
ist kein Thema, da alle Aktionen genau ein Feature betreffen.
