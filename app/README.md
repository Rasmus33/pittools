# PitTools (Android)

WebView-App für die **EA FC Web App** nach PaleBrowser-Vorbild: lädt beim Start
automatisch die neuesten Userscripts und injiziert sie — kein Tampermonkey nötig.

**Enthalten:**
1. **EA FC SBC Rating-Optimizer** — Update-URL konfigurierbar; die App zieht bei
   jedem Start die neueste Version von deiner URL. Fallback: lokaler Cache,
   notfalls die in der APK gebündelte Version.
2. **PaleTools** (Mobile-Build, offiziell von `pale.tools`) — abschaltbar.

## Installation (für den Kollegen)

1. `pittools-v1.2.0.apk` aufs Handy schicken (z.B. WhatsApp/Mail/Drive).
2. Antippen → Installation aus unbekannten Quellen einmalig erlauben.
   (Play Protect ggf. mit „Trotzdem installieren" bestätigen — die App ist
   selbstsigniert.)
3. App öffnen → bei EA einloggen. Fertig. Die App startet im Querformat mit
   Desktop-Ansicht; beide Tools laden automatisch.

## Script-Updates verteilen

Die App lädt den Optimizer bei jedem Start von einer URL:

1. Die aktuelle `ea-fc-sbc-optimizer.user.js` irgendwo öffentlich ablegen —
   eigener Webspace (z.B. `https://…/sbc/ea-fc-sbc-optimizer.user.js`) oder ein
   GitHub-Gist (Raw-URL ohne Commit-Hash nehmen: `https://gist.githubusercontent.com/<user>/<id>/raw/ea-fc-sbc-optimizer.user.js`).
2. In der App unten links auf **⚙** → URL eintragen → „Speichern & neu laden".
   Das macht man pro Gerät genau einmal.
3. Ab dann: neue Script-Version einfach an dieselbe URL hochladen — beide
   Handys ziehen sie beim nächsten App-Start automatisch.

Ist keine URL gesetzt (oder offline), läuft die in der APK gebündelte Version.

## Selbst bauen (ohne Gradle)

Voraussetzungen: JDK 17+, Android SDK mit `build-tools;34.0.0` und
`platforms;android-34` (per `sdkmanager`), Pfad in `$ANDROID_SDK`.

```bash
./build.sh    # erzeugt build/sbc-tools-browser.apk
```

`debug.keystore` (Passwort `android`) liegt bei — **behalten**, sonst müssen
Updates der APK neu installiert statt drüberinstalliert werden.

## Technik-Notizen

- Injection: `evaluateJavascript` in `onPageStarted` (vor dem EA-Bundle, damit
  die fetch/XHR-Interception greift) + Sicherheitsnetz in `onPageFinished`
  mit `window.__inj_*`-Guards gegen Doppel-Ausführung.
- Desktop-User-Agent + WideViewPort, sonst verweigert die EA-Seite mobile Browser.
- Third-Party-Cookies aktiv (EA-SSO-Login).
- Bewusst keine anonymen inneren Klassen im Java-Code: der direkte
  d8-Build (ohne Gradle) stolpert sonst über das InnerClasses-Attribut.
