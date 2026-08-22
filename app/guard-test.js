/**
 * Test für den PaleTools-Wächter aus MainActivity.java.
 *
 * Aufruf:  node app/guard-test.js
 *
 * Warum es diesen Test gibt: der Wächter ist ein aus Java-String-Literalen
 * zusammengesetztes JS-Programm, das am Gerät STILL ausfallen kann - man sieht
 * dann nur "PaleTools läuft nicht". Genau diese Logik war schon zweimal falsch
 * (zu früh injiziert; dann nach 60s trotzdem ausgeführt und damit den einzigen
 * Versuch verbrannt). Deshalb wird der Code hier aus der Java-Quelle extrahiert
 * (gleiches Prinzip wie solver-test.js beim Userscript) und in einem Fake-DOM
 * durchgespielt.
 *
 * Zwei Extraktionsprinzipien bestehen bewusst nebeneinander: extractGuard()
 * (Marker-primär, Fragment-Literale als Fallback) für den Wächter selbst und
 * extractBraceBlock() (Signatur + Klammer-Balance) für alle übrigen Checks.
 * Der Wächter ist ein anonymer IIFE-Ausdruck ohne feste Methoden-Signatur -
 * extractBraceBlock passt darauf strukturell nicht 1:1, deshalb keine
 * Migration auf ein einziges Prinzip (Q4).
 *
 * Keine Dependencies.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const JAVA = path.join(__dirname, 'java', 'com', 'sbctools', 'browser', 'MainActivity.java');
const BS = String.fromCharCode(92); // Backslash

// ---- Wächter aus der Java-Quelle extrahieren -----------------------------
// In eine eigene Funktion ausgelagert (statt inline in extractGuard), damit
// Test 0 unten dieselbe Parse-Logik gegen einen synthetischen CRLF-Block
// prüfen kann, unabhängig davon, ob der eigene Checkout gerade CRLF oder LF
// verwendet.
function literalsFromJavaBlock(block) {
    // CRLF-Checkouts (core.autocrlf=true) lassen ein "\r" am Zeilenende stehen.
    // Ohne Normalisierung verfehlt der Kommentar-Regex unten sein "$"-Anker
    // (der Punkt matcht kein "\r", und "$" ohne /m sitzt hinter dem "\r",
    // nicht davor) - der Java-Zeilenkommentar bleibt dann stehen und seine
    // Anführungszeichen-Fragmente landen im rekonstruierten Guard-JS.
    block = block.replace(/\r\n/g, '\n');
    const lits = [];
    for (let line of block.split('\n')) {
        line = line.replace(/\/\/.*$/, '');           // Java-Zeilenkommentar
        const re = /"((?:[^"\\]|\\.)*)"/g;
        let m;
        while ((m = re.exec(line)) !== null) lits.push(m[1]);
    }
    return lits.map(unescapeJava).join('');
}

// Vier Anker, die in JEDEM vollständigen Wächter-Extrakt vorkommen müssen -
// eine verschobene/entfernte Marker- oder Literal-Grenze verkürzt den Block
// sonst STILL, ohne dass ein Test das bemerkt (Gap-Report Mangel 3).
const GUARD_ANCHORS = ['HARD=', 'exec(', 'miss()', '__pt_status'];

function missingAnchors(guardCode) {
    return GUARD_ANCHORS.filter((a) => guardCode.indexOf(a) < 0);
}

// Primärer Weg: dedizierte Marker-Kommentare, immun gegen Reformats der
// Fragment-Literale darunter.
function extractGuardViaMarkers(src) {
    const startMark = '// [PALE-GUARD-BEGIN]';
    const endMark = '// [PALE-GUARD-END]';
    const start = src.indexOf(startMark);
    const end = src.indexOf(endMark, start < 0 ? 0 : start);
    if (start < 0 || end < 0) {
        return { ok: false, reason: 'Marker nicht gefunden (' + (start < 0 ? 'BEGIN' : 'END') + ' fehlt)' };
    }
    const guard = literalsFromJavaBlock(src.slice(start, end + endMark.length));
    const missing = missingAnchors(guard);
    if (missing.length) {
        return { ok: false, reason: 'Marker gefunden, Extrakt unvollständig (fehlende Anker: ' + missing.join(', ') + ')' };
    }
    return { ok: true, guard: guard };
}

// Fallback: die ursprünglichen Fragment-Literale, solange dieser Weg noch
// existiert (Aktion 5 hält beide Wege per Byte-Gleichheits-Test synchron).
function extractGuardViaLiterals(src) {
    const startMark = '"(function(){" +';
    const endMark = '"})()", null);';
    const start = src.indexOf(startMark);
    const end = src.indexOf(endMark, start < 0 ? 0 : start);
    if (start < 0 || end < 0) {
        return { ok: false, reason: 'Literal-Fragmente nicht gefunden (gesucht: ' + startMark + ')' };
    }
    const guard = literalsFromJavaBlock(src.slice(start, end + '"})()"'.length));
    const missing = missingAnchors(guard);
    if (missing.length) {
        return { ok: false, reason: 'Literal-Fallback gefunden, Extrakt unvollständig (fehlende Anker: ' + missing.join(', ') + ')' };
    }
    return { ok: true, guard: guard };
}

function extractGuard() {
    const src = fs.readFileSync(JAVA, 'utf8');
    const viaMarker = extractGuardViaMarkers(src);
    if (viaMarker.ok) return viaMarker.guard;
    const viaLiteral = extractGuardViaLiterals(src);
    if (viaLiteral.ok) return viaLiteral.guard;
    throw new Error('Wächter-Block in MainActivity.java nicht extrahierbar - '
        + 'Marker-Weg: ' + viaMarker.reason + ' | '
        + 'Literal-Fallback: ' + viaLiteral.reason);
}

function unescapeJava(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === BS && i + 1 < s.length) {
            const n = s[i + 1];
            if (n === BS) out += BS;
            else if (n === '"') out += '"';
            else if (n === 'n') out += '\n';
            else if (n === 't') out += '\t';
            else out += n;
            i++;
            continue;
        }
        out += s[i];
    }
    return out;
}

// ---- Statische Source-Checks: Fallback-Reihenfolge + Pflicht-Logging ----
// HttpURLConnection/Dateizugriffe lassen sich nicht sinnvoll in vm simulieren
// (Technik 3 aus docs/roadmap/patterns/good/eingebetteten-code-exakt-testen.md)
// - deshalb wird hier der rohe Java-Quelltext per Klammer-Balance ab der
// Methoden-/Klassensignatur extrahiert und als Text geprüft, kein vm-Play.
function extractBraceBlock(src, signature) {
    const sigIdx = src.indexOf(signature);
    if (sigIdx < 0) {
        throw new Error('Signatur nicht gefunden: ' + signature);
    }
    const braceStart = src.indexOf('{', sigIdx);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(braceStart, i + 1);
        }
    }
    throw new Error('Keine schließende Klammer gefunden für: ' + signature);
}

// ---- Fake-Browser --------------------------------------------------------
// appendChild führt textContent aus, wie ein echtes inline-<script>.
// BEWUSST kein Function aus diesem Scope in die Sandbox geben: der vm-Kontext
// bringt seine eigene mit und verhält sich wie die des Browsers (kompiliert im
// globalen Scope der Seite).
function makeSandbox(opts) {
    opts = opts || {};
    const sandbox = {};
    sandbox.window = sandbox;
    sandbox.setTimeout = setTimeout;
    sandbox.innerWidth = 420;      // Hochformat, wie die App läuft
    sandbox.innerHeight = 900;
    sandbox.__pt_buf = ['globalThis.__PALE_RAN=1;'];   // der "PaleTools"-Code
    // Testhooks für die Zeitschwellen (Ticks à 250ms), sonst müsste der Test
    // 2 bzw. 30 Minuten warten.
    if (opts.softAfter !== undefined) sandbox.__pt_soft_after = opts.softAfter;
    if (opts.hardAfter !== undefined) sandbox.__pt_hard_after = opts.hardAfter;
    const keys = (opts.lsKeys || []).slice();
    sandbox.localStorage = {
        get length() { return keys.length; },
        key: function (i) { return keys[i]; }
    };
    const paletoolsEls = [];
    for (let i = 0; i < (opts.domEls || 0); i++) {
        paletoolsEls.push({
            offsetParent: null,
            getClientRects: () => (i < (opts.domVisible || 0) ? [{}] : [])
        });
    }
    sandbox.document = {
        body: {},
        documentElement: { appendChild: function () {} },
        head: {
            appendChild: function (node) {
                if (opts.cspBlocksInline) return;      // still nichts tun
                vm.runInContext(node.textContent, sandbox.__ctx);
            }
        },
        createElement: function () { return { textContent: '', parentNode: null }; },
        querySelectorAll: function (sel) {
            if (sel.indexOf('paletools') >= 0) return paletoolsEls;
            if (sel.indexOf('ut-tab-bar') >= 0) return new Array(opts.tabBars || 0);
            return [];
        }
    };
    return sandbox;
}

function start(guard, opts) {
    const sandbox = makeSandbox(opts);
    const ctx = vm.createContext(sandbox);
    sandbox.__ctx = ctx;
    vm.runInContext(guard, ctx);
    return { sandbox: sandbox, ctx: ctx };
}

// Die EA-App wird "bereit": tragende Symbole. UIItemActionEvent bewusst
// separat - es ist der unsichere Marker.
function appReady(ctx, withItemActionEvent) {
    vm.runInContext('var services={};var getAppMain=function(){};'
        + 'var UTStandardButtonControl={};', ctx);
    if (withItemActionEvent) vm.runInContext('var UIItemActionEvent={};', ctx);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function ok(name, cond, detail) {
    console.log((cond ? '  ok  ' : '  FEHLER  ') + name + (detail ? ': ' + detail : ''));
    if (!cond) failed++;
}

// ---- Tests ---------------------------------------------------------------
(async function main() {
    // 0. Regression: CRLF-Zeilenenden (wie sie ein core.autocrlf=true-Checkout
    //    erzeugt) dürfen keine Anführungszeichen-Fragmente aus Kommentaren in
    //    den extrahierten Code durchlassen - unabhängig davon, ob der eigene
    //    Checkout gerade CRLF oder LF verwendet.
    const crlfBlock = 'code +\r\n'
        + '"a(" + // Kommentar mit "Anfuehrungszeichen" drin\r\n'
        + '"1)";\r\n';
    ok('CRLF-Block: Kommentar-Anführungszeichen bleiben draußen',
        literalsFromJavaBlock(crlfBlock) === 'a(1)',
        JSON.stringify(literalsFromJavaBlock(crlfBlock)));

    // 0b. Byte-Gleichheit Marker- vs. Literal-Pfad (lift-plan android-app-
    //     wrapper, Aktion 4/5): solange beide Extraktionswege existieren,
    //     muss ein Reformat, das nur einen der beiden bricht, durch die
    //     jeweils andere Fehlermeldung auffallen statt eine STILLE
    //     Divergenz zu erzeugen. Vergleich auf dem bereits normalisierten
    //     Ergebnis (nach literalsFromJavaBlock/unescapeJava), kein Rohtext-
    //     Diff über die CRLF-behaftete Java-Quelle selbst.
    const guardSrc = fs.readFileSync(JAVA, 'utf8');
    const viaMarker = extractGuardViaMarkers(guardSrc);
    const viaLiteral = extractGuardViaLiterals(guardSrc);
    ok('Marker-Pfad liefert ein vollständiges Extrakt', viaMarker.ok, viaMarker.reason);
    ok('Literal-Pfad liefert ein vollständiges Extrakt', viaLiteral.ok, viaLiteral.reason);
    ok('Marker- und Literal-Pfad liefern byte-identisches Extrakt',
        viaMarker.ok && viaLiteral.ok && viaMarker.guard === viaLiteral.guard,
        viaMarker.ok && viaLiteral.ok
            ? 'Marker-Länge=' + viaMarker.guard.length + ' Literal-Länge=' + viaLiteral.guard.length
            : 'einer der beiden Pfade lieferte kein Ergebnis');

    const guard = extractGuard();

    // 1. Syntax
    try {
        new vm.Script(guard);
        ok('Syntax', true, guard.length + ' Zeichen gültiges JS');
    } catch (e) {
        ok('Syntax', false, e.message);
    }

    // 2. Ohne EA-Klassen NICHT ausführen. Das war der erste Live-Fehler:
    //    "UIItemActionEvent is not defined", weil zu früh injiziert wurde.
    const a = start(guard, {});
    await wait(600);
    ok('wartet ohne EA-Klassen', !a.sandbox.__pt_status && !a.sandbox.__PALE_RAN,
        'wait=' + a.sandbox.__pt_wait);
    ok('meldet, worauf gewartet wird', /fehlt: services/.test(a.sandbox.__pt_wait || ''),
        a.sandbox.__pt_wait);
    ok('Puffer bleibt erhalten, solange nicht ausgeführt',
        Array.isArray(a.sandbox.__pt_buf), 'buf=' + typeof a.sandbox.__pt_buf);

    // 3. Sind alle Symbole da, wird ausgeführt - auch wenn es lange dauert
    //    (im Live-Log kam die App erst nach über einer Minute).
    const b = start(guard, {});
    await wait(1200);
    appReady(b.ctx, true);
    await wait(600);
    ok('führt aus, sobald EA-Klassen da sind', b.sandbox.__PALE_RAN === 1);
    ok('Status "geladen"', /^geladen \(\d+ Zeichen\)$/.test(b.sandbox.__pt_status || ''),
        JSON.stringify(b.sandbox.__pt_status));
    ok('Puffer nach Erfolg freigegeben', b.sandbox.__pt_buf === null);

    // 4. Fehlt NUR UIItemActionEvent, wird nach SOFT trotzdem gestartet -
    //    das Symbol könnte in dieser FC-Version gar nicht existieren.
    const c = start(guard, { softAfter: 2 });
    appReady(c.ctx, false);
    await wait(1500);
    ok('startet ohne UIItemActionEvent nach SOFT', c.sandbox.__PALE_RAN === 1);
    ok('Status vermerkt das fehlende Symbol',
        /ohne UIItemActionEvent/.test(c.sandbox.__pt_status || ''),
        JSON.stringify(c.sandbox.__pt_status));

    // 5. Fehlen tragende Symbole dauerhaft, wird NICHT ausgeführt (der Versuch
    //    darf nicht verbrannt werden - genau das ist in v1.4.1 passiert).
    const d = start(guard, { hardAfter: 3 });
    await wait(1500);
    ok('gibt auf, ohne auszuführen', !d.sandbox.__PALE_RAN);
    ok('Status nennt die fehlenden Symbole',
        /^NICHT ausgefuehrt, fehlt dauerhaft: .*services/.test(d.sandbox.__pt_status || ''),
        JSON.stringify(d.sandbox.__pt_status));
    ok('Puffer nach Aufgeben noch da (erneuter Versuch möglich)',
        Array.isArray(d.sandbox.__pt_buf));

    // 6. Blockt eine CSP das inline-<script>, muss new Function übernehmen -
    //    das passiert STILL, ohne Exception, daher der Sentinel im Code.
    const e = start(guard, { cspBlocksInline: true });
    appReady(e.ctx, true);
    await wait(600);
    ok('CSP-Fallback (new Function) greift', e.sandbox.__PALE_RAN === 1);
    ok('Status auch im Fallback "geladen"', /^geladen /.test(e.sandbox.__pt_status || ''),
        JSON.stringify(e.sandbox.__pt_status));

    // 7. Die Nachkontrolle (~6s später) ist die eigentliche Diagnose: sie muss
    //    "läuft nicht" von "läuft, aber unsichtbar" unterscheiden. Fällt sie
    //    still aus, fehlt genau die Information, für die sie da ist.
    const f = start(guard, {
        lsKeys: ['paletools:settings', 'paletools:storage:version', 'fremd:key'],
        domEls: 5, domVisible: 2, tabBars: 1
    });
    appReady(f.ctx, true);
    await wait(7000);
    const st = f.sandbox.__pt_status || '';
    ok('Nachkontrolle läuft ohne Fehler', st.indexOf('Nachkontrolle:') < 0, st);
    ok('Nachkontrolle zählt localStorage-Keys', /LS-Keys:2\b/.test(st), st);
    ok('Nachkontrolle zählt DOM + Sichtbarkeit', /DOM:5 sichtbar:2/.test(st), st);
    ok('Nachkontrolle meldet Ausrichtung', /orient:hoch/.test(st), st);

    // 8. ScriptLoader-Fallback-Reihenfolge (siehe
    //    docs/roadmap/patterns/good/ea-grenz-fallback-ketten.md): Optimizer
    //    Download -> Cache -> gebündeltes Asset, PaleTools Cache -> Download.
    const javaSrc = fs.readFileSync(JAVA, 'utf8');
    const loaderBody = extractBraceBlock(javaSrc, 'class ScriptLoader');
    const idxFetch = loaderBody.indexOf('a.fetchUrl(sbcUrl)');
    const idxReadCacheSbc = loaderBody.indexOf('a.readCache("sbc.js")');
    const idxReadAsset = loaderBody.indexOf('a.readAsset("sbc-optimizer.user.js")');
    ok('ScriptLoader Optimizer-Reihenfolge: fetchUrl vor readCache vor readAsset',
        idxFetch >= 0 && idxReadCacheSbc >= 0 && idxReadAsset >= 0
            && idxFetch < idxReadCacheSbc && idxReadCacheSbc < idxReadAsset,
        'fetch=' + idxFetch + ' readCache=' + idxReadCacheSbc + ' readAsset=' + idxReadAsset);

    const idxReadCachePale = loaderBody.indexOf('a.readCache("pale.js")');
    const idxFetchIfChanged = loaderBody.indexOf('a.fetchUrlIfChanged(paleUrl,');
    ok('ScriptLoader PaleTools-Reihenfolge: readCache vor fetchUrlIfChanged',
        idxReadCachePale >= 0 && idxFetchIfChanged >= 0 && idxReadCachePale < idxFetchIfChanged,
        'readCache=' + idxReadCachePale + ' fetchUrlIfChanged=' + idxFetchIfChanged);

    // 9. Pflicht-Logging: jede Netz-/Cache-Methode ruft addLog oder
    //    reportNetError auf (siehe
    //    docs/roadmap/patterns/bad/fehler-unsichtbar-verschluckt.md) - ein
    //    stiller Catch/Early-Return ohne Log-Aufruf lässt den Grund eines
    //    Download-/Cache-Fehlschlags im einzigen Diagnosekanal verschwinden.
    const loggedMethods = [
        ['fetchUrl', 'String fetchUrl(String u) {'],
        ['fetchUrlIfChanged', 'String fetchUrlIfChanged(String u, String etagKey, String modKey) {'],
        ['readAsset', 'String readAsset(String name) {'],
        ['readCache', 'String readCache(String name) {'],
        ['writeCache', 'void writeCache(String name, String content) {'],
        ['appVersion', 'String appVersion() {']
    ];
    for (const [name, signature] of loggedMethods) {
        const body = extractBraceBlock(javaSrc, signature);
        ok('Pflicht-Logging in ' + name,
            /addLog\(|reportNetError\(/.test(body),
            name + ' ruft weder addLog noch reportNetError auf');
    }

    // 10. Aktion 1 (lift-plan android-app-wrapper): 304 ist kein Fehler -
    //     reportNetNote([net-ok]) statt des fehler-benannten reportNetError.
    //     Die Zeile muss sichtbar bleiben (Rasmus liest daran den
    //     PaleTools-Hintergrund-Refresh ab, docs/LEARNINGS.md §20) - nur das
    //     Praefix wechselt.
    const reportNetNoteBody = extractBraceBlock(javaSrc, 'void reportNetNote(String where, String detail) {');
    ok('reportNetNote nutzt das [net-ok]-Präfix',
        /addLog\("\[net-ok\] "/.test(reportNetNoteBody), reportNetNoteBody);
    const fetchIfChangedBody = extractBraceBlock(javaSrc,
        'String fetchUrlIfChanged(String u, String etagKey, String modKey) {');
    const idx304 = fetchIfChangedBody.indexOf('code == 304');
    const idxNot200 = fetchIfChangedBody.indexOf('code != 200', idx304);
    const branch304 = idx304 >= 0 && idxNot200 > idx304
        ? fetchIfChangedBody.slice(idx304, idxNot200) : '';
    ok('304-Zweig in fetchUrlIfChanged ruft reportNetNote statt reportNetError',
        /reportNetNote\(/.test(branch304) && !/reportNetError\(/.test(branch304),
        branch304);

    // 11. Aktion 2: scriptSbc/scriptPale/paleSource laufen ausschließlich
    //     über setLoadedScripts() - keine externe Feldzuweisung mehr.
    const setLoadedScriptsBody = extractBraceBlock(javaSrc,
        'void setLoadedScripts(String sbc, String pale, String source) {');
    ok('setLoadedScripts loggt (nur bei tatsächlicher Änderung)',
        /addLog\(/.test(setLoadedScriptsBody), setLoadedScriptsBody);
    const srcWithoutSetter = javaSrc.replace(setLoadedScriptsBody, '');
    const externalAssignRe = /\.(scriptSbc|scriptPale|paleSource)\s*=(?!=)/;
    const externalAssignMatch = srcWithoutSetter.match(externalAssignRe);
    ok('keine .scriptSbc=/.scriptPale=/.paleSource=-Zuweisung außerhalb des Setters',
        !externalAssignMatch, externalAssignMatch && externalAssignMatch[0]);
    const scriptLoaderBody = extractBraceBlock(javaSrc, 'class ScriptLoader implements Runnable {');
    ok('ScriptLoader.run() nutzt setLoadedScripts',
        /a\.setLoadedScripts\(sbc, pale, source\)/.test(scriptLoaderBody), scriptLoaderBody);
    const settingsSaveBody = extractBraceBlock(javaSrc, 'class SettingsSave implements DialogInterface.OnClickListener {');
    ok('SettingsSave.onClick() nutzt setLoadedScripts(null, null, null)',
        /a\.setLoadedScripts\(null,\s*null,\s*null\)/.test(settingsSaveBody), settingsSaveBody);

    // 12. Aktion 3: SbcWebViewClient bekommt onReceivedError/onReceivedHttpError
    //     (bisher einzige Fremd-Grenze ganz ohne Diagnose-Spur), beide loggend.
    const webViewClientBody = extractBraceBlock(javaSrc,
        'class SbcWebViewClient extends android.webkit.WebViewClient {');
    const onReceivedErrorBody = extractBraceBlock(webViewClientBody, 'public void onReceivedError(');
    ok('onReceivedError existiert und loggt über addLog',
        /addLog\(/.test(onReceivedErrorBody), onReceivedErrorBody);
    const onReceivedHttpErrorBody = extractBraceBlock(webViewClientBody, 'public void onReceivedHttpError(');
    ok('onReceivedHttpError existiert und loggt über addLog',
        /addLog\(/.test(onReceivedHttpErrorBody), onReceivedHttpErrorBody);

    // 13. Aktion 4: readStream liefert nie null (nur ""), also muss der
    //     Leer-Body-Schutz auf isEmpty() prüfen statt auf den strukturell nie
    //     zutreffenden Vergleich mit null - fetchUrl bekommt denselben Schutz,
    //     der ihm bisher komplett fehlte.
    ok('fetchUrlIfChanged prüft body.isEmpty() statt body == null',
        /body\.isEmpty\(\)/.test(fetchIfChangedBody) && !/body == null/.test(fetchIfChangedBody),
        fetchIfChangedBody);
    const fetchUrlBody = extractBraceBlock(javaSrc, 'String fetchUrl(String u) {');
    ok('fetchUrl hat einen eigenen Leer-Body-Check ("leerer Body") mit return null',
        /isEmpty\(\)/.test(fetchUrlBody) && /"leerer Body"/.test(fetchUrlBody)
            && /isEmpty\(\)[\s\S]*?return null;/.test(fetchUrlBody),
        fetchUrlBody);

    // ======================================================================
    // 14. JS_BACK und JS_FILL_LOGIN (App 1.9.0)
    // ======================================================================
    // Beide sind - wie der Wächter - aus Java-String-Literalen zusammengesetzt
    // und fallen am Gerät STILL aus, wenn ein Selektor oder eine Klammer nicht
    // stimmt. Also: aus der Quelle holen und in einem Fake-DOM ausführen.
    function jsConst(name) {
        const at = javaSrc.indexOf('static final String ' + name + ' =');
        if (at < 0) throw new Error('Konstante ' + name + ' nicht gefunden');
        const end = javaSrc.indexOf('";', at);
        return literalsFromJavaBlock(javaSrc.slice(at, end + 1));
    }

    // ---- Fake-DOM-Baukasten ---------------------------------------------
    function el(opts) {
        opts = opts || {};
        const listeners = {};
        const self = {
            className: opts.cls || '',
            tagName: opts.tag || 'DIV',
            value: opts.value != null ? opts.value : '',
            offsetParent: opts.hidden ? null : {},
            getClientRects: () => (opts.hidden ? [] : [{}]),
            getBoundingClientRect: () => opts.rect || { left: 0, top: 0, width: 200, height: 40 },
            addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
            dispatchEvent: (ev) => {
                self.events.push(ev && ev.type);
                (listeners[(ev && ev.type)] || []).forEach(f => f(ev));
                return !(opts.prevent && opts.prevent.indexOf(ev && ev.type) > -1);
            },
            events: [],
            constructor: { prototype: {} }
        };
        return self;
    }
    function makeDom(map) {
        return {
            querySelector: (sel) => (map[sel] ? map[sel][0] : null),
            querySelectorAll: (sel) => (map[sel] || [])
        };
    }
    function runJs(code, extra) {
        const sandbox = Object.assign({
            window: {},
            document: makeDom({}),
            Event: function (t, o) { this.type = t; Object.assign(this, o || {}); },
            MouseEvent: function (t, o) { this.type = t; Object.assign(this, o || {}); },
            Object: Object, String: String, Math: Math, JSON: JSON
        }, extra || {});
        sandbox.window.innerWidth = 400;
        sandbox.window.innerHeight = 900;
        sandbox.window = Object.assign(sandbox.window, extra && extra.window ? extra.window : {});
        return vm.runInNewContext('(' + JSON.stringify('x') + ', ' + code + ')', sandbox);
    }

    // ---- JS_BACK ---------------------------------------------------------
    const jsBack = jsConst('JS_BACK');
    ok('JS_BACK: extrahiert und syntaktisch gültig',
        (function () { try { new Function('return ' + jsBack); return true; }
                       catch (e) { return 'Syntaxfehler: ' + e.message; } })() === true,
        jsBack.slice(0, 160));

    // (a) Offener Dialog -> Dialog schliessen, NICHT navigieren.
    {
        let closed = 0;
        const dlg = el({ cls: 'ea-dialog-view', rect: { left: 0, top: 0, width: 400, height: 800 } });
        const res = runJs(jsBack, {
            window: { gPopupClickShield: { closeActivePopup: () => { closed++; } },
                      innerWidth: 400, innerHeight: 900 },
            document: makeDom({ '[class*="click-shield"],[class*="dialog"],[class*="popup"]': [dlg] })
        });
        ok('JS_BACK: offener Dialog wird geschlossen', res === 'popup' && closed === 1,
            res + ' closed=' + closed);
    }
    // (b) Unsere eigene UI (sbc-opt) zaehlt NICHT als Dialog.
    {
        let closed = 0;
        const own = el({ cls: 'sbc-opt-panel', rect: { left: 0, top: 0, width: 400, height: 800 } });
        const res = runJs(jsBack, {
            window: { gPopupClickShield: { closeActivePopup: () => { closed++; } },
                      innerWidth: 400, innerHeight: 900 },
            document: makeDom({ '[class*="click-shield"],[class*="dialog"],[class*="popup"]': [own] })
        });
        ok('JS_BACK: eigenes Panel wird nicht als Dialog geschlossen',
            closed === 0 && res === 'none', res + ' closed=' + closed);
    }
    // (c) EAs Navigation: obersten Controller mit pop* nehmen.
    {
        const calls = [];
        const inner = { popViewController: (a) => { calls.push('inner:' + a); } };
        const root = { getPresentedViewController: () => inner,
                       popViewController: () => { calls.push('root'); } };
        const res = runJs(jsBack, {
            window: { innerWidth: 400, innerHeight: 900 },
            getAppMain: () => ({ getRootViewController: () => root }),
            document: makeDom({})
        });
        ok('JS_BACK: EAs eigene Navigation wird benutzt (oberster Controller)',
            res === 'pop:popViewController' && calls.length === 1 && calls[0] === 'inner:true',
            res + ' ' + JSON.stringify(calls));
    }
    // (d) Kein Controller -> Zurueck-Knopf im DOM, Touch zuerst.
    {
        const btn = el({ tag: 'BUTTON', cls: 'back', prevent: ['touchend'] });
        const dom = makeDom({ '.ut-navigation-bar-view button.back': [btn] });
        const res = runJs(jsBack, {
            window: { innerWidth: 400, innerHeight: 900,
                      Touch: function (o) { Object.assign(this, o); },
                      TouchEvent: function (t, o) { this.type = t; Object.assign(this, o || {}); } },
            document: dom
        });
        ok('JS_BACK: DOM-Zurueck-Knopf wird getippt',
            String(res).indexOf('dom:') === 0, res);
        ok('JS_BACK: Touch zuerst, keine Maus-Events wenn Touch verarbeitet',
            btn.events.indexOf('touchstart') > -1 && btn.events.indexOf('click') === -1,
            btn.events.join(','));
    }
    // (e) Nichts da -> 'none', damit Java die History bzw. den Doppel-Tipp nimmt.
    {
        const res = runJs(jsBack, { window: { innerWidth: 400, innerHeight: 900 },
                                    document: makeDom({}) });
        ok('JS_BACK: ohne alles kommt "none" zurueck', res === 'none', String(res));
    }

    // ---- JS_FILL_LOGIN ---------------------------------------------------
    const jsFill = jsConst('JS_FILL_LOGIN');
    ok('JS_FILL_LOGIN: Platzhalter sind unversehrt',
        jsFill.indexOf('__MAIL__') > -1 && jsFill.indexOf('__PW__') > -1, jsFill.slice(0, 120));
    const filled = jsFill.replace('__MAIL__', '"a@b.de"').replace('__PW__', '"geheim"');
    ok('JS_FILL_LOGIN: syntaktisch gültig',
        (function () { try { new Function('return ' + filled); return true; }
                       catch (e) { return 'Syntaxfehler: ' + e.message; } })() === true,
        filled.slice(0, 160));
    {
        const mail = el({ tag: 'INPUT' });
        const pass = el({ tag: 'INPUT' });
        const res = runJs(filled, {
            document: makeDom({ '#email': [mail], '#password': [pass] }),
            window: { innerWidth: 400, innerHeight: 900 }
        });
        ok('JS_FILL_LOGIN: beide Felder gefüllt', res === 'mail+pw', String(res));
        ok('JS_FILL_LOGIN: Werte stehen in den Feldern',
            mail.value === 'a@b.de' && pass.value === 'geheim',
            mail.value + ' / ' + pass.value);
        ok('JS_FILL_LOGIN: input- UND change-Event ausgelöst (React hört darauf)',
            mail.events.indexOf('input') > -1 && mail.events.indexOf('change') > -1,
            mail.events.join(','));
    }
    {
        const res = runJs(filled, { document: makeDom({}), window: {} });
        ok('JS_FILL_LOGIN: ohne Felder kommt "no-fields"', res === 'no-fields', String(res));
    }

    // ---- Java-Seite: kein Passwort im Log, kein Autofill ohne Daten ------
    const autofillBody = extractBraceBlock(javaSrc, 'void maybeAutofillLogin(String url) {');
    ok('Autofill: schreibt das Passwort NICHT in den Log',
        /addLog\(/.test(autofillBody) && !/addLog\([^)]*pwTxt/.test(autofillBody),
        autofillBody);
    ok('Autofill: nur auf Login-URLs und nur mit gespeicherten Daten',
        /isLoginUrl\(url\)/.test(autofillBody) && /loginAutofill/.test(autofillBody)
            && /blob == null/.test(autofillBody),
        autofillBody);
    ok('Autofill: sendet das Formular NICHT ab (kein submit/click im JS)',
        !/\.submit\(\)/.test(jsFill) && !/logInBtn/.test(jsFill), jsFill.slice(0, 200));

    const saveBody = extractBraceBlock(javaSrc,
        'void saveLogin(String mailTxt, String pwTxt, boolean autofill) {');
    ok('Login speichern: Passwort nur verschlüsselt (CredStore.encrypt)',
        /CredStore\.encrypt\(pwTxt\)/.test(saveBody) && !/putString\("loginPw", *pwTxt/.test(saveBody),
        saveBody);
    ok('Login speichern: leeres Feld lässt das gemerkte Passwort stehen',
        /pwTxt\.length\(\) > 0/.test(saveBody), saveBody);

    const credBody = extractBraceBlock(javaSrc, 'class CredStore {');
    ok('CredStore: Schlüssel im AndroidKeyStore, AES/GCM',
        /AndroidKeyStore/.test(credBody) && /AES\/GCM\/NoPadding/.test(credBody), credBody);
    ok('CredStore: IV pro Verschlüsselung neu (c.getIV() statt fester Wert)',
        /c\.getIV\(\)/.test(credBody), credBody);
    ok('CredStore: löscht auch den Schlüssel',
        /deleteEntry\(ALIAS\)/.test(credBody), credBody);

    const backBody = extractBraceBlock(javaSrc, 'void handleBackResult(String res) {');
    ok('Zurück: bei "none" erst History, dann Doppel-Tipp zum Beenden',
        /canGoBack\(\)/.test(backBody) && /lastBackMs/.test(backBody) && /finish\(\)/.test(backBody),
        backBody);
    ok('Zurück: beendet NICHT beim ersten Wischen',
        /Nochmal zurueck/.test(backBody), backBody);

    console.log(failed
        ? '\n' + failed + ' Test(s) fehlgeschlagen.'
        : '\nAlle Wächter-Tests bestanden.');
    process.exit(failed ? 1 : 0);
})();
