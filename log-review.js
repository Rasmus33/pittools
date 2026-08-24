#!/usr/bin/env node
/**
 * log-review.js - Auswerte-Buchfuehrung fuer die vom Handy hochgeladenen Logs.
 *
 *   node log-review.js list       Welche Logs sind NEU (noch nicht ausgewertet)?
 *   node log-review.js fetch      Neue Logs herunterladen, Pfade ausgeben
 *   node log-review.js mark-all   Alle heruntergeladenen als ausgewertet buchen
 *   node log-review.js mark A B   Nur diese Dateien buchen
 *   node log-review.js status     Zaehlerstand (gesamt / ausgewertet / neu)
 *
 * Warum es das gibt: Rasmus soll "werte die neuesten logs aus" sagen koennen und
 * ich soll dann GENAU die auswerten, die ich noch nicht hatte - nicht alles
 * nochmal und nichts vergessen. Der Stand liegt dafuer NICHT auf meinem Rechner
 * (der wechselt pro Sitzung), sondern im Repo selbst:
 *
 *     logs/2026-08-24_201134_Pixel8Pro.txt      <- die App laedt hier hoch
 *     state/evaluated.json                      <- was schon ausgewertet ist
 *
 * Damit ist die Buchfuehrung sitzungsunabhaengig und fuer uns beide sichtbar.
 * Das Repo ist PRIVAT (im Log stehen EA-Nutzer-ID und Karten-IDs).
 *
 * Keine Dependencies; benutzt die gh-CLI (schon eingerichtet).
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = process.env.PITTOOLS_LOG_REPO || 'Rasmus33/pittools-logs';
const MARKER = 'state/evaluated.json';

function gh(args, allowFail) {
    try {
        // stderr abfangen statt durchreichen: bei allowFail ist ein 404 der
        // ERWARTETE Fall (leeres Repo, noch kein Marker) - gh' Meldung dazu
        // waere nur Rauschen vor der eigentlichen Ausgabe.
        return execFileSync('gh', args, {
            encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (e) {
        if (allowFail) return null;
        const msg = (e.stderr || e.stdout || e.message || '').toString().trim();
        throw new Error('gh ' + args.join(' ') + '\n' + msg);
    }
}

/** Alle Log-Dateinamen im Repo, aufsteigend (Dateiname ist ISO-artig). */
function listRemote() {
    const out = gh(['api', 'repos/' + REPO + '/contents/logs', '--jq', '.[].name'], true);
    if (out == null) return [];          // Ordner existiert noch nicht = keine Logs
    return out.split('\n').map(s => s.trim()).filter(Boolean).sort();
}

/** Marker lesen: { evaluated: [...], sha } - sha fuer das spaetere Update. */
function readMarker() {
    const out = gh(['api', 'repos/' + REPO + '/contents/' + MARKER], true);
    if (out == null) return { evaluated: [], sha: null };
    let j;
    try { j = JSON.parse(out); } catch (e) { return { evaluated: [], sha: null }; }
    let body = {};
    try {
        body = JSON.parse(Buffer.from(j.content || '', 'base64').toString('utf8'));
    } catch (e) { body = {}; }
    return {
        evaluated: Array.isArray(body.evaluated) ? body.evaluated : [],
        sha: j.sha || null
    };
}

function writeMarker(names, sha) {
    const body = JSON.stringify({
        evaluated: names.slice().sort(),
        count: names.length,
        updated: new Date().toISOString()
    }, null, 2) + '\n';
    const b64 = Buffer.from(body, 'utf8').toString('base64');
    const args = ['api', '-X', 'PUT', 'repos/' + REPO + '/contents/' + MARKER,
                  '-f', 'message=log-review: ' + names.length + ' Logs als ausgewertet gebucht',
                  '-f', 'content=' + b64];
    if (sha) args.push('-f', 'sha=' + sha);
    gh(args);
}

function newOnes() {
    const remote = listRemote();
    const m = readMarker();
    const done = new Set(m.evaluated);
    return { neu: remote.filter(n => !done.has(n)), alle: remote, marker: m };
}

function outDir() {
    const d = path.join(os.tmpdir(), 'pittools-logs');
    fs.mkdirSync(d, { recursive: true });
    return d;
}

const cmd = (process.argv[2] || 'list').toLowerCase();

if (cmd === 'status') {
    const s = newOnes();
    console.log('Repo      : ' + REPO);
    console.log('Logs total: ' + s.alle.length);
    console.log('ausgewertet: ' + s.marker.evaluated.length);
    console.log('NEU       : ' + s.neu.length);
} else if (cmd === 'list') {
    const s = newOnes();
    if (!s.neu.length) { console.log('Keine neuen Logs (' + s.alle.length + ' insgesamt).'); }
    else s.neu.forEach(n => console.log(n));
} else if (cmd === 'fetch') {
    const s = newOnes();
    if (!s.neu.length) { console.log('Keine neuen Logs.'); process.exit(0); }
    const dir = outDir();
    for (const n of s.neu) {
        const j = JSON.parse(gh(['api', 'repos/' + REPO + '/contents/logs/' + n]));
        const txt = Buffer.from(j.content || '', 'base64').toString('utf8');
        const p = path.join(dir, n);
        fs.writeFileSync(p, txt);
        console.log(p);
    }
    // Die Namen merken, damit "mark-all" genau diese bucht - und nicht
    // versehentlich Logs, die zwischendurch neu hochgeladen wurden.
    fs.writeFileSync(path.join(dir, '_fetched.json'), JSON.stringify(s.neu, null, 2));
} else if (cmd === 'mark-all' || cmd === 'mark') {
    let names;
    if (cmd === 'mark') {
        names = process.argv.slice(3);
        if (!names.length) { console.error('mark braucht Dateinamen.'); process.exit(1); }
    } else {
        const f = path.join(outDir(), '_fetched.json');
        if (!fs.existsSync(f)) { console.error('Erst "fetch" laufen lassen.'); process.exit(1); }
        names = JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    const m = readMarker();
    const merged = Array.from(new Set(m.evaluated.concat(names)));
    writeMarker(merged, m.sha);
    console.log(names.length + ' gebucht, jetzt ' + merged.length + ' insgesamt ausgewertet.');
} else {
    console.error('Unbekannt: ' + cmd + ' (list | fetch | mark-all | mark <datei...> | status)');
    process.exit(1);
}
