# ROADMAP — offen & Ideen

## Offen (konkret)

1. **PaleTools in der App zum Laufen bringen** — Rasmus braucht es parallel.
   Stand: App v1.4.0 injiziert es gestückelt (16 Chunks à 60k, IPC-Limit war
   der wahrscheinliche Grund, warum es gar nicht lief). Am Gerät zu prüfen:
   der Toast beim Start sagt „PaleTools: geladen (N Zeichen)" oder nennt den
   Fehler; „still fehlgeschlagen" heißt CSP blockt das inline-Script.
   Was danach noch fehlen kann: **`window.invokePaletoolsAction`** — die Bridge
   für Cross-Origin-Requests, die PaleBrowser bereitstellt (LEARNINGS §8). Ohne
   sie greifen nur die externen Preisabfragen (futbin/futwiz/fut.gg) nicht, das
   übrige PaleTools sollte laufen. Nachbauen wäre: ein `@JavascriptInterface`,
   das die Requests nativ ausführt und das Ergebnis zurückgibt — erst angehen,
   wenn wirklich diese Features fehlen.
   Ein GM_-Shim ist NICHT nötig (PaleTools hat Fallbacks, LEARNINGS §8).
2. **APK beim Kollegen testen**: v1.3.0 (PitTools, Hochformat, Pitroipa-Icon,
   GitHub-URL als Default) ist gebaut, aber der EA-Login im WebView ist erst auf
   EINEM Gerät verifiziert. Mögliche Stolpersteine: SSO-Popups, Captcha.
3. ~~⚙-Knopf der App beweglich machen~~ — erledigt in App v1.4.0 (ziehen
   verschiebt, Position in SharedPreferences; Tippen öffnet wie bisher die
   Einstellungen). Am Gerät noch gegenzuprüfen.
4. **SBC-Button verifizieren** (v4.8.0): Erscheint „PitTools" in der
   SBC-Aktionsleiste neben „Use Squad Builder"/„Clear Squad", und reagiert er?
   Im Diagnose-Report zeigt `launcher.containerVisible`, ob
   `.sbc-button-container` in dieser FC-Version existiert; wenn nicht, steht in
   `launcher.visibleButtons` der echte Container (alle sichtbaren Buttons mit
   Text, Klasse und Parent-Klasse) — daraus ist der Selektor direkt ablesbar.
   `launcher.launcherClicks` trennt „Tap kommt nicht an" (0) von „Panel zeigt
   sich nicht" (>0). Der fliegende Kreis bleibt unabhängig davon der
   verlässliche Weg.
5. **Count-Parsing verifizieren**: Die "Ohne-Team-Rating ⇒ Vorgabe gilt für
   alle Slots"-Regel deckt die bekannten Fälle ab. Falls eine SBC auftaucht,
   bei der das falsch ist (Min-OVR-Count < Slots ohne Team-Rating), muss die
   echte Count-Quelle im Challenge-Objektbaum gefunden werden
   (Diagnose-Feld einbauen, reqDump erweitern).
6. **F5-Refresh-Restfälle**: Weg 0 (submitViaApp) aktualisiert die Ansicht
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
