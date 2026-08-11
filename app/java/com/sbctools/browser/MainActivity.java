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
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
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

    WebView web;
    SharedPreferences prefs;
    String scriptSbc = null;       // Inhalt SBC-Optimizer
    String scriptPale = null;      // Inhalt PaleTools
    volatile boolean scriptsReady = false;

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

        // Kleiner Zahnrad-Knopf unten links für die Script-Einstellungen
        Button gear = new Button(this);
        gear.setText("⚙");
        gear.setTextColor(Color.WHITE);
        gear.setBackgroundColor(0x66000000);
        gear.setAlpha(0.55f);
        FrameLayout.LayoutParams gp = new FrameLayout.LayoutParams(110, 110);
        gp.gravity = Gravity.BOTTOM | Gravity.START;
        gp.leftMargin = 8; gp.bottomMargin = 8;
        root.addView(gear, gp);
        gear.setOnClickListener(new GearClick(this));

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
            web.evaluateJavascript(
                "if(!window.__inj_sbc){window.__inj_sbc=1;try{" + scriptSbc +
                "\n}catch(e){console.error('SBC-Optimizer Injection:',e);}}", null);
        }
        if (scriptPale != null) {
            web.evaluateJavascript(
                "if(!window.__inj_pale){window.__inj_pale=1;try{" + scriptPale +
                "\n}catch(e){console.error('PaleTools Injection:',e);}}", null);
        }
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

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}

// ---- Benannte Hilfsklassen (kein Gradle-Build: d8 mag keine anonymen Klassen) ----

class GearClick implements View.OnClickListener {
    private final MainActivity a;
    GearClick(MainActivity a) { this.a = a; }
    @Override public void onClick(View v) { a.showSettings(); }
}

class SbcWebViewClient extends android.webkit.WebViewClient {
    private final MainActivity a;
    SbcWebViewClient(MainActivity a) { this.a = a; }
    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
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
