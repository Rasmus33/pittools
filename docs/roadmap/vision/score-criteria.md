# Score-Kriterien

Pro Dimension: was misst sie, wie wird sie berechnet, was bedeuten die Stufen.

## RA — Robust Architecture

**Adapter:** manual_rubric

**Berechnung:** Semantische Bewertung (0–100) durch den `audit-evaluator`-Subagent
pro Feature — Code-Read + Architektur-Analyse entlang dieser Rubric:

- **Fehlertoleranz gegen EA-Wandel:** Wie gut übersteht das Feature EAs
  undokumentierte Änderungen (Response-Strukturen, Controller-Namen, DOM-Klassen)?
  Generische Erkennung + Fallback-Wege zählen positiv, hartkodierte Einzelpfade negativ.
- **Beobachtbarkeit:** Hat jedes bekannte Fehlerbild ein Diagnose-Feld im Report
  bzw. eine Log-Zeile? (Debugging-Konvention: erst messbar machen, dann fixen.)
- **Abbruch-Disziplin:** Bricht der Code bei Unstimmigkeit sauber und erklärend ab,
  statt weiterzuklicken/weiterzuschreiben? („2 von 5 fertig" schlägt eine falsch
  abgegebene SBC.)
- **Testbarkeit:** Ist die Logik deterministisch prüfbar (solver-test.js /
  guard-test.js), sind Erwartungswerte verifiziert statt geraten?
- **Dokumentierte Begründung:** Steht das WARUM fragiler Stellen in LEARNINGS.md
  („Nicht anfassen ohne Grund"-Kandidaten markiert)?

**Strukturelles Maximum pro Feature:** im jeweiligen `vision/features/<slug>.md → structural_max.RA`.

**Schwellwert:** `structural_max × 0.7` (threshold_factor 0.7, kein threshold_min_abs).

**Stufen:**
- `pass`    → capped_value ≥ Schwellwert
- `partial` → capped_value ≥ 50 % des structural_max, < Schwellwert
- `fail`    → darunter

**Edge Cases / Was NICHT gemessen wird:** Chemie/Positionen/SBC-Belohnungslogik sind
bewusst ignoriert (Produktregel) und zählen nicht als Lücke. EA-seitige Ausfälle
(Rate-Limits, Server-Fehler) mindern den Score nicht, solange das Feature sie erkennt
und sauber meldet. Die Bewertung misst Robustheit der Struktur, nicht Feature-Umfang.
