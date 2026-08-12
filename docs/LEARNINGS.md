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
