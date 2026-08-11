# ROADMAP — offen & Ideen

## Offen (konkret)

1. **GitHub-Deployment-Flow etablieren**: Nach jeder Script-Änderung
   `ea-fc-sbc-optimizer.user.js` auf `main` pushen — das IST das Deployment
   (beide Handys ziehen die Raw-URL bei App-Start). In einer lokalen Session
   (VS Code / Claude Code) geht das direkt; in der Cloud-Session musste das
   Repo als Quelle angehängt sein.
2. **APK beim Kollegen testen**: v1.2.0 (PitTools, Hochformat, Pitroipa-Icon)
   ist gebaut, aber der EA-Login im WebView ist erst auf EINEM Gerät
   verifiziert. Mögliche Stolpersteine: SSO-Popups, Captcha.
3. **Count-Parsing verifizieren**: Die "Ohne-Team-Rating ⇒ Vorgabe gilt für
   alle Slots"-Regel deckt die bekannten Fälle ab. Falls eine SBC auftaucht,
   bei der das falsch ist (Min-OVR-Count < Slots ohne Team-Rating), muss die
   echte Count-Quelle im Challenge-Objektbaum gefunden werden
   (Diagnose-Feld einbauen, reqDump erweitern).
4. **F5-Refresh-Restfälle**: Weg 0 (submitViaApp) aktualisiert die Ansicht
   zuverlässig. Falls die Fallback-Wege (http/services) greifen, ist die
   Ansicht evtl. erst nach Reopen aktuell — akzeptiert, aber beobachten
   (`submitVia` im Diagnose-Report zeigt den benutzten Weg).

## Ideen (nicht committed)

- **Desktop-Modus-Schalter in der App** (⚙-Menü): Desktop-UA + Querformat
  für die "große" Web-App-Ansicht, falls die mobile Ansicht irgendwo klemmt.
- **Icon/Branding**: adaptives Icon (Android 13+ themed icons).
- **Mehrere SBCs am Stück**: "Set abarbeiten"-Modus (Optimieren + Eintragen
  über alle offenen Challenges eines Sets). Vorsicht: Submit bleibt bewusst
  manuell.
- **Kosten-Tabelle pro Saison-Phase**: Presets (z.B. "FUTTIES-Phase")
  speicherbar/umschaltbar.
- **iOS**: Userscripts-App/Orion dokumentieren, falls je ein iPhone dazukommt.
- **Auto-Version-Check im Panel**: Script vergleicht seine Version mit der
  Raw-URL und zeigt "Update verfügbar" (in der App unnötig, in Tampermonkey
  nett).

## Bewusst NICHT geplant

- Chemie/Positions-Optimierung — Grundsatzentscheidung, rein Rating-basiert.
- Automatisches Submit der SBC — Rasmus drückt immer selbst.
- Transfermarkt-Funktionen — dafür läuft PaleTools parallel.
