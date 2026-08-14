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

function extractGuard() {
    const src = fs.readFileSync(JAVA, 'utf8');
    const startMark = '"(function(){" +';
    const endMark = '"})()", null);';
    const start = src.indexOf(startMark);
    const end = src.indexOf(endMark, start);
    if (start < 0 || end < 0) {
        throw new Error('Wächter-Block in MainActivity.java nicht gefunden - '
            + 'Markierungen geändert? Gesucht: ' + startMark);
    }
    const block = src.slice(start, end + '"})()"'.length);
    return literalsFromJavaBlock(block);
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

    console.log(failed
        ? '\n' + failed + ' Test(s) fehlgeschlagen.'
        : '\nAlle Wächter-Tests bestanden.');
    process.exit(failed ? 1 : 0);
})();
