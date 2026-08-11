/**
 * Test für den PaleTools-Wächter aus MainActivity.java.
 *
 * Aufruf:  node app/guard-test.js     (aus dem Repo-Wurzelverzeichnis oder app/)
 *
 * Warum es diesen Test gibt: der Wächter ist ein aus Java-String-Literalen
 * zusammengesetztes JS-Programm. Ein Syntaxfehler oder ein Logikfehler darin
 * führt dazu, dass PaleTools STILL nicht lädt - man sieht am Gerät nichts,
 * nur "keine Rückmeldung". Deshalb wird der Code hier aus der Java-Quelle
 * extrahiert (gleiches Prinzip wie solver-test.js beim Userscript), auf
 * Syntax geprüft und in einem Fake-DOM durchgespielt.
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
    const lits = [];
    for (let line of block.split('\n')) {
        line = line.replace(/\/\/.*$/, '');           // Java-Zeilenkommentar
        const re = /"((?:[^"\\]|\\.)*)"/g;
        let m;
        while ((m = re.exec(line)) !== null) lits.push(m[1]);
    }
    return lits.map(unescapeJava).join('');
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
    // localStorage-Stub: so viele "paletools*"-Keys, wie der Test vorgibt -
    // daran erkennt die Nachkontrolle, ob PaleTools sich eingerichtet hat.
    const keys = (opts.lsKeys || []).slice();
    sandbox.localStorage = {
        get length() { return keys.length; },
        key: function (i) { return keys[i]; }
    };
    const paletoolsEls = [];
    for (let i = 0; i < (opts.domEls || 0); i++) {
        // getClientRects gefüllt = sichtbar
        paletoolsEls.push({ offsetParent: null, getClientRects: () => (i < (opts.domVisible || 0) ? [{}] : []) });
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

function makeEaClassesAppear(ctx) {
    vm.runInContext('var UIItemActionEvent={};var UTStandardButtonControl={};'
        + 'var services={};', ctx);
}

// ---- Tests ---------------------------------------------------------------
let failed = 0;
function ok(name, cond, detail) {
    console.log((cond ? '  ok  ' : '  FEHLER  ') + name + (detail ? ': ' + detail : ''));
    if (!cond) failed++;
}

const guard = extractGuard();

// 1. Syntax
let syntaxOk = true;
try { new vm.Script(guard); } catch (e) { syntaxOk = false; ok('Syntax', false, e.message); }
if (syntaxOk) ok('Syntax', true, guard.length + ' Zeichen gültiges JS');

// 2. Ohne EA-Klassen darf NICHT ausgeführt werden (das war der Live-Fehler:
//    "UIItemActionEvent is not defined", weil zu früh injiziert wurde).
const a = start(guard, {});
ok('wartet ohne EA-Klassen', !a.sandbox.__pt_status && !a.sandbox.__PALE_RAN,
    'Status=' + a.sandbox.__pt_status);

// 3. Erscheinen die Klassen später, wird ausgeführt und der Status gesetzt.
const b = start(guard, {});
setTimeout(function () { makeEaClassesAppear(b.ctx); }, 400);
setTimeout(function () {
    ok('führt aus, sobald EA-Klassen da sind', b.sandbox.__PALE_RAN === 1);
    ok('Status "geladen"', /^geladen \(\d+ Zeichen\)$/.test(b.sandbox.__pt_status || ''),
        JSON.stringify(b.sandbox.__pt_status));
    ok('Puffer freigegeben', b.sandbox.__pt_buf === null);

    // 4. Blockt eine CSP das inline-<script>, muss new Function übernehmen -
    //    das passiert STILL, ohne Exception, daher der Sentinel im Code.
    const c = start(guard, { cspBlocksInline: true });
    setTimeout(function () { makeEaClassesAppear(c.ctx); }, 300);
    setTimeout(function () {
        ok('CSP-Fallback (new Function) greift', c.sandbox.__PALE_RAN === 1);
        ok('Status auch im Fallback "geladen"', /^geladen /.test(c.sandbox.__pt_status || ''),
            JSON.stringify(c.sandbox.__pt_status));
        testNachkontrolle();
    }, 1200);
}, 1400);

// 5. Die Nachkontrolle (~6s nach dem Ausführen) ist die eigentliche Diagnose:
//    Sie muss "läuft nicht" von "läuft, aber unsichtbar" unterscheiden. Wenn
//    sie still in einen Fehler läuft, fehlt genau die Information, für die sie
//    da ist - deshalb wird sie hier mitgeprüft.
function testNachkontrolle() {
    const d = start(guard, {
        lsKeys: ['paletools:settings', 'paletools:storage:version', 'fremd:key'],
        domEls: 5, domVisible: 2, tabBars: 1
    });
    makeEaClassesAppear(d.ctx);
    setTimeout(function () {
        const st = d.sandbox.__pt_status || '';
        ok('Nachkontrolle läuft ohne Fehler', st.indexOf('Nachkontrolle:') < 0, st);
        ok('Nachkontrolle zählt localStorage-Keys', /LS-Keys:2\b/.test(st), st);
        ok('Nachkontrolle zählt DOM + Sichtbarkeit', /DOM:5 sichtbar:2/.test(st), st);
        ok('Nachkontrolle meldet Ausrichtung', /orient:hoch/.test(st), st);
        console.log(failed
            ? '\n' + failed + ' Test(s) fehlgeschlagen.'
            : '\nAlle Wächter-Tests bestanden.');
        process.exit(failed ? 1 : 0);
    }, 7000);
}
