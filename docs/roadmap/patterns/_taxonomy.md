# Pattern-Taxonomie — pittools

Generiert vom roadmap-patterns-Lauf (Iteration 0, 2026-08-14). 9 Aspect-Slices,
35 Roh-Cluster, konsolidiert zu 7 Patterns + 3 Antipatterns.

**Konsolidierungs-Hinweis:** Der deterministische Clusterer fand keine
titel-identischen Cluster über mehrere Aspect-Files (Ein-Datei-Codebase, Slices
vergeben eigene Titel). Die Reife (≥2 Aspect-Files, ≥3 Belege) wurde deshalb
auf Main-Ebene semantisch geprüft — jedes synthetisierte Doc erfüllt sie real.

## Patterns (good/)

| Pattern | Kern | Features |
|---------|------|----------|
| [[ea-grenz-fallback-ketten]] | Nie ein einzelner Weg an Fremd-Grenzen: geordnete Fallback-Kette + Diagnose, welcher Weg griff | ea-app-anbindung, spieler-pool, batch-modus, android-app-wrapper |
| [[strukturierte-ok-why-rueckgabe]] | Riskante Aktionen liefern `{ok, why, …}` — das WHY landet wörtlich im Diagnose-Report | batch-modus, rating-solver, sbc-vorgaben-erkennung, team-eintragen |
| [[diagnose-feld-statt-raten]] | Fehlt Info: erst STATE.diag-Feld einbauen, Report anfordern, dann fixen; diagError als Zweitkanal | diagnose-werkzeuge, ea-app-anbindung, team-eintragen, batch-modus, android-app-wrapper |
| [[eingebetteten-code-exakt-testen]] | Ausgelieferten Code per Marker/Literal extrahieren und testen; Brute-Force-Erwartungswerte; statische Source-Checks | rating-solver, android-app-wrapper, bedienpanel-ui |
| [[abbruch-disziplin]] | Bei Unstimmigkeit sofort, erklärend, ohne Halbzustand abbrechen — „2 von 5 fertig" schlägt falsch abgegeben | batch-modus, rating-solver, android-app-wrapper, team-eintragen |
| [[stille-catches-nur-an-der-ea-grenze]] | Leere catches NUR um Fremd-Code (EA-Objekte, DOM, localStorage) — das Script darf die Host-Seite nie crashen | ea-app-anbindung, sbc-vorgaben-erkennung, bedienpanel-ui, batch-modus |
| [[warum-kommentare-mit-live-belegen]] | Kommentare zitieren den echten Vorfall/die echten Zahlen — Schutz live verifizierter Entscheidungen vor Refactors | rating-solver, diagnose-werkzeuge, spieler-pool, ea-app-anbindung |

## Antipatterns (bad/)

| Antipattern | Kern | Features |
|-------------|------|----------|
| [[helfer-existiert-wird-umgangen]] | Kanonischer Helfer/Funnel existiert, Call-Sites duplizieren inline (getControllerChain, visibleAll, apiGet/apiPut-Retry, Komparator, reserve()) | ea-app-anbindung, team-eintragen, batch-modus, rating-solver, bedienpanel-ui, sbc-vorgaben-erkennung |
| [[wissens-duplikate-ohne-ssot]] | Dasselbe Wissen mehrfach ohne SSOT, Drift nachgewiesen (Rating-Kosten-Defaults ×3, sbs/sbc-Pfade ×7, Kostenformel im Test, STATE.diag ohne Schema, slots/formationSlots) | rating-solver, bedienpanel-ui, sbc-vorgaben-erkennung, diagnose-werkzeuge, batch-modus, ea-app-anbindung |
| [[fehler-unsichtbar-verschluckt]] | Reportwürdige eigene Fehler nur in warn()/still verschluckt statt im kopierbaren Report (diagError/addLog vorhanden, ungenutzt) | spieler-pool, ea-app-anbindung, android-app-wrapper, diagnose-werkzeuge, batch-modus |

## Beziehungen

- [[diagnose-feld-statt-raten]] ⟷ Gegenstück [[fehler-unsichtbar-verschluckt]]
- [[stille-catches-nur-an-der-ea-grenze]] grenzt ab, wo Stille RICHTIG ist — jenseits der Grenze gilt [[fehler-unsichtbar-verschluckt]]
- [[strukturierte-ok-why-rueckgabe]] speist [[diagnose-feld-statt-raten]] (batchSteps)
- [[abbruch-disziplin]] nutzt [[strukturierte-ok-why-rueckgabe]] für erklärende Abbrüche
- [[ea-grenz-fallback-ketten]] + [[stille-catches-nur-an-der-ea-grenze]] = die zwei Hälften des Fremd-Grenzen-Umgangs
- [[eingebetteten-code-exakt-testen]] ist das Werkzeug gegen die Test-Drift-Unterklasse von [[wissens-duplikate-ohne-ssot]]
- [[helfer-existiert-wird-umgangen]] ⟷ verschwistert mit [[wissens-duplikate-ohne-ssot]] (Code- vs. Wissens-Duplikat)
- [[warum-kommentare-mit-live-belegen]] schützt dieselben Stellen, die die oberste Regel „keine Regression" (CLAUDE.md) meint

## Weak Signals (nächsten Aspect-Lauf erneut prüfen)

Ein-Slice-Themen mit Substanz, aber ohne Cross-Slice-Bestätigung:

- **Vollständige Tap-Nachbildung statt el.click()** (dom-interaktion, 5 Belege, LEARNINGS §21-verifiziert) — Pattern-Kandidat, sobald ein zweiter Bereich Taps braucht.
- **Graceful Degradation mit Pflicht-Warnung** (solver, 5 Belege: Lockern harter Constraints nur mit Warnung) — Solver-intern konsistent.
- **Observable→Promise-Adapter + responseOk als einziger Antwort-Prüfer** (ea-services, 7+6 Belege) — kanonische Helfer, in [[helfer-existiert-wird-umgangen]] als Soll referenziert.
- **Zentrales STATE-Objekt + zentraler Reset beim Challenge-Wechsel** (zustand-config) — trägt, solange kein Schema fehlt (siehe STATE.diag-Befund).
- **401-Ursachenunterscheidung mit selbstbremsendem Takt** (netz-api, 5 Belege, LEARNINGS §7) — „Nicht anfassen ohne Grund".
- **Passive Session-Header-Erfassung über fetch/XHR-Interception** (netz-api, 5 Belege).
- **Gestückelte Cross-Context-Injection + selbstjustierender Wächter** (android-app, 5+5 Belege) — App-spezifisch, LEARNINGS §8/§20/§22.
- **Ungekapselte Activity-Felder, von Top-Level-Hilfsklassen direkt mutiert** (android-app, 6 Belege, bad) — strukturell durch d8-ohne-Gradle bedingt; beobachten.
- **Doku-Drift:** CLAUDE.md verweist auf „LEARNINGS §23", die Datei hat nur 22 (teils doppelt nummerierte) Abschnitte (netz-api-Fund).
- **Tote Artefakte im Solver:** ungenutztes `WASTE_WEIGHT`, möglicherweise toter `priorityOf`-Export (solver, je 2 Belege).

## Fund-Kandidaten für Tickets (aus den Antipattern-Belegen, an Gap/Plan weiterreichen)

1. **Panel-Reset liefert veraltete Kosten-Defaults** — `defaultBands()` (85-86:5/87-88:2) widerspricht `DEFAULT_RATING_COST_SPEC` (85-88:2, Stand Aug 2026). Sichtbares Fehlverhalten beim „Zurücksetzen"-Button.
2. **`STATE.sbc.slots` wird nie geschrieben** — der Slots-Teil von `matchesPlannedSbc` (Batch-Sicherheitsnetz) ist ein No-Op (blockiert nie fälschlich, prüft aber auch nichts).
3. **`reserve()`-Funnel umgangen** (Anker- + Rarity-Pick-Pfad) — latentes HTTP-460-Risiko, aktuell durch Pool-Dedup gedeckt; Korrektur nur mit eigenem Brute-Force-Testfall.
4. **`uiScan` im Report immer null** + doppelter `rareConstraints`-Key in buildDiagReport.
