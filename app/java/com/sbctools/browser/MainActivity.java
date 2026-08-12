package com.sbctools.browser;

/*
 * SBC Tools Browser - WebView-Wrapper für die EA FC Web App.
 * Injiziert beim Laden zwei Userscripts (nach PaleBrowser-Vorbild):
 *   1. EA FC SBC Rating-Optimizer  (Update-URL konfigurierbar, Fallback:
 *      gebündelte Version in assets/)
 *   2. PaleTools (Mobile-Build von pale.tools, abschaltbar)
 *
 * Ablauf pro App-Start: beide Scripts werden frisch von ihren URLs geladen
 * (8s Timeout) und lokal gecacht. Schlägt der Download fehl, wird der Cache
 * verwendet, notfalls die gebündelte Version. So bekommt jeder Nutzer der
 * APK immer automatisch das neueste Script - ohne Tampermonkey.
 *
 * Hinweis Implementierung: bewusst KEINE anonymen/inneren Klassen -
 * benannte Top-Level-Klassen umgehen einen d8-Parserfehler beim
 * InnerClasses-Attribut (Build ohne Gradle).
 */

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {

    static final String WEB_APP_URL =
            "https://www.ea.com/ea-sports-fc/ultimate-team/web-app/";
    // Deployment-Quelle: Push auf main = Update auf allen Geraeten (siehe
    // CLAUDE.md). Frueher war der Default leer -> die App blieb dauerhaft auf
    // dem in der APK gebuendelten Asset haengen, solange die URL nicht pro
    // Geraet manuell eingetragen wurde.
    static final String DEFAULT_SBC_URL =
            "https://raw.githubusercontent.com/Rasmus33/pittools/main/ea-fc-sbc-optimizer.user.js";
    static final String DEFAULT_PALETOOLS_URL =
            "https://pale.tools/fifa/dist/latest/paletools-mobile.user.js";

    // Rohzeichen pro evaluateJavascript-Aufruf. Durch das Unicode-Escaping
    // wird daraus im Extremfall das Sechsfache - mit 60k bleibt jeder
    // IPC-Aufruf klar unter dem ~1-MB-Binder-Limit.
    // (Kein u-Escape-Literal in Kommentaren: javac wertet die auch dort aus.)
    static final int PALE_CHUNK = 60000;

    WebView web;
    SharedPreferences prefs;
    String scriptSbc = null;       // Inhalt SBC-Optimizer
    String scriptPale = null;      // Inhalt PaleTools
    volatile boolean scriptsReady = false;
    boolean paleInjected = false;  // pro Seitenladen nur einmal (teuer)

    // ---- Log-Puffer ---------------------------------------------------------
    // Am Gerät hängt keine Konsole. Deshalb sammelt die App alle
    // console-Ausgaben der Seite (auch die von PaleTools selbst) in einem
    // Ringpuffer, der sich über ⚙ teilen oder kopieren lässt.
    static final int LOG_MAX = 400;
    static final int LOG_LINE_MAX = 600;
    final java.util.ArrayList<String> logLines = new java.util.ArrayList<String>();

    void addLog(String line) {
        if (line == null) return;
        if (line.length() > LOG_LINE_MAX) {
            line = line.substring(0, LOG_LINE_MAX) + " …[gekürzt]";
        }
        synchronized (logLines) {
            logLines.add(line);
            while (logLines.size() > LOG_MAX) logLines.remove(0);
        }
    }

    /** Der komplette Bericht: Kopfdaten + gesammelte Konsolenzeilen. */
    String buildLogReport() {
        StringBuilder sb = new StringBuilder(8192);
        sb.append("PitTools-Log\n");
        sb.append("App-Version: ").append(appVersion()).append('\n');
        sb.append("Android: ").append(Build.VERSION.RELEASE)
          .append(" (SDK ").append(Build.VERSION.SDK_INT).append(")")
          .append(", ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n');
        sb.append("Optimizer: ").append(scriptSbc == null ? "FEHLT"
                : (scriptSbc.length() + " Zeichen")).append('\n');
        sb.append("PaleTools: ").append(scriptPale == null ? "FEHLT/aus"
                : (scriptPale.length() + " Zeichen")).append('\n');
        sb.append("PaleTools-Quelle: ").append(paleSource == null ? "(unbekannt)" : paleSource)
                .append('\n');
        sb.append("PaleTools-Status: ").append(paleStatus == null ? "(noch keiner)" : paleStatus)
          .append("\n\n--- Konsole (neueste zuletzt) ---\n");
        synchronized (logLines) {
            for (int i = 0; i < logLines.size(); i++) sb.append(logLines.get(i)).append('\n');
            if (logLines.isEmpty()) sb.append("(leer)\n");
        }
        return sb.toString();
    }

    String paleStatus = null;   // letzte Rückmeldung des PaleTools-Wächters
    String paleSource = null;   // "Cache" oder "Download" - erklärt die Startzeit

    String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) { return "?"; }
    }

    void shareLog() {
        String text = buildLogReport();
        // Der Intent-Extra geht über Binder - grob begrenzen, sonst fliegt es
        // bei langen Logs (dieselbe Grenze wie bei evaluateJavascript).
        if (text.length() > 120000) text = text.substring(text.length() - 120000);
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType("text/plain");
        i.putExtra(Intent.EXTRA_SUBJECT, "PitTools-Log " + appVersion());
        i.putExtra(Intent.EXTRA_TEXT, text);
        startActivity(Intent.createChooser(i, "Log senden an"));
    }

    void copyLog() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("PitTools-Log", buildLogReport()));
            Toast.makeText(this, "Log in die Zwischenablage kopiert", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Kopieren fehlgeschlagen: " + e.getMessage(),
                    Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("sbctools", Context.MODE_PRIVATE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN);

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // Zahnrad-Knopf für die Script-Einstellungen. VERSCHIEBBAR: als
        // nativer Button liegt er über dem WebView, und alles im DOM darunter
        // ist nicht antippbar - unten links war er damit eine Totzone, die
        // unseren eigenen Knöpfen im Weg stand.
        // Gravity TOP|START + absolute Position, damit setX/setY eindeutig
        // sind; die Startposition (unten links) wird nach dem Layout gesetzt.
        Button gear = new Button(this);
        gear.setText("⚙");
        gear.setTextColor(Color.WHITE);
        gear.setBackgroundColor(0x66000000);
        gear.setAlpha(0.55f);
        FrameLayout.LayoutParams gp = new FrameLayout.LayoutParams(110, 110);
        gp.gravity = Gravity.TOP | Gravity.START;
        root.addView(gear, gp);
        // Kein OnClickListener: der Touch-Listener unterscheidet Tippen
        // (Einstellungen öffnen) von Ziehen und würde ihn sonst verschlucken.
        gear.setOnTouchListener(new GearDrag(this));
        root.post(new GearRestore(this, root, gear));

        setContentView(root);
        setupWebView();
        loadScriptsThenStart();
    }

    void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        // MOBILE Chrome-Kennung: die EA Web App liefert dann ihre mobile
        // Hochformat-Ansicht (dafür ist auch paletools-mobile gebaut).
        // Wir nehmen die Geräte-UA des WebViews und entfernen nur die
        // WebView-Marker ("; wv", "Version/4.0"), die manche Seiten blocken.
        String ua = s.getUserAgentString();
        if (ua != null) {
            ua = ua.replace("; wv", "").replace("Version/4.0 ", "");
            s.setUserAgentString(ua);
        }
        s.setMediaPlaybackRequiresUserGesture(true);
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, true);

        web.setWebChromeClient(new SbcChromeClient(this));
        web.setWebViewClient(new SbcWebViewClient(this));
    }

    // ---- Script-Beschaffung -------------------------------------------------

    void loadScriptsThenStart() {
        Toast.makeText(this, "Lade Scripts...", Toast.LENGTH_SHORT).show();
        new Thread(new ScriptLoader(this)).start();
    }

    /**
     * Unser Optimizer: so FRÜH wie möglich (onPageStarted), die fetch/XHR-
     * Interception muss vor dem EA-Bundle stehen.
     */
    void injectScripts() {
        if (!scriptsReady) return;
        if (scriptSbc != null) {
            web.evaluateJavascript(
                "if(!window.__inj_sbc){window.__inj_sbc=1;try{" + scriptSbc +
                "\n}catch(e){console.error('SBC-Optimizer Injection:',e);}}", null);
        }
    }

    /**
     * PaleTools: bewusst SPÄT (onPageFinished) und zusätzlich abgesichert
     * durch einen Wächter, der auf die EA-Klassen wartet.
     * Grund: PaleTools referenziert EA-Symbole auf Top-Level
     * (UIItemActionEvent, UTStandardButtonControl, UTSBCSquadDetailPanelView …)
     * und stirbt sofort mit "… is not defined", wenn das EA-Bundle noch nicht
     * gelaufen ist. Als Tampermonkey-Script läuft es bei document-idle, also
     * lange nach unserem Script - das muss die App nachbilden.
     */
    void injectPaleLate() {
        if (!scriptsReady || scriptPale == null || paleInjected) return;
        paleInjected = true;
        injectPaleChunked();
        web.postDelayed(new PalePoll(this, 0), 1500);
    }

    /**
     * PaleTools ist ~900 KB. evaluateJavascript schiebt den String per
     * Binder-IPC zum Renderer, und dessen Transaktionslimit liegt bei ~1 MB
     * (geteilter Puffer) - bei der Größe wird das je nach Gerät abgeschnitten
     * oder wirft. Deshalb: in Häppchen als String-Literale übertragen, im
     * Seitenkontext zusammensetzen und dann ausführen.
     *
     * Ausgeführt wird über ein <script>-Tag (echter globaler Scope, wie ein
     * normales Userscript - PaleTools legt Globals an). Sollte eine CSP inline
     * Scripts blockieren, passiert das STILL, ohne Exception; deshalb hängt am
     * Code ein Sentinel (__pt_ran), und nur wenn der fehlt, wird new Function
     * als Fallback versucht. Das Ergebnis kommt als Toast zurück, damit ohne
     * angeschlossene Konsole sichtbar ist, was passiert ist.
     */
    void injectPaleChunked() {
        final String code = scriptPale;
        web.evaluateJavascript(
            "if(!window.__inj_pale){window.__inj_pale=1;window.__pt_buf=[];}", null);
        for (int i = 0; i < code.length(); i += PALE_CHUNK) {
            String part = code.substring(i, Math.min(code.length(), i + PALE_CHUNK));
            web.evaluateJavascript(
                "window.__pt_buf&&window.__pt_buf.push(" + jsQuote(part) + ");", null);
        }
        // Ausfuehren, sobald die EA-Klassen stehen. Der Status landet in
        // window.__pt_status und wird von PalePoll abgeholt (der Callback von
        // evaluateJavascript kann ihn nicht liefern - das Ergebnis kommt
        // asynchron, oft erst Sekunden spaeter).
        web.evaluateJavascript(
            "(function(){" +
            "if(window.__pt_waiting)return;window.__pt_waiting=1;" +
            "function exec(note){try{" +
            "  if(!window.__pt_buf){window.__pt_status='no-buffer';return;}" +
            "  var code=window.__pt_buf.join('')+'\\n;window.__pt_ran=1;';" +
            // Puffer NICHT vorab freigeben: schlaegt die Ausfuehrung fehl,
            // waere der einzige Versuch sonst unwiederbringlich verbraucht.
            "  var n=code.length;" +
            "  try{var s=document.createElement('script');s.textContent=code;" +
            "    (document.head||document.documentElement).appendChild(s);" +
            "    if(s.parentNode)s.parentNode.removeChild(s);}catch(e1){}" +
            "  if(!window.__pt_ran){try{(new Function(code))();}" +
            "    catch(e2){window.__pt_status='FEHLER: '+(e2&&e2.message||e2);return;}}" +
            // Erst JETZT freigeben - erledigt, die ~900 KB duerfen weg.
            "  if(window.__pt_ran)window.__pt_buf=null;" +
            "  window.__pt_status=(window.__pt_ran?'geladen':'still fehlgeschlagen')" +
            "    +' ('+n+' Zeichen'+note+')';" +
            // Nachkontrolle: hat PaleTools sich tatsaechlich eingerichtet?
            // Es schreibt localStorage-Keys mit Prefix "paletools" und baut
            // Elemente mit paletools-*-Klassen. Damit ist "laeuft nicht" von
            // "laeuft, aber man sieht nichts" unterscheidbar (die
            // Mobile-UI-Regeln von PaleTools sind .landscape-lastig, wir
            // laufen im Hochformat).
            "  setTimeout(function(){try{" +
            "    var ls=0,k;for(var i=0;i<localStorage.length;i++){" +
            "      k=String(localStorage.key(i));" +
            "      if(k.indexOf('paletools')===0)ls++;}" +
            "    var el=document.querySelectorAll('[class*=\"paletools\"]');var vis=0;" +
            "    for(var j=0;j<el.length;j++){" +
            "      if(el[j].offsetParent!==null||el[j].getClientRects().length)vis++;}" +
            "    window.__pt_status=(window.__pt_status||'')+' | LS-Keys:'+ls" +
            "      +' DOM:'+el.length+' sichtbar:'+vis" +
            "      +' tabbar:'+document.querySelectorAll('.ut-tab-bar').length" +
            "      +' orient:'+(window.innerWidth>window.innerHeight?'quer':'hoch');" +
            "  }catch(e2){window.__pt_status=(window.__pt_status||'')+' | Nachkontrolle: '+e2;}}," +
            "  6000);" +
            "}catch(e){window.__pt_status='FEHLER: '+(e&&e.message||e);}}" +
            // PaleTools fasst EA-Symbole direkt beim Laden an - erst warten.
            // Einzeln pruefen, damit im Log steht, WORAUF gewartet wird.
            "function miss(){var m=[];" +
            "  if(typeof services==='undefined')m.push('services');" +
            "  if(typeof getAppMain!=='function')m.push('getAppMain');" +
            "  if(typeof UTStandardButtonControl==='undefined')m.push('UTStandardButtonControl');" +
            "  if(typeof UIItemActionEvent==='undefined')m.push('UIItemActionEvent');" +
            "  if(!document.body)m.push('body');return m;}" +
            // Schwellen in Ticks (250ms): SOFT = ab wann ohne
            // UIItemActionEvent gestartet wird (2 Min), HARD = endgueltiges
            // Aufgeben (30 Min). Ueberschreibbar, damit guard-test.js beide
            // Pfade pruefen kann, ohne Minuten zu warten.
            "var SOFT=window.__pt_soft_after||480,HARD=window.__pt_hard_after||7200;" +
            "var t=0;(function w(){" +
            "  var m=miss();" +
            "  window.__pt_wait='t='+t+(m.length?(' fehlt: '+m.join(',')):' bereit');" +
            "  if(!m.length){exec('');return;}" +
            // Wenn die App sonst bereit ist und nur UIItemActionEvent fehlt,
            // nach 2 Min trotzdem starten - das Symbol koennte in dieser
            // FC-Version gar nicht existieren und PaleTools es nur in einem
            // toten Zweig anfassen.
            "  var blockers=m.filter(function(x){return x!=='UIItemActionEvent';});" +
            "  if(!blockers.length&&t>SOFT){exec(', ohne UIItemActionEvent');return;}" +
            // 30 Minuten Geduld: der EA-Login dauert, und die App laedt ihre
            // Klassen erst danach. VORZEITIG ausfuehren ist schaedlich -
            // PaleTools stirbt an fehlenden Symbolen und der einzige Versuch
            // ist verbraucht (genau das ist in v1.4.1 passiert).
            "  if(++t>HARD){window.__pt_status='NICHT ausgefuehrt, fehlt dauerhaft: '" +
            "    +m.join(',');return;}" +
            "  setTimeout(w,250);})();" +
            "})()", null);
    }

    /** Escaped einen Beliebig-Text als JS-String-Literal (inkl. Quotes). */
    static String jsQuote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 32);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"') sb.append("\\\"");
            else if (c == '\\') sb.append("\\\\");
            else if (c == '\n') sb.append("\\n");
            else if (c == '\r') sb.append("\\r");
            else if (c == '\t') sb.append("\\t");
            else if (c < 0x20 || c > 0x7e) {
                // Alles außerhalb von ASCII-druckbar wird als Unicode-Escape
                // geschrieben - umgeht Encoding-Fragen zwischen Java, Binder
                // und JS komplett (auch Surrogate-Paare, da zeichenweise).
                sb.append(String.format("\\u%04x", (int) c));
            } else sb.append(c);
        }
        sb.append('"');
        return sb.toString();
    }

    String fetchUrl(String u) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setInstanceFollowRedirects(true);
            if (c.getResponseCode() != 200) return null;
            return readStream(c.getInputStream());
        } catch (Exception e) { return null; }
    }

    /**
     * Bedingter GET: schickt den gemerkten ETag / Last-Modified mit. Antwortet
     * der Server mit 304, ist der Cache aktuell und es kommt KEIN Body ueber
     * die Leitung - das haelt die Hintergrund-Auffrischung billig.
     * Liefert den neuen Inhalt oder null (304, Fehler, oder kein Fortschritt).
     */
    String fetchUrlIfChanged(String u, String etagKey, String modKey) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(u).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setInstanceFollowRedirects(true);
            String etag = prefs.getString(etagKey, null);
            String mod = prefs.getString(modKey, null);
            if (etag != null) c.setRequestProperty("If-None-Match", etag);
            if (mod != null) c.setRequestProperty("If-Modified-Since", mod);
            int code = c.getResponseCode();
            if (code == 304) return null;
            if (code != 200) return null;
            String newEtag = c.getHeaderField("ETag");
            String newMod = c.getHeaderField("Last-Modified");
            String body = readStream(c.getInputStream());
            if (body == null) return null;
            SharedPreferences.Editor e = prefs.edit();
            if (newEtag != null) e.putString(etagKey, newEtag);
            if (newMod != null) e.putString(modKey, newMod);
            e.apply();
            return body;
        } catch (Exception e) { return null; }
    }

    String readAsset(String name) {
        try { return readStream(getAssets().open(name)); }
        catch (Exception e) { return null; }
    }

    String readCache(String name) {
        try { return readStream(new FileInputStream(new File(getFilesDir(), name))); }
        catch (Exception e) { return null; }
    }

    void writeCache(String name, String content) {
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(new File(getFilesDir(), name));
            out.write(content.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) { /* Cache ist optional */ }
        finally { try { if (out != null) out.close(); } catch (Exception e) {} }
    }

    String readStream(InputStream in) throws Exception {
        StringBuilder sb = new StringBuilder();
        BufferedReader r = null;
        try {
            r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            char[] buf = new char[16384];
            int n;
            while ((n = r.read(buf)) > 0) sb.append(buf, 0, n);
        } finally { try { if (r != null) r.close(); } catch (Exception e) {} }
        return sb.toString();
    }

    // ---- Einstellungen ------------------------------------------------------

    void showSettings() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = 40;
        box.setPadding(pad, pad, pad, pad);

        TextView l1 = new TextView(this);
        l1.setText("URL für den SBC-Optimizer (.user.js)\n"
                + "Vorbelegt mit GitHub (main) — holt bei jedem Start die\n"
                + "neueste Version. Leer = eingebaute Version verwenden.");
        box.addView(l1);
        EditText urlSbc = new EditText(this);
        urlSbc.setHint("https://.../ea-fc-sbc-optimizer.user.js");
        urlSbc.setText(prefs.getString("sbcUrl", DEFAULT_SBC_URL));
        box.addView(urlSbc);

        CheckBox paleOn = new CheckBox(this);
        paleOn.setText("PaleTools mitladen");
        paleOn.setChecked(prefs.getBoolean("paleOn", true));
        box.addView(paleOn);
        EditText urlPale = new EditText(this);
        urlPale.setText(prefs.getString("paleUrl", DEFAULT_PALETOOLS_URL));
        box.addView(urlPale);

        // Diagnose: die gesammelten Konsolenmeldungen rausbekommen. Am Gerät
        // hängt keine Konsole, also muss der Log teilbar sein.
        TextView l2 = new TextView(this);
        l2.setText("\nDiagnose");
        box.addView(l2);
        TextView logInfo = new TextView(this);
        int n;
        synchronized (logLines) { n = logLines.size(); }
        logInfo.setText("Konsole: " + n + " Zeilen · PaleTools: "
                + (paleStatus == null ? "kein Status" : paleStatus));
        logInfo.setTextSize(11f);
        box.addView(logInfo);
        Button bShare = new Button(this);
        bShare.setText("Log teilen (WhatsApp/Mail)");
        bShare.setOnClickListener(new LogShare(this));
        box.addView(bShare);
        Button bCopy = new Button(this);
        bCopy.setText("Log kopieren");
        bCopy.setOnClickListener(new LogCopy(this));
        box.addView(bCopy);

        new AlertDialog.Builder(this)
            .setTitle("Script-Einstellungen")
            .setView(box)
            .setPositiveButton("Speichern & neu laden", new SettingsSave(this, urlSbc, paleOn, urlPale))
            .setNegativeButton("Abbrechen", (DialogInterface.OnClickListener) null)
            .show();
    }

    void saveGearPos(float x, float y) {
        prefs.edit().putFloat("gearX", x).putFloat("gearY", y).apply();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}

// ---- Benannte Hilfsklassen (kein Gradle-Build: d8 mag keine anonymen Klassen) ----

/**
 * Zahnrad ziehen statt nur antippen. Tippen (unter der Schwelle) öffnet die
 * Einstellungen - deshalb gibt es keinen OnClickListener mehr, der würde von
 * einem Touch-Listener mit return true ohnehin verschluckt.
 */
class GearDrag implements View.OnTouchListener {
    private final MainActivity a;
    private float downX, downY, startX, startY;
    private boolean moved;
    GearDrag(MainActivity a) { this.a = a; }
    @Override public boolean onTouch(View v, MotionEvent ev) {
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = ev.getRawX(); downY = ev.getRawY();
                startX = v.getX(); startY = v.getY();
                moved = false;
                return true;
            case MotionEvent.ACTION_MOVE: {
                float dx = ev.getRawX() - downX;
                float dy = ev.getRawY() - downY;
                if (Math.abs(dx) > 12 || Math.abs(dy) > 12) moved = true;
                if (moved) {
                    View p = (View) v.getParent();
                    float maxX = Math.max(0, p.getWidth() - v.getWidth());
                    float maxY = Math.max(0, p.getHeight() - v.getHeight());
                    v.setX(Math.min(Math.max(0, startX + dx), maxX));
                    v.setY(Math.min(Math.max(0, startY + dy), maxY));
                }
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (moved) a.saveGearPos(v.getX(), v.getY());
                else if (ev.getActionMasked() == MotionEvent.ACTION_UP) a.showSettings();
                return true;
            default:
                return false;
        }
    }
}

/** Setzt die gemerkte Zahnrad-Position, sobald das Layout Maße hat. */
class GearRestore implements Runnable {
    private final MainActivity a;
    private final FrameLayout root;
    private final View gear;
    GearRestore(MainActivity a, FrameLayout root, View gear) {
        this.a = a; this.root = root; this.gear = gear;
    }
    @Override public void run() {
        float maxX = Math.max(0, root.getWidth() - gear.getWidth());
        float maxY = Math.max(0, root.getHeight() - gear.getHeight());
        float x = a.prefs.getFloat("gearX", -1f);
        float y = a.prefs.getFloat("gearY", -1f);
        if (x < 0 || y < 0) { x = 8; y = maxY - 8; }   // Default: unten links
        gear.setX(Math.min(Math.max(0, x), maxX));
        gear.setY(Math.min(Math.max(0, y), maxY));
    }
}

/**
 * Holt window.__pt_status ab, sobald der Wächter im JS ihn gesetzt hat, und
 * zeigt ihn als Toast - am Gerät hängt keine Konsole.
 */
/**
 * Pollt window.__pt_status. Läuft bewusst WEITER, nachdem der erste Status da
 * ist: der Wächter hängt ~6s später die Nachkontrolle an (localStorage-Keys,
 * DOM-Elemente, Ausrichtung). Jede Änderung wird geloggt, getoastet wird nur
 * die erste Meldung.
 */
class PalePoll implements Runnable, ValueCallback<String> {
    private final MainActivity a;
    private final int tries;
    private final boolean toasted;
    PalePoll(MainActivity a, int tries) { this(a, tries, false); }
    PalePoll(MainActivity a, int tries, boolean toasted) {
        this.a = a; this.tries = tries; this.toasted = toasted;
    }
    static final String SEP = "|~|";
    @Override public void run() {
        // Status UND Wartefortschritt in einem Rutsch holen.
        a.web.evaluateJavascript(
            "(window.__pt_status||'')+'" + SEP + "'+(window.__pt_wait||'')", this);
    }
    @Override public void onReceiveValue(String value) {
        String s = (value == null) ? "" : value;
        // evaluateJavascript liefert JSON - Strings kommen in Anführungszeichen
        if (s.length() >= 2 && s.charAt(0) == '"' && s.charAt(s.length() - 1) == '"') {
            s = s.substring(1, s.length() - 1)
                 .replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", " ");
        }
        String status = s, wait = "";
        int i = s.indexOf(SEP);
        if (i >= 0) { status = s.substring(0, i); wait = s.substring(i + SEP.length()); }

        boolean have = status.length() > 0 && !"null".equals(status);
        boolean didToast = toasted;
        if (have && !status.equals(a.paleStatus)) {
            a.paleStatus = status;
            a.addLog("PaleTools-Status: " + status);
            if (!didToast) {
                Toast.makeText(a, "PaleTools: " + status, Toast.LENGTH_LONG).show();
                didToast = true;
            }
        }
        // Solange gewartet wird, jede Minute eine Zeile - daran ist im Log zu
        // sehen, auf welches Symbol es hängt, ohne den Puffer zu fluten.
        if (!have && wait.length() > 0 && tries % 12 == 0) {
            a.addLog("PaleTools wartet: " + wait);
        }
        // ~20 Minuten mitlaufen: der Login kann dauern, und die Nachkontrolle
        // kommt erst 6s nach dem Ausführen.
        if (tries < 240) {
            a.web.postDelayed(new PalePoll(a, tries + 1, didToast), 5000);
        } else if (!have) {
            a.paleStatus = "keine Rückmeldung (letzter Wartestand: " + wait + ")";
            a.addLog("PaleTools-Status: " + a.paleStatus);
        }
    }
}

class LogShare implements View.OnClickListener {
    private final MainActivity a;
    LogShare(MainActivity a) { this.a = a; }
    @Override public void onClick(View v) { a.shareLog(); }
}

class LogCopy implements View.OnClickListener {
    private final MainActivity a;
    LogCopy(MainActivity a) { this.a = a; }
    @Override public void onClick(View v) { a.copyLog(); }
}

/**
 * Fängt die Konsolenausgaben der Seite ab - inklusive der von PaleTools und
 * uncaught errors. Ohne das ist am Gerät nicht zu sehen, warum etwas nicht
 * läuft (kein angeschlossenes DevTools).
 */
class SbcChromeClient extends WebChromeClient {
    private final MainActivity a;
    SbcChromeClient(MainActivity a) { this.a = a; }
    @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
        try {
            String lvl = (m.messageLevel() == null) ? "LOG" : m.messageLevel().name();
            String src = m.sourceId() == null ? "" : m.sourceId();
            int cut = src.lastIndexOf('/');
            if (cut >= 0 && cut + 1 < src.length()) src = src.substring(cut + 1);
            a.addLog("[" + lvl + "] " + m.message()
                    + (src.length() > 0 ? ("  (" + src + ":" + m.lineNumber() + ")") : ""));
        } catch (Exception e) { /* Logging darf nie stören */ }
        return false; // zusätzlich normal ins Logcat
    }
}

class SbcWebViewClient extends android.webkit.WebViewClient {
    private final MainActivity a;
    SbcWebViewClient(MainActivity a) { this.a = a; }
    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        // Neue Seite = neues window, also darf PaleTools wieder injiziert
        // werden (sonst fehlt es nach jedem Reload). Gegen Doppel-Injection
        // innerhalb DERSELBEN Seite schützt der __inj_pale-Guard im JS.
        a.paleInjected = false;
        // So früh wie möglich injizieren - die fetch/XHR-Interception der
        // Scripts muss VOR dem EA-Bundle stehen.
        a.injectScripts();
    }
    @Override
    public void onPageFinished(WebView view, String url) {
        // Sicherheitsnetz: falls die frühe Injection zu früh kam.
        // (Guards in injectScripts verhindern Doppel-Ausführung.)
        a.injectScripts();
        // PaleTools erst JETZT - es fasst EA-Symbole beim Laden an und stirbt
        // in onPageStarted mit "UIItemActionEvent is not defined".
        a.injectPaleLate();
    }
}

class ScriptLoader implements Runnable {
    private final MainActivity a;
    ScriptLoader(MainActivity a) { this.a = a; }
    @Override public void run() {
        String sbcUrl = a.prefs.getString("sbcUrl", MainActivity.DEFAULT_SBC_URL).trim();
        boolean paleOn = a.prefs.getBoolean("paleOn", true);
        String paleUrl = a.prefs.getString("paleUrl", MainActivity.DEFAULT_PALETOOLS_URL).trim();

        // 1. SBC-Optimizer: URL -> Cache -> gebündeltes Asset
        String sbc = null;
        if (!sbcUrl.isEmpty()) {
            sbc = a.fetchUrl(sbcUrl);
            if (sbc != null) a.writeCache("sbc.js", sbc);
            else sbc = a.readCache("sbc.js");
        }
        if (sbc == null) sbc = a.readAsset("sbc-optimizer.user.js");
        a.scriptSbc = sbc;

        // 2. PaleTools: CACHE ZUERST. Es ist ~900 KB, und die WebView startete
        // bisher erst NACH dem Download - das war die Wartezeit, bis PaleTools
        // am Handy aktiv wurde. Die Datei aendert sich selten, also: liegt eine
        // Kopie im Cache, wird die sofort benutzt und der Download passiert
        // danach im Hintergrund (wirkt beim naechsten Start).
        // Der Optimizer bleibt bewusst Download-zuerst: "Push auf main =
        // Deployment", und Rasmus prueft die Version im Panel-Header.
        String pale = null;
        boolean paleFromCache = false;
        if (paleOn) {
            pale = a.readCache("pale.js");
            if (pale != null) paleFromCache = true;
            else {
                pale = a.fetchUrl(paleUrl);
                if (pale != null) a.writeCache("pale.js", pale);
            }
        }
        a.scriptPale = pale;
        a.paleSource = (pale == null) ? "keine" : (paleFromCache ? "Cache" : "Download");
        a.scriptsReady = true;

        // BEWUSST "geladen", nicht "bereit": das sagt nur, dass die Dateien
        // heruntergeladen sind. Ob PaleTools auch LÄUFT, meldet erst der
        // Wächter über den zweiten Toast (window.__pt_status).
        String info = "Scripts geladen: Optimizer " +
                (a.scriptSbc != null ? "OK" : "FEHLT") +
                (paleOn ? (" / PaleTools " + (a.scriptPale != null ? "OK" : "FEHLT")) : "");
        a.addLog("Download: Optimizer=" + (a.scriptSbc != null ? a.scriptSbc.length() : -1)
                + " Zeichen, PaleTools=" + (a.scriptPale != null ? a.scriptPale.length() : -1)
                + " Zeichen (paleOn=" + paleOn + ")");
        a.addLog("Quellen: sbcUrl=" + (sbcUrl.isEmpty() ? "(Asset)" : sbcUrl)
                + " | paleUrl=" + paleUrl);
        a.runOnUiThread(new StartWebApp(a, info));

        // Auffrischen NACH dem Start - blockiert die Seite nicht mehr. Mit
        // If-None-Match/If-Modified-Since ist das meist ein 304 ohne Body.
        if (paleOn && paleFromCache) {
            String fresh = a.fetchUrlIfChanged(paleUrl, "paleEtag", "paleMod");
            if (fresh != null && fresh.length() > 100000) {
                a.writeCache("pale.js", fresh);
                a.addLog("PaleTools-Cache erneuert (" + fresh.length()
                        + " Zeichen) - wirkt beim naechsten Start.");
            } else {
                a.addLog("PaleTools-Cache ist aktuell (" + pale.length() + " Zeichen).");
            }
        }
    }
}

class StartWebApp implements Runnable {
    private final MainActivity a;
    private final String info;
    StartWebApp(MainActivity a, String info) { this.a = a; this.info = info; }
    @Override public void run() {
        Toast.makeText(a, info, Toast.LENGTH_LONG).show();
        a.web.loadUrl(MainActivity.WEB_APP_URL);
    }
}

class SettingsSave implements DialogInterface.OnClickListener {
    private final MainActivity a;
    private final EditText urlSbc, urlPale;
    private final CheckBox paleOn;
    SettingsSave(MainActivity a, EditText urlSbc, CheckBox paleOn, EditText urlPale) {
        this.a = a; this.urlSbc = urlSbc; this.paleOn = paleOn; this.urlPale = urlPale;
    }
    @Override public void onClick(DialogInterface d, int w) {
        a.prefs.edit()
            .putString("sbcUrl", urlSbc.getText().toString().trim())
            .putBoolean("paleOn", paleOn.isChecked())
            .putString("paleUrl", urlPale.getText().toString().trim())
            .apply();
        a.scriptsReady = false;
        a.scriptSbc = null;
        a.scriptPale = null;
        a.loadScriptsThenStart();
    }
}
