/**
 * Test für den App-seitigen Log-Ringpuffer aus MainActivity.java
 * (addLog/buildLogReport, CLAUDE.md-Debugging-Konvention Kanal 2 - das App-Log).
 *
 * Aufruf:  node app/log-test.js
 *
 * Warum es diesen Test gibt: addLog/buildLogReport hatten bisher keinen
 * einzigen Testfall (Gap-Report diagnose-werkzeuge, Mangel 5). Java lässt sich
 * in Node nicht ausführen, deshalb folgt dieser Test demselben Prinzip wie
 * app/guard-test.js und solver-test.js (siehe
 * docs/roadmap/patterns/good/eingebetteten-code-exakt-testen.md): die
 * Ringpuffer-Grenzen (LOG_MAX/LOG_LINE_MAX) und der Kürzungs-Suffix werden per
 * Regex aus der echten Java-Quelle extrahiert (keine eigene, drift-fähige
 * Zahlenkopie), die Ringpuffer-LOGIK selbst wird als reine JS-Portierung
 * gegen Fixtures geprüft, und zusätzlich prüfen statische Regex-Checks auf
 * addLog()/buildLogReport(), dass Struktur und Kopf-Label im Java-Quelltext
 * noch dem entsprechen, was die JS-Portierung nachbildet - ändert sich dort
 * die Form, ohne dass dieser Test angepasst wird, schlägt er sichtbar fehl,
 * statt eine inzwischen falsche Nachbildung stillschweigend weiter grün zu
 * zeigen.
 *
 * Ändert NICHTS an MainActivity.java, liest die Datei nur.
 * Keine Dependencies.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const JAVA = path.join(__dirname, 'java', 'com', 'sbctools', 'browser', 'MainActivity.java');
const javaSrc = fs.readFileSync(JAVA, 'utf8');

// ---- Brace-Balance-Extraktion (identisches Prinzip wie app/guard-test.js) --
function extractBraceBlock(src, signature) {
    const sigIdx = src.indexOf(signature);
    if (sigIdx < 0) throw new Error('Signatur nicht gefunden: ' + signature);
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

// ---- Konstanten + Kürzungs-Suffix aus der Java-Quelle extrahieren ----------
// SSOT: keine eigene 400/600-Zahlenkopie (siehe
// docs/roadmap/patterns/bad/wissens-duplikate-ohne-ssot.md) - driftet die
// Java-Quelle, driftet dieser Test automatisch mit.
function extractIntConst(name) {
    const m = javaSrc.match(new RegExp('static final int ' + name + '\\s*=\\s*(\\d+)\\s*;'));
    if (!m) throw new Error('Konstante nicht gefunden: ' + name);
    return Number(m[1]);
}
const LOG_MAX = extractIntConst('LOG_MAX');
const LOG_LINE_MAX = extractIntConst('LOG_LINE_MAX');

const addLogBody = extractBraceBlock(javaSrc, 'void addLog(String line) {');
const suffixMatch = addLogBody.match(/substring\(0,\s*LOG_LINE_MAX\)\s*\+\s*"((?:[^"\\]|\\.)*)"/);
if (!suffixMatch) throw new Error('Kürzungs-Suffix in addLog() nicht gefunden');
const TRUNC_SUFFIX = suffixMatch[1];

const buildLogReportBody = extractBraceBlock(javaSrc, 'String buildLogReport() {');

// ---- Reine JS-Portierung der Ringpuffer-Logik, parametrisiert -------------
function makeRingBuffer() {
    const logLines = [];
    function addLog(line) {
        if (line == null) return;
        if (line.length > LOG_LINE_MAX) line = line.slice(0, LOG_LINE_MAX) + TRUNC_SUFFIX;
        logLines.push(line);
        while (logLines.length > LOG_MAX) logLines.shift();
    }
    return { addLog: addLog, logLines: logLines };
}

let failed = 0;
function ok(name, cond, detail) {
    console.log((cond ? '  ok  ' : '  FEHLER  ') + name + (detail ? ': ' + detail : ''));
    if (!cond) failed++;
}

// ---- Tests ------------------------------------------------------------------

// 1. Konstanten wie im Live-Report dokumentiert (CLAUDE.md: "Ringpuffer (400
//    Zeilen)").
ok('LOG_MAX aus der Java-Quelle extrahiert', LOG_MAX === 400, 'LOG_MAX=' + LOG_MAX);
ok('LOG_LINE_MAX aus der Java-Quelle extrahiert', LOG_LINE_MAX > 0, 'LOG_LINE_MAX=' + LOG_LINE_MAX);
ok('Kürzungs-Suffix extrahiert', TRUNC_SUFFIX.length > 0, JSON.stringify(TRUNC_SUFFIX));

// 2. Struktureller Check: addLog() folgt noch der Form, die die JS-Portierung
//    nachbildet (Kürzung VOR dem Puffern, FIFO-Eviction am Kopf).
ok('addLog() kürzt lange Zeilen auf LOG_LINE_MAX',
    /if\s*\(\s*line\.length\(\)\s*>\s*LOG_LINE_MAX\s*\)/.test(addLogBody), addLogBody);
ok('addLog() verwirft die älteste Zeile bei Überschreiten von LOG_MAX',
    /while\s*\(\s*logLines\.size\(\)\s*>\s*LOG_MAX\s*\)\s*logLines\.remove\(0\)/.test(addLogBody),
    addLogBody);

// 3. Ringpuffer-Verhalten gegen Fixtures.
{
    const rb = makeRingBuffer();
    for (let i = 0; i < 401; i++) rb.addLog('Zeile ' + i);
    ok('401 Zeilen geschrieben: Puffer bleibt auf LOG_MAX begrenzt',
        rb.logLines.length === LOG_MAX, 'length=' + rb.logLines.length);
    ok('401 Zeilen geschrieben: die ERSTE Zeile ("Zeile 0") ist evicted',
        rb.logLines.indexOf('Zeile 0') === -1);
    ok('401 Zeilen geschrieben: die LETZTE Zeile ("Zeile 400") ist noch da',
        rb.logLines[rb.logLines.length - 1] === 'Zeile 400', rb.logLines[rb.logLines.length - 1]);
}
{
    const rb = makeRingBuffer();
    const longLine = 'x'.repeat(700);
    rb.addLog(longLine);
    ok('700-Zeichen-Zeile wird auf LOG_LINE_MAX + Suffix gekürzt',
        rb.logLines[0] === longLine.slice(0, LOG_LINE_MAX) + TRUNC_SUFFIX,
        'len=' + rb.logLines[0].length);
    const shortLine = 'kurze Zeile';
    const rb2 = makeRingBuffer();
    rb2.addLog(shortLine);
    ok('Kurze Zeile bleibt unverändert', rb2.logLines[0] === shortLine, rb2.logLines[0]);
}

// 4. buildLogReport(): Kopfdaten-Label vollständig (Live-Report-Kontinuität -
//    CLAUDE.md nennt "App-Version, Gerät, Script-Größen und paleStatus" als
//    Kopf; ein still entferntes Label wäre für Rasmus nicht mehr auffindbar).
for (const label of ['App-Version', 'Android', 'Optimizer', 'PaleTools', 'PaleTools-Status']) {
    ok('buildLogReport()-Kopf enthält Label "' + label + '"',
        buildLogReportBody.indexOf('"' + label + ':') > -1 || buildLogReportBody.indexOf(label) > -1,
        label + ' fehlt im Kopf');
}

console.log(failed
    ? '\n' + failed + ' Test(s) fehlgeschlagen.'
    : '\nAlle Log-Ringpuffer-Tests bestanden.');
process.exit(failed ? 1 : 0);
