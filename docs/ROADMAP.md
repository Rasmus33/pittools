# ROADMAP — offen & Ideen

## Offen (konkret)

0. ~~Batch-Abgabe~~ — **erledigt**, live bestaetigt in v4.12.0
   (`lastSubmitVia: controller`, `grantedSetAwards` in der Antwort).
   Der Weg dahin, als Referenz: 1. Versuch (v4.11.1) lief auf HTTP 403,
   nichts abgegeben (Abbruch bei 0/3, Sicherheitsnetz hat gehalten).
   Zwei Erkenntnisse aus dem Report:
   - `submitChallengeArity: 0` — der Service erwartet **kein** Argument, wir
     übergaben die Challenge.
   - `controllerScan` zeigt, dass `UTSBCSquadSplitViewController` selbst
     `submitChallenge`/`_submitChallenge`/`_onChallengeSubmitted` hat. Das ist
     der Weg, den die App beim Klick auf ihren Submit-Button nimmt — analog zum
     Eintragen (§5) geht der Aufruf jetzt über den Controller, Service ohne
     Argument nur als Fallback.
   - Neu vorab: `_squad.isSBCSquadEligible()` — bricht ab, BEVOR EA mit 403
     antwortet, und nennt den Grund.
   Offen: War der 403 der falsche Aufruf, oder war die SBC wirklich nicht
   erfüllt? Der Report zeigte `sbc.reqDump` mit `scope: "PLAYER"` und
   `"CLUB MEMBER"` — Vorgaben, die der Solver bewusst nicht abdeckt. Nächster
   Test: nach dem Eintragen Diagnose schicken und `batch.squadEligible`
   ansehen; ist das `false`, fehlt eine Vorgabe (dann ist der Batch für
   SOLCHE SBCs grundsätzlich nicht geeignet, nicht der Aufruf schuld).

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
1b. ~~Batch: mehrere SBCs automatisch abgeben~~ — **ausgebaut in v4.17.0**.
   Abgeben und Dialog-Wegraeumen funktionierten; gescheitert ist das Zurueckkommen
   in die naechste Runde. Grund (jetzt bekannt): jede Wiederholung einer SBC hat
   eine EIGENE `challengeId` — `loadChallenge(alteId)` laedt die verbrauchte
   Instanz, und ein Weg, eine Challenge programmatisch zu OEFFNEN, wurde nicht
   gefunden. Details in LEARNINGS §9.
   Wieder aufgreifen nur mit: `requestChallengesForSet(setId)` fuer die neue
   Instanz + geklaerter Frage, was `#repeat-sbc` ("Repeat Search") tut.
   `planBatch()` + 8 Testfaelle bleiben im Code.

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
- **Set abarbeiten**: über alle offenen Challenges eines SETS (der Batch aus
  v4.11.0 macht dieselbe Challenge mehrfach, nicht verschiedene).
- **Kosten-Tabelle pro Saison-Phase**: Presets (z.B. "FUTTIES-Phase")
  speicherbar/umschaltbar.
- **iOS**: Userscripts-App/Orion dokumentieren, falls je ein iPhone dazukommt.
- **Auto-Version-Check im Panel**: Script vergleicht seine Version mit der
  Raw-URL und zeigt "Update verfügbar" (in der App unnötig, in Tampermonkey
  nett).

## Bewusst NICHT geplant

- Chemie/Positions-Optimierung — Grundsatzentscheidung, rein Rating-basiert.
- Automatisches Submit bei EINZEL-SBCs — da drückt Rasmus selbst.
  (Der Batch-Modus darf abgeben, siehe CLAUDE.md — nach Vorschau und einer
  ausdrücklichen Freigabe.)
- Transfermarkt-Funktionen — dafür läuft PaleTools parallel.
