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
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
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

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new SbcWebViewClient(this));
    }

    // ---- Script-Beschaffung -------------------------------------------------

    void loadScriptsThenStart() {
        Toast.makeText(this, "Lade Scripts...", Toast.LENGTH_SHORT).show();
        new Thread(new ScriptLoader(this)).start();
    }

    void injectScripts() {
        if (!scriptsReady) return;
        if (scriptSbc != null) {
            // Direkt als Code: bewährt, und muss so früh wie möglich laufen
            // (die fetch/XHR-Interception muss vor dem EA-Bundle stehen).
            web.evaluateJavascript(
                "if(!window.__inj_sbc){window.__inj_sbc=1;try{" + scriptSbc +
                "\n}catch(e){console.error('SBC-Optimizer Injection:',e);}}", null);
        }
        if (scriptPale != null && !paleInjected) {
            paleInjected = true;
            injectPaleChunked();
        }
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
        web.evaluateJavascript(
            "(function(){try{" +
            "if(!window.__pt_buf)return'no-buffer';" +
            "var code=window.__pt_buf.join('')+'\\n;window.__pt_ran=1;';" +
            "window.__pt_buf=null;var n=code.length;" +
            "try{var s=document.createElement('script');s.textContent=code;" +
            "(document.head||document.documentElement).appendChild(s);" +
            "if(s.parentNode)s.parentNode.removeChild(s);}catch(e1){}" +
            "if(!window.__pt_ran){try{(new Function(code))();}" +
            "catch(e2){return'FEHLER: '+(e2&&e2.message||e2);}}" +
            "return (window.__pt_ran?'geladen':'still fehlgeschlagen')+' ('+n+' Zeichen)';" +
            "}catch(e){return'FEHLER: '+(e&&e.message||e);}})()",
            new PaleResult(this));
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

/** Ergebnis der PaleTools-Injection sichtbar machen (ohne Konsole am Gerät). */
class PaleResult implements ValueCallback<String> {
    private final MainActivity a;
    PaleResult(MainActivity a) { this.a = a; }
    @Override public void onReceiveValue(String value) {
        String s = (value == null) ? "keine Antwort" : value;
        // evaluateJavascript liefert JSON - Strings kommen in Anführungszeichen
        if (s.length() >= 2 && s.charAt(0) == '"' && s.charAt(s.length() - 1) == '"') {
            s = s.substring(1, s.length() - 1)
                 .replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", " ");
        }
        Toast.makeText(a, "PaleTools: " + s, Toast.LENGTH_LONG).show();
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

        // 2. PaleTools: URL -> Cache (kein Asset-Fallback, ist optional)
        String pale = null;
        if (paleOn) {
            pale = a.fetchUrl(paleUrl);
            if (pale != null) a.writeCache("pale.js", pale);
            else pale = a.readCache("pale.js");
        }
        a.scriptPale = pale;
        a.scriptsReady = true;

        String info = "Scripts bereit: Optimizer " +
                (a.scriptSbc != null ? "OK" : "FEHLT") +
                (paleOn ? (" / PaleTools " + (a.scriptPale != null ? "OK" : "FEHLT")) : "");
        a.runOnUiThread(new StartWebApp(a, info));
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
