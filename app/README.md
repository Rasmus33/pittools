# PitTools (Android)

WebView-App für die **EA FC Web App** nach PaleBrowser-Vorbild: lädt beim Start
automatisch die neuesten Userscripts und injiziert sie — kein Tampermonkey nötig.

**Enthalten:**
1. **EA FC SBC Rating-Optimizer** — wird bei jedem App-Start von GitHub (`main`)
   geladen, URL im ⚙-Menü änderbar. Fallback: lokaler Cache, notfalls die in der
   APK gebündelte Version.
2. **PaleTools** (Mobile-Build von `pale.tools`) — abschaltbar. Wird ab v1.4.0
   gestückelt injiziert (~910 KB sprengen eine einzelne `evaluateJavascript`-
   Transaktion). Ein Toast beim Start meldet, ob es geladen wurde.

## Installation (für den Kollegen)

1. `pittools-v1.5.1.apk` aufs Handy schicken (z.B. WhatsApp/Mail/Drive).
2. Antippen → Installation aus unbekannten Quellen einmalig erlauben.
   (Play Protect ggf. mit „Trotzdem installieren" bestätigen — die App ist
   selbstsigniert.)
3. App öffnen → bei EA einloggen. Fertig — die App läuft im **Hochformat** mit
   der mobilen EA-Ansicht, der Optimizer lädt automatisch.

## Script-Updates verteilen

Die App zieht den Optimizer bei jedem Start von der Raw-URL des Repos:

```
https://raw.githubusercontent.com/Rasmus33/pittools/main/ea-fc-sbc-optimizer.user.js
```

Das ist seit v1.3.0 der **Default** — nichts einzurichten. Push auf `main` =
Update auf allen Geräten beim nächsten App-Start (Raw-CDN cacht ~5 Min).

Im ⚙-Menü lässt sich eine andere URL setzen (z.B. ein Testbranch). Ein **leeres**
Feld heißt bewusst „nur die in der APK gebündelte Version verwenden".

> Vor v1.3.0 war der Default leer — die App blieb dann dauerhaft auf dem
> gebündelten Asset, solange die URL nicht pro Gerät manuell eingetragen wurde.
> Wer noch v1.2.0 nutzt, trägt die URL einmal im ⚙-Menü ein.

## Selbst bauen (ohne Gradle)

Voraussetzungen: JDK 17+, Android SDK mit `build-tools` und `platforms`
(≥ android-34). SDK-Pfad in `$ANDROID_SDK`, `$ANDROID_HOME` oder
`$ANDROID_SDK_ROOT` — `build.sh` nimmt automatisch die höchste installierte
stabile `build-tools`- und Platform-Version.

```bash
cd app && ./build.sh     # erzeugt build/pittools-v<versionName>.apk
```

Läuft auch unter Windows in Git Bash: die Tool-Endungen (`d8.bat`, `aapt2.exe`)
werden erkannt, und für den `classes.dex`-Schritt springt Python bzw. `jar` ein,
wenn `zip` fehlt.

`app/debug.keystore` (Passwort `android`) liegt **nicht im Repo** — Rasmus hat
die Datei separat und legt sie dort ab. Ohne genau diesen Keystore bricht der
Build bewusst ab (`ALLOW_NEW_KEYSTORE=1` erzwingt einen neuen), denn eine andere
Signatur macht Updates in-place unmöglich.

Nach dem Build gegenprüfen, dass die Signatur zur installierten Version passt:

```bash
apksigner verify --print-certs build/pittools-v1.5.1.apk   # SHA-256: 41f23895…1b17
```

## Logs vom Gerät holen

Am Handy hängt keine Konsole. Die App sammelt deshalb alle Konsolenmeldungen der
Seite (auch die von PaleTools und uncaught errors) in einem Ringpuffer:

⚙ → **Log teilen** (WhatsApp/Mail) oder **Log kopieren**. Der Bericht enthält
App-Version, Gerät, Script-Größen, den PaleTools-Status und die letzten 400
Konsolenzeilen.

Der PaleTools-Status sagt, woran es liegt:

| Status | Bedeutung |
| --- | --- |
| `geladen (N Zeichen)` | Code wurde ausgeführt |
| `… LS-Keys:0 DOM:0` | ausgeführt, aber PaleTools hat sich nicht eingerichtet |
| `… DOM:12 sichtbar:0` | läuft, aber die UI ist unsichtbar (Layout/Ausrichtung) |
| `still fehlgeschlagen` | eine CSP blockt das inline-Script-Tag |
| `NICHT ausgefuehrt, fehlt dauerhaft: …` | 30 min gewartet, Symbol kam nie |
| `keine Rückmeldung` | der Wächter hat nie ausgeführt |

`node app/guard-test.js` prüft diesen Wächter samt Nachkontrolle (18 Tests).

## Technik-Notizen

- Injection: `evaluateJavascript` in `onPageStarted` (vor dem EA-Bundle, damit
  die fetch/XHR-Interception greift) + Sicherheitsnetz in `onPageFinished`
  mit `window.__inj_*`-Guards gegen Doppel-Ausführung.
- Der Optimizer geht direkt als Code rein (klein, muss so früh wie möglich
  laufen). PaleTools wird gestückelt übertragen und dann über ein
  `<script>`-Tag ausgeführt — eine einzelne `evaluateJavascript`-Transaktion
  hält keine ~910 KB (Binder-Limit ~1 MB).
- **PaleTools wird bewusst spät ausgeführt** (`onPageFinished` + Wächter, der
  auf die EA-Klassen wartet): es fasst `UIItemActionEvent` & Co. direkt beim
  Laden an und stirbt sonst mit "is not defined". `node app/guard-test.js`
  prüft diesen Wächter.
- Der ⚙-Knopf ist verschiebbar (ziehen; Tippen öffnet die Einstellungen). Als
  nativer Button liegt er über dem WebView und macht alles im DOM darunter
  untippbar — unten links war er eine Totzone.
- **Kein Desktop-UA, keine Querformat-Sperre.** Die EA-Seite erkennt Handys und
  liefert ihre mobile Hochformat-Ansicht; erzwungenes Querformat führte zum
  festhängenden „Rotate device"-Screen (LEARNINGS §8). Die App nimmt die
  Geräte-UA und entfernt nur die WebView-Marker (`; wv`, `Version/4.0`).
- Third-Party-Cookies aktiv (EA-SSO-Login).
- Bewusst keine anonymen inneren Klassen im Java-Code: der direkte
  d8-Build (ohne Gradle) stolpert sonst über das InnerClasses-Attribut.
- `res/` wird per `aapt2 compile --dir res` gebaut und mit `-R` gelinkt — ohne
  das findet `aapt2` das im Manifest referenzierte `@mipmap/ic_launcher` nicht.
- `reportNetError` (Fehler, `[net]`-Präfix) und `reportNetNote` (Nicht-Fehler
  wie 304/Cache-aktuell, `[net-ok]`-Präfix) sind die einzigen zwei
  Log-Choke-Points für Netz-/Cache-Vorgänge — getrennte Präfixe halten echte
  Fehler von erwarteten Zuständen im App-Log auseinander.
- `scriptSbc`/`scriptPale`/`paleSource` laufen ausschließlich über
  `setLoadedScripts(sbc, pale, source)` — analog zu den Zustands-Settern
  `setScriptsReady`/`setPaleStatus`/`setPaleInjected`, loggt nur bei
  tatsächlicher Änderung.
- `SbcWebViewClient` loggt Main-Frame-Ladefehler (`onReceivedError`/
  `onReceivedHttpError`) mit `[webview]`-Präfix — die einzige Fremd-Grenze
  der App (DNS/TLS/Serverfehler beim initialen Laden von `WEB_APP_URL`), die
  sonst nur die eigene WebView-Fehlerseite zeigt, ohne dass Log-Ringpuffer
  oder Script-Report davon etwas sehen. Subressourcen-Fehler laufen über die
  Konsole und damit `SbcChromeClient.onConsoleMessage`.
- `fetchUrl`/`fetchUrlIfChanged` prüfen den gelesenen Body auf `isEmpty()`,
  nicht auf `null` — `readStream` liefert laut Signatur nie `null`, nur `""`.
