# LEARNINGS — Probleme & Lösungen (chronologisch destilliert)

Alles hier ist live gegen die EA FC 26 Web App verifiziert (Stand: Aug 2026,
Script v4.5.2). Wer am Code arbeitet, liest das VORHER.

## 1. Die echte Squad-Rating-Formel

EA rechnet NICHT den gerundeten Durchschnitt:

```
avg    = summe / N
excess = Σ (rating_i − avg)  für alle Spieler ÜBER dem Durchschnitt
rating = floor( round(summe + excess) / N )
```

Verifiziert gegen Rasmus' Beispiele (9×84+2×83=84; 2×85+3×84+6×83=84) und
PaleTools' Dezimalanzeige. Ganzzahliges Maß im Solver:
`V = N·sum + Σ max(0, N·r − sum) = N² · exaktes_Rating`. Machbarkeit:
`V ≥ NEED = N²·T − floor(N/2)`. Der Solver (band-zerlegter Bounded-Knapsack-
DP über Booster ≥ floor(st/N)+1 und Füller) minimiert V, im Fenster
`windowV = maxOvershoot·N²` entscheiden die Kartenkosten.
Kostenmodell: `alpha/anzahl(rating) + bandkosten(rating)`; Storage:
`(basis/2 − beta)`; Rarity-Schutz (+8 für Gruppe-83) NACH dem Storage-Rabatt.
**Der Aufschlag allein reicht NICHT** (live, v4.8.0: 90er-Team mit zwei FUTTIES
statt einer): die Storage-Ersparnis ist `basis/2 + beta` und wächst mit der
Basis — ab Bandkosten 12 (Rating 93+) ist sie *immer* größer als 8, eine
Storage-FUTTIES also billiger als das gleichwertige Vereins-Gold. Am Aufschlag
zu drehen verschiebt die Grenze nur. Ab v4.9.0 ist der Schutz deshalb eine
**harte Sperre**: über die von der SBC geforderte Anzahl hinaus kommen
geschützte Karten gar nicht in die Suche (`solve()` läuft strikt, und nur wenn
das unlösbar ist, ein zweites Mal ohne Sperre + Warnung — dasselbe Muster wie
bei „max. teure Spieler"). Getestet inkl. Gegenprobe: mit ausgehebelter Sperre
zeigt der Testfall `protected=2` und wird rot.
WICHTIG (war ein Bug): innerhalb eines Ratings konsumiert der DP in
KOSTEN-Reihenfolge (costOf zuerst, Storage/Stapel nur als Tiebreak).

## 2. Karten-Klassifikation (rareflag & Co.)

- `rareflag 0/1` = normale Karte ("Gold"), `≥2` = Special, `3` = TOTW.
  (Anfangs falsch herum interpretiert → Pool bestand nur aus 58 Karten.)
- `groups`-Array am Item = Rarity-Gruppen. Gruppe **83** = TOTW/TOTS/FOF/
  FUTTIES — exakt das, was `PLAYER_RARITY_GROUP`-Vorgaben verlangen.
  Matching NUR über `p.groups.includes(groupId)`, nie über Heuristiken.
- Evolutions: tragen rareflag wie normale Karten! Erkennung über
  `academyAttributes`, `academyId`, `tradableBeforeAcademy !== undefined` u.a.
- Leihspieler: `loans > 0`. Konzept-Spieler: `concept/isConcept`-Flags —
  beide nie in den Pool.
- Duplikate desselben Spielers haben verschiedene Item-IDs, aber dieselbe
  `assetId`.
- **PaleTools-Sperren (Schloss auf der Karte)** sollen respektiert werden — wer
  sperrt, will behalten. PaleTools hat dafür `lockPlayers` und warnt selbst bei
  SBCs (`plugins.lockPlayers.messages.sbcWarning`), setzt am DOM
  `dataset.locked` + Klasse `locked`. Der localStorage-KEY ist im Bundle nur
  dynamisch zusammengesetzt (`'paletools:' + …`) und nicht ablesbar; deshalb
  wird formatunabhängig gesucht: alle Keys mit „paletools", darin jeder Zweig
  mit „lock" im Namen, und daraus alles, was wie eine Item-ID aussieht
  (12-stellig). IDs können Array-Werte ODER Objekt-Keys sein — beides wird
  abgedeckt. `locks.keys` im Diagnose-Report zeigt die gefundenen Keys, falls
  `found: 0` bleibt.

## 3. API-Zugriff

- Basis: `https://utas.mob.v5.prd.futc-ext.gcp.ea.com:443/ut/game/fc26/`.
  Auth über abgefangene Header (X-UT-SID, X-UT-PHISHING-TOKEN, X-UT-Route,
  Easw-Session-Data-Nucleus-Id) aus fetch/XHR-Interception ab document-start.
- Eigene Requests mit `credentials:'omit'` — mit 'include' blockt CORS.
- Club laden: `club?...count=91&start=N` paginiert. Unassigned:
  `purchased/items`. Storage: `storagepile`. SBC: `sbs/sets`,
  `sbs/setId/{id}/challenges`, GET/PUT `sbs/challenge/{id}/squad`.
- PUT-Body: IMMER alle Slots (23), `{index, itemData:{id, dream:false}}`,
  leere Slots id 0. (Format live vom App-PUT abgeschnitten.)

## 4. 401er — zwei völlig verschiedene Ursachen

1. **Session abgelaufen** → `nudgeSession()`: einen App-eigenen Request
   anstoßen (wechselnde Endpunkte: Unassigned → Tradepile → Watchlist, weil
   Unassigned aus dem App-Cache kommen kann!), dann AKTIV warten bis die
   Interception eine NEUE SID sieht (bis 8s; fixer Sleep war zu kurz).
2. **Rate-Limit** (zu schnelle Club-Pagination) → Session ist noch gültig,
   Nudge ändert nichts. Lösung: 250ms zwischen Seiten (120ms = Abbruch bei
   Seite ~55, live passiert), beim Retry 3s-Cooldown statt zweitem Nudge.
- Keep-Alive: alle 240s ein leichter App-Request.

## 5. Eintragen + F5-freie Ansicht (der härteste Brocken)

Falsche Wege (alle probiert, alle gescheitert):
selbstgebaute Items via `Object.assign(new UTItemEntity(), raw)` crashen die
View ("Cannot read isDream of undefined"); `_generateSquadOverview()` &
Co. zeichnen nicht neu; `origLoadChallenge` lädt aus dem App-Cache, nicht
vom Server.

**Der funktionierende Weg (PaleTools-Rezept, submitViaApp):**
```js
const factory = new UTItemEntityFactory();
const entities = players.map(p => factory.createItem(p.raw)); // ECHTE Entities
liveSquad.setPlayers(arr, true);          // arr = Array über ALLE Slots
await services.SBC.saveChallenge(liveChallenge);
```
`liveSquad`/`liveChallenge` kommen aus dem LIVE-Controller
(`UTSBCSquadSplitViewController`, via getAppMain()-Kette; Challenge hängt am
`_overviewController._challenge`). saveChallenge macht den PUT UND
aktualisiert die Ansicht selbst. Fallback: eigener HTTP-PUT + GET-Verify
(Erfolg misst sich am GET, NICHT am PUT-Status — EA liefert teils 400/460
trotz Erfolg).

**HTTP-460-Ursachen (alle live gehabt):**
1. Zwei Karten desselben Spielers (assetId) im Team → Dedupe im Solver:
   pro assetId genau EINE Karte (Präferenz: manuelle Wahl > erfüllt
   Rarity-Vorgabe > Storage > höchstes Rating).
2. Brick-Slots: manche SBCs sperren Slots. `playerRequirements` in der
   GET-squad-Antwort sagt exakt, welche Indizes nutzbar sind — NUR dort
   eintragen, Teamgröße = nutzbare Slots.
3. Veralteter Pool (Karte nicht mehr im Besitz) → "Spieler laden" verwirft
   jetzt den alten Bestand komplett (der Merge behielt früher Karteileichen).

## 6. SBC-Erkennung

- Primär: Hook auf `services.SBC.loadChallenge` + Netzwerk-Scan. ABER: die
  App bedient Reopenings aus dem Cache und Submit-/Reward-Antworten
  verschmutzen den Zustand (live nach Pack-Öffnen). Deshalb wird bei jedem
  Optimieren mit der OFFEN SICHTBAREN Challenge synchronisiert
  (`syncSbcWithOpenChallenge` → Live-Controller → `captureChallengeEntity`).
- Challenge-Wechsel setzt ALLE Vorgaben zurück (`setCurrentChallenge`).
- Vorgaben-Typen: TEAM_RATING (Ziel-OVR), PLAYER_RARITY_GROUP (Gruppen-ID
  in `value`!), PLAYER_OVERALL_RATING_MIN (Spieler-Level),
  PLAYER_QUALITY (1=Bronze ≤64, 2=Silber 65-74, 3=Gold ≥75 — als
  Band-Filter für das ganze Team).
- **Gold-SBCs ohne Ziel-OVR: Rare ist knapp, Common nicht.** Solche SBCs
  verlangen oft „Rare: Min. N Players". Regel (Rasmus): dann GENAU N Rare, Rest
  Common — und ohne Rare-Vorgabe gar keine Rare, weil die für die Rating-SBCs
  gebraucht wird. Dazu zwei Obergrenzen im Panel (Default Rare bis 77, Common
  bis 99): eine 85er Rare aus dem Storage soll hier nicht verheizt werden.
  Technisch ist „rare" der `rareflag`: **0 = Common, 1 = Rare**, ab 2 Special —
  passt zum Pool-Histogramm (rund 4200 Common gegen 2500 Rare). `isRare`/
  `isCommon` liegen deshalb am normalisierten Spieler.
  ACHTUNG beim Testen: `P()` in solver-test.js muss diese beiden Felder
  mitsetzen, sonst greifen die Filter nicht und der Test prüft nichts (genau das
  ist passiert — 5 Fälle waren rot, obwohl der Solver stimmte).
- **`PLAYER_LEVEL` ist doppelt belegt** — der WERT entscheidet: `1..3` ist die
  QUALITÄTSSTUFE (Bronze/Silber/Gold), ab `40` ein Mindest-Rating. Live an einer
  „genau 1 Bronze-Spieler"-SBC verifiziert: `reqDump` lieferte
  `PLAYER_LEVEL value 1`, und weil der Parser nur `v >= 40` als Level und nur
  `QUALITY` im Namen als Qualität akzeptierte, wurde die Vorgabe komplett
  ignoriert (beide Constraint-Listen leer).
- Bei **Bronze/Silber** wird das Min-Rating komplett ignoriert (Rasmus): mit
  Min-Rating 75 wäre so eine SBC nie lösbar, und der Wert ist dort
  bedeutungslos. Bei Gold bleibt es als Untergrenze wirksam.
  Ausserdem werden dort nur NORMALE Karten genommen (rareflag 0/1, rare oder
  non-rare egal) — ein bronzenes Special ist wertvoller als sein Rating, zählt
  für die Vorgabe aber gleich. Gibt es zu wenige, wird mit Warnung gelockert.
- **Bei Bronze/Silber entscheidet das RATING, nicht die Kosten.** Der
  Scarcity-Term (`alpha/anzahl`) machte einen häufigen 58er billiger als den
  einzelnen 48er — gewählt wurde 58 statt des niedrigsten. Im Füll-Pfad ohne
  Ziel-OVR wird deshalb bei Bronze/Silber zuerst nach Rating aufsteigend
  sortiert.
- EAs Count-Feld ("Min. 4") ist im Objektbaum unzuverlässig zu finden
  (liegt am Eltern-Objekt der KV-Paare, parst oft als 1). Robuste Regel:
  **ohne Team-Rating gilt eine Min-OVR-Vorgabe für ALLE Slots** (bei
  Tausch-/Provisions-SBCs ist die Slot-Zahl die geforderte Spieleranzahl).

## 7. Pool-Verwaltung

- Auto-Load einmalig beim Start, sobald Session steht. 250ms/Seite (§4!).
- Nach Eintragen: verbaute IDs aus dem Pool entfernen. Wird eine SBC doch
  nicht abgegeben, fehlen die Karten im Pool → einmal "Spieler laden".
- "Spieler laden" = Voll-Refresh (alter Bestand wird verworfen, Backup bei
  Fehlschlag). Unvollständiger Load setzt `loadIncomplete` → Warnung beim
  Optimieren.

## 8. Android-App (app/)

- WebView-Wrapper nach PaleBrowser-Vorbild. Lädt beide Scripts pro App-Start
  von URLs (8s Timeout) → Cache → gebündeltes Asset. Injection via
  `evaluateJavascript` in `onPageStarted` (vor dem EA-Bundle!) mit
  `window.__inj_*`-Guards; Sicherheitsnetz in `onPageFinished`.
- **Kein Desktop-UA, keine Querformat-Sperre!** Die EA-Seite erkennt Handys
  und will ihre mobile Hochformat-Ansicht — erzwungenes Querformat führte
  zum festhängenden "Rotate device"-Screen. Lösung: Geräte-UA ohne
  WebView-Marker ("; wv", "Version/4.0"), Orientierung frei. PaleTools hat
  dafür einen eigenen Mobile-Build:
  `https://pale.tools/fifa/dist/latest/paletools-mobile.user.js`.
- Build OHNE Gradle (javac → d8 → aapt2 → zipalign → apksigner). Achtung:
  d8 crasht auf anonymen inneren Klassen (NPE im InnerClasses-Attribut) —
  deshalb NUR benannte Top-Level-Klassen in MainActivity.java.
- Drittanbieter-Cookies aktiv (EA-SSO). Icon: Jonathan Pitroipa (fotmob
  38216), Kreis mit Türkis-Ring, generiert in build-Zeit via PIL.
- **PaleTools braucht KEINEN GM_-Shim** — das war eine Fehlannahme. Der
  Mobile-Build deklariert zwar `@grant GM_xmlhttpRequest/GM_download/
  unsafeWindow`, hat aber im Code für beide Fälle Fallbacks:
  `typeof unsafeWindow != 'undefined' ? unsafeWindow : window` und
  `GM_xmlhttpRequest` → **`window.invokePaletoolsAction`** → eigenes `fetch`.
  `invokePaletoolsAction` ist die Bridge, die PaleBrowser (deren eigene native
  App) für Cross-Origin-Requests bereitstellt — die fehlt bei uns. Betroffen
  sind damit nur die externen Preisabfragen (futbin/futwiz/fut.gg), nicht das
  Laden von PaleTools selbst.
- **Ohne Logs vom Gerät ist PaleTools-Debugging Raten** — am Handy hängt keine
  DevTools-Konsole, und die App-Toasts reichten nicht (der Download-Toast
  "Optimizer OK / PaleTools OK" hat sogar in die Irre geführt: er sagt nur,
  dass die DATEIEN geholt wurden, nicht dass PaleTools läuft — deshalb heißt er
  jetzt "Scripts geladen"). Ab v1.5.0 sammelt `SbcChromeClient.onConsoleMessage`
  alle Konsolenmeldungen der Seite (inkl. PaleTools und uncaught errors) in
  einem Ringpuffer, teilbar über ⚙ → "Log teilen".
- **Die entscheidende Frage ist "läuft nicht" vs. "läuft, aber unsichtbar".**
  Marker, an denen sich ein laufendes PaleTools erkennen lässt:
  `localStorage`-Keys mit Prefix `paletools` (u.a. `paletools:settings`,
  `paletools:storage:version`) und DOM-Elemente mit `paletools-*`-Klassen.
  Der Wächter hängt das ~6s nach dem Ausführen an den Status an
  (`LS-Keys:… DOM:… sichtbar:… tabbar:… orient:…`). `DOM>0` bei `sichtbar:0`
  heißt: PaleTools läuft, aber seine UI hängt am Layout — plausibel, denn seine
  Mobile-CSS-Regeln sind `.landscape`-lastig und wir laufen im Hochformat.
- **PaleTools darf NICHT früh injiziert werden** (das war der eigentliche
  Grund, live bestätigt): es referenziert EA-Symbole direkt beim Laden auf
  Top-Level — `UIItemActionEvent`, `UTStandardButtonControl` (65×),
  `UTSBCSquadDetailPanelView` (38×) und viele weitere. In `onPageStarted`
  injiziert stirbt es sofort mit `UIItemActionEvent is not defined`, und zwar
  komplett. Als Tampermonkey-Script läuft es bei `document-idle`, also lange
  nach unserem Script — das muss die App nachbilden.
  Ab v1.4.1: Übertragung in `onPageFinished` und ein Wächter im JS, der auf die
  EA-Symbole wartet, bevor er ausführt.
- **Die EA-Klassen kommen erst nach dem Login — und das dauert Minuten.** Im
  Live-Log (v1.5.0, Pixel 8 Pro) stand `geladen (…, EA-Klassen fehlten)`, und
  die Reihenfolge zeigte es klar: PaleTools lief los, bevor die App bereit war;
  SBC-Erkennung und Pool-Load kamen erst danach. Die Web App lädt ihr
  Haupt-Bundle offenbar erst nach dem Login.
  **Ein Timeout, der dann „trotzdem ausführt", ist deshalb schädlich** — er
  verbrennt den einzigen Versuch zum schlechtesten Zeitpunkt (v1.4.1/v1.5.0).
  Ab v1.5.1: 30 Minuten Geduld, und wenn es dann nicht geht, wird NICHT
  ausgeführt und der Puffer behalten. Nur wenn ausschließlich
  `UIItemActionEvent` fehlt (unsicherer Marker — existiert vielleicht gar
  nicht), wird nach 2 Minuten gestartet und das im Status vermerkt.
  Der Wächter meldet in `__pt_wait` laufend, WELCHES Symbol fehlt; die App
  schreibt das jede Minute ins Log.
  **Genau umgekehrt zu unserem Script**, das so früh wie möglich laufen MUSS
  (fetch/XHR-Interception vor dem EA-Bundle) — die beiden Scripts haben
  entgegengesetzte Anforderungen, deshalb zwei getrennte Wege.
- **Große Scripts müssen gestückelt injiziert werden** (ab App v1.4.0):
  PaleTools ist ~910 KB, und `evaluateJavascript` schiebt den String per
  Binder-IPC zum Renderer — Transaktionslimit ~1 MB (geteilter Puffer), also
  je nach Gerät abgeschnitten oder Exception. Lösung: in Häppchen von 60k
  Rohzeichen als JS-String-Literale übertragen, im Seitenkontext zusammensetzen
  und ausführen. Beim Escaping alles außerhalb ASCII-druckbar als u-Escape
  schreiben — das Ergebnis ist reines ASCII und damit frei von
  Encoding-Fragen zwischen Java, Binder und JS. Verifiziert: 16 Chunks,
  größter escapeter Chunk 64 KB, Roundtrip byte-identisch zum Original.
- Ausgeführt wird über ein `<script>`-Tag mit `textContent` (echter globaler
  Scope, wie ein normales Userscript — PaleTools legt Globals an). **Wenn eine
  CSP inline Scripts blockt, passiert das STILL**, ohne Exception — deshalb
  hängt am Code ein Sentinel (`__pt_ran`), und nur wenn der fehlt, wird
  `new Function` als Fallback versucht. Das Ergebnis kommt als Toast zurück,
  weil am Gerät keine Konsole hängt.
- **Achtung javac-Falle:** u-Escape-Sequenzen werden auch in KOMMENTAREN
  ausgewertet — `\uXXXX` als Platzhalter in einem Kommentar ist ein
  Compile-Fehler ("invalid unicode"). Deshalb im Code nur umschrieben.
- **Der Update-Default war ein stiller Deployment-Killer** (bis v1.2.0): die
  Optimizer-URL hatte den Default `""`, und `""` heißt "gebündeltes Asset
  verwenden". Ohne manuellen Eintrag pro Gerät zog die App also NIE von GitHub —
  "Push auf main = Deployment" galt nur auf Papier. Ab v1.3.0 ist
  `DEFAULT_SBC_URL` die Raw-URL; leer bleibt als bewusster Offline-Modus.
- PaleTools kann so nicht laufen: es verlangt `GM_*`/`unsafeWindow` (die nackte
  `evaluateJavascript`-Injection liefert die nicht) und ist mit 912 KB am
  Binder-IPC-Limit (~1 MB). Details + Lösungsweg in ROADMAP §1.
- `build.sh` hatte vier Fallen, alle beim ersten Build auf einem anderen Rechner
  aufgeschlagen (der v1.2.0-Build lief im Cloud-Container):
  1. build-tools/Platform waren auf `34.0.0`/`android-34` hart kodiert → jetzt
     automatisch die höchste installierte STABILE Version (rc/beta wird
     übersprungen).
  2. Tool-Namen: unter Windows `d8.bat`, `aapt2.exe`, `apksigner.bat` → werden
     jetzt mit Endungs-Fallback aufgelöst.
  3. `zip` fehlt in Git Bash → Python- bzw. `jar`-Fallback für classes.dex.
     Vorsicht: `python3` ist unter Windows oft nur ein Store-Stub, der nichts
     ausführt — jeden Kandidaten testen (`python -c "import zipfile"`).
  4. Der `cp` des Scripts ins Asset zeigte auf einen Pfad, den es hier nicht
     gibt (`../sbc-optimizer/…`), und `|| true` schluckte den Fehler → das
     gebündelte Fallback-Asset wäre unbemerkt veraltet. Jetzt harter Fehler.
  Außerdem fehlte der `res`-Schritt (`aapt2 compile --dir res` + `link -R`) —
  ohne ihn findet aapt2 das `@mipmap/ic_launcher` aus dem Manifest nicht.
- Signatur-Check nach jedem Build: `apksigner verify --print-certs` muss
  SHA-256 `41f23895…1b17` zeigen (= `app/debug.keystore`, Alias `sbctools`).
  Weicht es ab, lässt sich die APK nicht über die installierte Version
  installieren. `build.sh` erzeugt deshalb NIE still einen neuen Keystore,
  sondern bricht ab (`ALLOW_NEW_KEYSTORE=1` erzwingt).

## 9. SBC abgeben + warum der Batch ausgebaut wurde

**Jede Wiederholung einer SBC hat eine EIGENE challengeId.** Das ist die
Erkenntnis, die alles erklaert. Live gesehen an derselben wiederholbaren SBC:
erst 3829, dann 3800, dann 3771. Folgen:
- Wer in eine verbrauchte Instanz schreibt, bekommt **HTTP 404** von
  `saveChallenge` bzw. **475** vom PUT. Das trifft auch den normalen
  Einzel-Betrieb, wenn man dieselbe SBC mehrmals hintereinander macht: die
  Ansicht/der App-Cache steht noch auf der alten Instanz. Seit v4.17.0 gibt es
  dafuer eine verstaendliche Meldung ("SBC-Instanz veraltet - im Spiel schliessen
  und neu oeffnen") statt eines nackten Status.
- Eine ID-Gleichheitspruefung ist als Sicherheitsnetz beim Fortsetzen deshalb
  FALSCH: die ID darf sich zwischen zwei Runden legitim aendern. Ueber das Set
  (`setId`) waere der richtige Anker, plus `requestChallengesForSet(setId)`, um
  die aktuelle Instanz zu finden.

**Abgeben selbst funktioniert** (live bestaetigt): ueber die Methode des
Live-Controllers, NICHT ueber `services.SBC.submitChallenge(challenge)` -
letzteres kam mit 403 zurueck, und der Report zeigte auch warum
(`submitChallengeArity: 0`, die Methode nimmt kein Argument, und
`UTSBCSquadSplitViewController` hat selbst `submitChallenge`). Dasselbe Muster
wie beim Eintragen (Paragraph 5): erst Controller, dann Service.
`gPopupClickShield.closeActivePopup()` raeumt den Belohnungs-Dialog weg - das ist
EAs eigener Popup-Manager, PaleTools nutzt ihn fuer sein Plugin
"claim-sbc-rewards".

**Woran der Batch gescheitert ist:** nach dem Abgeben ist der
SBC-Squad-Controller weg (`batchSteps` zeigte `controller: null`,
`challengeBack: false` in jeder Runde; die Controller-Kette endete teils auf
`UTSBCHubViewController`). `services.SBC.loadChallenge(id)` laedt nur Daten und
wechselt die Ansicht nicht - und mit der ALTEN ID ohnehin die falsche Instanz.
Ein Weg, eine Challenge programmatisch zu OEFFNEN, wurde nicht gefunden;
`UTGameFlowNavigationController` hat `pushViewController`, aber dafuer muesste
man einen korrekt initialisierten Controller bauen.
**Die Loesung, Teil 1 (v4.18.0):** nach dem Abgeben nicht die alte ID
weiterbenutzen, sondern `requestChallengesForSet(setId)` aufrufen und die
FRISCHE Instanz laden. Anker fuer "ist das noch dieselbe SBC?" sind Set +
Vorgaben (Ziel-OVR/Slots), NICHT die challengeId.

**Die Loesung, Teil 2 (v4.19.0):** das reichte nicht -
`services.SBC.loadChallenge(id)` laedt nur DATEN und wechselt die Ansicht
nicht. Nach dem Abgeben steht die App im SBC-Hub (dreimal belegt:
`UTSBCHubViewController`, `containerCount: 0`, kein Squad-Controller). Es gibt
keinen gefundenen Weg, eine Challenge programmatisch zu OEFFNEN. Also wird der
Weg gegangen, den man von Hand geht - per DOM-Klick auf EAs eigene Elemente:
```
.ut-sbc-set-tile-view              Set-Kachel im Hub  (Auswahl per Set-NAME)
.ut-sbc-challenge-table-row-view   Challenge-Zeile in der Set-Ansicht
```
Beide Klassennamen sind aus PaleTools' Bundle verifiziert, ebenso
`.ut-sbc-hub-view`, `.ut-sbc-challenges-view--challenges`,
`.ut-sbc-challenge-details-view`. Den Set-NAMEN liefert `ctrl._set.name`
(UTSBCSetEntity) und wird beim Planen mitgespeichert.
**LAEUFT (v4.19.1 live bestaetigt), und wo die Zeit hinging (v4.20.0):**
Der Log der ersten erfolgreichen Runde zeigte `detailsView: 1` bei `rowView: 0` -
**nach dem Klick auf die Set-Kachel ist die Challenge direkt offen**, eine
Challenge-Zeile gibt es nur, wenn das Set mehrere hat. Verschenkt waren damit:
4s Vorlauf, bevor ueberhaupt geklickt wurde, 4 Anlaeufe a 1,2s fuer die
nicht existierende Zeile und 1,2s fuer einen DOM-Abzug. Ausserdem lieferte
`requestChallengesForSet` `freshId: null` und ist ueberfluessig - die frische
Instanz kommt durch den Kachel-Klick.
Jetzt: Pruefschleife alle 300ms, Set-Klick sofort, Zeilen-Klick nur als
Sonderfall (i=10/25). Aus ~13s pro Runde werden ~2-4s.

**Zwei weitere Fallen beim Kachel-Klick (v4.23.0, live):** Bronze lief 5 Runden
durch, Silber brach in Runde 1 ab. Unterschied im Log: `detailsView: 1` (Bronze,
Challenge direkt offen) gegen `detailsView: 0` (Silber, nichts geöffnet) — bei
dreimal gemeldetem „Set-Kachel geklickt".
- **Der Hub-FILTER versteckt Kacheln.** Er stand auf „Favourites", und die
  gesuchte SBC war dort nicht dabei — ihre Kachel ist dann gar nicht im DOM.
  Fix: bei Misserfolg `.ea-filter-bar-item-view` mit Text „All" klicken und
  erneut suchen.
- **Teilstring-Matching trifft die falsche SBC.** „Upgrade" steckt in jeder
  zweiten Kachel; der Klick meldete Erfolg auf einer fremden Kachel. Fix:
  Reihenfolge exakter Titel → Titel-Anfang → Teilstring, und der Vergleich läuft
  über `.tileTitle`/`.tileHeader` statt über den ganzen Kachel-Text (der enthält
  auch Beschreibung und Belohnungen). Ausserdem wird nach der Kachel noch ihr
  Titel-Element geklickt — manche Views hängen den Tap-Handler am Kind.
Beides protokolliert jetzt mit, WAS gesucht und WAS getroffen wurde
(`want`, `hitTitle`, `titles`), damit ein Fehlgriff sofort sichtbar ist.

**Zwei Fallen dabei (v4.19.1, live aus `batchSteps`):**
- `requestChallengesForSet` erwartet das **SET-OBJEKT**, nicht die `setId`.
  Mit einer Zahl stirbt es an `i.getChallenges is not a function`. Das Set-Entity
  liegt am Controller (`ctrl._set`, UTSBCSetEntity) und wird beim Planen
  mitgespeichert.
- **`element.click()` reicht bei EA-Views NICHT.** Der Set-Kachel-Klick meldete
  Erfolg, die Ansicht reagierte aber nicht. EA-Views haengen an ihrem eigenen
  Event-System (PaleTools registriert dort per `addTarget(…, EventType.TAP)`),
  das auf die Pointer-/Maus-Kette hoert. Es braucht die ganze Sequenz:
  `pointerdown` -> `pointerup` -> `mousedown` -> `mouseup` -> `click`, alle mit
  `bubbles: true`.

Ein Klick auf eine Kachel ist harmlos - sie oeffnet nur eine Ansicht. Das ist
der Unterschied zu einem geratenen Klick in einem Belohnungs-Dialog, wo
"Quick Sell" danebenliegt; solche Klicks bleiben tabu.

**Die App kann nach dem Abgeben auch im SQUAD-VIEW haengen bleiben (v4.36.0,
live: TOTW-Batch nach 4/5 gestoppt).** Bisher galt: nach dem Abgeben steht die
App im Hub. Beim 4. von 5 TOTW-Upgrades blieb sie stattdessen 18s im
`UTSBCSquadSplitViewController` mit dem VOLLEN (gerade abgegebenen) Squad -
erkennbar daran, dass der fehlgeschlagene `batchSteps`-Eintrag NUR den
Endzustand enthielt: alle Klick- UND Log-Zweige von `openNextInstance` liefen
nur unter `!ctrl` (= "wir sind im Hub"). Drei Folgen und ihre Fixes:
- Nichts geloggt, nichts unternommen -> neuer `stuck`-Step (Controller,
  challengeId, ob die Instanz schon in `usedChallengeIds` steht, `matches`,
  `empty`) bei i=2/20/45.
- Kein Weg zurueck -> `clickBackButton()`: der Zurueck-Pfeil der Kopfleiste
  (`.ut-navigation-button-control`) wird bei i=5/25 geklickt, danach greift
  der bekannte Kachel-Weg. Harmlos, weil das Team bereits abgegeben ist;
  geklickt wird nie, solange ein Overlay offen ist. Landet der Klick in der
  Challenge-Liste statt im Hub, darf `clickChallengeRow` jetzt auch ohne
  vorherigen Kachel-Klick ran (`wentBack`).
- `setLooksRepeatable` liest Kachel-Status - aus dem Squad-View gibt es keine
  Kacheln, also kam `{repeatable: null, status: ""}` statt einer moeglichen
  Erschoepfungs-Meldung. Nach dem Back-Klick ist der Status wieder lesbar.
Offen blieb, ob Abgabe 4 von EA wirklich bestaetigt wurde:
`ctrl.submitChallenge()` ohne auswertbare Response galt still als Erfolg.
Der Report unterscheidet das jetzt (`submitChallengeVia: "... (ohne Response)"`).

Noch ungeklaert, waere die naechste Option: der Button `#repeat-sbc`
("Repeat Search") in `.sbc-button-container` - PaleTools' repeatSbc oder EAs
Suche-wiederholen? Bewusst nicht geraten.

**Beim Ausbauen kaputtgemacht (v4.17.0, Lehre fuer sich):** mein Skript hat mit
dem Batch-HTML auch den Diagnose-Button und ein schliessendes `</div>` aus dem
Panel gerissen. `ui.diagBtn` war dann null, und
`ui.diagBtn.addEventListener(...)` brach den GANZEN Panel-Aufbau ab - das
Script hatte keine Oberflaeche mehr, und `node --check` sah nichts davon.
solver-test.js prueft seit v4.18.0 statisch, dass jede
`panel.querySelector('#…')`-Referenz ein Element im HTML hat und jeder
Listener an einem gesetzten ui-Feld haengt.

- `_squad.isSBCSquadEligible()` sagt VOR dem Abgeben, ob EA die SBC fuer
  erfuellt haelt - spart einen 403-Blindflug. Nur bei explizit `false`
  abbrechen, damit ein unerwarteter Rueckgabewert nicht alles blockiert.
- **Ein halbautomatischer Batch ist wertlos.** Rasmus' Einwand: "Weiter druecken
  ist ja quasi so als wenn ich einfach selbst noch mal auf Optimieren druecke".
  Wenn pro Runde Handgriffe noetig sind, spart der Batch nichts - er MUSS
  durchlaufen, sonst ist das Feature seinen Aufwand nicht wert.
- **Spielernamen stehen NICHT in den Items.** `rawKeys` im Diagnose-Report
  zeigt nur `assetId`, `rating`, `groups` & Co. - deshalb erschien in der
  Vorschau immer `#assetId`. Namen loest die App ueber ihre eigenen
  Item-Entities auf (`UTItemEntityFactory` -> `getStaticData()`/`_staticData`
  -> `commonName`/`firstName`+`lastName`). Nur zur ANZEIGEZEIT aufloesen und
  cachen: fuer 8000 Pool-Karten waere das viel zu teuer, fuer die 11-55
  angezeigten ist es unkritisch.
- **Shadowing-Falle:** `const log = []` im Batch-Lauf ueberdeckte die Funktion
  `log()` - der Lauf starb mit "log is not a function", und zwar erst NACH der
  ersten abgegebenen SBC. Weder JS noch `node --check` melden das. solver-test.js
  prueft jetzt statisch, dass keine Variable die Helfer (log/warn/toast/
  setStatus/escapeHtml/diagError) ueberdeckt.

## 10. UI-Einstiegspunkte (Panel öffnen)

- **Die globale Navigationsleiste (`.ut-tab-bar`) ist ein Irrweg** — zweimal
  live gescheitert (v4.6.0, v4.7.0) und inzwischen ausgebaut. Gründe: im
  mobilen Hochformat ist die Leiste voll, unser zusätzliches Item bricht per
  flex-wrap in eine zweite Zeile darunter (linke untere Ecke = ⚙-Totzone), und
  der Eintrag reagierte auf keinen Tap. Bezeichnend: PaleTools' eigene
  CSS-Regeln für diesen Weg sind alle mit `.landscape` präfixiert — er ist
  fürs Querformat gedacht, und wir laufen bewusst im Hochformat (§8).
  Fachlich außerdem falsch platziert: die globale Leiste gilt überall, unser
  Werkzeug gehört in die SBC.
- **Der richtige Ort ist die SBC-Aktionsleiste `.sbc-button-container`** (ab
  v4.8.0) — dort, wo EA "Use Squad Builder" / "Clear Squad" / "Exchange"
  zeigt. Als EA-Klasse aus PaleTools' CSS verifiziert (`.sbc-button-container
  button#btn-squad-builder { order: 1 }`); die IDs `btn-squad-builder` /
  `btn-clear-squad` setzt PaleTools dagegen SELBST, auf die darf man sich
  ohne laufendes PaleTools nicht verlassen.
  Trick fürs Aussehen: die `className` eines echten Nachbar-Buttons im
  Container kopieren, statt EA-Button-Klassen zu erraten — überlebt
  EA-Updates.
- **Der ⚙-Knopf der Android-App ist ein NATIVER Button über dem WebView**
  (`Gravity.BOTTOM|START`, 110×110). Was im DOM darunter liegt, ist nicht
  antippbar — der Menüpunkt war sichtbar, reagierte aber auf keinen Tap. Bei
  DOM-Elementen in der unteren linken Ecke immer mitdenken.
- **Kein Listener am eingehängten Button selbst.** Die EA-App baut ihre Leisten
  neu und kopiert dabei Knoten; ein Klon verliert den Listener (Button da,
  Klick tot). Klicks laufen deshalb delegiert über `document` in der
  Capture-Phase — das hält auch EAs eigene Handler davon weg. Auf `click`
  UND `touchend` hören (die mobile Ansicht verarbeitet Touches teils selbst,
  dann entsteht gar kein `click`), aber mit Entprellung: feuern beide, toggelt
  das Panel doppelt — auf und sofort wieder zu, was **genau wie "es passiert
  nichts" aussieht**. Derselbe Grund, warum man nie Delegation UND einen
  Element-Listener gleichzeitig registriert.
- Es gibt je nach Ausrichtung MEHRERE Container derselben Klasse im DOM, einer
  davon unsichtbar — den sichtbaren über `offsetParent`/`getClientRects` wählen.
- Der runde FAB ist der **verlässliche Weg** und bleibt sichtbar, auch wenn der
  SBC-Button steht (zwei eingehängte Buttons waren live tot — dieses Vertrauen
  muss sich erst wieder verdienen). Ab v4.7.0 erscheinen beide Einstiege NUR im
  SBC-Bereich (Controller-Kette auf `/sbc/i`), weil der Knopf sonst überall im
  Weg ist. Liefert die Kette nichts, wird der Einstieg bewusst NICHT versteckt
  — lieber ein Knopf zu viel als eine unbenutzbare App.
- **Der FAB-Tap hängt an `pointerup`, nicht an `click`.** Sobald ein Element
  ziehbar ist, ruft `pointerdown` ein `preventDefault()` (gegen Scrollen/
  Textselektion) — das kann auf Touch-Geräten die Kompatibilitäts-Mausevents
  und damit den Klick unterdrücken. Tap = pointerup ohne Zug (6px-Schwelle).
- `launcher.launcherClicks` im Diagnose-Report unterscheidet die zwei
  "es passiert nichts"-Fälle: 0 = der Tap kommt nicht an; >0 = der Tap kam an,
  dann liegt es am Panel (z.B. gemerkte Position außerhalb des Bildschirms —
  `ensurePanelOnScreen()` fängt das seit v4.8.0 beim Öffnen ab).
- **Ziehen muss auf Pointer-Events laufen.** Die erste Panel-Drag-Implementierung
  hörte nur auf `mousedown`/`mousemove` und war am Handy — dem einzigen Gerät,
  auf dem gearbeitet wird — komplett unbenutzbar. Dazu gehört zwingend
  `touch-action: none` im CSS (sonst scrollt Android die Seite statt zu ziehen)
  und `setPointerCapture`. Klick und Zug per Schwelle (6px) trennen, sonst
  öffnet sich das Panel bei jedem Verschieben.
- Gemerkte Positionen nach `resize` neu einklemmen: nach Drehen des Handys
  liegt eine gespeicherte Position sonst außerhalb des Bildschirms.

## 11. Test-Harness

`solver-test.js` lädt den Solver-Block per `new Function` aus dem Userscript
(Marker `// [SOLVER-BEGIN]` / `// [SOLVER-END]`).
Brute-Force-Referenz (`bruteBest`) rechnet das V-Ziel über alle Teilmengen —
Pflicht bei jeder Objective-Änderung. Der Karten-Kosten-Spiegel
(`cardCostFn`) MUSS synchron zum Solver gehalten werden (inkl. Rarity-Schutz
und Untradeable-Rabatt) — sonst vergleichen die Brute-Force-Tests gegen ein
anderes Kostenmodell als der Solver benutzt.
Kein `Math.random` ohne Seed (mulberry32 vorhanden).


## 11. Vorgaben-Parsing: Substring-Matches auf Scope-Namen sind gefährlich

**v4.24.0, live:** Für „Rare: Min. 6 Players" suchte der Parser
`scope.indexOf('RARE') > -1`. Der Report zeigte daraufhin fünf Phantom-Vorgaben:

```
rareConstraints: [ "CARRARESE CALCIO", "BRIAN FERRARES",
                   "RAREȘ ILIE", "RAREȘ GAL", "RAREȘ POP" ]
```

Das sind **Spielernamen und ein Verein** — im `reqDump` stehen Vorgaben wie
„dieser Spieler" oder „dieser Verein" mit dem Namen als Scope. „Ca**rrarese**",
„Fer**rares**", „**Rareș**" enthalten alle die Buchstabenfolge RARE.

**Regel:** Scope-Namen nur **exakt** oder gegen eine Whitelist prüfen, niemals
per `indexOf` auf ein kurzes, in Namen häufiges Wort. Ein Test hält den
Substring-Match jetzt draußen.

**Die echte Vorgabe** stand daneben und war schon korrekt geparst:

```
reqDump: [ {scope:"PLAYER_COUNT", value:6},
           {scope:"PLAYER_RARITY_GROUP", value:4},
           {scope:"PLAYER_QUALITY", value:3} ]
```

**Gruppe 4 = „Rare"** (analog Gruppe 83 = TOTW/TOTS/FOF/FUTTIES). Zwei
Konsequenzen:

1. `count` war 1 bei 6 Slots — EAs Count-Feld ist unzuverlässig (§6). Ohne
   Team-Rating gilt eine Gruppe-4-Vorgabe deshalb für ALLE Slots. Bewusst NUR
   für Gruppe 4: bei 83 will Rasmus genau die geforderte Anzahl, eine Anhebung
   wäre dort teuer falsch (ein Test hält das fest).
2. „Rare" ist eine Karten-EIGENSCHAFT, kein Event. Ob EA die 4 überhaupt in
   `p.groups` mitschickt, ist unbekannt — `matchesRarity` prüft für Gruppe 4
   deshalb zusätzlich `rareflag === 1`. Damit greift es in beiden Fällen.

## 12. PaleTools-Locks stehen unter kurzen IDs (assetId/resourceId)

Die Lock-Erkennung fand den richtigen localStorage-Key
(`paletools:2026:<userId>:lockedItems`), meldete aber `found: 0`. Inhalt:

```
[100664921, 190871, 225733, 231747, 50332136, 83923656, ...]
```

Das sind **keine 12-stelligen Item-IDs** (`916543482768`), sondern kürzere
Zahlen — PaleTools sperrt über assetId/resourceId, also den **Spieler**, nicht
die einzelne Karte. Die Plausibilitätsprüfung `n > 1e11` hat deshalb jeden
Eintrag verworfen: Key gefunden, Werte alle weggefiltert, stiller Ausfall.

Schwelle jetzt `>= 1000`; der Abgleich läuft gegen `id`, `assetId` und
`resourceId`. Vier Tests prüfen das mit den echten Zahlen aus dem Report.

**Muster:** eine Plausibilitätsprüfung, die zu streng ist, sieht genauso aus wie
„Feature nicht vorhanden". Deshalb liefert das Diagnose-Feld `locks` neben
`found` auch `keysScanned`, `keys` und `sample` — daran war in einem Blick zu
sehen, dass die Daten da waren und nur meine Prüfung sie wegwarf.

## 13. Warnungen deduplizieren

Die gelockerte Rare-Grenze wurde einmal pro Slot gemeldet — sechs identische
Zeilen im Panel, in denen die eine wichtige Meldung unterging. `warnings.push`
ist jetzt gegen Dubletten gesichert (Wrapper direkt an der Array-Erzeugung).


## 14. Vorgaben gelten für JEDEN Spieler — auch für reservierte Karten

**v4.25.0, live:** „Rare: Min. 6 Players" + „Player Quality: Exactly Gold"
ergab sechs **Bronze**-Rare (54-62). Grund: das Qualitäts-Fenster steckte nur
im Auffüll-Pool (`pool = poolAll.filter(qLo..qHi)`), die Vorgaben-Reservierung
lief weiter auf dem ungefilterten `poolAll`.

Die Reservierung prüft jetzt `inQualityBand(p)` — inklusive „bei Bronze/Silber
keine Specials, auch nicht als Vorgabe-Karte".

**Dabei wichtig:** die Panel-Grenze „Rare bis 77" ist eine PRÄFERENZ und darf
fallen; das Qualitäts-Fenster ist eine SBC-VORGABE und bleibt stehen. Ein
eigener Test hält das fest (nur Bronze-Rare und 85er Gold-Rare im Pool →
Grenze lockern, nicht die Qualität brechen).

**Muster:** jeder neue Filter muss an ALLEN Stellen greifen, an denen Karten ins
Team kommen — Auffüllen, Rarity-Reservierung, Anker, Rarity-Pick. Der
Locked-Cards-Filter sitzt aus genau diesem Grund vor allem anderen (`poolAll`
wird gefiltert, nicht `pool`).

## 15. Ohne Ziel-Rating gilt IMMER: niedrigstes Rating zuerst

**v4.25.0, live:** eine SBC ohne Rating-Vorgabe bekam sieben Vereins-**77er**,
obwohl 75er im Verein lagen. Der Auffüll-Sort ging nach Kosten — und 75, 76, 77
liegen in der Kostentabelle alle in derselben Stufe („0-80: 0"). Also entschied
der Rest der Formel, und dort gewinnt über den Scarcity-Term `alpha/anzahl` die
**häufigere** Karte. Von 77ern hat Rasmus viele.

Das ist DERSELBE Fehler wie bei Bronze (58 statt 48, §Bronze/Silber) — dort war
er nur für `qualityLow` gefixt. Die Regel ist allgemeiner: **ohne Ziel-Rating
ist die niedrigste Karte immer die richtige**, Kosten nur als
Gleichstand-Entscheid (dort steckt Storage-Vorrang und Untradeable-Rabatt).
Gilt jetzt für den ganzen `!target`-Zweig.

**Merksatz:** wo kein Rating gefordert ist, ist ein höheres Rating reine
Verschwendung — Kosten dürfen darüber nicht entscheiden, weil die Kostentabelle
im unteren Bereich flach ist.


## 16. Reservierungen liefen auf dem NICHT deduplizierten Pool (HTTP 460)

**v4.26.0, live:** der PUT hatte dieselbe Karte auf zwei Slots und liess einen
Slot leer -> HTTP 460, danach 400 auf allen Fallback-Wegen.

Die assetId-Deduplizierung (Abschnitt 6) lief auf `pool`. Die
Vorgaben-Reservierungen greifen aber bewusst auf `poolAll` zu -- dort stehen
auch Vereins-TOTW und Karten unter dem Min-Rating, die fuer eine Vorgabe
erlaubt sind. `poolAll` ist NICHT dedupliziert, also konnten eine Vorgabe-Karte
und eine Auffuell-Karte derselbe Spieler sein.

Drei Aenderungen:

1. Alle Reservierungen laufen jetzt ueber `reserve(p)` / `freeCard(p)`, die
   `used` (Karten-ID) UND `usedAssets` (Spieler) zusammen nachfuehren. Das ist
   die eigentliche Absicherung -- mit der Gegenprobe belegt: ohne `freeCard`
   reserviert der Solver denselben Spieler zweimal.
2. `poolAll` wird zusaetzlich dedupliziert, wobei die Karten aus `pool` Vorrang
   haben (sonst zeigen die beiden Pools auf verschiedene Karten desselben
   Spielers).
3. **Endkontrolle in `finishTeam`:** doppelte Karten-ID, doppelte assetId, Karte
   ohne ID oder falsche Teamgroesse fuehren zu `ok: false` mit klarer Meldung --
   nichts wird eingetragen. Der Diagnose-Report hat dafuer das neue Feld
   `lastTeam` (id/assetId/rating/storage pro Karte).

**Muster:** wenn zwei Pools nebeneinander existieren (einer streng gefiltert,
einer bewusst weiter), muss JEDE Invariante an beiden haengen -- oder besser an
der Stelle, an der Karten ins Team wandern. Ein Guard am Ende ist billig und
verhindert, dass so etwas ueberhaupt an den Server geht.

## 17. Storage vor Rating (Rasmus, live nachgeschaerft)

Nach dem Fix aus Abschnitt 15 nahm der Solver konsequent die niedrigsten Karten
-- und damit Vereins-75er statt der 77er aus dem Storage. Rasmus: *"wenn es 77er
im storage gibt sollten die vor 75ern aus dem verein bevorzugt werden."*

Die Rangfolge ohne Ziel-Rating ist also:

1. **Storage vor Verein** (Storage ist Verbrauchsmaterial)
2. dann das **niedrigste Rating**
3. dann die **Kosten** (dort steckt der Untradeable-Rabatt)

Der Storage-Rabatt im Kostenmodell reicht dafuer NICHT, weil die Kosten erst an
dritter Stelle greifen -- Storage muss ein eigener, erster Sortier-Schluessel
sein. Gilt fuer das Auffuellen und fuer die Rare-Reservierung.


## 18. Gemischte Qualitaets-Vorgaben (Bronze + Silber in einer SBC)

**Live-Fall:** "Daily Common Gold Upgrade", setId 1037 / challenge 3070 —
*Bronze: Min. 5 Players*, *Silber: Min. 5 Players*, *Squad: 10*.

So kommt es an:

```
qualityConstraints: [ {PLAYER_LEVEL, quality:1, count:1},
                      {PLAYER_LEVEL, quality:2, count:1} ]
reqDump:            [ {PLAYER_COUNT, value:5}, {PLAYER_LEVEL, value:1},
                      {PLAYER_LEVEL, value:2} ]
slots: 10
```

Drei Dinge daran:

1. Die Stufen kommen als **PLAYER_LEVEL mit Wert 1/2**, nicht als
   PLAYER_QUALITY. Der Parser deckt beides schon ab (PLAYER_LEVEL ist
   doppeldeutig: 1-3 = Stufe, >= 40 = Min-Rating).
2. `count` ist wieder **1 statt 5** — EAs Count-Feld ist unbrauchbar (§6).
3. `PLAYER_COUNT: 5` ist hier **nicht** die Squad-Groesse (die ist 10), sondern
   die Anzahl pro Vorgabe: 2 Stufen x 5 = 10. Bei der 6er-Rare-SBC fielen beide
   zusammen (PLAYER_COUNT 6, Squad 6), deshalb war das vorher nicht zu sehen.

**Der Fehler vorher:** `Math.max` ueber alle Stufen gewann, also Silber, und der
GANZE Pool wurde auf 65-74 gefiltert. Ergebnis: 10x Silber, 0 Bronze — und ein
`ok`. Die Gegenprobe liefert genau das (`65,65,71,71,...`).

**Die Loesung:** Quoten pro Stufe statt eines Bandes.

- Ein Praedikat `inQBand` statt eines Bereichs `qLo..qHi` — bei Bronze + Gold
  ist das erlaubte Fenster nicht durchgehend (Silber muss aussen bleiben).
- Anzahl pro Stufe: die genannten Zahlen sind das MINIMUM, die restlichen Slots
  werden gleichmaessig verteilt, der Rest geht an die niedrigste (billigste)
  Stufe. Das trifft den Live-Fall (1/1 auf 10 Slots -> 5 Bronze + 5 Silber) und
  ist bei "Min. N"-Vorgaben unschaedlich — Mehrliefern erfuellt sie auch.
  Die Verteilung steht als Warnung im Panel, damit ein Fehlgriff sichtbar ist.
- Reservierung pro Stufe in derselben Rangfolge wie ueberall ohne Ziel-Rating:
  Storage vor Verein, dann niedrigstes Rating, dann Kosten (§17).
- Min-Rating wird ignoriert, sobald eine Bronze-/Silber-Stufe dabei ist, und
  Specials bleiben draussen — beides wie bei einer einzelnen Bronze-Vorgabe.
- Ist eine Stufe nicht erfuellbar, gibt es einen **Abbruch mit Grund** statt
  eines Teams, das nur die andere Stufe erfuellt.

**Wichtig:** eine EINZELNE Stufe darf sich nicht wie gemischt verhalten —
"Exactly Gold" ist der haeufige Fall und muss weiter alle Slots binden. Dafuer
gibt es einen eigenen Regressionstest.


## 19. Am Handy heisst der SBC-Controller anders (Batch-Abbruch bei 0/7)

**v4.27.0, live am Handy:** `Batch gestoppt nach 0/7: Abgeben fehlgeschlagen
(Controller hat kein submitChallenge() | Service: Cannot read properties of
undefined (reading squad))`. Dieselbe SBC lief vorher.

Der `controllerScan` zeigt den Unterschied:

| | oberster Controller | hat |
|---|---|---|
| PC (1920x911) | `UTSBCSquadSplitViewController` | `submitChallenge` + `_submitChallenge` |
| Handy (448x997) | `UTSBCSquadOverviewViewController` | NUR `_submitChallenge` |

Am Handy fehlt der Split-View komplett (`.sbc-button-container` ist gar nicht
da, `containerCount: 0`) - die schmale Ansicht hat eine eigene Hierarchie. Der
Code schaute aber nur auf EINEN gefundenen Controller und nur auf den
oeffentlichen Methodennamen.

Jetzt werden ALLE Controller im Stack abgesucht, jeder auf `submitChallenge`
UND `_submitChallenge`, dazu die Split-View-Unter-Controller
(`leftController`/`rightController`/`_overviewController`/
`_challengeDetailsController`). Reihenfolge: die oeffentliche Methode zuerst -
sie macht den regulaeren Weg inklusive Ansicht-Update.

Der Service-Fallback wird zusaetzlich MIT der Challenge-Entity probiert
(`ctrl._challenge`): ohne Argument ist der dokumentierte Weg (arity 0), aber am
Handy zieht der Service die Challenge aus einem Zustand, der in dieser Ansicht
nicht gesetzt ist.

Neue Diagnose-Felder: `submitCandidates` (welche Controller/Methoden kamen in
Frage) und `submitChallengeVia` (welche hat gegriffen).

**Muster:** EA-Klassennamen sind layout-abhaengig. Jede Annahme der Form "der
Controller heisst X und hat Methode Y" muss am HANDY geprueft werden, nicht nur
am PC - das ist Rasmus' Hauptgeraet.


## 20. PaleTools blockierte den Start (Cache war nur Notfall-Fallback)

Rasmus: *"gibt es eine moeglichkeit das letzte paletools script zu cachen damit
es nicht immer eine minute dauert, bis paletools am handy aktiv ist?"*

Ein Cache war schon da - aber in der falschen Reihenfolge benutzt:

```java
pale = fetchUrl(paleUrl);              // ~900 KB, bei JEDEM Start
if (pale != null) writeCache("pale.js", pale);
else pale = readCache("pale.js");      // nur wenn der Download SCHEITERT
...
runOnUiThread(new StartWebApp(...));   // erst JETZT laedt die EA-Seite
```

Der Cache griff also nur bei Netzfehler, und die WebView startete erst nach dem
Download. Die 900 KB lagen komplett im kritischen Pfad, VOR dem Laden der
EA-Seite.

**Jetzt cache-first (stale-while-revalidate):** liegt eine Kopie im Cache, wird
die sofort benutzt; die Auffrischung laeuft NACH dem Start im
Hintergrund-Thread und wirkt beim naechsten Mal. Mit
If-None-Match/If-Modified-Since ist das meist ein 304 ohne Body.

**Der Optimizer bleibt bewusst Download-zuerst.** "Push auf main =
Deployment", und Rasmus prueft die Version im Panel-Header - eine Version
hinterherzulaufen waere hier ein echter Nachteil. Er ist mit ~260 KB auch
deutlich kleiner. Die Asymmetrie ist Absicht, nicht Inkonsequenz.

Der Log-Kopf zeigt jetzt `PaleTools-Quelle: Cache|Download|keine` - damit ist
eine lange Startzeit sofort erklaerbar.

**Was das NICHT beschleunigt:** das Warten auf die EA-Klassen (der Waechter aus
Abschnitt 8) und die gestueckelte Injection der 900 KB. Der Anteil, der wegfaellt,
ist der Download vor dem Seitenaufbau.


## 21. Am Handy braucht ein Tap TOUCH-Events (Batch-Navigation)

**v4.29.0, live am Handy:** das Abgeben lief endlich (`submitChallengeVia:
ctrl._submitChallenge`, siehe Abschnitt 19), aber Runde 2 kam nicht auf:

```
batchSteps: round 1
  ms 1475  setTile ok  "Set-Kachel geklickt (exakt)"  hitTitle: daily silver upgrade
  ms 3501  chRow  FAIL "keine Challenge-Zeilen sichtbar"  rowView 0, detailsView 0
  ms 6539  setTile ok  (nochmal)
  ms 12792 setTile ok  (nochmal)
hubScan.inHub: true   controllerNames: [..., UTSBCHubViewController]
```

Die Kachel wurde gefunden und "geklickt" - und die App blieb im Hub. Drei
Fehler in `clickLike` auf einmal:

1. **Keine Touch-Events.** Die schmale EA-Ansicht haengt ihre Tap-Handler an
   `touchstart`/`touchend`. Am PC (Maus) genuegten pointer+mouse, deshalb fiel
   das dort nie auf. Das ist dieselbe Fehlerklasse wie damals bei
   `element.click()` - nur eine Schicht tiefer.
2. **Keine Koordinaten.** Die Events gingen mit `clientX/clientY = 0` raus,
   also aus der linken oberen Ecke. Wer per Hit-Test prueft, verwirft das.
3. **Kein `scrollIntoView`.** Im Live-Report war "Daily Silver Upgrade" die
   achte Kachel von vielen, bei ~320-400 px Hoehe pro Kachel also weit
   unterhalb des 997 px hohen Viewports. Ein Tap ausserhalb des Bildes ist
   keiner.

Der Tap schickt jetzt: `scrollIntoView` -> Mittelpunkt der Kachel berechnen ->
`touchstart`/`touchend` mit echten `Touch`-Objekten -> und **nur wenn kein
Touch-Handler `preventDefault` gerufen hat** zusaetzlich pointer+mouse. Genau
so verhaelt sich ein echter Browser; ohne diese Bedingung kaeme die Navigation
womoeglich zweimal.

Neues Diagnose-Feld `lastTap` (`events`, `touchHandled`, `x`/`y`,
`inViewport`), und der `setTile`-Schritt in `batchSteps` fuehrt es mit.

**Muster:** Rasmus' Hauptgeraet ist das Handy. Jede Interaktion, die am PC
funktioniert, muss dort eigens geprueft werden - Controller-Namen (Abschnitt 19)
UND Event-Typen.

## 22. Die 2-Minuten-Nachfrist des PaleTools-Waechters war verschenkte Zeit

Nach dem Cache-Fix (Abschnitt 20) dauerte der Start weiter lang. Der Log zeigte,
warum:

```
PaleTools-Quelle: Cache
PaleTools wartet: t=5   fehlt: UIItemActionEvent
PaleTools wartet: t=243 fehlt: UIItemActionEvent
PaleTools-Status: geladen (910647 Zeichen, ohne UIItemActionEvent)
```

`t` zaehlt 250ms-Ticks, die SOFT-Schwelle stand bei 480 - **zwei Minuten**. Und
zwar jedes Mal: `UIItemActionEvent` ist das EINZIGE fehlende Symbol
(services/getAppMain/UTStandardButtonControl/body sind bei t=5 schon da) und es
erscheint in FC26 offenbar nie. Zwei Live-Logs (App 1.5.0 und 1.6.0) zeigen
dasselbe Bild, und PaleTools laeuft ohne das Symbol.

Jetzt: Nachfrist 40 Ticks (10s) statt 480. Und die App **merkt** sich pro Geraet,
dass es ohne das Symbol geklappt hat - dann wird gar nicht mehr gewartet. Der
Beleg dafuer ist die Nachkontrolle (`LS-Keys >= 1`, PaleTools hat seine
localStorage-Keys geschrieben); ohne diesen Beleg wird nichts gemerkt, sonst
wuerde ein kaputter Zustand festgeschrieben.

Die 30-Minuten-Geduld fuer die ECHTEN Blocker bleibt unveraendert - der
EA-Login kann dauern, und vorzeitig auszufuehren war schon einmal ein Ausfall
(Abschnitt 8).

Nebenbefund aus demselben Log: `PaleTools-Cache erneuert (910627 Zeichen)`,
obwohl die Datei unveraendert war - der erste Download-Weg merkte sich ETag und
Last-Modified nicht, also war die erste Auffrischung ein voller GET. Laeuft
jetzt auch ueber `fetchUrlIfChanged`.

**Zur Log-Lesehilfe:** `Optimizer: 259968 Zeichen` sind **Java-Zeichen
(UTF-16)**, nicht Bytes. Die Datei hat 260424 Bytes - die Differenz sind die
Umlaute und Sonderzeichen. 259968 ist also genau v4.29.0, kein alter Stand.

## 23. reportError() erzwingt den Doppelkanal strukturell

Direkt neben `diagError()` steht `reportError(label, e)`: buendelt
`warn(label + ':', e)` und `diagError(label + ': ' + e.message)` in einem
Aufruf. Am Handy haengt keine DevTools-Konsole - was nur in `warn()` landet,
sieht Rasmus nie; nur `STATE.diag.lastErrors` (ueber `diagError`) taucht im
kopierbaren Report auf. Reportwuerdige eigene Fehler (Netzwerk-/Service-
Aufrufe, Submit-Pfade, Pool-/Lock-Laden) rufen `reportError()`, damit keine
Call-Site den zweiten Kanal vergisst. Bewusst stille Catches an der EA-Grenze
(Fremd-Objekte, deren Fehlschlag folgenlos bleibt - Response-Traversierung,
`localStorage`-Zugriffe) bleiben davon unberuehrt.

## 24. App-seitig: reportNetError() + Zustands-Setter als Choke-Points

Am Geraet haengt keine DevTools-Konsole - der einzige Diagnosekanal fuer die
Android-App ist der `addLog`-Ringpuffer (⚙ → "Log teilen"/"Log kopieren").
`MainActivity.reportNetError(where, detail)` ist der einzige Aufrufweg, ueber
den `fetchUrl`, `fetchUrlIfChanged`, `readAsset`, `readCache`, `writeCache`
und `appVersion` einen Fehlschlag melden - jeder stille Catch bzw.
Early-Return dieser Methoden ruft ihn auf, statt einen eigenen Ad-hoc-String
zu bauen. `app/guard-test.js` prueft per statischem Source-Regex-Check, dass
jede dieser sechs Methoden mindestens einen `addLog`- oder
`reportNetError`-Aufruf im Methodenkoerper enthaelt.

Analog dazu sind `setScriptsReady(boolean)`, `setPaleStatus(String)` und
`setPaleInjected(boolean)` der einzige Schreibweg fuer die gleichnamigen
Felder: jeder tatsaechliche Wertwechsel landet automatisch im Log, ohne dass
die aufrufende Klasse (`ScriptLoader`, `PalePoll`, `SbcWebViewClient`,
`SettingsSave`) selbst daran denken muss. Neue Schreibstellen fuer diese drei
Felder gehoeren ausschliesslich ueber die Setter, direkte Feldmutation
(`a.scriptsReady = ...` o.ae.) unterlaeuft den Choke-Point.

## 25. STATE.diag ist vollstaendig deklariert, uiScan lebt neben launcher

Die `STATE.diag`-Deklaration (nahe Kopf des Userscripts) listet ALLE
tatsaechlich verwendeten Felder mit Kurzzweck-Kommentar (`fetchSeen`,
`xhrSeen`, `utasSeen`, `lastUtasPaths`, `lastErrors`, `evoExcluded`,
`lastSquadPutBody`, `staleRecover`, `locks`, `clubLoad`, `submitVia`,
`lastEligible`, `refreshLog`, `uiScan`, `batchSteps`, `lastTeam`,
`submitCandidates`, `submitChallengeVia`, `lastTap`) - jedes neue Feld gehoert
zuerst hierher, danach erst an seine Zuweisungsstelle. `solver-test.js` prueft
das symmetrisch: jedes in `buildDiagReport()` gelesene `STATE.diag.*`-Feld
muss deklariert sein, und jedes deklarierte Feld muss irgendwo im File auch
tatsaechlich befuellt werden (direkte Zuweisung, `++`, oder wie bei
`lastErrors`/`lastUtasPaths` per Referenz eingesammelt und mit `push()`/
`shift()` mutiert). Ein weiterer Test prueft, dass das `sbc`-Objekt-Literal in
`buildDiagReport()` keinen Property-Namen doppelt deklariert.

`STATE.diag.uiScan` wird direkt beim Diagnose-Klick (`onDiagClick()`) gesetzt
(Panel-/FAB-Sichtbarkeit + `inSbcView()`), bevor `buildDiagReport()`
aufgerufen wird - unabhaengig vom `launcher`-Sub-Objekt, das dieselben
Basiswerte zusaetzlich zu einem vollen DOM-Scan (Controller-Kette,
Button-Dump, Rects) liefert. `uiScan` bleibt dadurch auch dann verfuegbar,
wenn ein spaeteres Feld in `buildDiagReport()` einmal einen Fehler wirft.

## 26. Slots-Vergleich im Batch-Anker ist scharf, deepScanChallenge per Marker testbar

`STATE.sbc.formationSlots` ist die einzige Quelle fuer die Anzahl nutzbarer
SBC-Slots (geschrieben beim Scan der `playerRequirements`/`getSBCSlots()`,
Default 11 bei jedem Challenge-Wechsel). `resolveFreshChallengeId()`
(Kandidaten-Filter `okTarget && okSlots`), `matchesPlannedSbc()` (Batch-Anker-
Abgleich) und der Nutzertext bei Batch-Abbruch-Diskrepanz lesen ausschliesslich
dieses Feld. Ein Batch-Plan mit `plan.slots: 11` gegen eine offene SBC mit
`STATE.sbc.formationSlots: 4` liefert dadurch tatsaechlich `false` - vorher
verglichen beide Stellen ein nie geschriebenes `STATE.sbc.slots` und damit
immer `undefined === undefined`.

Der Deep-Scan-Parser-Cluster (`scopeString`, `reqValue`, `reqIds`, `reqCount`,
`isDomOrWindow`, `deepScanChallenge`) steht zwischen den Kommentar-Markern
`// [SBCSCAN-BEGIN]` und `// [SBCSCAN-END]` - `solver-test.js` extrahiert ihn
darueber (analog `// [SOLVER-BEGIN]`/`// [SOLVER-END]` fuer den Solver) und
ruft ihn mit konstruierten EA-Objekten auf, statt nur den Rohquelltext auf
bestimmte Strings zu pruefen. Jeder `reqDump`-Eintrag traegt zusaetzlich
`matchedAs` (`'TEAM_RATING'`/`'PLAYER_LEVEL'`/`'PLAYER_QUALITY'`/`'RARITY'`/
`'unclassified'`): macht sichtbar, welcher der sich gegenseitig ausschliessenden
Klassifizierungs-Zweige tatsaechlich griff. Ein `PLAYER_LEVEL`-Wert zwischen 4
und 39 faellt durch beide realen Zweige (`isPlayerLevel` verlangt `v >= 40`,
`isQualityScope` verlangt `v` in 1..3) und zeigt `'unclassified'` statt
lautlos zu verschwinden - genau die Information, die beim
`PLAYER_LEVEL`-Dual-Use-Bug (§6/§11) zuerst haendisch rekonstruiert werden
musste.

`app/log-test.js` prueft den App-seitigen Log-Ringpuffer (`addLog`/
`buildLogReport`) unabhaengig vom Gradle-Build: `LOG_MAX`/`LOG_LINE_MAX`
sowie der Kuerzungs-Suffix werden per Regex aus `MainActivity.java`
extrahiert, die Ringpuffer-Logik selbst laeuft als reine JS-Portierung gegen
Fixtures (FIFO-Eviction bei > 400 Zeilen, Kuerzung + Suffix bei > 600
Zeichen), zusaetzliche statische Checks sichern die Kopf-Label des
Log-Reports (App-Version, Android, Optimizer, PaleTools, PaleTools-Status)
sowie die Grundform von `addLog()` ab.

## 27. Batch-Diagnose: Haeufigkeit statt Einzelfall, Transientes am Namensdrift-Anker sichtbar

Fortsetzung von §9/§21/§26: der `stuck`-Diagnosezweig in `openNextInstance()`
(v4.36.0, ein einziger Live-Beleg, "TOTW-Batch nach 4/5 gestoppt") zaehlt jetzt
ueber `STATE.diag.batchStuckCount` mit, wie oft er seit App-Start auslöste -
statt nur aus einem einzelnen Report ablesbar zu sein. Derselbe Zweig traegt
zusaetzlich `formationSlots`/`planSlots` mit: `setCurrentChallenge()` setzt
`formationSlots` bei JEDEM Challenge-Wechsel auf den Default 11 zurueck, bevor
die Brick-Slot-Korrektur (`parseSbcChallenge`) den echten Wert nachliefert -
`matches: false` im `stuck`-Eintrag kann in diesem Fenster also transient
sein, nicht zwingend eine echte Diskrepanz zum Plan. `STATE.diag.submitWithoutResponseCount`
zaehlt parallel, wie oft `submitChallengeToEa()` ohne auswertbare Promise-/
Observable-Response trotzdem als Erfolg galt (der offen gelassene Punkt am
Ende von §9) - rein additiv, der Live-verifizierte Controller-Weg selbst
bleibt unveraendert.

`solver-test.js` deckt die Batch-Perspektive auf `matchesPlannedSbc()` jetzt
zusaetzlich zum isolierten Comparator-Test aus §26 ab: Plan-Erstellung wie
`onBatchPlanClick()`, der transiente Reset auf `formationSlots: 11` waehrend
eines Challenge-Wechsels, die Brick-Slot-Korrektur danach und die echte,
dauerhafte Diskrepanz zwischen zwei Varianten desselben Sets. Ein statischer
Source-Slice-Regressionstest (Stil analog `setLooksRepeatable`) sichert die
drei Abbruch-Zweige von `onBatchRunClick()`, das Plan-verbraucht-Prinzip im
`finally` sowie den `stuck`-/`clickBackButton`-Diagnosezweig in
`openNextInstance()` gegen stillschweigendes Entfernen ab.

## 28. reserve()-Funnel jetzt an JEDEM Reservierungspfad, Sortier-Komparator + Kostenformel als Factory

Fortsetzung von §16: die dortige Absicherung ("Alle Reservierungen laufen
jetzt ueber `reserve(p)`/`freeCard(p)`") galt tatsaechlich nur fuer die
automatischen Reservierungspfade (Bronze/Silber-Quoten, Spieler-Level-
Vorgaben, Rarity-Vorgaben, Rare-ohne-Ziel). Der Anker (`cfg.anchorId`) und die
manuell gewaehlte Rarity-Karte (`cfg.rarityPickId`) pflegten `used`/`reserved`
weiterhin inline und liefen damit am `reserve()`-Funnel vorbei - `usedAssets`
blieb fuer beide Pfade unbefuellt. Folgenlos war das nur, weil die
SPIELER-EINDEUTIGKEIT (ebenfalls §16, laeuft VOR der Anker-/Rarity-Pick-
Auswahl auf `pool` UND `poolAll`) pro assetId schon vorher genau eine Karte
uebriglaesst - ein zweiter Eintrag mit derselben assetId wie der Anker bzw.
der manuelle Pick kann den Fund also strukturell gar nicht ueberleben. Zwei
unabhaengige Mechanismen schuetzten also dieselbe Invariante, aber nur einer
davon war als solcher erkennbar (kein Log-Spur, kein Test, der genau diesen
zweiten Pfad beschreibt). Jetzt reservieren beide Pfade ueber `reserve(p)`;
`reserve()` selbst meldet zusaetzlich per Warnung, falls eine assetId doch
schon in `usedAssets` steht - vorher gab es dafuer keinerlei Beobachtungspunkt.
Das Solver-Ergebnis (`finishTeam`) und der Diagnose-Report (`STATE.diag.lastTeam`)
tragen dafuer `usedAssetsCount` (Anzahl distinkter, ueber `reserve()`
gezaehlter Spieler) mit.

Zwei begleitende Struktur-Refactorings im selben Codeabschnitt, beide
verhaltensneutral (236/236 Tests unveraendert gruen):

- Der Sortier-Komparator "Storage vor Verein -> niedrigstes Rating -> Kosten
  -> Tiebreak" stand viermal woertlich im Solver (Bronze/Silber-Quoten,
  Rare-ohne-Ziel, Gold-Rare-Reservierung, Auffuell-Karten). `makeFillCmp(costOf,
  tiebreakCmp)` ersetzt alle vier - der Tiebreak-Comparator bleibt Parameter,
  weil zwei Stellen mit `makeConsumeCmp(pool)` und zwei mit
  `makeConsumeCmp(avail)` abschliessen (unterschiedliche Kartenmengen; ein
  hartkodierter gemeinsamer Tiebreak haette an zwei Stellen die Reihenfolge
  stillschweigend geaendert).
- `costOf()` war eine private Closure innerhalb von `solveCore`, `solver-test.js`
  bildete dieselbe Formel eigenstaendig als `cardCostFn()` nach (nur per
  Kommentar synchron gehalten). `makeCostOf(pool, cfg)` ist jetzt die
  modul-weite Factory (`SolverCore.makeCostOf`), `solveCore` ruft sie auf statt
  die Closure inline zu definieren, `bruteBest()`/`solverObjective()` in
  `solver-test.js` rufen dieselbe Funktion statt einer eigenen Nachbildung -
  Test und Solver rechnen seither nachweislich mit demselben Code.

`WASTE_WEIGHT` (Kommentar beschrieb eine Fenstersteuerung, die tatsaechlich
laengst ueber `cfg.maxOvershoot` laeuft) und der `priorityOf`-Export (kein
Aufrufer ausserhalb des Moduls) waren beide tot - per Grep bestaetigt, dann
entfernt statt mit einem nachtraeglich erfundenen Verwendungsgrund behalten.

**Muster:** eine im Code als "gilt jetzt ueberall" dokumentierte Invariante
(§16) galt hier tatsaechlich nur an den Pfaden, die zum Zeitpunkt der
Doku-Aenderung schon existierten - ein spaeter hinzugefuegter Pfad (Anker,
manueller Rarity-Pick) wurde beim Haerten der Invariante nicht nachgezogen.
Ein zweiter, unabhaengiger Schutzmechanismus kann dieselbe Luecke lange
unsichtbar halten, ohne dass jemand merkt, dass die dokumentierte Garantie
nur zufaellig haelt.
