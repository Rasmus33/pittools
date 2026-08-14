---
feature: sbc-vorgaben-erkennung
iteration: 0
score_current:
  RA: 65
score_target:
  RA: 75
primary_paths:
  - ea-fc-sbc-optimizer.user.js
  - solver-test.js
patterns_required:
  - eingebetteten-code-exakt-testen
  - diagnose-feld-statt-raten
pk_files_to_cite: []
citation_only: false
shared_items_required: []
priority: P2-normal
effort: S
analyzed_at: 2026-08-14
---

# Lift-Plan — SBC-Vorgaben-Erkennung

**Ticket-Titel-Vorschlag (ADR #73):** Slot-Namensdrift beheben und SBC-Parser mit echten Tests absichern

## Marschroute

Vier Aktionen entlang der Phasen-Reihenfolge `core → diagnose → tests → docs →
release`, in der von `gap-analyst` empfohlenen Abhängigkeitsordnung: zuerst
die einzige verhaltensändernde Aktion (Namensdrift-Fix, Aktion 1) isoliert mit
eigenem Testfall, danach die additive Marker-Extraktion samt echten
Parser-Tests (Aktion 2) — sie profitiert davon, dass der Slot-Vergleich dann
bereits scharf ist. Die beiden additiven Aktionen 3 (`matchedAs`-Diagnosefeld)
und 4 (Duplikat-Zeile entfernen) laufen parallel bzw. nachgelagert ohne
Abhängigkeit. Kein aggressiver Ein-Schritt-Umbau: RA ist mit 65/80 bereits
`pass` (Schwelle 56), die Iteration nimmt sich bewusst Zeit für den
Brute-Force-artigen Testfall aus Aktion 1 statt auf Geschwindigkeit zu
optimieren (Q1). Jede Aktion respektiert „keine Regression": `node --check`
und das volle `solver-test.js` müssen vorher wie nachher grün sein, und jede
Verhaltensänderung bekommt einen eigenen neuen Testfall statt eines stillen
Fixes nebenbei (Q2).

## Aktionen pro Dimension

### RA — Robust Architecture

1. **`STATE.sbc.slots`-Namensdrift auf `STATE.sbc.formationSlots` umstellen
   (SSOT-Fix, verhaltensändernd):** die vier Lesestellen des nie
   geschriebenen Feldes durch das tatsächlich gepflegte Feld ersetzen —
   `ea-fc-sbc-optimizer.user.js:576` (`resolveFreshChallengeId`, `wantSlots`),
   `:4795` (`matchesPlannedSbc`), `:4816` (`onBatchPlanClick`, Anker-Übernahme
   `plan.slots`), `:4916` (Nutzertext bei Batch-Abbruch-Diskrepanz). Schreib-
   stellen bleiben unverändert (`:492`, `:640`, `:675`, `:691` schreiben
   bereits korrekt `STATE.sbc.formationSlots`). Folgt dem SSOT-Prinzip aus
   `docs/roadmap/patterns/bad/wissens-duplikate-ohne-ssot.md` (Abschnitt
   „Namensdrift als Sonderfall"): eine Quelle statt einer zweiten, nie
   befüllten. **Pflicht-Testfall in `solver-test.js`** (kein stiller Fix,
   siehe Q2): zwei simulierte Set-Challenge-Knoten mit unterschiedlichem
   `formationSlots`-Wert durch `deepScanChallenge` schicken und assertieren,
   dass `resolveFreshChallengeId()`-Logik (bzw. eine isoliert testbare
   Nachbildung ihres Kandidaten-Filters `okTarget && okSlots`) den zum
   geplanten `wantSlots` passenden Knoten auswählt und den mit abweichender
   Slot-Zahl ablehnt — sowie ein zweiter Fall für `matchesPlannedSbc`, der
   zeigt, dass ein Plan mit `slots: 11` gegen eine offene SBC mit
   `formationSlots: 4` jetzt tatsächlich `false` liefert (vorher `false ===
   false`, also fälschlich `true`-äquivalent). Erwarteter Gain: **+6 bis +8
   Pt RA** (behebt den im Gap-Report benannten Hauptabzug „Slot-
   Disambiguierung faktisch tot").

2. **`deepScanChallenge`-Cluster per Marker extrahierbar machen und mit
   konstruierten EA-Objekten real testen (additiv):** in
   `ea-fc-sbc-optimizer.user.js` ein neues Marker-Paar `// [SBCSCAN-BEGIN]`
   vor `scopeString` (aktuell `:317`) und `// [SBCSCAN-END]` nach dem Ende von
   `deepScanChallenge` (aktuell `:476`) einfügen — umschließt `scopeString`,
   `reqValue`, `reqIds`, `reqCount`, `isDomOrWindow`, `deepScanChallenge`.
   Diese sechs Funktionen sind bereits self-contained (keine Referenz auf
   `STATE`, `warn` oder andere Datei-Globals außer Standard-JS), also ohne
   Anpassung 1:1 extrahierbar — Pattern `eingebetteten-code-exakt-testen`
   (Marker-Extraktion statt Nachbau, analog `// [SOLVER-BEGIN]`/`:1411` /
   `// [SOLVER-END]`/`:2446`). In `solver-test.js` eine neue Sektion nach dem
   Vorbild von `:10-13` (Regex-Extraktion + `new Function(...)`) ergänzen und
   drei Testfälle mit konstruierten EA-Response-Objekten schreiben, die die
   dokumentierten Live-Bugs aus `docs/LEARNINGS.md` §6/§11 exakt nachstellen:
   (a) `PLAYER_RARITY_GROUP` mit Wert 4 korrekt als Rare-Gruppe erkannt,
   während ein Namens-Scope mit „RARE"-Substring (`CARRARESE CALCIO` o.ä.)
   NICHT matcht (ergänzt die bestehenden reinen String-Checks aus
   `solver-test.js:1218-1235` um einen echten Funktionsaufruf), (b)
   `PLAYER_LEVEL` mit Wert 1 landet in `out.quality`, (c) `PLAYER_LEVEL` mit
   Wert 87 landet in `out.playerLevel` bzw. `out.target`. Rein additiv — nur
   neue Marker-Kommentare + neue Testsektion, keine Änderung an der
   Funktionslogik selbst; `node --check` und das volle `solver-test.js`
   trotzdem danach zur Bestätigung laufen lassen. Erwarteter Gain: **+8 bis
   +10 Pt RA** (schließt die im Gap-Report benannte fehlende Testbarkeit der
   Parsing-Kernlogik — bisher nur String-Präsenz-Checks auf den Rohquelltext,
   kein einziger Aufruf von `deepScanChallenge`).

3. **Klassifizierungs-Zweig pro `reqDump`-Eintrag sichtbar machen
   (additiv):** in `out.reqs.push(...)` (`ea-fc-sbc-optimizer.user.js:388`)
   ein zusätzliches Feld `matchedAs` ergänzen, abgeleitet aus denselben
   Bedingungen, die ohnehin schon berechnet werden — `isTeamRating` (`:390-
   393`) → `'TEAM_RATING'`, `isPlayerLevel` (`:401-404`) → `'PLAYER_LEVEL'`,
   `isQualityScope` (`:417-418`) → `'PLAYER_QUALITY'`, `scope.indexOf('RARITY')
   > -1` (`:427`) → `'RARITY'`, sonst `'unclassified'`. Pattern
   `diagnose-feld-statt-raten` befolgen: das Feld macht sichtbar, welcher der
   sich gegenseitig ausschließenden Zweige griff bzw. dass keiner griff —
   genau die Information, die beim `PLAYER_LEVEL`-Dual-Use-Bug (LEARNINGS
   §6/§11) beim Live-Debugging fehlte. **Edge-Case explizit mitdenken:** ein
   `PLAYER_LEVEL`/`PLAYER_QUALITY`-Wert zwischen 4 und 39 fällt durch
   `isPlayerLevel` (verlangt `v >= 40`) UND `isQualityScope` (verlangt `v` in
   1..3) — `matchedAs` muss für diesen Fall `'unclassified'` liefern statt
   das Feld wegzulassen, sonst bleibt genau die Lücke unsichtbar, die den
   nächsten Dual-Use-Bug verursachen könnte. Rein additiv — nur ein neues
   Feld im Objekt-Literal, keine bestehende Zuweisung wird verändert;
   trotzdem einen `solver-test.js`-Smoke-Check ergänzen (kann in derselben
   neuen Marker-Testsektion aus Aktion 2 laufen), der für die drei
   LEARNINGS-§6/§11-Fixtures (`PLAYER_LEVEL` Wert 1 / Wert 87 / ein Wert wie
   15 als Beleg für `'unclassified'`) das erwartete `matchedAs` prüft.
   Erwarteter Gain: **+4 bis +6 Pt RA** (Beobachtbarkeits-Kriterium aus
   `docs/roadmap/vision/score-criteria.md`).

4. **Doppelte `rareConstraints`-Deklaration im Diagnose-Report entfernen
   (verhaltensneutral):** `ea-fc-sbc-optimizer.user.js:3927-3928` — eine der
   beiden identischen Zeilen `rareConstraints: STATE.sbc.rareConstraints ||
   []` im selben Objekt-Literal streichen (JS überschreibt den Duplikat-Key
   ohnehin durch sich selbst, keine funktionale Änderung; die dritte,
   unabhängige Stelle `:4059` bleibt unberührt — anderer Report-Zweig, kein
   Duplikat desselben Literals). `node --check` + volles `solver-test.js`
   danach laufen lassen, um Verhaltensneutralität zu bestätigen. Erwarteter
   Gain: **+1 bis +2 Pt RA** (Sorgfalt-Signal im Beobachtbarkeits-Kanal
   selbst, der laut CLAUDE.md-Debugging-Konvention der einzige Weg zu
   Rasmus' Fehlerbildern ist).

## Phasen-Commit-Mapping

| Phase | Aktionen |
|-------|----------|
| core | Aktion 1 (vier Lesestellen `STATE.sbc.slots` → `STATE.sbc.formationSlots`); Aktion 4 (Duplikat-Zeile `:3927` oder `:3928` entfernen); `// [SBCSCAN-BEGIN]`/`// [SBCSCAN-END]`-Marker für Aktion 2 einfügen (reine Kommentarzeilen, keine Logikänderung) |
| diagnose | Aktion 3 (`matchedAs`-Feld in `out.reqs.push(...)`, `:388`) |
| tests | Pflicht-Testfall zu Aktion 1 (zwei simulierte Set-Challenge-Knoten, `resolveFreshChallengeId`-Kandidatenfilter + `matchesPlannedSbc`); neue `solver-test.js`-Marker-Extraktionssektion für Aktion 2 mit den drei LEARNINGS-§6/§11-Fixtures; Smoke-Check für Aktion 3 (`matchedAs` an denselben drei Fixtures, inkl. `'unclassified'`-Fall) |
| docs | `docs/LEARNINGS.md`-Eintrag zum jetzt scharf geschalteten Slot-Vergleich (Batch-Anker-Abgleich vergleicht ab jetzt tatsächlich Slots) |
| release | `node --check ea-fc-sbc-optimizer.user.js`; `node solver-test.js` (alle Tests inkl. der neuen grün); `@version` + `const VERSION` bumpen; Push auf `main` |

## Shared-Item-Bedarf

Keiner. Die `deepScanChallenge`-Cluster-Zeilen (`ea-fc-sbc-optimizer.user.js:317-476`)
gehören ausschließlich zur Code-Geographie von `sbc-vorgaben-erkennung` — kein
anderes Vision-Feature (`ea-app-anbindung`, `rating-solver`, `batch-modus`,
`team-eintragen`, `bedienpanel-ui`, `diagnose-werkzeuge`, `spieler-pool`,
`android-app-wrapper`) referenziert diese Zeilen oder eine analoge
Parser-Struktur. Der neue `// [SBCSCAN-BEGIN]`/`// [SBCSCAN-END]`-Marker ist
dieselbe TECHNIK wie `// [SOLVER-BEGIN]`/`// [SOLVER-END]`, aber kein
gemeinsam genutztes Code-Artefakt — jedes Feature markiert seinen eigenen,
unabhängigen Block. Ein `diagError`-Nachrüstung für neue Fehlerbilder wäre
zwar cross-feature-relevant, ist hier aber nicht Teil der Aktionen (Aktion 3
nutzt ausschließlich das bereits bestehende `reqDump`-Feld additiv) und
gehört, falls sie ansteht, in die Lift-Pläne von `diagnose-werkzeuge` bzw. den
Features, die tatsächlich neue Fehlerpfade einführen. `[]` in
`sbc-vorgaben-erkennung.shared-items.json`.

## Risiken / Edge-Cases

- **Aktion 1 schaltet zwei bislang stummen Vergleiche scharf:**
  `resolveFreshChallengeId()` kann nach dem Fix Kandidaten ablehnen, die
  vorher (mangels funktionierendem Slot-Vergleich) durchgingen — betrifft den
  von CLAUDE.md als Knackpunkt bezeichneten Batch-Modus-Anker. Ohne den
  Pflicht-Testfall bestünde das Risiko, dass eine SBC mit tatsächlich
  passenden Slots durch einen Tippfehler im Vergleich (`Number(...)`-Cast,
  `== null`-Fallback) neu fälschlich abgelehnt wird — genau das Szenario, vor
  dem die Abbruch-Disziplin (`:596-599`, „lieber sauber melden als in die
  falsche SBC schreiben") schützen soll, aber nur wenn der Vergleich selbst
  korrekt ist.
- **`matchesPlannedSbc` nach dem Fix strenger:** ein Batch-Plan, dessen
  `plan.slots` vor dem Fix immer `undefined` war, verglich bisher
  `undefined !== undefined` → `false` (Test bestand). Nach dem Fix vergleicht
  er echte Zahlen — ein Alt-Plan-Objekt aus einer laufenden Session (falls
  über einen Reload hinweg persistiert, was aktuell nicht der Fall ist, aber
  als Annahme zu prüfen) könnte inkonsistent werden. Da `STATE.batch` laut
  Code nur In-Memory lebt und nach jedem Lauf verbraucht wird (`plan.consumed`
  über `finally`), ist das Risiko gering, sollte aber beim Review kurz
  bestätigt werden.
- **Marker-Kollision:** der neue Markername `SBCSCAN` darf nicht mit
  `SOLVER` kollidieren oder von dessen Regex versehentlich mitgegriffen
  werden — `solver-test.js`s bestehende `SOLVER-BEGIN`/`SOLVER-END`-Regex ist
  nicht-gierig (`[\s\S]*?`) und stoppt am ersten `SOLVER-END`, bleibt also
  unberührt; trotzdem beim Einfügen prüfen, dass kein Objekt/keine Variable
  in beiden Blöcken gleich benannt ist (aktuell keine Überschneidung
  erkennbar, da `deepScanChallenge`-Cluster außerhalb 1411–2446 liegt).
  Mid-Iter-Einschub (Klasse G) wäre denkbar, falls sich beim Extrahieren doch
  eine versteckte Abhängigkeit auf eine Funktion außerhalb des neuen Blocks
  zeigt (z.B. falls eine künftige Änderung `deepScanChallenge` um einen
  `warn()`-Aufruf erweitert) — dann müsste der Marker-Block nachträglich
  erweitert werden.
- **Edge-Case `matchedAs: 'unclassified'` als Dauerzustand statt Ausnahme:**
  falls EA in einer künftigen Season tatsächlich eine 5-stufige
  Qualitätsskala einführt (Werte 4-39, siehe Gap-Report), würde `matchedAs`
  dauerhaft `'unclassified'` für diese Vorgabe zeigen, ohne dass sich das
  Verhalten der SBC-Erfüllung ändert — das Diagnose-Feld macht die Lücke
  sichtbar, schließt sie aber nicht. Kein Grund, das in dieser Iteration zu
  beheben (kein bekannter Live-Vorfall, nur eine dokumentierte Möglichkeit),
  aber der Report sollte diesen Fall künftig triggern können, falls er
  eintritt.
