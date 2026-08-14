---
name: WARUM-Kommentare mit Live-Belegen
slug: warum-kommentare-mit-live-belegen
applies_to_features: [rating-solver, diagnose-werkzeuge, spieler-pool, ea-app-anbindung]
related_patterns: [abbruch-disziplin, diagnose-feld-statt-raten]
related_antipatterns: []
extracted_in_iteration: 0
last_updated: 2026-08-14
---

## Kontext

Der Code arbeitet gegen eine fremde Live-Plattform (die EA-Web-App), deren
Verhalten nicht dokumentiert ist — jede nicht-offensichtliche Entscheidung im
Solver, in der Netz-Schicht oder im Diagnose-Report wurde durch einen echten
Vorfall erzwungen: einen HTTP-460-Fehler, einen Rate-Limit-Ausfall, einen
falsch priorisierten Kartensatz, einen lückenhaften Report. Diese
Entscheidungen sehen im Code oft wie beliebiges Feintuning aus (ein fester
Millisekunden-Wert, eine harte statt weiche Grenze, ein Vergleichsglied mehr
in einem Comparator). Ohne den Beleg wirkt ein späterer Refactor wie eine
harmlose Vereinfachung — genau das würde eine live verifizierte Entscheidung
stillschweigend rückgängig machen und den Fehler wiederholen. Die Situation
tritt überall dort auf, wo Verhalten der EA-Plattform reverse-engineered und
nicht aus einer Spezifikation abgeleitet wurde.

## Pattern

Ein Kommentar an einer solchen Stelle beschreibt ausschließlich das WARUM
(Q6) und belegt es mit dem konkreten Vorfall: welche Zahlen, welche Version,
welcher Fehlercode aufgetreten sind — nicht was der folgende Code tut. Der
Beleg macht den Kommentar überprüfbar und unterscheidet ihn von einer bloßen
Behauptung. Drei wiederkehrende Formen:

1. **Harte Grenze statt Kosten-Feintuning**, mit dem Rechenbeispiel, das
   zeigte, dass Feintuning nicht ausreicht.
2. **Selbstkommentar am eigenen Fehler**, direkt an dem Feld/der Stelle, die
   beim Vorfall gefehlt hat — nicht nur in einem separaten Änderungsprotokoll.
3. **Taktik-Wert mit Ausfall-Referenz**, der auf die Lernquelle verweist
   (`docs/LEARNINGS.md`) statt die Begründung stumm im Kopf zu behalten.

```js
// Warum hart und nicht über die Kosten: der Aufschlag (+8) konnte den
// Storage-Rabatt nicht überstimmen [...]. Live passiert bei einem
// 90er-Team (zwei FUTTIES verbaut, eine gefordert). Kosten-Feintuning
// hätte das nur verschoben, nicht behoben.
if (rareGroup83Count > required) { /* harte Sperre, kein Kostenmalus */ }
```

Die Konvention ist in `docs/LEARNINGS.md` explizit verankert (jeder
Abschnitt erklärt, WARUM der Code so ist, wie er ist) und in `CLAUDE.md`
unter „Nicht anfassen ohne Grund" fortgesetzt — beide sind die Quelle, auf
die Code-Kommentare bei Bedarf verweisen.

## Code-Belege

- `ea-fc-sbc-optimizer.user.js:1630-1636` — Warum der Rarity-Schutz eine
  HARTE Grenze ist und nicht über Kosten gelöst wird, mit Rechenbeispiel
  (92er FUTTIES aus dem Storage 12.5 vs. gleichwertiges Vereins-Gold 13) und
  Live-Referenz („passiert bei einem 90er-Team, zwei FUTTIES verbaut, eine
  gefordert").
- `ea-fc-sbc-optimizer.user.js:1793-1801` — Warum Spieler-Eindeutigkeit pro
  `assetId` nötig ist: „EA erlaubt denselben SPIELER nur EINMAL pro Squad",
  Duplikat-Karten führen sonst zu HTTP 460, samt der vier-stufigen
  Prioritätsreihenfolge für den verbleibenden Kandidaten.
- `ea-fc-sbc-optimizer.user.js:2224-2233` — Warum ohne Ziel-Rating
  ausnahmslos „niedrigstes Rating vor Kosten" gilt, mit Live-Regressionsbeleg:
  „Live (v4.25.0) kamen so sieben Vereins-77er in eine SBC ohne
  Rating-Vorgabe, wo 75er gereicht hätten."
- `ea-fc-sbc-optimizer.user.js:2116-2120` — Warum `finishTeam` eine
  Endkontrolle vor dem Eintragen macht: „Live kam ein PUT heraus, in dem
  dieselbe Karte auf zwei Slots stand und ein Slot leer blieb -> HTTP 460,
  und der Grund war im Report nicht zu sehen."
- `ea-fc-sbc-optimizer.user.js:3763-3764` — Selbstkommentar direkt am Feld
  `batchSteps`: „in v4.18.0 fehlte das Feld im Report, mein Fehler" — der
  Vorfall steht an genau der Stelle, die ihn künftig verhindert, nicht in
  einem separaten Log.
- `ea-fc-sbc-optimizer.user.js:1247-1253` — Club-Lade-Takt (300ms zwischen
  den Starts, wächst bei jedem Fehlversuch): „Rate-Limit-401er haben schon
  einmal einen Ladevorgang gekostet, LEARNINGS 7" — Kommentar verweist
  namentlich auf die Lernquelle statt die Begründung stumm vorauszusetzen.
- `docs/LEARNINGS.md:161-168` (§7 „Pool-Verwaltung") — die im Code
  referenzierte Lernquelle selbst: dokumentiert den Live-Ausfall, auf den
  sich der Takt-Kommentar bezieht.
- `CLAUDE.md` (Abschnitt „Nicht anfassen ohne Grund") — führt dieselbe
  Taktbegründung als Repo-weite Warnung fort: „Der Club-Lade-Takt (…):
  120ms provozierte Rate-Limit-401er und war ein Live-Ausfall."

## Beziehungen

- **Bezieht sich auf:** [[diagnose-feld-statt-raten]] — beide Muster
  entstehen aus derselben Arbeitsweise gegen eine fremde Plattform ohne
  Remote-Debugging: erst der Vorfall/Report, dann der Fix, dann der Beleg im
  Code bzw. im Diagnose-Feld, der das nächste Mal verhindert, dass dieselbe
  Ursache erneut geraten werden muss.
- **Bezieht sich auf:** [[abbruch-disziplin]] — wo Abbruch-Disziplin das
  strukturelle Verhalten bei Unstimmigkeiten festlegt (lieber abbrechen als
  falsch abgeben), sichern WARUM-Kommentare mit Live-Belegen die Begründung
  dahinter gegen spätere Refactors ab, die die Regel für überflüssig halten
  könnten.
- **Voraussetzungen:** setzt voraus, dass ein Vorfall überhaupt sichtbar
  gemacht wurde (Diagnose-Report/LEARNINGS-Eintrag) — ohne dokumentierten
  Vorfall gibt es keinen Beleg, der zitiert werden könnte.
