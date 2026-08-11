# ROADMAP — offen & Ideen

## Offen (konkret)

1. **PaleTools läuft in der App nicht** (live bestätigt: unsere Funktionen ok,
   PaleTools tot). Ursachenanalyse — noch NICHT am Gerät verifiziert:
   - PaleTools 26.0.30 deklariert `@grant GM_xmlhttpRequest`, `GM_download`,
     `unsafeWindow` und nutzt sie im Code. Die App injiziert nackt per
     `evaluateJavascript`, ohne Tampermonkey und ohne `GM_*`-Shim → beim ersten
     Zugriff ReferenceError. Unser Script braucht kein `GM_*`, deshalb läuft es.
   - Der Mobile-Build ist **912 KB**. `evaluateJavascript` schickt den String per
     Binder-IPC an den Renderer; das Transaktionslimit liegt bei ~1 MB
     (geteilter Puffer) → je nach Gerät TransactionTooLargeException oder
     stilles Abschneiden. Unser Script (154 KB) ist unkritisch.
   - **Ein Mirror des Scripts im Repo behebt keinen der beiden Punkte.**
   Lösungsweg: `GM_*`-Shim (`GM_xmlhttpRequest` → `fetch`/`XMLHttpRequest`,
   `unsafeWindow` → `window`, `GM_download` → Blob-Link) vor PaleTools
   injizieren, und das Script nicht als IPC-String übergeben, sondern über ein
   `<script src="blob:…">`- bzw. Local-File-Tag laden. Erst dann ist zu sehen,
   ob weitere Inkompatibilitäten dahinter liegen.
   Der ⚙-Schalter „PaleTools mitladen" ist der saubere Workaround, bis das steht.
2. **APK beim Kollegen testen**: v1.3.0 (PitTools, Hochformat, Pitroipa-Icon,
   GitHub-URL als Default) ist gebaut, aber der EA-Login im WebView ist erst auf
   EINEM Gerät verifiziert. Mögliche Stolpersteine: SSO-Popups, Captcha.
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
