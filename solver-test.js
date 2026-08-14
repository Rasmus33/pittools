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
// Sammelstelle fuer asynchrone Testblöcke (der Club-Loader ist async).
const pending = [];
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
        // Muss dem Datenmodell des Scripts entsprechen (normalizePlayer):
        // rareflag 0 = Common, 1 = Rare. Fehlte das hier, greifen die
        // Rare/Common-Filter im Solver nicht und der Test prüft nichts.
        isRare: (opts.rareflag != null ? opts.rareflag : (opts.special ? 24 : 1)) === 1,
        isCommon: (opts.rareflag != null ? opts.rareflag : (opts.special ? 24 : 1)) === 0,
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

// ========== 8b5. Gesperrte Karten (PaleTools-Schloss) ==========
{
    // Wer eine Karte sperrt, will sie behalten - sie darf NICHT verbaut werden,
    // auch nicht als Vorgabe-Karte oder Anker (live gesehen: ein gesperrter
    // 91er Mbappé stand trotzdem im Team).
    const keep = P(91, { groups: [19] });
    const others = many(12, 84, { groups: [19] });
    const pool = [].concat([keep], others);

    const res = SolverCore.solve(pool, cfg(84, { lockedIds: [keep.id] }));
    check('Locks: gesperrte Karte wird nicht verbaut',
        res.ok && !res.players.some(p => p.id === keep.id),
        res.ok ? '' : res.reason);
    check('Locks: Ausschluss wird gemeldet',
        res.ok && res.warnings.some(w => /gesperrte Karte/i.test(w)),
        JSON.stringify(res.warnings));
    // Ohne Sperre darf sie verwendet werden (sonst prüft der Test nichts).
    const res2 = SolverCore.solve([].concat([keep], many(10, 84)), cfg(84, { maxOvershoot: 2 }));
    check('Locks: ohne Sperre ist dieselbe Karte erlaubt',
        res2.ok && res2.players.some(p => p.id === keep.id),
        res2.ok ? '' : res2.reason);
    // Auch als ANKER darf eine gesperrte Karte nicht reinkommen.
    const res3 = SolverCore.solve(pool, cfg(84, { lockedIds: [keep.id], anchorId: keep.id }));
    check('Locks: gesperrte Karte kommt auch nicht als Anker rein',
        res3.ok && !res3.players.some(p => p.id === keep.id),
        res3.ok ? '' : res3.reason);
    // Und nicht als Karte für eine Rarity-Vorgabe.
    const lockedTotw = P(88, { special: true, rareflag: 3, groups: [83] });
    const freeTotw = P(84, { special: true, rareflag: 3, groups: [83] });
    const res4 = SolverCore.solve([].concat([lockedTotw, freeTotw], many(11, 84)), cfg(84, {
        lockedIds: [lockedTotw.id], maxOvershoot: 2,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }));
    check('Locks: Rarity-Vorgabe nimmt die freie, nicht die gesperrte Karte',
        res4.ok && !res4.players.some(p => p.id === lockedTotw.id) &&
        res4.players.some(p => p.id === freeTotw.id),
        res4.ok ? '' : res4.reason);
}

// ========== 8d3. Gold-SBCs: Rare nur in geforderter Anzahl ==========
{
    // Rasmus' zwei Live-Fälle:
    //  Bild 1: "Exactly Gold" + 9 Spieler, KEINE Rare-Vorgabe -> nur Common.
    //  Bild 2: "Exactly Gold" + 6 Spieler + "Rare: Min. 6" -> 6 niedrige Rare.
    // Dazu die Obergrenzen: Rare nur bis 77 hergeben, 78+ bleibt für die
    // Rating-SBCs.
    const rare75 = many(4, 75, { rareflag: 1, storage: true });
    const rare77 = many(4, 77, { rareflag: 1, storage: true });
    const rare85 = many(6, 85, { rareflag: 1, storage: true });   // zu wertvoll
    const common78 = many(12, 78, { rareflag: 0 });
    const pool = [].concat(rare75, rare77, rare85, common78);
    const gcfg = (extra) => cfg(null, Object.assign({
        targetOVR: null, slots: 9, minRating: 0,
        maxRareRating: 77, maxCommonRating: 99,
        qualityConstraints: [{ label: 'PLAYER_QUALITY', quality: 3, count: 1 }]
    }, extra || {}));

    // Fall 1: keine Rare-Vorgabe -> ausschliesslich Common
    const res = SolverCore.solve(pool, gcfg());
    check('Gold ohne Rare-Vorgabe: nur Common im Team',
        res.ok && res.players.length === 9 && res.players.every(p => p.isCommon),
        res.ok ? ('rare=' + res.players.filter(p => p.isRare).length) : res.reason);

    // Fall 2: 6 Rare gefordert, 6 Slots -> genau 6 Rare, alle <= 77.
    // GENAU die Live-Form aus Rasmus' Report (setId 1351/challenge 3868):
    // PLAYER_RARITY_GROUP mit Wert 4 und count 1 bei 6 Slots. Der count 1 ist
    // EAs unzuverlaessiges Feld - ohne Team-Rating gilt die Vorgabe fuer ALLE
    // Slots.
    const RARE_G4 = [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 4 }];
    const res2 = SolverCore.solve(pool, gcfg({
        slots: 6, rarityConstraints: RARE_G4
    }));
    const nRare = res2.ok ? res2.players.filter(p => p.isRare).length : -1;
    check('Gold mit "6x Rare": genau 6 Rare', res2.ok && nRare === 6,
        res2.ok ? ('rare=' + nRare) : res2.reason);
    check('Gold mit "6x Rare": keine Rare über der Grenze 77',
        res2.ok && res2.players.filter(p => p.isRare).every(p => p.rating <= 77),
        res2.ok ? res2.players.filter(p => p.isRare).map(p => p.rating).join(',') : '');
    check('Gold mit "6x Rare": die NIEDRIGSTEN Rare zuerst (75er vor 77er)',
        res2.ok && res2.players.filter(p => p.isRare).filter(p => p.rating === 75).length === 4,
        res2.ok ? res2.players.filter(p => p.isRare).map(p => p.rating).sort().join(',') : '');

    // Fall 3: 3 Rare gefordert bei 9 Slots -> 3 Rare + 6 Common
    const res3 = SolverCore.solve(pool, gcfg({
        rareConstraints: [{ label: 'PLAYER_RARITY', count: 3 }]
    }));   // expliziter Rare-Count (Solver kann beides)
    check('Gold mit "3x Rare" bei 9 Slots: 3 Rare + 6 Common',
        res3.ok && res3.players.filter(p => p.isRare).length === 3 &&
        res3.players.filter(p => p.isCommon).length === 6,
        res3.ok ? ('rare=' + res3.players.filter(p => p.isRare).length +
                   ' common=' + res3.players.filter(p => p.isCommon).length) : res3.reason);

    // Fall 4: Grenze zu streng -> Warnung, aber kein stiller Fehlgriff
    const res4 = SolverCore.solve([].concat(rare85, common78), gcfg({
        slots: 6, maxRareRating: 77, rarityConstraints: RARE_G4
    }));
    check('Gold: zu strenge Rare-Grenze wird gemeldet',
        res4.ok && res4.warnings.some(w => /Rare-Karte bis Rating 77/.test(w)),
        res4.ok ? JSON.stringify(res4.warnings) : res4.reason);

    // Fall 5: Common-Grenze wirkt
    const res5 = SolverCore.solve([].concat(many(9, 76, { rareflag: 0 }), common78), gcfg({
        maxCommonRating: 76
    }));
    check('Gold: Common-Grenze 76 haelt die 78er draussen',
        res5.ok && res5.players.every(p => p.rating <= 76),
        res5.ok ? res5.players.map(p => p.rating).join(',') : res5.reason);

    // Fall 6: Gruppe 4 muss auch greifen, wenn EA die 4 NICHT in p.groups
    // mitschickt - "rare" ist eine Karten-Eigenschaft (rareflag 1), kein Event.
    const noGroups = pool.map(p => Object.assign({}, p, { groups: [] }));
    const res6 = SolverCore.solve(noGroups, gcfg({ slots: 6, rarityConstraints: RARE_G4 }));
    check('Gruppe 4 greift auch ohne 4 in p.groups (rareflag 1 zaehlt)',
        res6.ok && res6.players.filter(p => p.isRare).length === 6,
        res6.ok ? ('rare=' + res6.players.filter(p => p.isRare).length) : res6.reason);

    // Fall 7: Die Anhebung auf alle Slots gilt NUR fuer Gruppe 4. Bei Gruppe 83
    // (TOTW/TOTS/FOF/FUTTIES) will Rasmus genau die geforderte Anzahl - eine
    // Anhebung waere dort teuer falsch.
    const totw = many(6, 82, { rareflag: 3, groups: [83], storage: true });
    const res7 = SolverCore.solve([].concat(totw, many(12, 80, { rareflag: 0 })), gcfg({
        slots: 6,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    }));
    check('Gruppe 83 wird NICHT auf alle Slots angehoben (genau 1)',
        res7.ok && res7.players.filter(p => (p.groups || []).indexOf(83) > -1).length === 1,
        res7.ok ? ('g83=' + res7.players.filter(p => (p.groups || []).indexOf(83) > -1).length) : res7.reason);

    // Fall 8: Rangfolge OHNE Ziel-Rating (Rasmus, live nachgeschaerft):
    //   1. Storage vor Verein  2. niedrigstes Rating  3. Kosten
    // "Wenn es 77er im Storage gibt, gehen die VOR 75ern aus dem Verein."
    const res8 = SolverCore.solve(
        [].concat(many(1, 75, { rareflag: 1 }), many(8, 77, { rareflag: 1, storage: true }),
                  many(12, 76, { rareflag: 0 })),
        gcfg({ slots: 6, rarityConstraints: RARE_G4, maxCommonRating: 76 }));
    check('Gruppe 4: Storage-77er gehen vor der Vereins-75er',
        res8.ok && res8.players.every(p => p.isStorage && p.rating === 77),
        res8.ok ? res8.players.map(p => p.rating + (p.isStorage ? 'S' : 'V')).join(',') : res8.reason);

    // Innerhalb des Storage gilt weiter das niedrigste Rating.
    const res8b = SolverCore.solve(
        [].concat(many(3, 75, { rareflag: 1, storage: true }),
                  many(8, 77, { rareflag: 1, storage: true }),
                  many(12, 76, { rareflag: 0 })),
        gcfg({ slots: 6, rarityConstraints: RARE_G4, maxCommonRating: 76 }));
    check('Innerhalb des Storage: die 75er vor den 77ern',
        res8b.ok && res8b.players.filter(p => p.rating === 75).length === 3,
        res8b.ok ? res8b.players.map(p => p.rating).sort().join(',') : res8b.reason);
}

// ========== 8b-2b. Zwei Live-Fehler aus v4.25.0 ==========
{
    // (a) "Rare: Min. 6" + "Player Quality: Exactly Gold" reservierte sechs
    //     BRONZE-Rare (54-62). Die Qualitaets-Vorgabe filterte nur den
    //     Auffuell-Pool, nicht die Vorgaben-Reservierung.
    const bronzeRare = [].concat(many(6, 62, { rareflag: 1 }), many(4, 54, { rareflag: 1 }));
    const goldRare = [].concat(many(3, 75, { rareflag: 1 }), many(5, 77, { rareflag: 1 }));
    const goldCommon = many(10, 76, { rareflag: 0 });
    const G4 = [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 4 }];
    const gold = { targetOVR: null, minRating: 0, maxRareRating: 77, maxCommonRating: 77,
                   qualityConstraints: [{ label: 'PLAYER_QUALITY', quality: 3, count: 1 }] };
    const res = SolverCore.solve([].concat(bronzeRare, goldRare, goldCommon),
        cfg(null, Object.assign({ slots: 6, rarityConstraints: G4 }, gold)));
    check('Rare-Vorgabe + "Exactly Gold": keine Bronze-Karte im Team',
        res.ok && res.players.every(p => p.rating >= 75),
        res.ok ? res.players.map(p => p.rating).join(',') : res.reason);
    check('Rare-Vorgabe + "Exactly Gold": 6 Rare, die niedrigsten Gold zuerst',
        res.ok && res.players.filter(p => p.isRare).length === 6 &&
        res.players.filter(p => p.rating === 75).length === 3,
        res.ok ? res.players.map(p => p.rating).join(',') : res.reason);

    // Auch wenn die Panel-Grenze fallen muss, bleibt Gold Pflicht: nur Bronze-
    // Rare und Gold-Rare ueber der Grenze vorhanden -> Grenze lockern, NICHT
    // die Qualitaets-Vorgabe.
    const res2 = SolverCore.solve(
        [].concat(bronzeRare, many(6, 85, { rareflag: 1 }), goldCommon),
        cfg(null, Object.assign({ slots: 6, rarityConstraints: G4 }, gold)));
    check('Gelockerte Rare-Grenze bricht die Qualitaets-Vorgabe nicht',
        res2.ok && res2.players.every(p => p.rating >= 75),
        res2.ok ? res2.players.map(p => p.rating).join(',') : res2.reason);

    // (b) Ohne Ziel-Rating kamen sieben Vereins-77er, obwohl 75er da waren:
    //     75/76/77 sind in der Kostentabelle alle Stufe "0-80: 0", also
    //     entschied der Scarcity-Term - und 77er gibt es viele.
    const res3 = SolverCore.solve(
        [].concat(many(20, 77, { rareflag: 0 }), many(9, 75, { rareflag: 0 }),
                  many(2, 76, { rareflag: 0, storage: true })),
        cfg(null, Object.assign({ slots: 9 }, gold,
            { ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC })));
    // Storage zuerst (die beiden 76er), der Rest die NIEDRIGSTEN aus dem
    // Verein - nicht die haeufigen 77er.
    check('Ohne Ziel-Rating: Storage zuerst, dann die 75er aus dem Verein',
        res3.ok && res3.players.filter(p => p.isStorage).length === 2 &&
        res3.players.filter(p => !p.isStorage).every(p => p.rating === 75),
        res3.ok ? res3.players.map(p => p.rating + (p.isStorage ? 'S' : 'V')).sort().join(',') : res3.reason);
    check('Ohne Ziel-Rating: kein einziger 77er aus dem Verein',
        res3.ok && !res3.players.some(p => !p.isStorage && p.rating === 77),
        res3.ok ? res3.players.map(p => p.rating).sort().join(',') : res3.reason);
}

// ========== 8b-2c. Kein Spieler zweimal im Team (HTTP 460) ==========
{
    // Live (v4.26.0): der PUT hatte dieselbe Karte auf zwei Slots und einen
    // leeren Slot -> HTTP 460. Ursache: die Vorgaben-Reservierung lief auf
    // poolAll, das NICHT nach assetId dedupliziert ist - eine Vorgabe-Karte und
    // eine Auffuell-Karte konnten derselbe Spieler sein.
    const G4 = [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 4 }];
    const gold = { targetOVR: null, minRating: 0, maxRareRating: 77, maxCommonRating: 77,
                   qualityConstraints: [{ label: 'PLAYER_QUALITY', quality: 3, count: 1 }] };
    // Sechs Rare, aber nur DREI verschiedene Spieler (je zwei Kopien) - dazu
    // genug Common. Ohne Dedupe wuerden Kopien desselben Spielers reserviert.
    const rare = [];
    for (const asset of [11111, 22222, 33333]) {
        for (let k = 0; k < 2; k++) {
            const p = P(76, { rareflag: 1, storage: true });
            p.assetId = asset;
            rare.push(p);
        }
    }
    const res = SolverCore.solve([].concat(rare, many(12, 77, { rareflag: 1, storage: true }),
                                           many(12, 75, { rareflag: 0 })),
        cfg(null, Object.assign({ slots: 6, rarityConstraints: G4 }, gold)));
    check('Vorgaben-Reservierung: kein Spieler doppelt (assetId)',
        res.ok && new Set(res.players.map(p => String(p.assetId))).size === res.players.length,
        res.ok ? res.players.map(p => p.assetId).join(',') : res.reason);
    check('Vorgaben-Reservierung: keine Karte doppelt (id)',
        res.ok && new Set(res.players.map(p => String(p.id))).size === res.players.length,
        res.ok ? res.players.map(p => p.id).join(',') : res.reason);

    // Die Endkontrolle muss ein kaputtes Team melden statt es einzutragen.
    const srcJs = require('fs').readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8');
    check('Endkontrolle gegen doppelte Karten ist im Code',
        /doppelt im Team/.test(srcJs) && /Nichts eingetragen/.test(srcJs));
    check('Endkontrolle liefert einen teamDump fuer die Diagnose',
        /teamDump/.test(srcJs));
}

// ========== 8b-2d. Gemischte Qualitaets-Vorgaben (Bronze + Silber) ==========
{
    // Live: "Daily Common Gold Upgrade", setId 1037 / challenge 3070.
    //   Bronze: Min. 5 Players | Silber: Min. 5 Players | Squad: 10
    // EA schickt das als ZWEI PLAYER_LEVEL-Vorgaben mit Wert 1 und 2 - und
    // beide mit count 1 statt 5. Vor v4.28.0 gewann Math.max ueber die Stufen,
    // also Silber, und der GANZE Pool wurde auf 65-74 gefiltert: 10x Silber,
    // 0 Bronze, dazu ein "ok".
    const MIXED = [{ label: 'PLAYER_LEVEL', quality: 1, count: 1 },
                   { label: 'PLAYER_LEVEL', quality: 2, count: 1 }];
    const pool = [].concat(many(6, 47, { rareflag: 0 }), many(6, 52, { rareflag: 0 }),
                           many(6, 65, { rareflag: 0 }),
                           many(8, 71, { rareflag: 0, storage: true }),
                           many(12, 78, { rareflag: 0 }));
    // Min-Rating 75 wie in Rasmus' Panel - muss bei Bronze/Silber ignoriert
    // werden, sonst ist die SBC nie loesbar.
    const res = SolverCore.solve(pool, cfg(null, {
        targetOVR: null, slots: 10, minRating: 75, qualityConstraints: MIXED,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC
    }));
    const rs = res.ok ? res.players.map(p => p.rating) : [];
    check('Gemischt: loesbar', res.ok, res.ok ? '' : res.reason);
    check('Gemischt: genau 5 Bronze', res.ok && rs.filter(r => r <= 64).length === 5,
        rs.sort((a, b) => a - b).join(','));
    check('Gemischt: genau 5 Silber',
        res.ok && rs.filter(r => r >= 65 && r <= 74).length === 5,
        rs.sort((a, b) => a - b).join(','));
    check('Gemischt: kein Gold trotz Min-Rating 75',
        res.ok && !rs.some(r => r >= 75), rs.sort((a, b) => a - b).join(','));
    check('Gemischt: die NIEDRIGSTEN Bronze (47er, nicht 52er)',
        res.ok && rs.filter(r => r === 47).length === 5, rs.join(','));
    check('Gemischt: Silber aus dem Storage bevorzugt (71er statt 65er)',
        res.ok && res.players.filter(p => p.rating >= 65 && p.rating <= 74)
            .every(p => p.isStorage),
        res.ok ? res.players.filter(p => p.rating >= 65 && p.rating <= 74)
            .map(p => p.rating + (p.isStorage ? 'S' : 'V')).join(',') : '');
    check('Gemischt: die Verteilung wird gemeldet',
        res.ok && res.warnings.some(w => /5x Bronze \+ 5x Silber/.test(w)),
        res.ok ? JSON.stringify(res.warnings) : '');

    // Keine Specials als Vorgabe-Karte (Rasmus: kein Evo, kein Special).
    const withSpecial = [].concat(many(6, 40, { rareflag: 24, special: true }),
                                  many(6, 47, { rareflag: 0 }),
                                  many(8, 71, { rareflag: 0 }));
    const res2 = SolverCore.solve(withSpecial, cfg(null, {
        targetOVR: null, slots: 10, minRating: 0, qualityConstraints: MIXED,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC
    }));
    check('Gemischt: keine Special-Karte im Team',
        res2.ok && !res2.players.some(p => p.isSpecial),
        res2.ok ? res2.players.map(p => p.rating + (p.isSpecial ? 'X' : '')).join(',') : res2.reason);

    // Unerfuellbar -> klare Meldung statt eines still falschen Teams.
    const res3 = SolverCore.solve(many(20, 71, { rareflag: 0 }), cfg(null, {
        targetOVR: null, slots: 10, minRating: 0, qualityConstraints: MIXED,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC
    }));
    check('Gemischt: fehlende Bronze wird gemeldet, kein stilles Silber-Team',
        !res3.ok && /Bronze/.test(res3.reason || ''),
        res3.ok ? res3.players.map(p => p.rating).join(',') : res3.reason);

    // Eine einzelne Stufe darf sich NICHT wie gemischt verhalten (Regression:
    // "Exactly Gold" ist der haeufige Fall und muss weiter alle Slots binden).
    const res4 = SolverCore.solve(
        [].concat(many(12, 76, { rareflag: 0 }), many(6, 60, { rareflag: 0 })),
        cfg(null, { targetOVR: null, slots: 9, minRating: 0,
            qualityConstraints: [{ label: 'PLAYER_QUALITY', quality: 3, count: 1 }],
            ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC }));
    check('Eine Stufe bleibt eine Stufe: "Exactly Gold" -> alle 9 Gold',
        res4.ok && res4.players.every(p => p.rating >= 75),
        res4.ok ? res4.players.map(p => p.rating).join(',') : res4.reason);
}

// ========== 8b-2e. Abgeben muss den ganzen Controller-Stack absuchen ==========
{
    // Live am Handy (v4.27.0): "Batch gestoppt nach 0/7: Controller hat kein
    // submitChallenge()". In der schmalen Ansicht ist der oberste Controller
    // UTSBCSquadOverviewViewController, und der hat laut controllerScan NUR
    // _submitChallenge - am PC ist es der UTSBCSquadSplitViewController mit
    // beiden. Der Code schaute nur auf EINEN Controller und nur auf den
    // oeffentlichen Namen.
    const src = require("fs").readFileSync(__dirname + "/ea-fc-sbc-optimizer.user.js", "utf8");
    const fn = src.slice(src.indexOf("async function submitChallengeToEa"),
                         src.indexOf("async function openNextInstance"));
    check("Submit sucht auch _submitChallenge", fn.indexOf("_submitChallenge") > -1);
    check("Submit laeuft ueber den ganzen Controller-Stack",
        fn.indexOf("getControllerChain") > -1);
    check("Submit prueft auch die Split-View-Unter-Controller",
        fn.indexOf("leftController") > -1 && fn.indexOf("_overviewController") > -1);
    check("Submit probiert den Service auch MIT Challenge",
        fn.indexOf("_challenge") > -1 && fn.indexOf("tries") > -1);
    check("Die Kandidaten landen im Diagnose-Report",
        /submitCandidates/.test(fn) && /submitCandidates: STATE.diag.submitCandidates/.test(src));
    // Die oeffentliche Methode muss VOR der internen probiert werden: sie macht
    // den regulaeren Weg inklusive Ansicht-Update.
    check("Oeffentliche Methode vor der internen",
        fn.indexOf("c.submitChallenge === ") < fn.indexOf("c._submitChallenge === "));
}

// ========== 8b-2f. Tap am Handy: Touch-Events + Koordinaten ==========
{
    // Live (v4.29.0, Handy): batchSteps meldete dreimal "Set-Kachel geklickt
    // (exakt)", die App blieb aber im Hub (hubScan.inHub true,
    // UTSBCHubViewController). clickLike schickte nur pointer+mouse, ohne
    // Koordinaten - die schmale EA-Ansicht haengt ihre Tap-Handler an
    // touchstart/touchend.
    const src = require("fs").readFileSync(__dirname + "/ea-fc-sbc-optimizer.user.js", "utf8");
    const fn = src.slice(src.indexOf("function clickLike"),
                         src.indexOf("function visibleAll"));
    check("Tap schickt touchstart/touchend",
        fn.indexOf("touchstart") > -1 && fn.indexOf("touchend") > -1);
    check("Tap hat Koordinaten (nicht 0,0)",
        /clientX: x/.test(fn) && /getBoundingClientRect/.test(fn));
    check("Tap scrollt das Ziel ins Bild", fn.indexOf("scrollIntoView") > -1);
    check("Maus-Events entfallen, wenn Touch verarbeitet wurde",
        /if \(!touchHandled\)/.test(fn));
    check("Touch kommt VOR pointer/mouse",
        fn.indexOf("touchstart") < fn.indexOf("pointerdown"));
    check("Tap-Details landen im Diagnose-Report",
        /STATE.diag.lastTap/.test(fn) && /tap: tap/.test(src));
}

// ========== 8b-2g. Report-Groesse und Set-Status ==========
{
    const src = require("fs").readFileSync(__dirname + "/ea-fc-sbc-optimizer.user.js", "utf8");
    // Rasmus konnte den Report nicht mehr komplett kopieren - er brach mitten
    // in challengeResponseSample ab (zig KB, fast nur leere Slots id 0).
    check("challengeResponseSample wird gekuerzt",
        /leere Slots weggelassen/.test(src) && /indexOf\(."players".\)/.test(src));
    // hubScan lieferte 40 Zeilen (pro Set sechs: Kachel, Header, Titel, Content,
    // Rewards, Status). Jetzt eine Zeile pro Set - mit Status, denn der sagt,
    // ob sich das Set noch wiederholen laesst.
    const hub = src.slice(src.indexOf("hubScan: (function"), src.indexOf("submitInfo: (function"));
    check("hubScan liefert eine Zeile pro Set",
        /out.sets.push/.test(hub) && /ut-sbc-set-tile-view/.test(hub));
    check("hubScan nimmt den Status-Text mit", /sbc-status-container/.test(hub));
    // Nur der SELEKTOR zaehlt - das Wort tileContent steht noch im Kommentar,
    // der erklaert, was rausgeflogen ist.
    check("hubScan sammelt keine Unter-Elemente mehr",
        hub.indexOf("[class*=") === -1 && hub.indexOf("querySelector('.tileContent") === -1);

    // Set nicht mehr wiederholbar -> klarer Abbruch statt "Diagnose schicken".
    const fn = src.slice(src.indexOf("function setLooksRepeatable"),
                         src.indexOf("function matchesPlannedSbc"));
    check("Set-Status wird gelesen", /repeatable/.test(fn) && /complete/.test(fn));
    check("Nicht ablesbarer Status bricht NICHT ab (null)",
        /repeatable: null/.test(fn));
    check("Explizite 0 gilt als erschoepft",
        fn.indexOf("Repeatable:") > -1 && /Number\(m\[1\]\) === 0/.test(fn));
    check("Erschoepft wird als Auskunft gemeldet, nicht als Fehler",
        /laesst sich nicht/.test(src.replace(/ä/g, "ae")) &&
        /bereits abgegebenen Runden sind aber durch/.test(src));
}

// ========== 8b-2h. Club-Laden: groessere Seiten + Takt ==========
// Rasmus: "diese 8000+ spieler dauern immer recht lang". Zwei Aenderungen -
// Seitengroesse 175 statt 91 (adaptiv, falls EA kappt) und der Abstand wird
// zwischen den STARTS getaktet statt nach jeder Antwort geschlafen.
// Die Kalibrierung ist die gefaehrliche Stelle: "weniger Items als angefragt"
// heisst normalerweise "fertig" - bei einer Kappung aber NICHT. Darum hier eine
// echte Simulation der Funktion, nicht nur ein Textcheck.
{
    const src = require('fs').readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8');
    const a = src.indexOf('async function fetchClubViaHttp');
    const b = src.indexOf('async function fetchUnassignedViaHttp');
    const fnSrc = src.slice(a, b);

    // Laedt die Funktion mit Attrappen. cap = was EA pro Seite maximal
    // herausgibt, TOTAL = Kartenzahl, withTotal = schickt EA totalItemCount?
    function runLoader(TOTAL, cap, withTotal, failPages) {
        const calls = [];
        const STATE = { pool: [], cancelLoad: false, diag: {}, loadIncomplete: false };
        const sandbox = {
            STATE: STATE,
            calls: calls,
            setTimeout: (f) => { f(); return 0; },   // kein echtes Warten im Test
            Date: Date,
            log: () => {}, warn: () => {},
            extractItems: (j) => j.items,
            normalizePlayer: (it) => ({ id: it.id, rating: 80, assetId: it.id }),
            mergeIntoPool: (ps) => { STATE.pool.push.apply(STATE.pool, ps); },
            apiGet: async (path) => {
                const m = /count=(\d+)&start=(\d+)/.exec(path);
                const want = Number(m[1]), start = Number(m[2]);
                calls.push({ want: want, start: start });
                if (failPages && failPages.indexOf(calls.length) > -1) {
                    throw new Error('HTTP 401 (simuliert)');
                }
                const n = Math.max(0, Math.min(want, cap, TOTAL - start));
                const items = [];
                for (let i = 0; i < n; i++) items.push({ id: start + i + 1 });
                const out = { items: items };
                if (withTotal) out.totalItemCount = TOTAL;
                return out;
            }
        };
        const keys = Object.keys(sandbox);
        const fn = new Function(keys.join(','),
            fnSrc + '\nreturn fetchClubViaHttp;').apply(null, keys.map(k => sandbox[k]));
        return fn().then(found => ({ found: found, calls: calls, STATE: STATE }));
    }

    const results = [];
    // 1. EA gibt 175 her -> alle 8400, deutlich weniger Requests als mit 91.
    results.push(runLoader(8400, 175, true, null).then(r => {
        check('Club-Laden: alle 8400 Karten geholt (Seiten a 175)',
            r.found === 8400 && r.STATE.pool.length === 8400,
            'found=' + r.found + ' pool=' + r.STATE.pool.length);
        check('Club-Laden: 48 Requests statt 93',
            r.calls.length === 48, 'requests=' + r.calls.length);
        check('Club-Laden: fragt mit 175 an', r.calls[0].want === 175);
    }));
    // 2. EA KAPPT auf 150 -> muss kalibrieren UND trotzdem alles laden.
    //    Ohne die Kalibrierung waere hier nach Seite 1 Schluss ("weniger
    //    Items als angefragt = fertig").
    results.push(runLoader(8400, 150, true, null).then(r => {
        check('Kappung auf 150: trotzdem alle 8400 Karten',
            r.found === 8400, 'found=' + r.found + ' requests=' + r.calls.length);
        check('Kappung auf 150: Seitengroesse wird uebernommen',
            r.calls.length > 1 && r.calls[1].want === 150,
            'zweiter Request want=' + (r.calls[1] && r.calls[1].want));
        check('Kappung wird im Report vermerkt',
            r.STATE.diag.clubLoad && r.STATE.diag.clubLoad.pageSize === 150,
            JSON.stringify(r.STATE.diag.clubLoad));
    }));
    // 3. OHNE totalItemCount: die kurze letzte Seite beendet den Lauf.
    results.push(runLoader(300, 175, false, null).then(r => {
        check('Ohne totalItemCount: kurze letzte Seite beendet den Lauf',
            r.found === 300 && r.calls.length === 2,
            'found=' + r.found + ' requests=' + r.calls.length);
    }));
    // 4. Fehlversuch -> Takt wird dauerhaft groesser (Selbstbremse).
    results.push(runLoader(1000, 175, true, [1]).then(r => {
        check('Fehlversuch erhoeht den Takt (Selbstbremse)',
            r.STATE.diag.clubLoad.gap > 300 && r.STATE.diag.clubLoad.retries >= 1,
            JSON.stringify(r.STATE.diag.clubLoad));
        check('Fehlversuch verliert keine Karten',
            r.found === 1000, 'found=' + r.found);
    }));
    // 5. Kein Schlafen NACH der Antwort mehr, sondern Takt zwischen den Starts.
    check('Takt statt Schlafen (Latenz zaehlt mit)',
        /gap - \(Date\.now\(\) - tStart\)/.test(fnSrc) &&
        fnSrc.indexOf('setTimeout(r, 250)') === -1);

    pending.push(Promise.all(results));
}

// ========== 8b-2i. Kachel-Tap ohne Wirkung: Popup/Ueberdeckung ==========
{
    // Live (v4.32.0, PC): der Batch gab eine Runde ab, dann kam die naechste
    // nicht auf. Der Tap kam dreimal an (touchHandled true, inViewport true),
    // das Set hatte laut Kachel noch 19 Wiederholungen offen. Nach einem
    // Neustart lief es wieder -> es hing ein Zustand, kein Selektor.
    const src = require("fs").readFileSync(__dirname + "/ea-fc-sbc-optimizer.user.js", "utf8");
    const ps = src.slice(src.indexOf("function popupState"), src.indexOf("function dismissRewardPopup"));
    check("popupState liest den App-Shield", /gPopupClickShield/.test(ps) && /isShieldUp/.test(ps));
    check("popupState zaehlt bildschirmfuellende Overlays",
        /click-shield/.test(ps) && /innerWidth/.test(ps));
    check("popupState ignoriert unsere eigene UI", /sbc-opt/.test(ps));

    const dm = src.slice(src.indexOf("function dismissRewardPopup"),
                         src.indexOf("function popupState") > 0 ? src.length : 0);
    check("Popups werden MEHRFACH geschlossen (mehrere Overlays hintereinander)",
        /for \(let k = 0; k < 3; k\+\+\)/.test(src));
    check("closed wird nur gemeldet, wenn wirklich was offen war",
        /if \(!before.overlays/.test(src));

    const cl = src.slice(src.indexOf("function clickLike"), src.indexOf("function visibleAll"));
    check("Tap meldet, was an der Stelle GANZ OBEN liegt",
        /elementFromPoint/.test(cl) && /covered/.test(cl));
    check("Tap nimmt den Popup-Zustand mit", /popup: popupState\(\)/.test(cl));

    check("Vor dem Tap wird aufgeraeumt", /popupClosed: pop/.test(src));
    check("Nach zwei wirkungslosen Taps wird der Hub neu aufgebaut",
        /rerender: f2/.test(src) && /setTileAfterRerender/.test(src));
}

// ========== 8b-2j. Veraltete SBC-Instanz + nicht abgedeckte Vorgaben ==========
{
    // Live: nach einem langen Batch lief ein einzelner Lauf in 403 (Challenge
    // 3729), danach in 404/475 (3821). 475/404 heisst "Instanz verbraucht"
    // (wiederholbare SBCs bekommen pro Durchlauf eine neue ID), 403 heisst
    // "EA nimmt das so nicht an" - im reqDump standen scope PLAYER und
    // CLUB MEMBER, also Vorgaben, die der Solver bewusst nicht abdeckt.
    const src = require("fs").readFileSync(__dirname + "/ea-fc-sbc-optimizer.user.js", "utf8");
    const rf = src.slice(src.indexOf("async function resolveFreshChallengeId"),
                         src.indexOf("// Anforderungen der aktuellen Challenge"));
    check("Frische Instanz wird aus der Set-Liste geholt",
        /sbs\/setId\/. \+ setId \+ ./.test(rf) || rf.indexOf("/challenges") > -1);
    check("Die alte ID wird ausgeschlossen", /String\(n.challengeId\) === String\(oldId\)/.test(rf));
    check("Nur bei EINDEUTIGEM Treffer wird getauscht (sonst Abbruch)",
        /cands.length !== 1/.test(rf) && /return null/.test(rf));
    check("Signatur wird geprueft (Ziel-OVR und Slots)",
        /okTarget/.test(rf) && /okSlots/.test(rf));
    check("Der Tausch landet im Report", /staleRecover/.test(rf) && /staleRecover: STATE.diag.staleRecover/.test(src));
    check("Nach dem Tausch wird GENAU EINMAL neu versucht",
        /submitToSbc\(result, true\)/.test(src) && /if \(!_retried\)/.test(src));

    check("403 wird nicht als 'veraltet' verkauft",
        /EA hat das Eintragen abgelehnt \(403\)/.test(src));

    // v4.34.0 hatte hier eine WARNUNG gebaut: Scopes ohne Wert galten als
    // "Vorgabe, die PitTools nicht abdeckt". Das war falsch - "PLAYER" und
    // "CLUB MEMBER" stehen bei JEDER SBC drin (Eligibility: "Spieler-Items aus
    // deinem Verein"). Live bewiesen an einer SBC, die tadellos durchlief
    // (lastErrors leer, lastTeam ok, submitVia app) und trotzdem gewarnt wurde.
    // Diese Tests halten die Fehlannahme jetzt DRAUSSEN.
    check("Keine Warnung mehr aus den reqDump-Scopes",
        src.indexOf("PitTools nicht abdeckt") === -1 &&
        src.indexOf("unsupportedScopes") === -1);
    check("PLAYER und CLUB MEMBER gelten als Boilerplate",
        /BOILERPLATE = \['PLAYER', 'CLUB MEMBER'/.test(src));
    check("Die Scope-Liste ist nur noch informativ", /otherScopes/.test(src));
    check("403 fragt EA selbst (isSBCSquadEligible) statt zu raten",
        /lastEligible/.test(src) && /isSBCSquadEligible/.test(src));
    check("Der Denkfehler ist im Code dokumentiert",
        /Eligibility-Scopes, die JEDE SBC hat/.test(src));
}

// ========== 8b-2k. Aufgerufene Helfer muessen es auch geben ==========
{
    // In v4.35.0 stand kurz ein Aufruf von findLiveSquad() im Code - eine
    // Funktion, die es nie gab. `node --check` sieht das nicht (die Syntax ist
    // gueltig), es haette erst am Handy geknallt. Dieselbe Fehlerklasse wie der
    // log2()-Tippfehler von damals.
    const src = require('fs').readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8');
    const defined = new Set();
    let m;
    const defRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = defRe.exec(src))) defined.add(m[1]);
    const constRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g;
    while ((m = constRe.exec(src))) defined.add(m[1]);
    // Unsere eigenen Helfer folgen erkennbaren Namensschemata - Browser- und
    // EA-Funktionen bleiben damit aussen vor.
    const callRe = /\b((?:find|click|dismiss|resolve|collect|normalize|merge|extract|nudge|popup|batch)[A-Z][\w$]*)\s*\(/g;
    const missing = new Set();
    while ((m = callRe.exec(src))) {
        const before = src.charAt(m.index - 1);
        if (before === '.' || before === '_') continue;
        if (!defined.has(m[1])) missing.add(m[1]);
    }
    check('Kein Aufruf einer Funktion, die es nicht gibt',
        missing.size === 0, Array.from(missing).join(', '));
}

// ========== 8b-3. Der Rare-Parser darf keine Spielernamen matchen ==========
{
    // Live-Fehler (v4.24.0): ein Substring-Match auf "RARE" im Scope-Namen hat
    // SPIELERNAMEN getroffen - "Carrarese Calcio", "Brian Ferrares",
    // "Rareș Ilie/Gal/Pop" - und Phantom-Rare-Vorgaben erzeugt.
    const src = require('fs').readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8');
    check('Parser: kein Substring-Match auf RARE (traf Spielernamen)',
        src.indexOf("indexOf('RARE')") === -1,
        src.indexOf("indexOf('RARE')") > -1 ? 'indexOf(RARE) ist zurueck' : '');
    check('Quelle warnt vor dem Namens-Treffer',
        /Carrarese/.test(src) && /SPIELERNAMEN/.test(src));

    // Und die Gegenprobe am echten Report-Ausschnitt: diese Scopes sind Namen.
    const namey = ['CARRARESE CALCIO', 'BRIAN FERRARES', 'RAREȘ ILIE'];
    check('Gegenprobe: Namens-Scopes wuerden mit dem alten Match anschlagen',
        namey.every(n => n.toUpperCase().indexOf('RARE') > -1 ||
                         n.toUpperCase().indexOf('RARES') > -1));
}

// ========== 8b-4. PaleTools-Locks: kurze IDs (assetId/resourceId) ==========
{
    // Live-Report: paletools:2026:...:lockedItems = [100664921, 190871, 225733,
    // 50332136, ...] - KEINE 12-stelligen Item-IDs. Die alte Schwelle 1e11 hat
    // alles verworfen (found: 0), obwohl der Key da war.
    const src = require('fs').readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8');
    const a = src.indexOf('function looksLikeItemId');
    const b = src.indexOf('\n    }', a) + 6;
    check('looksLikeItemId ist vorhanden', a > -1 && b > a);
    const looks = eval('(' + src.slice(a, b).replace('function looksLikeItemId', 'function') + ')');
    const real = [100664921, 190871, 225733, 50332136, 83923656];
    check('Locks: echte PaleTools-IDs werden erkannt', real.every(looks),
        real.filter(x => !looks(x)).join(','));
    check('Locks: 12-stellige Item-IDs weiter erkannt', looks(916543482768));
    check('Locks: Muell wird verworfen',
        !looks(true) && !looks('abc') && !looks(1.5) && !looks(0) && !looks(null));

    // Und der Filter selbst: sperrt PaleTools per assetId oder resourceId,
    // muss die Karte trotzdem draussen bleiben.
    const byAsset = P(84, {}); byAsset.assetId = 190871;
    const byRes = P(84, {}); byRes.resourceId = 50332136;
    const r = SolverCore.solve([].concat([byAsset, byRes], many(11, 84)),
        cfg(84, { lockedIds: [190871, 50332136] }));
    check('Lock per assetId schliesst die Karte aus',
        r.ok && !r.players.some(p => p.assetId === 190871),
        r.ok ? 'drin' : r.reason);
    check('lockedPacks wird uebersprungen (Pack-IDs sind keine Karten)',
        /pack\/i\.test\(k\)/.test(src) || src.indexOf('/pack/i.test(k)') > -1,
        'kein Pack-Ausschluss in readPaletoolsLocks');
    check('Lock per resourceId schliesst die Karte aus',
        r.ok && !r.players.some(p => p.resourceId === 50332136),
        r.ok ? 'drin' : r.reason);
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

// Erst die asynchronen Blöcke abwarten, dann abrechnen. Ohne das killt
// process.exit() die Loader-Tests, bevor sie laufen - sie zählten dann nicht mit
// und ein Fehler dort wäre unbemerkt geblieben.
Promise.all(pending).then(function () {
    console.log('\n' + (tests - failures) + '/' + tests + ' Tests bestanden.');
    process.exit(failures ? 1 : 0);
}, function (e) {
    console.error('FAIL  asynchroner Testblock geworfen: ' + (e && e.message || e));
    process.exit(1);
});
