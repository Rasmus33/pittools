/*
 * Test-Harness für den SBC-Solver v4 (Ziel: minimales EXAKTES Dezimal-Rating,
 * Karten-Kosten als Sekundärziel im Überschuss-Fenster).
 * Extrahiert den [SOLVER-BEGIN]..[SOLVER-END]-Block aus dem Userscript
 * und testet GENAU den ausgelieferten Code (kein Duplikat).
 */
'use strict';
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8');
const m = src.match(/\/\/ \[SOLVER-BEGIN\]([\s\S]*?)\/\/ \[SOLVER-END\]/);
if (!m) { console.error('SOLVER-Block nicht gefunden!'); process.exit(1); }
const SolverCore = new Function(m[1] + '\nreturn SolverCore;')();

let failures = 0;
let tests = 0;
function check(name, cond, extra) {
    tests++;
    if (cond) { console.log('  ok  ' + name); }
    else { failures++; console.error('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

// ---------- Helpers ----------
let nextId = 1;
function P(rating, opts) {
    opts = opts || {};
    return {
        id: nextId++,
        assetId: opts.assetId != null ? opts.assetId : 100000 + nextId,
        rating: rating,
        // FUT-Standard: 0/1 = normale Karte, ab 2 = Special
        rareflag: opts.rareflag != null ? opts.rareflag : (opts.special ? 24 : 1),
        isGold: !opts.special,
        isSpecial: !!opts.special,
        isStorage: !!opts.storage,
        name: 'P' + rating + (opts.storage ? 'S' : '') + (opts.special ? 'X' : ''),
        groups: opts.groups || null,
        untradeable: !!opts.untradeable
    };
}
function many(n, rating, opts) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(P(rating, opts));
    return out;
}
function cfg(target, extra) {
    return Object.assign({
        targetOVR: target, slots: 11, minRating: 0,
        specialOnlyFromStorage: false,
        maxExpensiveEnabled: false, maxExpensiveCount: 0, expensiveThreshold: 99,
        scarcityWeight: 0, storageBonus: 0,
        maxOvershoot: 0.10, applyRarity: true,
        ratingCostSpec: '0-99:0',
        anchorId: null, rarityPickId: null,
        rarityConstraints: [], playerLevelConstraints: []
    }, extra || {});
}

// Karten-Kosten wie im Solver (Band + Scarcity, Storage halb minus Bonus,
// Rarity-Schutz-Aufschlag für Gruppe-83-Karten und Untradeable-Rabatt NACH dem
// Storage-Rabatt).
// MUSS synchron zu costOf() im Userscript bleiben - sonst vergleichen die
// Brute-Force-Tests gegen ein anderes Kostenmodell als der Solver benutzt.
function cardCostFn(pool, c) {
    let alpha = c.scarcityWeight || 0, beta = c.storageBonus || 0;
    if (alpha <= 0) alpha = 1e-6;
    if (beta <= 0) beta = 1e-7;
    const guard = Math.max(0, c.rarityGuardCost != null ? c.rarityGuardCost : 8);
    const untr = Math.max(0, c.untradeableBonus != null ? c.untradeableBonus : 3);
    const band = SolverCore.parseRatingCosts(
        c.ratingCostSpec != null ? c.ratingCostSpec : SolverCore.DEFAULT_RATING_COST_SPEC);
    const counts = new Map();
    for (const p of pool) counts.set(p.rating, (counts.get(p.rating) || 0) + 1);
    return function (p) {
        const n = counts.get(p.rating) || 1;
        const base = alpha / n + band(p.rating);
        const prot = guard > 0 && Array.isArray(p.groups) && p.groups.indexOf(83) > -1;
        return (p.isStorage ? (base / 2 - beta) : base) + (prot ? guard : 0)
               - (p.untradeable ? untr : 0);
    };
}

// Brute force über das V-Ziel (V = N² * exaktes Rating).
// Nur für Configs OHNE Reservierungen korrekt.
function bruteBest(pool, c) {
    const N = c.slots || 11;
    const T = c.targetOVR;
    const NEED = N * N * T - Math.floor(N / 2);
    const windowV = Math.round((c.maxOvershoot != null ? c.maxOvershoot : 0.10) * N * N);
    const cardCost = cardCostFn(pool, c);
    const n = pool.length;
    const feasible = [];
    const ratings = [];
    (function rec(start, cnt, cost) {
        if (cnt === N) {
            const V = SolverCore.squadV(ratings);
            if (V >= NEED) feasible.push({ V: V, cost: cost });
            return;
        }
        if (n - start < N - cnt) return;
        for (let i = start; i < n; i++) {
            ratings.push(pool[i].rating);
            rec(i + 1, cnt + 1, cost + cardCost(pool[i]));
            ratings.pop();
        }
    })(0, 0, 0);
    if (!feasible.length) return null;
    let vMin = Infinity;
    for (const f of feasible) if (f.V < vMin) vMin = f.V;
    let best = Infinity;
    for (const f of feasible) {
        if (f.V <= vMin + windowV) {
            const obj = f.cost + (f.V - vMin) * 1e-4;
            if (obj < best) best = obj;
        }
    }
    return { vMin: vMin, bestObj: best };
}
function solverObjective(res, pool, c, vMin) {
    const cardCost = cardCostFn(pool, c);
    let cost = 0;
    for (const p of res.players) cost += cardCost(p);
    const V = SolverCore.squadV(res.players.map(p => p.rating));
    return cost + (V - vMin) * 1e-4;
}

// Seeded RNG
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ========== 1. Squad-Rating-Formel (Rasmus' verifizierte Beispiele) ==========
{
    const sr = SolverCore.squadRating;
    function reps(list) {
        const out = [];
        for (const [n, r] of list) for (let i = 0; i < n; i++) out.push(r);
        return out;
    }
    check('Formel: 9x84 + 2x83 = 84 (Rasmus-Beispiel 1)', sr(reps([[9, 84], [2, 83]])) === 84);
    check('Formel: 2x85 + 3x84 + 6x83 = 84 (Rasmus-Beispiel 2)', sr(reps([[2, 85], [3, 84], [6, 83]])) === 84);
    check('Formel: 9x84 + 83 + 80 = 83 (knapp drunter)', sr(reps([[9, 84], [1, 83], [1, 80]])) === 83);
    check('Formel: 11x84 = 84', sr(reps([[11, 84]])) === 84);
    check('Formel: 96 + 10x80 = 82 (Booster zählt doppelt)', sr(reps([[1, 96], [10, 80]])) === 82);
    check('Formel: 11x80 = 80', sr(reps([[11, 80]])) === 80);
    // Konsistenz V <-> exakt
    const team = reps([[1, 91], [2, 84], [8, 80]]);
    const V = SolverCore.squadV(team);
    check('squadV konsistent mit exaktem Rating',
        Math.abs(V / 121 - SolverCore.squadRatingExact(team)) < 1e-9);
}

// ========== 2. Solver-Grundfälle ==========
{
    const pool = many(20, 80);
    const res = SolverCore.solve(pool, cfg(80));
    check('20x80 @ Ziel 80: lösbar mit exakt 80.00', res.ok && res.sum === 880 &&
        res.ovrExact === 80 && res.waste === 0,
        'sum=' + res.sum + ' exakt=' + res.ovrExact);
    const res2 = SolverCore.solve(many(15, 75), cfg(85));
    check('15x75 @ Ziel 85: unlösbar', !res2.ok && !!res2.reason);
    const res3 = SolverCore.solve(many(8, 90), cfg(80));
    check('nur 8 Spieler: unlösbar mit Grund', !res3.ok && /Nicht genug/i.test(res3.reason));
}

// ========== 3. Dezimal-Minimierung: 84.0x statt 84.7 ==========
{
    // Pool erlaubt sowohl "2x91 + 8x80 + 84" (exakt ~84.08) als auch
    // flachere Teams. Das V-Ziel muss die Variante nahe 84.00 wählen.
    const pool = [].concat(many(3, 91), many(12, 84), many(20, 80), many(20, 79), many(20, 78));
    const res = SolverCore.solve(pool, cfg(84, { maxOvershoot: 0.10 }));
    check('Ziel 84: exaktes Rating <= 84.10', res.ok && res.ovrExact >= 83.9 && res.ovrExact <= 84.10,
        'exakt=' + res.ovrExact + ' team=' + res.players.map(p => p.rating).sort((a, b) => b - a).join(','));
    // Und per Brute-Force: es gibt kein Team mit kleinerem V
    // (kleiner Pool für Brute)
    const pool2 = [].concat(many(2, 91), many(5, 84), many(8, 80));
    const c2 = cfg(84, { maxOvershoot: 0.10 });
    const r2 = SolverCore.solve(pool2, c2);
    const b2 = bruteBest(pool2, c2);
    check('V-Minimum stimmt mit Brute-Force überein', r2.ok && b2 &&
        SolverCore.squadV(r2.players.map(p => p.rating)) <= b2.vMin + Math.round(0.10 * 121),
        'solverV=' + (r2.ok && SolverCore.squadV(r2.players.map(p => p.rating))) + ' bruteVmin=' + (b2 && b2.vMin));
}

// ========== 4. Brute-Force-Parität (randomisiert, V-Ziel) ==========
{
    const rand = mulberry32(1234567);
    let allMatch = true, detail = '';
    for (let t = 0; t < 40; t++) {
        const n = 13 + Math.floor(rand() * 3);
        const pool = [];
        for (let i = 0; i < n; i++) {
            pool.push(P(75 + Math.floor(rand() * 18), { storage: rand() < 0.3 }));
        }
        const target = 78 + Math.floor(rand() * 9);
        const c = cfg(target, {
            maxOvershoot: Math.floor(rand() * 5) / 10, // 0 .. 0.4
            scarcityWeight: 18, storageBonus: 2,
            ratingCostSpec: (t % 2 === 0) ? SolverCore.DEFAULT_RATING_COST_SPEC : '0-99:0'
        });
        const res = SolverCore.solve(pool, c);
        const bb = bruteBest(pool, c);
        if (bb === null) {
            if (res.ok) { allMatch = false; detail = 't' + t + ': brute unlösbar, solver ok'; break; }
        } else {
            if (!res.ok) { allMatch = false; detail = 't' + t + ': brute lösbar (vMin=' + bb.vMin + '), solver nicht: ' + res.reason; break; }
            const obj = solverObjective(res, pool, c, bb.vMin);
            if (Math.abs(obj - bb.bestObj) > 1e-6) {
                allMatch = false;
                detail = 't' + t + ': brute=' + bb.bestObj + ' solver=' + obj;
                break;
            }
            if (SolverCore.squadRating(res.players.map(p => p.rating)) < target) {
                allMatch = false; detail = 't' + t + ': Team erreicht Ziel nicht!'; break;
            }
        }
    }
    check('40x Brute-Force-Parität (V-Ziel, div. Fenster/Gewichte)', allMatch, detail);
}

// ========== 5. Storage-Priorität bei gleichem Rating ==========
{
    const pool = [].concat(many(11, 80, { storage: true }), many(11, 80));
    const res = SolverCore.solve(pool, cfg(80));
    const st = res.players.filter(p => p.isStorage).length;
    check('Storage-Karten werden bei gleichem Rating zuerst konsumiert', res.ok && st === 11, 'storage=' + st);
}

// ========== 6. Duplikat-Stapel: vom größten Stapel zuerst ==========
{
    const pool = [].concat(
        many(10, 88, { storage: true, assetId: 111 }),
        [P(88, { storage: true, assetId: 222 })],
        many(15, 80)
    );
    const res = SolverCore.solve(pool, cfg(81, { scarcityWeight: 18, storageBonus: 2, maxOvershoot: 0.5 }));
    const used88 = res.players.filter(p => p.rating === 88);
    check('Duplikate: 88er kommt vom 10er-Stapel', res.ok && used88.length >= 1 &&
        used88.every(p => p.assetId === 111), 'assets=' + used88.map(p => p.assetId).join(','));
}

// ========== 7. Anker ==========
{
    const anchor = P(93);
    const pool = [].concat([anchor], many(20, 80));
    const res = SolverCore.solve(pool, cfg(81, { anchorId: anchor.id, maxOvershoot: 2 }));
    check('Anker wird verwendet', res.ok && res.players.some(p => p.id === anchor.id));
    const low = P(70);
    const pool2 = [].concat([low], many(20, 85));
    const res2 = SolverCore.solve(pool2, cfg(84, { minRating: 75, anchorId: low.id }));
    check('Gefilterter Anker: Warnung + ignoriert', res2.ok &&
        !res2.players.some(p => p.id === low.id) &&
        res2.warnings.some(w => /Anker/.test(w)), JSON.stringify(res2.warnings));
}

// ========== 8. Rarity-Vorgaben: Gruppen-Matching + Quellen-Regel + Kosten ==========
{
    // Kosten-basierte Wahl der Vorgabe-Karte: die BILLIGERE gewinnt, auch wenn
    // sie das höhere Rating hat. Die Bänder werden hier EXPLIZIT gesetzt statt
    // die Default-Tabelle zu nehmen - sonst hängt der Test daran, wie Rasmus
    // seine Ratings gerade bewertet (mit '85-88:2' waren 85er und 88er gleich
    // teuer und der Test prüfte nichts mehr).
    const BANDS = '0-84:0, 85-86:5, 87-88:2, 89+:12';
    const totw85 = P(85, { special: true, rareflag: 3, groups: [83] });
    const totw88 = P(88, { special: true, rareflag: 3, groups: [83] });
    const pool = [].concat([totw85, totw88], many(20, 80, { groups: [19] }));
    const res = SolverCore.solve(pool, cfg(80, {
        maxOvershoot: 2, scarcityWeight: 0, storageBonus: 0,
        ratingCostSpec: BANDS,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }));
    check('Vorgabe-Karte nach KOSTEN: 88er TOTW (2) statt 85er (5)', res.ok &&
        res.players.some(p => p.id === totw88.id) && !res.players.some(p => p.id === totw85.id),
        'team=' + res.players.filter(p => p.isSpecial).map(p => p.name).join(','));
    // Quellen-Regel: Club-FUTTIES nie, auch wenn günstiger
    const clubFutties = P(84, { special: true, rareflag: 137, groups: [83] });
    const pool2 = [].concat([clubFutties, totw88], many(20, 80, { groups: [19] }));
    const res2 = SolverCore.solve(pool2, cfg(80, {
        maxOvershoot: 2, specialOnlyFromStorage: true,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }));
    check('Quellen-Regel: Club-FUTTIES nie (Club-TOTW erlaubt)', res2.ok &&
        !res2.players.some(p => p.id === clubFutties.id) &&
        res2.players.some(p => p.id === totw88.id));
    // Falsche Gruppe zählt nicht
    const wrong = P(82, { special: true, rareflag: 50, groups: [35] });
    const res3 = SolverCore.solve([].concat([wrong], many(20, 80, { groups: [19] })), cfg(80, {
        maxOvershoot: 2,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }));
    check('Gruppen-Matching: unerfüllbar wird gemeldet', !res3.ok && /Rarity/.test(res3.reason));
    // applyRarity aus
    const res4 = SolverCore.solve(pool, cfg(80, {
        maxOvershoot: 2, applyRarity: false,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }));
    check('applyRarity=false: Vorgabe ignoriert + Warnung', res4.ok &&
        !res4.players.some(p => p.isSpecial) &&
        res4.warnings.some(w => /ACHTUNG/.test(w)));
    // Manuelle Karte übersteuert
    const res5 = SolverCore.solve(pool, cfg(80, {
        maxOvershoot: 2, rarityPickId: totw85.id,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }));
    check('Manuelle Rarity-Karte übersteuert die Automatik', res5.ok &&
        res5.players.some(p => p.id === totw85.id) &&
        res5.players.filter(p => p.isSpecial).length === 1);
}

// ========== 8b. Rarity-Schutz (TOTW/TOTS/FOF/FUTTIES = Gruppe 83) ==========
{
    // Ohne Vorgabe: Gruppe-83-Karten meiden, obwohl sie als Storage-Karten
    // ohne Schutz die günstigsten wären.
    const futties = many(3, 84, { special: true, rareflag: 137, groups: [83], storage: true });
    const golds = many(12, 84, { groups: [19] });
    const res = SolverCore.solve([].concat(futties, golds), cfg(84, { storageBonus: 2 }));
    check('Rarity-Schutz: ohne Vorgabe keine Gruppe-83-Karte im Team', res.ok &&
        res.players.every(p => !(p.groups && p.groups.indexOf(83) > -1)),
        res.ok ? 'protected=' + res.players.filter(p => p.groups && p.groups.indexOf(83) > -1).length : res.reason);
    // Mit Vorgabe (min 1 aus Gruppe 83): GENAU eine, nicht mehr.
    const res2 = SolverCore.solve([].concat(futties, golds), cfg(84, {
        storageBonus: 2,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }));
    const nProt = res2.ok ? res2.players.filter(p => p.groups && p.groups.indexOf(83) > -1).length : -1;
    check('Rarity-Schutz: mit Vorgabe GENAU eine Gruppe-83-Karte', res2.ok && nProt === 1,
        'protected=' + nProt);
    // Schutz aus (0): Storage-FUTTIES sind die günstigsten und werden verbraucht.
    const res3 = SolverCore.solve([].concat(futties, golds), cfg(84, {
        rarityGuardCost: 0, storageBonus: 2
    }));
    check('Rarity-Schutz aus: FUTTIES werden wieder normal verbraucht', res3.ok &&
        res3.players.some(p => p.groups && p.groups.indexOf(83) > -1));
}

// ========== 8b1. Userscript-Metablock (Tampermonkey-Auto-Update) ==========
{
    // In den ==UserScript==-Block gehören AUSSCHLIESSLICH "@key value"-Zeilen.
    // Freie Kommentare dazwischen markiert Tampermonkey als Fehler und kann
    // die danach folgenden Metadaten still ignorieren - passiert mit v4.11.0,
    // wodurch @updateURL/@downloadURL unwirksam wurden und das Auto-Update auf
    // dem PC ausblieb. Der Fehler ist von aussen nicht zu sehen, deshalb hier.
    const lines = src.split('\n');
    const start = lines.findIndex(l => l.trim() === '// ==UserScript==');
    const end = lines.findIndex(l => l.trim() === '// ==/UserScript==');
    check('Metablock: Anfang und Ende vorhanden', start === 0 && end > start,
        'start=' + start + ' end=' + end);
    const meta = lines.slice(start + 1, end);
    const bad = meta.filter(l => !/^\/\/\s*@\w+/.test(l));
    check('Metablock: nur @key-Zeilen, keine freien Kommentare', bad.length === 0,
        bad.length ? JSON.stringify(bad.slice(0, 3)) : '');
    const RAW = 'https://raw.githubusercontent.com/Rasmus33/pittools/main/'
        + 'ea-fc-sbc-optimizer.user.js';
    check('Metablock: @updateURL zeigt auf main',
        meta.some(l => /^\/\/\s*@updateURL\s+\S/.test(l) && l.indexOf(RAW) > -1));
    check('Metablock: @downloadURL zeigt auf main',
        meta.some(l => /^\/\/\s*@downloadURL\s+\S/.test(l) && l.indexOf(RAW) > -1));
    // @version im Header und VERSION im Code müssen übereinstimmen - daran
    // erkennt Rasmus im Panel, welche Version wirklich geladen ist, und
    // Tampermonkey entscheidet daran über das Update.
    const vHeader = (src.match(/^\/\/\s*@version\s+(\S+)/m) || [])[1];
    const vCode = (src.match(/const VERSION = '([^']+)'/) || [])[1];
    check('Version: Header und VERSION im Code identisch', !!vHeader && vHeader === vCode,
        '@version=' + vHeader + ' VERSION=' + vCode);
}

// ========== 8b1a. Panel-UI: jede ui-Referenz hat ihr Element ==========
{
    // Live-Fehler in v4.17.0: beim Ausbauen des Batch-Modus flog der
    // Diagnose-Button aus dem Panel-HTML, `ui.diagBtn` war dadurch null und
    // ui.diagBtn.addEventListener(...) hat den GANZEN Panel-Aufbau abgebrochen -
    // das Script hatte gar keine Oberfläche mehr. node --check sieht das nicht
    // (syntaktisch einwandfrei), und der Solver-Test auch nicht.
    const ids = new Set();
    const re = /id="(sbc-opt-[a-z-]+)"/g;
    let m;
    while ((m = re.exec(src)) !== null) ids.add(m[1]);
    const refs = new Set();
    const re2 = /panel\.querySelector\('#(sbc-opt-[a-z-]+)'\)/g;
    while ((m = re2.exec(src)) !== null) refs.add(m[1]);
    const missing = Array.from(refs).filter(r => !ids.has(r));
    check('Panel: jede querySelector-Referenz existiert im HTML',
        missing.length === 0,
        missing.length ? ('fehlt: ' + missing.join(', ')) : (refs.size + ' Referenzen geprüft'));
    // Und die Listener dürfen nur auf ui-Felder gehen, die auch gesetzt werden.
    const uiFields = new Set();
    const uiBlock = src.slice(src.indexOf('        ui = {'), src.indexOf('        panel.querySelector(\'#sbc-opt-close\')'));
    const re3 = /^\s*([a-zA-Z]+):/gm;
    while ((m = re3.exec(uiBlock)) !== null) uiFields.add(m[1]);
    const used = new Set();
    const re4 = /\bui\.([a-zA-Z]+)\.addEventListener/g;
    while ((m = re4.exec(src)) !== null) used.add(m[1]);
    const noField = Array.from(used).filter(u => !uiFields.has(u));
    check('Panel: alle Listener hängen an gesetzten ui-Feldern',
        noField.length === 0,
        noField.length ? ('nicht gesetzt: ' + noField.join(', ')) : (used.size + ' Listener geprüft'));
}

// ========== 8b1b. Kein Shadowing der Hilfsfunktionen ==========
{
    // Live-Fehler in v4.12.0: im Batch-Lauf stand "const log = []" - das
    // überdeckte die Funktion log() im selben Scope, und der Aufruf starb mit
    // "log is not a function". Erst NACH dem Abgeben der ersten SBC, also an
    // der teuersten Stelle. JS meldet das nicht statisch, node --check auch
    // nicht - deshalb hier.
    // Alle diese Helfer sind als "function X()" deklariert; ein const/let/var
    // mit demselben Namen ist damit immer ein Shadowing-Fehler.
    const HELPERS = ['log', 'warn', 'toast', 'setStatus', 'escapeHtml', 'diagError'];
    for (const h of HELPERS) {
        const re = new RegExp('(?:const|let|var)\\s+' + h + '\\s*=', 'g');
        const hits = src.match(re) || [];
        check('Kein Shadowing von ' + h + '()', hits.length === 0,
            hits.length ? hits.join(', ') : '');
    }
}

// ========== 8b2. Rarity-Schutz bei HOHEN Ratings (Live-Fall 90er-Team) ==========
{
    // Live mit v4.8.0: 90er-Team gebaut, ZWEI FUTTIES verbaut, obwohl die SBC
    // nur eine forderte. Ursache: ab Rating 93 ist die Band-Kostenstufe 12,
    // damit ist die Storage-Ersparnis (base/2 + beta) immer grösser als der
    // Schutz-Aufschlag (+8) - eine Storage-FUTTIES ist dann billiger als das
    // gleichwertige Vereins-Gold. Am Aufschlag zu drehen hätte die Grenze nur
    // verschoben; die Regel ist "über die geforderte Anzahl hinaus gar nicht".
    const REAL = {
        scarcityWeight: 18, storageBonus: 2,
        ratingCostSpec: '0-80:0,81-83:2,84:1,85-86:5,87-88:2,89-90:3,91-92:4,93+:12'
    };
    const need1 = [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }];

    // Bestes erreichbares OVR bei HÖCHSTENS maxProt geschützten Karten -
    // damit die Erwartungswerte unten nicht aus dem Kopf kommen.
    function bestWithProtected(pool, N, maxProt) {
        let bestOvr = -1, bestTeam = null;
        const idx = [];
        (function rec(start, cnt, prot) {
            if (prot > maxProt) return;
            if (cnt === N) {
                const rats = idx.map(i => pool[i].rating);
                const ovr = SolverCore.squadRating(rats);
                if (ovr > bestOvr) { bestOvr = ovr; bestTeam = rats.slice(); }
                return;
            }
            if (pool.length - start < N - cnt) return;
            for (let i = start; i < pool.length; i++) {
                idx.push(i);
                rec(i + 1, cnt + 1, prot + (((pool[i].groups || []).indexOf(83) > -1) ? 1 : 0));
                idx.pop();
            }
        })(0, 0, 0);
        return { ovr: bestOvr, team: bestTeam };
    }
    const protCount = (res) => res.ok
        ? res.players.filter(p => p.groups && p.groups.indexOf(83) > -1).length : -1;

    // Fall 1: Es gibt Vereins-Gold als Alternative auf 93 -> genau EINE
    // geschützte Karte muss reichen.
    const pool = [].concat(
        many(2, 93, { special: true, rareflag: 137, groups: [83], storage: true }),
        many(2, 93, { groups: [19] }),
        many(9, 89, { groups: [19] }));
    const bf1 = bestWithProtected(pool, 11, 1);
    check('Brute-Force: Ziel 90 ist mit genau 1 Gruppe-83-Karte erreichbar',
        bf1.ovr >= 90, 'bestOvr=' + bf1.ovr + ' team=' + JSON.stringify(bf1.team));
    const res = SolverCore.solve(pool,
        cfg(90, Object.assign({}, REAL, { rarityConstraints: need1 })));
    check('90er-Team: genau 1 geschützte Karte trotz Storage-Rabatt bei 93+',
        res.ok && protCount(res) === 1,
        res.ok ? ('protected=' + protCount(res) + ' ovr=' + res.ovr) : res.reason);
    check('90er-Team: Ziel dabei trotzdem erreicht', res.ok && res.ovr >= 90,
        res.ok ? ('ovr=' + res.ovr) : res.reason);

    // Fall 2: Ohne Vereins-Gold auf 93 geht es NUR mit zwei geschützten Karten.
    // Dann muss die Sperre sich lösen - mit Warnung, damit es nicht unbemerkt
    // passiert.
    const poolNoAlt = [].concat(
        many(2, 93, { special: true, rareflag: 137, groups: [83], storage: true }),
        many(9, 89, { groups: [19] }));
    const bfOnly1 = bestWithProtected(poolNoAlt, 11, 1);
    const bfUpTo2 = bestWithProtected(poolNoAlt, 11, 2);
    check('Brute-Force: ohne Alternative nur mit 2 geschützten Karten möglich',
        bfOnly1.ovr < 90 && bfUpTo2.ovr >= 90,
        'maxOvr mit 1=' + bfOnly1.ovr + ', mit 2=' + bfUpTo2.ovr);
    const res2 = SolverCore.solve(poolNoAlt,
        cfg(90, Object.assign({}, REAL, { rarityConstraints: need1 })));
    check('Schutz wird gelockert, wenn die SBC sonst unlösbar ist',
        res2.ok && protCount(res2) === 2 &&
        res2.warnings.some(w => /Schutz gelockert/.test(w)),
        res2.ok ? ('protected=' + protCount(res2) + ' warn=' + JSON.stringify(res2.warnings))
                : res2.reason);

    // Fall 3: Ohne Vorgabe darf auch bei 93+ keine geschützte Karte rein,
    // solange eine Alternative existiert.
    const res3 = SolverCore.solve(pool, cfg(90, REAL));
    check('Ohne Vorgabe: keine geschützte Karte, obwohl sie billiger wäre',
        res3.ok && protCount(res3) === 0,
        res3.ok ? ('protected=' + protCount(res3)) : res3.reason);
}

// ========== 8b3. Unverkäufliche Karten bevorzugen ==========
{
    // Untradeable-Karten lassen sich nicht verkaufen, sind für SBCs aber
    // vollwertig - sie zuerst zu verbauen spart echte Coins.
    const untr = many(11, 84, { untradeable: true });
    const sellable = many(11, 84);
    const pool = [].concat(sellable, untr);
    const res = SolverCore.solve(pool, cfg(84, { untradeableBonus: 3 }));
    const nUntr = res.ok ? res.players.filter(p => p.untradeable).length : -1;
    check('Untradeable werden zuerst verbaut', res.ok && nUntr === 11,
        res.ok ? ('untradeable=' + nUntr + '/11') : res.reason);
    // Aus (0): keine Bevorzugung mehr - dann entscheidet die übrige Ordnung.
    const res2 = SolverCore.solve(pool, cfg(84, { untradeableBonus: 0 }));
    check('Untradeable-Bonus aus: keine Bevorzugung',
        res2.ok && res2.players.filter(p => p.untradeable).length === 0,
        res2.ok ? ('untradeable=' + res2.players.filter(p => p.untradeable).length) : res2.reason);
    // Der Bonus darf das RATING-Ziel nicht überstimmen: hier reichen die
    // unverkäuflichen 83er nicht für Ziel 84, die 84er müssen ran.
    const pool3 = [].concat(many(11, 83, { untradeable: true }), many(11, 84));
    const res3 = SolverCore.solve(pool3, cfg(84, { untradeableBonus: 6 }));
    check('Untradeable-Bonus überstimmt das Ziel-Rating nicht',
        res3.ok && res3.ovr >= 84, res3.ok ? ('ovr=' + res3.ovr) : res3.reason);
}

// ========== 8b4. Batch-Planung (dieselbe SBC mehrfach) ==========
{
    // 3x dasselbe 84er-Team planen: die Runden dürfen sich KEINE Karte teilen,
    // sonst wäre der zweite Durchlauf im Spiel nicht mehr eintragbar.
    const pool = many(35, 84);
    const b = SolverCore.planBatch(pool, cfg(84), 3);
    check('Batch: 3 Runden geplant', b.planned === 3,
        'planned=' + b.planned + ' reason=' + b.stoppedReason);
    const allIds = [].concat.apply([], b.rounds.map(r => r.players.map(p => p.id)));
    check('Batch: keine Karte in zwei Runden', new Set(allIds).size === allIds.length,
        'ids=' + allIds.length + ' unique=' + new Set(allIds).size);
    check('Batch: jede Runde erreicht das Ziel',
        b.rounds.length === 3 && b.rounds.every(r => r.ovr >= 84),
        JSON.stringify(b.rounds.map(r => r.ovr)));
    check('Batch: usedIds deckt alle Runden ab', b.usedIds.length === allIds.length);

    // Reicht der Pool nur für 2 Runden, muss die Planung das SAGEN statt
    // stillschweigend weniger zu liefern.
    const b2 = SolverCore.planBatch(many(25, 84), cfg(84), 4);
    check('Batch: Abbruch wird gemeldet', b2.planned === 2 && !!b2.stoppedReason,
        'planned=' + b2.planned + ' reason=' + b2.stoppedReason);
    check('Batch: requested bleibt erhalten', b2.requested === 4);

    // Mit Rarity-Vorgabe braucht JEDE Runde ihre eigene geschützte Karte.
    const futties = many(2, 84, { special: true, rareflag: 137, groups: [83], storage: true });
    const golds = many(24, 84, { groups: [19] });
    const b3 = SolverCore.planBatch([].concat(futties, golds), cfg(84, {
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }), 2);
    const protPerRound = b3.rounds.map(r =>
        r.players.filter(p => p.groups && p.groups.indexOf(83) > -1).length);
    check('Batch: jede Runde erfüllt die Rarity-Vorgabe mit genau 1 Karte',
        b3.planned === 2 && protPerRound.every(n => n === 1),
        'planned=' + b3.planned + ' prot=' + JSON.stringify(protPerRound));
    // Dritte Runde ist unmöglich - nur zwei geschützte Karten vorhanden.
    const b4 = SolverCore.planBatch([].concat(futties, golds), cfg(84, {
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }), 3);
    check('Batch: stoppt, wenn die Vorgabe nicht mehr erfüllbar ist',
        b4.planned === 2 && /Rarity-Vorgabe/.test(b4.stoppedReason || ''),
        'planned=' + b4.planned + ' reason=' + b4.stoppedReason);
}

// ========== 8d2. Bronze/Silber-Vorgaben (Live-Fall "genau 1 Bronze") ==========
{
    // Live: eine SBC mit 1 Slot und reqDump PLAYER_LEVEL value 1 (= Bronze).
    // Erwartung von Rasmus: der NIEDRIGSTE normale Bronze-Spieler, kein Evo,
    // kein Special, rare/non-rare egal - und das Min-Rating wird komplett
    // ignoriert (sonst ist die SBC mit Min-Rating 75 nie lösbar).
    const bronzeLow = P(48, { groups: [19] });          // der billigste
    const bronzeMid = many(3, 58, { groups: [19] });
    const bronzeSpecial = P(45, { special: true, rareflag: 12, groups: [19] });
    const golds = many(5, 84, { groups: [19] });
    const pool = [].concat([bronzeLow], bronzeMid, [bronzeSpecial], golds);
    const qcfg = (extra) => cfg(null, Object.assign({
        targetOVR: null, slots: 1, minRating: 75,
        qualityConstraints: [{ label: 'PLAYER_LEVEL', quality: 1, count: 1 }]
    }, extra || {}));

    const res = SolverCore.solve(pool, qcfg());
    check('Bronze-Vorgabe: lösbar trotz Min-Rating 75', res.ok, res.ok ? '' : res.reason);
    check('Bronze-Vorgabe: Min-Rating wird ignoriert (Warnung)',
        res.ok && res.warnings.some(w => /Min-Rating .* ignoriert/i.test(w)),
        JSON.stringify(res.warnings));
    check('Bronze-Vorgabe: genau 1 Spieler', res.ok && res.players.length === 1,
        res.ok ? ('n=' + res.players.length) : '');
    check('Bronze-Vorgabe: nimmt den NIEDRIGSTEN normalen Bronze',
        res.ok && res.players.length === 1 && res.players[0].id === bronzeLow.id,
        res.ok ? ('gewählt: ' + res.players[0].rating + (res.players[0].isSpecial ? ' Special' : '')) : '');
    check('Bronze-Vorgabe: kein Special',
        res.ok && !res.players.some(p => p.isSpecial));

    // Gibt es NUR Specials in Bronze, muss es trotzdem lösbar sein (mit Warnung).
    const res2 = SolverCore.solve([].concat([bronzeSpecial], golds), qcfg());
    check('Bronze-Vorgabe: nur Specials vorhanden -> gelockert mit Warnung',
        res2.ok && res2.players.length === 1 && res2.players[0].isSpecial &&
        res2.warnings.some(w => /Specials werden mitbenutzt/.test(w)),
        res2.ok ? JSON.stringify(res2.warnings) : res2.reason);

    // SILBER: Band 65-74, Min-Rating ebenfalls egal.
    const silver = many(3, 68, { groups: [19] });
    const res3 = SolverCore.solve([].concat(silver, golds, [bronzeLow]), qcfg({
        qualityConstraints: [{ label: 'PLAYER_LEVEL', quality: 2, count: 1 }]
    }));
    check('Silber-Vorgabe: nimmt eine 65-74er Karte',
        res3.ok && res3.players.length === 1 &&
        res3.players[0].rating >= 65 && res3.players[0].rating <= 74,
        res3.ok ? ('rating=' + res3.players[0].rating) : res3.reason);

    // GOLD: hier bleibt das Min-Rating wirksam (Normalfall, gewollt).
    const res4 = SolverCore.solve([].concat(golds, many(3, 78, { groups: [19] })), qcfg({
        minRating: 84,
        qualityConstraints: [{ label: 'PLAYER_LEVEL', quality: 3, count: 1 }]
    }));
    check('Gold-Vorgabe: Min-Rating bleibt wirksam',
        res4.ok && res4.players[0].rating >= 84,
        res4.ok ? ('rating=' + res4.players[0].rating) : res4.reason);
}

// ========== 8c. Spieler-Eindeutigkeit (EA: gleiche assetId nur 1x pro Squad) ==========
{
    // 4 Kopien desselben Spielers (gleiche assetId, verschiedene Item-IDs,
    // z.B. Duplikate aus Packs) + 10 verschiedene 84er. Ohne Dedupe würde
    // der Solver mehrere Kopien aufstellen -> Server lehnt mit 460 ab.
    const dupes = many(4, 84).map(p => Object.assign(p, { assetId: 555555 }));
    const others = many(10, 84);
    const res = SolverCore.solve([].concat(dupes, others), cfg(84));
    const assetCounts = {};
    for (const p of (res.players || [])) assetCounts[p.assetId] = (assetCounts[p.assetId] || 0) + 1;
    check('Dedupe: lösbar mit 11 verschiedenen Spielern', res.ok, res.ok ? '' : res.reason);
    check('Dedupe: keine assetId doppelt im Team', res.ok &&
        Object.keys(assetCounts).length === 11 &&
        Object.values(assetCounts).every(n => n === 1));
    // Nur 10 VERSCHIEDENE Spieler vorhanden -> sauber unlösbar gemeldet
    // (statt später 460 vom Server).
    const res2 = SolverCore.solve([].concat(dupes, many(9, 84)), cfg(84));
    check('Dedupe: zu wenige verschiedene Spieler wird gemeldet', !res2.ok);
}

// ========== 8d. Qualitäts-Vorgabe (Tausch-/Upgrade-SBCs ohne Team-Rating) ==========
{
    const golds = many(12, 78);
    const silvers = many(12, 70);
    const highs = many(3, 88);
    const pool = [].concat(golds, silvers, highs);
    // Gold-Vorgabe ohne Ziel-OVR: 11 billigste Gold-Karten (>= 75)
    const res = SolverCore.solve(pool, cfg(null, {
        targetOVR: null, minRating: 0,
        qualityConstraints: [{ label: 'PLAYER_QUALITY', quality: 3, count: 1 }],
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC
    }));
    check('Qualität Gold: lösbar ohne Ziel-OVR', res.ok, res.ok ? '' : res.reason);
    check('Qualität Gold: alle Karten >= 75, billigste zuerst (keine 88er)', res.ok &&
        res.players.length === 11 &&
        res.players.every(p => p.rating >= 75) &&
        !res.players.some(p => p.rating === 88));
    // Silber-Vorgabe: nur 65-74, Min-Rating 75 kollidiert und wird ignoriert
    const res2 = SolverCore.solve(pool, cfg(null, {
        targetOVR: null, minRating: 75,
        qualityConstraints: [{ label: 'PLAYER_QUALITY', quality: 2, count: 1 }]
    }));
    check('Qualität Silber: nur 65-74er trotz Min-Rating 75', res2.ok &&
        res2.players.every(p => p.rating >= 65 && p.rating <= 74) &&
        res2.warnings.some(w => /Min-Rating .* ignoriert/i.test(w)),
        JSON.stringify(res2.warnings));
    // Zu wenige passende Karten -> sauberer Fehler
    const res3 = SolverCore.solve([].concat(many(5, 70), golds), cfg(null, {
        targetOVR: null, minRating: 0,
        qualityConstraints: [{ label: 'PLAYER_QUALITY', quality: 2, count: 1 }]
    }));
    check('Qualität: zu wenige passende Karten wird gemeldet', !res3.ok);
    // Qualität + Team-Rating kombiniert: Band-Filter gilt auch im DP-Pfad
    const res4 = SolverCore.solve(pool, cfg(78, {
        minRating: 0,
        qualityConstraints: [{ label: 'PLAYER_QUALITY', quality: 3, count: 1 }]
    }));
    check('Qualität + Ziel-OVR: lösbar, alle >= 75', res4.ok &&
        res4.players.every(p => p.rating >= 75) && res4.ovr >= 78);
}

// ========== 9. Spieler-Level-Vorgabe ==========
{
    const pool = [].concat(many(12, 85, { storage: true }), many(12, 86), many(20, 80));
    const res = SolverCore.solve(pool, cfg(null, {
        targetOVR: null,
        playerLevelConstraints: [{ label: 'PLAYER_RATING', minRating: 85, count: 10 }]
    }));
    const highs = res.players.filter(p => p.rating >= 85).length;
    check('PlayerLevel ohne Ziel-OVR: 10x 85+ erfüllt', res.ok && highs >= 10 && res.players.length === 11);
    const res3 = SolverCore.solve(many(20, 80), cfg(null, {
        targetOVR: null,
        playerLevelConstraints: [{ label: 'PLAYER_RATING', minRating: 85, count: 10 }]
    }));
    check('PlayerLevel unerfüllbar: klarer Fehler', !res3.ok && /85\+/.test(res3.reason));
    // Provisions-SBC: 4 Slots, "min OVR 87" ohne Team-Rating - EAs Count-Feld
    // ist unzuverlässig (parst oft als 1), daher gilt die Vorgabe ohne
    // Team-Rating für ALLE Slots: alle 4 Spieler müssen 87+ sein.
    const pool4 = [].concat(many(6, 87, { storage: true }), many(10, 84, { storage: true }));
    const res4 = SolverCore.solve(pool4, cfg(null, {
        targetOVR: null, slots: 4, minRating: 0,
        playerLevelConstraints: [{ label: 'PLAYER_OVERALL_RATING_MIN', minRating: 87, count: 1 }]
    }));
    check('Provisions-SBC: alle 4 Spieler 87+ (Count-Boost ohne Team-Rating)', res4.ok &&
        res4.players.length === 4 && res4.players.every(p => p.rating >= 87) &&
        res4.warnings.some(w => /alle 4 Slots/.test(w)),
        res4.ok ? res4.players.map(p => p.rating).join(',') : res4.reason);
}

// ========== 10. Max. teure Spieler ==========
{
    const pool = [].concat(many(5, 90), many(20, 80));
    const res = SolverCore.solve(pool, cfg(81, { maxOvershoot: 1, maxExpensiveEnabled: true, maxExpensiveCount: 1, expensiveThreshold: 90 }));
    const exp = res.players.filter(p => p.rating >= 90).length;
    check('MaxExp eingehalten: höchstens 1x 90er', res.ok && exp <= 1, 'exp=' + exp);
    const res2 = SolverCore.solve(pool, cfg(85, { maxOvershoot: 2, maxExpensiveEnabled: true, maxExpensiveCount: 0, expensiveThreshold: 90 }));
    check('MaxExp unerfüllbar: gelockert mit Warnung', (!res2.ok) ||
        (res2.ok && res2.warnings.some(w => /nicht einhaltbar/.test(w))));
}

// ========== 11. Filter ==========
{
    const pool = [].concat(many(11, 86, { special: true }), many(11, 80));
    const res = SolverCore.solve(pool, cfg(84, { specialOnlyFromStorage: true, maxOvershoot: 2 }));
    check('Vereins-Specials werden gefiltert (84 unlösbar)', !res.ok);
    const res2 = SolverCore.solve(pool, cfg(84, { specialOnlyFromStorage: false, maxOvershoot: 2 }));
    check('Ohne Filter lösbar', res2.ok);
}

// ========== 12. Überschuss-Fenster: Kosten-Trades nur im Rahmen ==========
{
    // 2x95 (teuer, Band 12) vs 60x88 (Band 2): Wenn beide V-nah sind,
    // müssen die 88er gewinnen. maxOvershoot begrenzt die Abweichung.
    const pool = [].concat(many(2, 95), many(60, 88), many(30, 80), many(20, 78));
    const c = cfg(84, {
        maxOvershoot: 0.3, scarcityWeight: 18, storageBonus: 2,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC
    });
    const res = SolverCore.solve(pool, c);
    check('Überschuss bleibt im Fenster', res.ok && res.ovrExact <= 84 + 0.3 + 0.01,
        'exakt=' + res.ovrExact);
    check('95er werden geschont, wenn 88er reichen', res.ok &&
        res.players.filter(p => p.rating === 95).length === 0,
        'team=' + res.players.map(p => p.rating).sort((a, b) => b - a).join(','));
}

// ========== 13. Kein Ziel + keine Vorgaben ==========
{
    const res = SolverCore.solve(many(20, 80), cfg(null, { targetOVR: null }));
    check('Kein Ziel-OVR + keine Vorgaben: klarer Fehler', !res.ok && /Kein Ziel/.test(res.reason));
}

// ========== 14. Weniger als 11 Slots ==========
{
    const pool = many(10, 84);
    const res = SolverCore.solve(pool, cfg(84, { slots: 5 }));
    check('SBC mit 5 Slots: lösbar, korrekte Teamgröße', res.ok && res.players.length === 5,
        'n=' + (res.players && res.players.length) + ' ovr=' + res.ovr);
}

// ========== 15. RatingCosts-Parser ==========
{
    const fn = SolverCore.parseRatingCosts(SolverCore.DEFAULT_RATING_COST_SPEC);
    // Stand Aug 2026: 85-88 liegen alle auf 2 (86er nicht mehr knapp, 85er
    // reichlich vorhanden). Vorher war 85-86:5.
    check('RatingCosts-Parser: Default-Tabelle (Rasmus) korrekt',
        fn(78) === 0 && fn(80) === 0 && fn(81) === 2 && fn(83) === 2 && fn(84) === 1 &&
        fn(85) === 2 && fn(86) === 2 && fn(87) === 2 && fn(88) === 2 &&
        fn(89) === 3 && fn(90) === 3 && fn(91) === 4 && fn(92) === 4 &&
        fn(93) === 12 && fn(97) === 12);
}

console.log('\n' + (tests - failures) + '/' + tests + ' Tests bestanden.');
process.exit(failures ? 1 : 0);
