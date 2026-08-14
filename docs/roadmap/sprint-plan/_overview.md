# Sprint-Plan — Iteration 0

## Schnitt-Begründung

1 Shared-Item + 9 Feature-Lifts, Dimension RA. Zwei Features liegen unter dem
Schwellwert (android-app-wrapper 48/56, diagnose-werkzeuge 58/59.5) — sie
tragen die höchsten Gains (+22, +19) und laufen früh.

## Konflikt-Entscheidung (PO, autonom)

`plan validate` meldet Pfad-Konflikte zwischen fast allen Lift-Plänen —
strukturell unvermeidbar: das Produkt ist EINE Userscript-Datei
(`ea-fc-sbc-optimizer.user.js`) plus EINE Test-Suite (`solver-test.js`).
Shared-Item-Extraktion oder Primary-Umverteilung lösen das nicht. Auflösung:

- **Sequenzielle Abarbeitung** — `worker.parallel_tickets: 1` (bereits
  konfiguriert). Jedes Ticket arbeitet auf frischem main, kein paralleles
  Schreiben derselben Datei.
- **`depends_on` für semantische Reihenfolge:** batch-modus → nach
  sbc-vorgaben-erkennung (slots-Fix liegt dort); diagnose-werkzeuge → nach
  dem SI fehler-sichtbarkeit-diagerror (reportError-Kern).
- Der SI liefert den `reportError`-Kern; die Feature-Lifts schließen ihre
  Fehlerpfade diese Iteration additiv (kein Blocker), Umstellung auf den
  Helfer ist Folge-Iteration.

## Reihenfolge (empfohlen für den Worker)

1. `fehler-sichtbarkeit-diagerror` (SI — Kern zuerst, P1)
2. `android-app-wrapper` (P1, unter Schwellwert, unabhängige Dateien app/**)
3. `diagnose-werkzeuge` (P1, unter Schwellwert, depends_on SI)
4. `sbc-vorgaben-erkennung` (slots-Fix — Voraussetzung für Batch-Test)
5. `batch-modus` (depends_on sbc-vorgaben-erkennung)
6. `rating-solver` · 7. `bedienpanel-ui` · 8. `spieler-pool` ·
9. `team-eintragen` · 10. `ea-app-anbindung`

## Leitplanke

Oberste Regel „keine Regression" (CLAUDE.md): jeder Merge nur mit komplett
grünem eisernem Arbeitsablauf; Push auf main = Live-Deployment auf beide
Handys. App-Tickets (android-app-wrapper, Teile von diagnose-werkzeuge)
erzeugen KEIN installierbares APK ohne Rasmus — Code + Tests mergen, Build
macht Rasmus nach dem Aufwachen.
