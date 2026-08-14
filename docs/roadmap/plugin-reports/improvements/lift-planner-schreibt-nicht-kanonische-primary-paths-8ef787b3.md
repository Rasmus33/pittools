---
kind: improvement
severity: info
title: lift-planner schreibt nicht-kanonische primary_paths
location: cli.commands.verify.cmd_plan_validate
cli: plan validate
first_seen: '2026-08-14T22:14:50Z'
last_seen: '2026-08-14T22:14:50Z'
occurrences: 1
plugin_version: 2.6.0
hash: 8ef787b3
---

# 💡 Improvement — lift-planner schreibt nicht-kanonische primary_paths

**Ort:** `cli.commands.verify.cmd_plan_validate`
**CLI:** `plan validate`

## Beobachtung

`plan validate` musste `primary_paths` gegen die Repo-Präfixe normalisieren, bevor der Konflikt-Check korrekt greifen konnte. Betroffene Beispiele:

- `pittools/ea-fc-sbc-optimizer.user.js → ea-fc-sbc-optimizer.user.js (bedienpanel-ui)`
- `pittools/solver-test.js → solver-test.js (bedienpanel-ui)`
- `pittools/docs/LEARNINGS.md → docs/LEARNINGS.md (bedienpanel-ui)`
- `pittools/ea-fc-sbc-optimizer.user.js → ea-fc-sbc-optimizer.user.js (ea-app-anbindung)`
- `pittools/solver-test.js → solver-test.js (ea-app-anbindung)`

## Was das Plugin getan hat

Pfade wurden deterministisch gegen Repo-Short-Name/`path` normalisiert (v1.0.13) — der Konflikt-Check lief korrekt, kein Stop.

## Vorschlag

lift-planner-Briefing schärfen, sodass `primary_paths` strikt repo-relativ ohne Repo-Präfix geschrieben werden (`references/briefings/lift-planner.md`).

---

_Auto-generiert vom roadmap-manager (Plugin-Self-Observation, ab v1.2.0). Funktioniert, aber Reibung erkannt — Kandidat für eine Plugin-Verbesserung. Nicht-blockierend._