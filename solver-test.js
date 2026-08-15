/*
 * Test-Harness für den SBC-Solver v4 (Ziel: minimales EXAKTES Dezimal-Rating,
 * Karten-Kosten als Sekundärziel im Überschuss-Fenster).
 * Extrahiert den [SOLVER-BEGIN]..[SOLVER-END]-Block aus dem Userscript
 * und testet GENAU den ausgelieferten Code (kein Duplikat).
 */
'use strict';
const fs = require('fs');

const src = fs.readFileSync(__dirname + '/ea-fc-sbc-optimizer.user.js', 'utf8');

// ---- Test-Extraktions-Helfer -------------------------------------------
// Gemeinsame Bausteine fuer jeden Testblock unten, der Code aus der oben
// EINMAL gelesenen `src` herausschneidet, um GENAU den ausgelieferten Stand
// zu pruefen (kein separat gepflegtes Duplikat, Pattern
// eingebetteten-code-exakt-testen). Siehe
// docs/roadmap/shared-items/test-extraktions-helfer.md fuer Konsumenten und
// den Migrations-Vertrag (Testblock 26 haelt beide Helfer byte-gleich gegen
// die urspruenglichen Einzel-Implementierungen).

// Schneidet den Text zwischen zwei Kommentar-Markern aus (z.B. "// [SOLVER-BEGIN]"
// / "// [SOLVER-END]"), EXKLUSIVE beider Marker - genau das Format, das
// new Function(...) als kompilierbaren Codeblock braucht.
function extractMarkerBlock(src, beginMarker, endMarker) {
    const start = src.indexOf(beginMarker);
    if (start === -1) return null;
    const contentStart = start + beginMarker.length;
    const end = src.indexOf(endMarker, contentStart);
    if (end === -1) return null;
    return src.slice(contentStart, end);
}

// Findet zur oeffnenden Klammer an Position openIdx die zugehoerige
// schliessende Klammer per Tiefenzaehlung. Ein indexOf(naechste Deklaration)
// waere bei benachbarten Funktionen/Objekt-Literalen zufaellig richtig, bricht
// aber bei einer Umstellung der Reihenfolge lautlos.
function matchingBraceIndex(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

// Schneidet eine benannte Funktion (inkl. "function"/"async function" und
// Signatur) per Klammer-Zaehlung komplett aus - unabhaengig davon, was im
// Quelltext auf sie folgt, im Gegensatz zu einem indexOf(naechste Funktion).
function extractFunction(src, functionName) {
    let key = src.indexOf('function ' + functionName);
    if (key === -1) return null;
    if (src.slice(Math.max(0, key - 6), key) === 'async ') key -= 6;
    const openBrace = src.indexOf('{', src.indexOf('(', key));
    const close = matchingBraceIndex(src, openBrace);
    if (close === -1) return null;
    return src.slice(key, close + 1);
}

const solverBlock = extractMarkerBlock(src, '// [SOLVER-BEGIN]', '// [SOLVER-END]');
if (!solverBlock) { console.error('SOLVER-Block nicht gefunden!'); process.exit(1); }
const SolverCore = new Function(solverBlock + '\nreturn SolverCore;')();

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

// Brute force über das V-Ziel (V = N² * exaktes Rating).
// Nur für Configs OHNE Reservierungen korrekt.
// Karten-Kosten kommen von SolverCore.makeCostOf() - der SSOT aus dem
// Userscript selbst (SOLVER-Block), keine eigenständige Nachbildung mehr
// (vorher cardCostFn(), nur per Kommentar synchron gehalten).
function bruteBest(pool, c) {
    const N = c.slots || 11;
    const T = c.targetOVR;
    const NEED = N * N * T - Math.floor(N / 2);
    const windowV = Math.round((c.maxOvershoot != null ? c.maxOvershoot : 0.10) * N * N);
    const cardCost = SolverCore.makeCostOf(pool, c);
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
    const cardCost = SolverCore.makeCostOf(pool, c);
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
    // teuer und der Test prüfte nichts mehr). KEINE SSOT-Drift: bewusst
    // unabhängig von SolverCore.DEFAULT_RATING_COST_SPEC, nicht mit ihr
    // synchron halten.
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
    const uiKey = src.indexOf('        ui = {');
    const uiOpen = src.indexOf('{', uiKey);
    const uiClose = matchingBraceIndex(src, uiOpen);
    const uiBlock = src.slice(uiOpen + 1, uiClose);
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
    // Historisch fixierte Tabelle des v4.8.0-Vorfalls - NICHT auf
    // SolverCore.DEFAULT_RATING_COST_SPEC umstellen, sonst reproduziert dieser
    // Test das damalige Kostenverhältnis nicht mehr.
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
    check('Endkontrolle gegen doppelte Karten ist im Code',
        /doppelt im Team/.test(src) && /Nichts eingetragen/.test(src));
    check('Endkontrolle liefert einen teamDump fuer die Diagnose',
        /teamDump/.test(src));
}

// ========== 8b-2e. reserve()-Funnel: Anker + manueller Rarity-Pick mit
// kollidierender assetId (Brute-Force) ==========
{
    // Der Anker- und der manuelle Rarity-Pick-Pfad reservierten frueher
    // "used.add(...); reserved.push(...)" inline statt ueber reserve() zu
    // laufen - usedAssets blieb dabei fuer beide Pfade unbefuellt. Folgenlos
    // war das nur, weil die SPIELER-EINDEUTIGKEIT (oben im Solver) pool/
    // poolAll schon VOR der Anker-/Rarity-Pick-Auswahl pro assetId
    // deduplizert: ein zweiter Eintrag mit derselben assetId wie der Anker
    // (bzw. der manuelle Pick) kann den Anker-/Pick-Fund darum gar nicht
    // ueberleben. Diese zwei Tests konstruieren genau diese Kollision
    // (zwei Karten, eine assetId) UND machen sie wirtschaftlich verlockend
    // (die "zweite Karte desselben Spielers" ist zusaetzlich die guenstigere
    // Storage-Karte) - ein Solver, der die Dedupe/den Funnel nicht durchsetzt,
    // haette einen echten Anreiz, sie trotzdem zu waehlen. Erwartungswerte
    // sind per Brute-Force ermittelt (nie aus dem Kopf, CLAUDE.md) und dieser
    // Test lief unveraendert VOR UND NACH dem reserve()-Umbau gruen (per
    // manuellem Abgleich gegen den Stand vor dem Refactor bestaetigt).
    function bruteBestFixed(pool, c, requiredIds, excludedIds) {
        const N = c.slots || 11;
        const T = c.targetOVR;
        const NEED = N * N * T - Math.floor(N / 2);
        const windowV = Math.round((c.maxOvershoot != null ? c.maxOvershoot : 0.10) * N * N);
        const cardCost = SolverCore.makeCostOf(pool, c);
        const required = pool.filter(p => requiredIds.has(p.id));
        const rest = pool.filter(p => !requiredIds.has(p.id) && !excludedIds.has(p.id));
        const need = N - required.length;
        const reqRatings = required.map(p => p.rating);
        const reqCost = required.reduce((s, p) => s + cardCost(p), 0);
        const feasible = [];
        const idx = [];
        (function rec(start, cnt) {
            if (cnt === need) {
                const ratings = reqRatings.concat(idx.map(i => rest[i].rating));
                const V = SolverCore.squadV(ratings);
                if (V >= NEED) {
                    const cost = reqCost + idx.reduce((s, i) => s + cardCost(rest[i]), 0);
                    feasible.push({ V: V, cost: cost });
                }
                return;
            }
            if (rest.length - start < need - cnt) return;
            for (let i = start; i < rest.length; i++) { idx.push(i); rec(i + 1, cnt + 1); idx.pop(); }
        })(0, 0);
        if (!feasible.length) return null;
        let vMin = Infinity;
        for (const f of feasible) if (f.V < vMin) vMin = f.V;
        let best = Infinity;
        for (const f of feasible) if (f.V <= vMin + windowV) {
            const obj = f.cost + (f.V - vMin) * 1e-4;
            if (obj < best) best = obj;
        }
        return { vMin: vMin, bestObj: best };
    }

    // ---- Anker-Pfad ----
    const anchor = P(90, { assetId: 7001, storage: false });
    const twin = P(90, { assetId: 7001, storage: true }); // gleicher Spieler, guenstiger (Storage)
    const fillersA = [].concat(many(5, 79), many(5, 84), many(3, 90));
    const poolA = [].concat([anchor, twin], fillersA);
    const cA = cfg(84, { scarcityWeight: 0, storageBonus: 2, ratingCostSpec: '0-99:0', anchorId: anchor.id });
    const resA = SolverCore.solve(poolA, cA);
    check('Anker: Team erreicht Ziel', resA.ok && resA.ovr >= 84, resA.ok ? '' : resA.reason);
    check('Anker: Anker selbst im Team', resA.ok && resA.players.some(p => p.id === anchor.id));
    check('Anker: Zwilling (gleicher Spieler) NICHT im Team',
        resA.ok && !resA.players.some(p => p.id === twin.id));
    check('Anker: kein Spieler doppelt (assetId)', resA.ok &&
        new Set(resA.players.map(p => String(p.assetId))).size === resA.players.length);
    const bfA = bruteBestFixed(poolA, cA, new Set([anchor.id]), new Set([twin.id]));
    check('Anker: Brute-Force-Optimum erreicht (V + Kosten)', resA.ok && bfA &&
        SolverCore.squadV(resA.players.map(p => p.rating)) === bfA.vMin &&
        Math.abs(solverObjective(resA, poolA, cA, bfA.vMin) - bfA.bestObj) < 1e-6,
        resA.ok ? ('V=' + SolverCore.squadV(resA.players.map(p => p.rating)) + ' vs vMin=' + (bfA && bfA.vMin)) : resA.reason);

    // ---- Manueller Rarity-Pick-Pfad ----
    const pick = P(85, { assetId: 8001, groups: [83], special: true, rareflag: 3, storage: false });
    const twinPick = P(92, { assetId: 8001, groups: [83], special: true, rareflag: 3, storage: true });
    const fillersB = [].concat(many(5, 82, { groups: [19] }), many(5, 84, { groups: [19] }), many(5, 86, { groups: [19] }));
    const poolB = [].concat([pick, twinPick], fillersB);
    const cB = cfg(84, {
        scarcityWeight: 0, storageBonus: 2, ratingCostSpec: '0-99:0',
        rarityPickId: pick.id,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    });
    const resB = SolverCore.solve(poolB, cB);
    check('Rarity-Pick: Team erreicht Ziel', resB.ok && resB.ovr >= 84, resB.ok ? '' : resB.reason);
    check('Rarity-Pick: manuelle Karte selbst im Team', resB.ok && resB.players.some(p => p.id === pick.id));
    check('Rarity-Pick: Zwilling (gleicher Spieler) NICHT im Team',
        resB.ok && !resB.players.some(p => p.id === twinPick.id));
    check('Rarity-Pick: genau eine Gruppe-83-Karte', resB.ok &&
        resB.players.filter(p => p.groups && p.groups.indexOf(83) > -1).length === 1);
    check('Rarity-Pick: kein Spieler doppelt (assetId)', resB.ok &&
        new Set(resB.players.map(p => String(p.assetId))).size === resB.players.length);
    const bfB = bruteBestFixed(poolB, cB, new Set([pick.id]), new Set([twinPick.id]));
    check('Rarity-Pick: Brute-Force-Optimum erreicht (V + Kosten)', resB.ok && bfB &&
        SolverCore.squadV(resB.players.map(p => p.rating)) === bfB.vMin &&
        Math.abs(solverObjective(resB, poolB, cB, bfB.vMin) - bfB.bestObj) < 1e-6,
        resB.ok ? ('V=' + SolverCore.squadV(resB.players.map(p => p.rating)) + ' vs vMin=' + (bfB && bfB.vMin)) : resB.reason);
}

// ========== 8b-2f. Sortier-Komparator (makeFillCmp): Snapshot bei Kosten-/
// Rating-Gleichstand ==========
{
    // Vier woertlich duplizierte Sortier-Komparatoren wurden durch eine
    // Factory (makeFillCmp) ersetzt. Dieser Test prueft NICHT nur das
    // aggregierte V/Kosten-Ergebnis, sondern WELCHE konkrete Karte bei einem
    // echten Gleichstand (Storage/Rating/Kosten identisch) gewinnt: Club-Gold
    // vor Club-Special (priorityOf 3 vor 4, makeConsumeCmp). Lief unveraendert
    // vor und nach dem Comparator-Refactor (manuell gegen den Stand vor dem
    // Umbau bestaetigt).
    const seed = P(95, { storage: true });
    const golds = many(10, 80, {});
    const special = P(80, { special: true, rareflag: 24 });
    const pool = [].concat([seed], golds, [special]);
    const res = SolverCore.solve(pool, cfg(null, { anchorId: seed.id }));
    check('Auffuellen ohne Ziel-OVR: bei Gleichstand gewinnt Gold vor Special',
        res.ok && !res.players.some(p => p.id === special.id) &&
        golds.every(g => res.players.some(p => p.id === g.id)),
        res.ok ? res.players.map(p => p.name).join(',') : res.reason);
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
    const fn = extractFunction(src, 'submitChallengeToEa');
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
    const fn = extractFunction(src, 'clickLike');
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
    // Rasmus konnte den Report nicht mehr komplett kopieren - er brach mitten
    // in challengeResponseSample ab (zig KB, fast nur leere Slots id 0).
    check("challengeResponseSample wird gekuerzt",
        /leere Slots weggelassen/.test(src) && /indexOf\(."players".\)/.test(src));
    // hubScan lieferte 40 Zeilen (pro Set sechs: Kachel, Header, Titel, Content,
    // Rewards, Status). Jetzt eine Zeile pro Set - mit Status, denn der sagt,
    // ob sich das Set noch wiederholen laesst.
    // "hubScan: (function () {...})()" ist ein Property-Key mit anonymer IIFE,
    // keine benannte Funktionsdeklaration und kein Marker-Paar - passt strukturell
    // zu keinem der beiden Extraktions-Helfer (extractFunction sucht "function
    // NAME", extractMarkerBlock ein Kommentar-Markerpaar). Bewusste
    // Einzelfall-Extraktion per indexOf/slice statt erzwungener Helfer-Nutzung.
    const hub = src.slice(src.indexOf("hubScan: (function"), src.indexOf("submitInfo: (function"));
    check("hubScan liefert eine Zeile pro Set",
        /out.sets.push/.test(hub) && /ut-sbc-set-tile-view/.test(hub));
    check("hubScan nimmt den Status-Text mit", /sbc-status-container/.test(hub));
    // Nur der SELEKTOR zaehlt - das Wort tileContent steht noch im Kommentar,
    // der erklaert, was rausgeflogen ist.
    check("hubScan sammelt keine Unter-Elemente mehr",
        hub.indexOf("[class*=") === -1 && hub.indexOf("querySelector('.tileContent") === -1);

    // Set nicht mehr wiederholbar -> klarer Abbruch statt "Diagnose schicken".
    const fn = extractFunction(src, 'setLooksRepeatable');
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
    const ps = extractFunction(src, 'popupState');
    check("popupState liest den App-Shield", /gPopupClickShield/.test(ps) && /isShieldUp/.test(ps));
    check("popupState zaehlt bildschirmfuellende Overlays",
        /click-shield/.test(ps) && /innerWidth/.test(ps));
    check("popupState ignoriert unsere eigene UI", /sbc-opt/.test(ps));

    check("Popups werden MEHRFACH geschlossen (mehrere Overlays hintereinander)",
        /for \(let k = 0; k < 3; k\+\+\)/.test(src));
    check("closed wird nur gemeldet, wenn wirklich was offen war",
        /if \(!before.overlays/.test(src));

    const cl = extractFunction(src, 'clickLike');
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
    const rf = extractFunction(src, 'resolveFreshChallengeId');
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
    const looksLikeItemIdSrc = extractFunction(src, 'looksLikeItemId');
    check('looksLikeItemId ist vorhanden', !!looksLikeItemIdSrc);
    const looks = eval('(' + looksLikeItemIdSrc.replace('function looksLikeItemId', 'function') + ')');
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

// ========== 8b-5. normalizePlayer/isEvolution gegen rohe EA-Rohdaten ==========
{
    // 8b-4 und der P()-Helfer oben testen nur das bereits NORMALISIERTE
    // Zielschema - die eigentliche Ausschlusslogik fuer Leihspieler/Konzept-
    // Karten/Evolutions (LEARNINGS SS2, Zeile 37-59) lief nie gegen die echten,
    // rohen EA-Feldnamen (academyId, loans, concept, itemType, ...).
    const poolSrc = [
        extractFunction(src, 'isNormalCard'),
        extractFunction(src, 'isEvolution'),
        extractFunction(src, 'normalizePlayer'),
        extractFunction(src, 'resolvePlayerName')
    ].join('\n');
    // Jeder Aufruf bekommt eine frische STATE.diag.evoExcluded - sonst wuerden
    // die Zaehler-Checks unten von vorherigen Fixtures verfaelscht.
    function fresh() {
        const STATE = { diag: { evoExcluded: 0 } };
        const mod = new Function('STATE', poolSrc +
            '\nreturn { isEvolution: isEvolution, normalizePlayer: normalizePlayer, resolvePlayerName: resolvePlayerName };')(STATE);
        mod.STATE = STATE;
        return mod;
    }

    // Leihspieler (loans > 0) - nie in den Pool, ungeachtet gueltigen Ratings.
    check('Leihspieler ausgeschlossen', fresh().normalizePlayer({ loans: 1, rating: 84, id: 1 }) === null);
    // Reihenfolge-Falle (Gap-Report): SOWOHL loans>0 ALS AUCH ein sonst
    // vollstaendig gueltiges Item (rating, id, rareflag, assetId) - ein
    // kuenftiger Refactor darf die Check-Reihenfolge nicht so umbauen, dass
    // eine geliehene Karte durch eine "einfachere" Fixture-Form durchrutscht.
    check('Leihspieler bleibt ausgeschlossen trotz sonst vollstaendig gueltiger Felder',
        fresh().normalizePlayer({ loans: 2, rating: 88, id: 7, rareflag: 1, assetId: 7 }) === null);

    // Konzept-Spieler - mehrere dokumentierte Flag-Varianten (LEARNINGS SS2).
    check('Konzept ueber concept===true', fresh().normalizePlayer({ concept: true, rating: 84, id: 1 }) === null);
    check('Konzept ueber isConcept===true', fresh().normalizePlayer({ isConcept: true, rating: 84, id: 1 }) === null);
    check('Konzept ueber conceptItem===true', fresh().normalizePlayer({ conceptItem: true, rating: 84, id: 1 }) === null);
    check('Konzept ueber isConcept()-Funktion',
        fresh().normalizePlayer({ isConcept: () => true, rating: 84, id: 1 }) === null);

    // Evolutions - mehrere Flag-Varianten (isEvolution), keine darf durchrutschen.
    const evoFixtures = [
        ['academyId', { academyId: 5, rating: 84, id: 1 }],
        ['academyItemId', { academyItemId: 9, rating: 84, id: 1 }],
        ['academyAttributes als Array', { academyAttributes: [{ a: 1 }], rating: 84, id: 1 }],
        ['academyAttributes als Objekt', { academyAttributes: { boost: 1 }, rating: 84, id: 1 }],
        ['evolutionId', { evolutionId: 3, rating: 84, id: 1 }],
        ['evolutionData', { evolutionData: {}, rating: 84, id: 1 }],
        ['evoPath', { evoPath: {}, rating: 84, id: 1 }],
        ['isEvo===true', { isEvo: true, rating: 84, id: 1 }],
        ['isAcademy===true', { isAcademy: true, rating: 84, id: 1 }],
        // Live verifiziert (fc26): Evos tragen tradableBeforeAcademy, auch wenn false.
        ['tradableBeforeAcademy===false', { tradableBeforeAcademy: false, rating: 84, id: 1 }],
        ['isAcademyItem()-Funktion', { isAcademyItem: () => true, rating: 84, id: 1 }]
    ];
    for (const [label, raw] of evoFixtures) {
        const mod = fresh();
        check('Evolution ausgeschlossen: ' + label, mod.normalizePlayer(raw) === null);
        check('Evolution zaehlt in STATE.diag.evoExcluded: ' + label, mod.STATE.diag.evoExcluded === 1,
            'evoExcluded=' + mod.STATE.diag.evoExcluded);
    }
    // Leihspieler/Konzept sind KEINE Evolutions - der Zaehler darf dafuer nicht steigen.
    check('evoExcluded bleibt bei Leihspieler auf 0', (() => {
        const m = fresh(); m.normalizePlayer({ loans: 1, rating: 84, id: 1 }); return m.STATE.diag.evoExcluded === 0;
    })());

    // Kein Spieler-Item (itemType/type ungleich 'player').
    check('itemType!=="player" ausgeschlossen',
        fresh().normalizePlayer({ itemType: 'club', rating: 84, id: 1 }) === null);
    check('type!=="player" ausgeschlossen (Alt-Feldname)',
        fresh().normalizePlayer({ type: 'kit', rating: 84, id: 1 }) === null);

    // Fehlendes Pflichtfeld.
    check('fehlendes rating -> null', fresh().normalizePlayer({ id: 1 }) === null);
    check('fehlende id -> null', fresh().normalizePlayer({ rating: 84 }) === null);
    check('kein Objekt -> null', fresh().normalizePlayer(null) === null);

    // Gueltige Karte: normalisiertes Zielschema mit korrektem isRare/isGold/isCommon.
    const valid = fresh().normalizePlayer({ id: 42, rating: 84, rareflag: 1, assetId: 42 });
    check('gueltige Karte liefert Objekt statt null', valid !== null);
    check('gueltige Karte: isGold true bei rareflag 1', valid && valid.isGold === true);
    check('gueltige Karte: isRare true bei rareflag 1', valid && valid.isRare === true);
    check('gueltige Karte: isCommon false bei rareflag 1', valid && valid.isCommon === false);

    const common = fresh().normalizePlayer({ id: 43, rating: 84, rareflag: 0, assetId: 43 });
    check('rareflag 0: isCommon true, isRare false',
        common && common.isCommon === true && common.isRare === false);

    const special = fresh().normalizePlayer({ id: 44, rating: 84, rareflag: 24, assetId: 44 });
    check('rareflag >=2: isSpecial true, isGold false',
        special && special.isSpecial === true && special.isGold === false);
}

// ========== 8b-6. readPaletoolsLocks/harvestIds/findLockBranches End-to-End ==========
{
    // 8b-4 testete nur looksLikeItemId isoliert und den Pack-Ausschluss als
    // reinen Text-Vorhandensein-Check - die eigentliche Traversierung (Array-
    // Form, Objekt-Form, Pack-Ausschluss NEBENEINANDER in DERSELBEN
    // localStorage-Instanz, verschachtelte Zweige) lief nie als Verhalten durch.
    const fnSrc = [
        extractFunction(src, 'looksLikeItemId'),
        extractFunction(src, 'harvestIds'),
        extractFunction(src, 'findLockBranches'),
        extractFunction(src, 'readPaletoolsLocks')
    ].join('\n');

    function makeLocalStorage(map) {
        const keys = Object.keys(map);
        return {
            get length() { return keys.length; },
            key: (i) => keys[i],
            getItem: (k) => (k in map ? map[k] : null)
        };
    }
    // Live-Struktur (LEARNINGS SS12, Zeile 543-563): kurze Zahlen (assetId/
    // resourceId statt 12-stelliger Item-ID), lockedItems als Array UND
    // lockedItemsMap als Objekt-Keys, lockedPacks (Pack-IDs, KEINE Karten)
    // koexistierend in DERSELBEN Instanz, plus ein verschachtelter Zweig fuer
    // findLockBranches' Rekursion.
    const map = {
        'paletools:locks:lockedItems': JSON.stringify([100664921, 190871, 225733]),
        'paletools:profile:lockedItemsMap': JSON.stringify({ '50332136': true, '83923656': false }),
        'paletools:packs:lockedPacks': JSON.stringify([1030, 20038]),
        'paletools:misc:state': JSON.stringify({ meta: { nested: { locked: [700123456] } } })
    };
    const localStorage = makeLocalStorage(map);
    const STATE = { diag: {} };
    const errors = [];
    function reportError(label) { errors.push(label); }
    const mod = new Function('localStorage', 'STATE', 'reportError',
        fnSrc + '\nreturn { looksLikeItemId: looksLikeItemId, readPaletoolsLocks: readPaletoolsLocks };')(
        localStorage, STATE, reportError);

    const ids = mod.readPaletoolsLocks();
    const idArr = Array.from(ids).sort();

    check('Array-Form (lockedItems) liefert alle drei IDs',
        ['100664921', '190871', '225733'].every(id => ids.has(id)), idArr.join(','));
    check('Objekt-Form (lockedItemsMap): true-Eintrag zaehlt', ids.has('50332136'), idArr.join(','));
    check('Objekt-Form: false-Eintrag zaehlt NICHT als gesperrt', !ids.has('83923656'), idArr.join(','));
    check('lockedPacks wird komplett uebersprungen (keine Pack-ID gilt als Lock)',
        !ids.has('1030') && !ids.has('20038'), idArr.join(','));
    check('verschachtelter Zweig wird ueber findLockBranches gefunden', ids.has('700123456'), idArr.join(','));
    check('genau 5 IDs gefunden (keine Packs, kein false-Eintrag)', ids.size === 5, idArr.join(','));

    check('STATE.diag.locks.found stimmt', STATE.diag.locks && STATE.diag.locks.found === 5,
        JSON.stringify(STATE.diag.locks));
    check('STATE.diag.locks.keysScanned zaehlt alle vier paletools-Keys',
        STATE.diag.locks && STATE.diag.locks.keysScanned === 4,
        JSON.stringify(STATE.diag.locks));
    check('kein Scan-Fehler -> STATE.diag.locks.error bleibt null',
        STATE.diag.locks && STATE.diag.locks.error === null && errors.length === 0);
    check('Gegenprobe: Pack-Zahlen erfuellen looksLikeItemId (der Ausschluss ist der Key-Filter, nicht die Zahl selbst)',
        mod.looksLikeItemId(1030) && mod.looksLikeItemId(20038));

    // Abbruch MITTEN in der Schleife (z.B. localStorage.key() wirft) - der
    // Diagnose-Report muss das zeigen statt nur ueber niedrige Zahlen zu
    // erraten (CLAUDE.md: gesperrte Karten NIEMALS verbauen - ein stiller
    // Teilausfall waere sicherheitsrelevant).
    const brokenLocalStorage = {
        length: 2,
        key: (i) => { if (i === 1) throw new Error('SecurityError (simuliert)'); return 'paletools:locks:lockedItems'; },
        getItem: () => JSON.stringify([100664921])
    };
    const STATE2 = { diag: {} };
    const errors2 = [];
    function reportError2(label, e) { errors2.push(label + ': ' + (e && e.message)); }
    const mod2 = new Function('localStorage', 'STATE', 'reportError',
        fnSrc + '\nreturn { readPaletoolsLocks: readPaletoolsLocks };')(brokenLocalStorage, STATE2, reportError2);
    const ids2 = mod2.readPaletoolsLocks();
    check('Abbruch in der Schleife setzt STATE.diag.locks.error sichtbar',
        STATE2.diag.locks && /SecurityError/.test(STATE2.diag.locks.error || ''),
        JSON.stringify(STATE2.diag.locks));
    check('Abbruch ruft reportError auf (nicht nur einen stillen Catch)',
        errors2.length === 1, errors2.join(','));
    check('bereits gefundene IDs vor dem Abbruch bleiben erhalten',
        ids2.has('100664921'), Array.from(ids2).join(','));
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

// ========== 16. reportError-Helfer: existiert und bedient beide Kanaele ==========
{
    const body = extractFunction(src, 'reportError') || '';
    check('reportError ist direkt neben diagError definiert', !!body);
    check('reportError ruft warn( auf', /\bwarn\(/.test(body), body);
    check('reportError ruft diagError( auf', /\bdiagError\(/.test(body), body);
}

// ========== 17. STATE.diag-Schema: gelesen <-> deklariert <-> zugewiesen ==========
{
    // Verhindert die Fehlerklasse aus dem uiScan-Vorfall: ein Feld, das
    // buildDiagReport() liest, aber das nirgends deklariert ist, liefert
    // dauerhaft null, ohne dass ein Fehler auffaellt - und umgekehrt ein
    // deklariertes Feld, das nirgends befuellt wird, ist tote Deklaration.
    const diagDeclKey = src.indexOf('diag: {');
    check('STATE.diag-Deklaration gefunden', diagDeclKey > -1);
    const diagOpen = src.indexOf('{', diagDeclKey);
    const diagClose = matchingBraceIndex(src, diagOpen);
    const diagDeclSrc = src.slice(diagOpen + 1, diagClose);
    const declared = new Set();
    {
        const re = /^\s*([A-Za-z_$][\w$]*)\s*:/gm;
        let mm;
        while ((mm = re.exec(diagDeclSrc))) declared.add(mm[1]);
    }
    check('STATE.diag deklariert mindestens 18 Felder (voller Schema-Umfang statt 6)',
        declared.size >= 18, Array.from(declared).join(','));

    const fnKey = src.indexOf('function buildDiagReport');
    check('buildDiagReport() gefunden', fnKey > -1);
    const fnOpen = src.indexOf('{', fnKey);
    const fnClose = matchingBraceIndex(src, fnOpen);
    const fnBody = src.slice(fnOpen, fnClose + 1);
    const readNames = new Set();
    {
        const re = /STATE\.diag\.([A-Za-z_$][\w$]*)/g;
        let mm;
        while ((mm = re.exec(fnBody))) readNames.add(mm[1]);
    }
    const undeclaredReads = Array.from(readNames).filter(n => !declared.has(n));
    check('Jedes in buildDiagReport() gelesene STATE.diag-Feld ist deklariert',
        undeclaredReads.length === 0, undeclaredReads.join(','));

    // Dritte Richtung, spiegelbildlich zur vorigen Pruefung: jedes deklarierte
    // Feld muss auch INNERHALB von buildDiagReport() (zwischen fnOpen/fnClose)
    // tatsaechlich gelesen werden - sonst bleibt es befuellt, aber im
    // kopierbaren Report unsichtbar (genau der lastEligible-Fund: deklariert
    // und bei jedem 403 befuellt, aber nirgends im Report gelesen).
    const MISSING_FROM_REPORT_EXCEPTIONS = new Set([
        // lastTap fliesst nur mittelbar in den Report: clickSetTile() liest
        // es per Wert in sein eigenes step-Objekt, das per recordBatchStep()
        // in STATE.diag.batchSteps/batchFailedSteps landet - UND die werden
        // in buildDiagReport() gelesen. Eine zusaetzliche direkte Lesung waere
        // eine doppelte Kopie desselben Werts, kein fehlendes Feld.
        'lastTap'
    ]);
    const missingFromReport = Array.from(declared)
        .filter(n => !readNames.has(n) && !MISSING_FROM_REPORT_EXCEPTIONS.has(n));
    check('Jedes deklarierte STATE.diag-Feld (ausser begruendeten Ausnahmen) wird auch INNERHALB von buildDiagReport() gelesen',
        missingFromReport.length === 0, missingFromReport.join(','));

    // Symmetrisch: jedes deklarierte Feld wird auch AUSSERHALB von
    // buildDiagReport() mit einem ECHTEN Schreibmuster befuellt (Zuweisung
    // "=" ausser "=="/"==="/"!==", .push(, .shift(, ++, --) - eine reine
    // Erwaehnung (z.B. eine Lesestelle "if (STATE.diag.X)") zaehlt bewusst
    // NICHT mehr als "befuellt", sonst koennte ein kuenftiges Feld denselben
    // uiScan-Fehler von der Schreib-Seite unbemerkt wiederholen.
    // "diag." statt zwingend "STATE.diag." erfasst auch reine Reducer-Helfer
    // wie recordBatchStep(diag, ...), die STATE.diag nur als Parameter
    // durchgereicht bekommen und intern "diag.<feld>" schreiben - eine reine
    // "STATE.diag."-Suche wuerde deren Felder faelschlich als unbefuellt melden.
    const ALIAS_MUTATED_FIELDS = new Set([
        // lastErrors/lastUtasPaths werden nie als "diag.X = ..." geschrieben,
        // sondern per lokaler Referenz eingesammelt und mit push()/shift()
        // mutiert (siehe diagError() bzw. detectApiBase(): "const arr =
        // STATE.diag.X; arr.push(...)"). Ein Schreibmuster-Regex kann diese
        // Aliasierung nicht verfolgen, ohne wieder jede blosse Erwaehnung
        // durchzulassen - beide Felder sind per Volltextsuche verifiziert.
        'lastErrors', 'lastUtasPaths'
    ]);
    const unassigned = [];
    for (const name of declared) {
        if (ALIAS_MUTATED_FIELDS.has(name)) continue;
        const writeRe = new RegExp(
            '\\bdiag\\.' + name + '\\s*=[^=]' +          // Zuweisung, kein ==/===/!==
            '|\\bdiag\\.' + name + '\\.(push|shift)\\(' + // Ringpuffer-Mutation
            '|\\bdiag\\.' + name + '\\s*(\\+\\+|--)',     // Zaehler
            'g');
        let mm, foundOutside = false;
        while ((mm = writeRe.exec(src))) {
            if (mm.index < fnOpen || mm.index >= fnClose) { foundOutside = true; break; }
        }
        if (!foundOutside) unassigned.push(name);
    }
    check('Jedes deklarierte STATE.diag-Feld (ausser Alias-Mutationen) wird ausserhalb des Reports mit einem echten Schreibmuster befuellt',
        unassigned.length === 0, unassigned.join(','));
}

// ========== 18. buildDiagReport(): keine doppelten Property-Namen im sbc-Objekt ==========
{
    // Regressionstest zum entfernten rareConstraints-Duplikat (Copy-Paste-Rest,
    // v4.37.0): zur Laufzeit harmlos (letzter Wert gewinnt), verschluckt aber
    // bei zwei tatsaechlich verschieden gemeinten Feldern eines davon lautlos.
    const fnKey = src.indexOf('function buildDiagReport');
    const sbcKey = src.indexOf('sbc: {', fnKey);
    check('sbc-Objekt-Literal in buildDiagReport() gefunden', sbcKey > -1);
    const sbcOpen = src.indexOf('{', sbcKey);
    const sbcClose = matchingBraceIndex(src, sbcOpen);
    const sbcSrc = src.slice(sbcOpen + 1, sbcClose);
    const keys = [];
    {
        const re = /^\s*([A-Za-z_$][\w$]*)\s*:/gm;
        let mm;
        while ((mm = re.exec(sbcSrc))) keys.push(mm[1]);
    }
    const dupes = Array.from(new Set(keys.filter((k, i) => keys.indexOf(k) !== i)));
    check('Keine doppelten Property-Namen im sbc-Objekt-Literal', dupes.length === 0,
        dupes.join(','));
}

// ========== 19. Namensdrift-Fix: Slot-Disambiguierung jetzt scharf ==========
// STATE.sbc.slots wurde nie geschrieben (immer undefined) - resolveFreshChallengeId()
// und matchesPlannedSbc() verglichen dadurch bislang undefined===undefined (immer
// wahr). Seit dem Umstieg auf STATE.sbc.formationSlots vergleichen beide Stellen
// tatsaechliche Zahlen. Extrahiert und ruft den ECHTEN, ausgelieferten Code auf
// (kein Nachbau) - collectChallengeNodes/resolveFreshChallengeId per Funktionsname
// + Klammerzaehlung (wie looksLikeItemId oben), deepScanChallenge ueber den
// [SBCSCAN-BEGIN]/[SBCSCAN-END]-Marker.
{
    const scanBlock = extractMarkerBlock(src, '// [SBCSCAN-BEGIN]', '// [SBCSCAN-END]');
    check('SBCSCAN-Marker-Block gefunden', !!scanBlock);
    const scanExports = new Function(scanBlock + '\nreturn { deepScanChallenge: deepScanChallenge, isDomOrWindow: isDomOrWindow };')();
    const collectSrc = extractFunction(src, 'collectChallengeNodes');
    check('Funktion collectChallengeNodes gefunden', !!collectSrc);
    const resolveSrc = extractFunction(src, 'resolveFreshChallengeId');
    check('Funktion resolveFreshChallengeId gefunden', !!resolveSrc);

    function buildResolver(jsonPayload, STATE) {
        return new Function('STATE', 'warn', 'apiGet', 'deepScanChallenge', 'isDomOrWindow',
            collectSrc + '\n' + resolveSrc + '\nreturn resolveFreshChallengeId;'
        )(STATE, function () {}, async function () { return jsonPayload; },
          scanExports.deepScanChallenge, scanExports.isDomOrWindow);
    }
    function node(cid, slots) {
        return { challengeId: cid, name: 'Node ' + cid,
                 requirements: [{ scope: 'TEAM_RATING', minimum: 84 }], slots: slots };
    }

    const results = [];
    // Zwei simulierte Set-Challenge-Knoten mit gleichem Ziel-OVR, aber
    // unterschiedlichem formationSlots - der Plan will 11.
    const stA = { sbc: { setId: 1, challengeId: 'OLD', targetOVR: 84, formationSlots: 11 }, diag: {} };
    results.push(buildResolver([node('A', 11), node('B', 4)], stA)().then(id => {
        check('resolveFreshChallengeId: waehlt den Knoten mit passenden Slots',
            id === 'A', 'ergebnis=' + id);
        check('resolveFreshChallengeId: lehnt den Knoten mit falschen Slots ab',
            stA.diag.staleRecover.candidates.indexOf('B') === -1,
            JSON.stringify(stA.diag.staleRecover));
    }));
    // Beide Knoten passen (Slots gleich) -> mehrdeutig, sauber null statt Raten.
    const stB = { sbc: { setId: 1, challengeId: 'OLD', targetOVR: 84, formationSlots: 11 }, diag: {} };
    results.push(buildResolver([node('A', 11), node('B', 11)], stB)().then(id => {
        check('resolveFreshChallengeId: mehrdeutig -> null statt raten', id === null, 'ergebnis=' + id);
    }));
    pending.push(Promise.all(results));

    // matchesPlannedSbc: derselbe Namensdrift-Fix, synchron testbar.
    const matchesSrc = extractFunction(src, 'matchesPlannedSbc');
    check('Funktion matchesPlannedSbc gefunden', !!matchesSrc);
    function buildMatcher(STATE) {
        return new Function('STATE', matchesSrc + '\nreturn matchesPlannedSbc;')(STATE);
    }
    const matches = buildMatcher({ sbc: { targetOVR: 84, formationSlots: 4 } });
    check('matchesPlannedSbc: Plan mit slots 11 gegen offene SBC mit formationSlots 4 -> false',
        matches({ targetOVR: 84, slots: 11 }) === false);
    const matchesOk = buildMatcher({ sbc: { targetOVR: 84, formationSlots: 11 } });
    check('matchesPlannedSbc: gleiche Slots + gleiches Ziel-OVR -> true',
        matchesOk({ targetOVR: 84, slots: 11 }) === true);
}

// ========== 20. SBCSCAN-Marker: deepScanChallenge real mit EA-Objekten getestet ==========
// Bislang nur String-Praesenz-Checks auf den Rohquelltext (siehe Abschnitt 8b-3).
// Hier laeuft der ECHTE, ausgelieferte Parser gegen konstruierte EA-Response-
// Objekte, die die Live-Bugs aus LEARNINGS 6/11 nachstellen.
{
    const scanBlock = extractMarkerBlock(src, '// [SBCSCAN-BEGIN]', '// [SBCSCAN-END]');
    check('SBCSCAN-Marker-Block gefunden (20)', !!scanBlock);
    const deepScanChallenge = new Function(scanBlock + '\nreturn deepScanChallenge;')();

    // (a) PLAYER_RARITY_GROUP=4 (echte Rare-Vorgabe) neben einem Namens-Scope
    // mit RARE-Substring ("Carrarese Calcio", LEARNINGS 11) - der Namens-Scope
    // darf NICHT als Rarity-Vorgabe landen.
    {
        const out = deepScanChallenge([
            { scope: 'PLAYER_RARITY_GROUP', value: 4 },
            { name: 'Carrarese Calcio' }
        ]);
        check('deepScanChallenge: PLAYER_RARITY_GROUP=4 erkannt (Gruppe 4 = Rare)',
            out.rarity.length === 1 && out.rarity[0].groupId === 4, JSON.stringify(out.rarity));
        check('deepScanChallenge: Namens-Scope mit RARE-Substring erzeugt KEINE Rarity-Vorgabe',
            !out.rarity.some(r => r.label.indexOf('CARRARESE') > -1), JSON.stringify(out.rarity));
        check('deepScanChallenge: matchedAs der echten Vorgabe ist RARITY',
            out.reqs.length === 1 && out.reqs[0].matchedAs === 'RARITY', JSON.stringify(out.reqs));
    }
    // (b) PLAYER_LEVEL value 1 = Qualitaetsstufe (Bronze), nicht Rating.
    {
        const out = deepScanChallenge([{ scope: 'PLAYER_LEVEL', value: 1 }]);
        check('deepScanChallenge: PLAYER_LEVEL value 1 landet in out.quality',
            out.quality.length === 1 && out.quality[0].quality === 1, JSON.stringify(out.quality));
        check('deepScanChallenge: PLAYER_LEVEL value 1 landet NICHT in out.playerLevel',
            out.playerLevel.length === 0, JSON.stringify(out.playerLevel));
        check('deepScanChallenge: matchedAs fuer PLAYER_LEVEL value 1 ist PLAYER_QUALITY',
            out.reqs[0].matchedAs === 'PLAYER_QUALITY', JSON.stringify(out.reqs));
    }
    // (c) PLAYER_LEVEL value 87 = Mindest-Rating, nicht Qualitaetsstufe.
    {
        const out = deepScanChallenge([{ scope: 'PLAYER_LEVEL', value: 87 }]);
        check('deepScanChallenge: PLAYER_LEVEL value 87 landet in out.playerLevel',
            out.playerLevel.length === 1 && out.playerLevel[0].minRating === 87, JSON.stringify(out.playerLevel));
        check('deepScanChallenge: PLAYER_LEVEL value 87 landet NICHT in out.quality',
            out.quality.length === 0, JSON.stringify(out.quality));
        check('deepScanChallenge: matchedAs fuer PLAYER_LEVEL value 87 ist PLAYER_LEVEL',
            out.reqs[0].matchedAs === 'PLAYER_LEVEL', JSON.stringify(out.reqs));
    }
    // Edge-Case: ein Wert zwischen 4 und 39 faellt durch BEIDE Zweige
    // (isPlayerLevel verlangt >=40, isQualityScope verlangt 1..3) - die Vorgabe
    // bleibt im reqDump sichtbar, aber unclassified statt lautlos zu verschwinden.
    {
        const out = deepScanChallenge([{ scope: 'PLAYER_LEVEL', value: 15 }]);
        check('deepScanChallenge: Wert 15 (4-39) faellt durch beide Zweige',
            out.playerLevel.length === 0 && out.quality.length === 0);
        check('deepScanChallenge: matchedAs fuer Wert 15 ist unclassified',
            out.reqs.length === 1 && out.reqs[0].matchedAs === 'unclassified', JSON.stringify(out.reqs));
    }
}

// ========== 21. Batch-Perspektive: matchesPlannedSbc im Lauf-Kontext (Brick-Slot-Transientes) ==========
// Ergaenzt Abschnitt 19 (isolierter Comparator-Test mit fest konstruierten
// Objekten) um die Sicht aus onBatchPlanClick/openNextInstance: der Plan
// merkt sich formationSlots beim PLANEN (Brick-Slot-SBC, 8 von 11 Slots
// nutzbar), danach setzt setCurrentChallenge() bei JEDEM Challenge-Wechsel
// formationSlots auf den Default 11 zurueck (ea-fc-sbc-optimizer.user.js:534) -
// die Brick-Slot-Korrektur (parseSbcChallenge, :682/:717) liefert den echten
// Wert erst nach dem naechsten Netzwerk-Scan nach. Im Retry-Fenster von
// openNextInstance kann matchesPlannedSbc dadurch TRANSIENT false liefern,
// obwohl die offene SBC eigentlich die geplante ist - failsafe (kein falscher
// Treffer), aber ohne diesen Test unentdeckt geblieben.
{
    const matchesSrc = extractFunction(src, 'matchesPlannedSbc');
    check('Funktion matchesPlannedSbc gefunden (21)', !!matchesSrc);
    function buildMatcher(STATE) {
        return new Function('STATE', matchesSrc + '\nreturn matchesPlannedSbc;')(STATE);
    }

    // 1) Plan-Erstellung wie onBatchPlanClick: plan.slots = STATE.sbc.formationSlots
    //    zum Planungszeitpunkt.
    const STATE = { sbc: { targetOVR: 84, formationSlots: 8 } };
    const plan = { targetOVR: STATE.sbc.targetOVR, slots: STATE.sbc.formationSlots };
    check('Plan uebernimmt formationSlots beim Planen (Brick-Slot-SBC, 8 von 11 nutzbar)',
        plan.slots === 8);

    // 2) Challenge-Wechsel zur naechsten Instanz: setCurrentChallenge() setzt
    //    formationSlots auf den Default 11 zurueck, BEVOR der Brick-Slot-Scan
    //    die Korrektur nachliefert.
    STATE.sbc.formationSlots = 11;
    check('Waehrend des Challenge-Wechsels (formationSlots noch Default 11): ' +
        'matchesPlannedSbc liefert false (failsafe, kein falscher Treffer)',
        buildMatcher(STATE)(plan) === false);

    // 3) Brick-Slot-Scan liefert die Korrektur nach (formationSlots wieder 8) ->
    //    matchesPlannedSbc erkennt die SBC wieder als die geplante.
    STATE.sbc.formationSlots = 8;
    check('Nach der Brick-Slot-Korrektur (formationSlots wieder 8): matchesPlannedSbc liefert true',
        buildMatcher(STATE)(plan) === true);

    // 4) Echte Diskrepanz: zweite Wiederholung/Variante desselben Sets mit
    //    gleichem targetOVR, aber ANDEREN Slots (10 statt geplanter 8) - muss
    //    dauerhaft false bleiben, nicht nur transient.
    STATE.sbc.formationSlots = 10;
    check('Gleicher targetOVR, dauerhaft andere formationSlots (10 vs. geplante 8): ' +
        'matchesPlannedSbc liefert false',
        buildMatcher(STATE)(plan) === false);

    // Die Abbruchmeldung in onBatchRunClick muss STATE.sbc.formationSlots nennen -
    // sonst zeigt sie bei echter Diskrepanz "undefined" statt Ist/Soll (Namensdrift).
    const runFn = extractFunction(src, 'onBatchRunClick');
    check('onBatchRunClick-Abbruchmeldung nennt STATE.sbc.formationSlots (nicht das ' +
        'nie geschriebene STATE.sbc.slots)',
        runFn.indexOf('STATE.sbc.formationSlots') > -1 && !/STATE\.sbc\.slots\b/.test(runFn));
}

// ========== 22. Statischer Regressionstest: Batch-Orchestrierung (onBatchRunClick/openNextInstance) ==========
// Analog zum bestehenden Source-Slice-Check fuer setLooksRepeatable
// (solver-test.js:1015, Technik aus patterns/good/eingebetteten-code-exakt-testen.md
// als Stilvorlage uebernommen). Verhindert, dass ein kuenftiges Refactoring
// eine der Abbruch-/Diagnose-Stellen still entfernt, ohne dass ein Test das
// bemerkt - genau der Mangel, der erklaert, warum der Slots-No-Op (Abschnitt 19)
// unbemerkt blieb.
{
    const runFn = extractFunction(src, 'onBatchRunClick');
    check('onBatchRunClick wirft bei fehlender Pool-Karte',
        runFn.indexOf('Karte(n) nicht mehr im Pool') > -1);
    check('onBatchRunClick wirft bei fehlendem Controller/Challenge',
        runFn.indexOf('keine offene SBC-Ansicht') > -1);
    check('onBatchRunClick wirft bei !matchesPlannedSbc(plan)',
        runFn.indexOf('!matchesPlannedSbc(plan)') > -1 && runFn.indexOf('passt nicht zum Plan') > -1);
    check('Alle drei Abbrueche sind eigene throw new Error(...)-Aufrufe',
        (runFn.match(/throw new Error\(/g) || []).length >= 3);
    check('Plan gilt nach dem Lauf als verbraucht (STATE.batch = null im finally)',
        runFn.indexOf('finally') > -1 &&
        runFn.indexOf('STATE.batch = null') > runFn.indexOf('finally'));

    const nextFn = extractFunction(src, 'openNextInstance');
    check('stuck-Diagnosezweig bei i===2/20/45 vorhanden',
        nextFn.indexOf('i === 2 || i === 20 || i === 45') > -1);
    // Die i===5/25-Bedingung selbst steckt seit der Extraktion in shouldTryBack
    // (echter Verhaltenstest statt Text-Match, Abschnitt 29) - hier bleibt nur
    // die Verdrahtungsstelle geprueft.
    check('clickBackButton-Zweig ruft shouldTryBack(i) auf',
        nextFn.indexOf('shouldTryBack(i)') > -1 && nextFn.indexOf('clickBackButton()') > -1);
    check('openNextInstance nutzt isFreshMatchingInstance(plan, STATE.sbc, empty) ' +
        'statt der alten Inline-Bedingung',
        nextFn.indexOf('isFreshMatchingInstance(plan, STATE.sbc, empty)') > -1);
}

// ========== 23. Band-Editor: SSOT-Ableitung + Edge-Cases ==========
// Extrahiert defaultBands()/bandsToSpec() per Marker (analog zum SOLVER-Block,
// Pattern eingebetteten-code-exakt-testen) statt sie hier nachzubilden.
{
    const bandsBlock = extractMarkerBlock(src, '// [BANDS-BEGIN]', '// [BANDS-END]');
    if (!bandsBlock) {
        tests++; failures++;
        console.error('FAIL  BANDS-Block nicht gefunden!');
    } else {
        const Bands = new Function('SolverCore',
            bandsBlock + '\nreturn { defaultBands: defaultBands, bandsToSpec: bandsToSpec };')(SolverCore);

        // Drift-Wächter: der Reset-Pfad muss wortgleich zur Solver-Konstante
        // bleiben - der eigentliche Regressionsschutz fuer die SSOT-Ableitung.
        const derivedSpec = Bands.bandsToSpec(Bands.defaultBands());
        check('bandsToSpec(defaultBands()) === SolverCore.DEFAULT_RATING_COST_SPEC',
            derivedSpec === SolverCore.DEFAULT_RATING_COST_SPEC, derivedSpec);

        // lo>hi bleibt in parseRatingCosts() ein No-Op (dokumentiertes
        // Verhalten - der Band-Editor markiert die Zeile seit dieser Version
        // sichtbar, die Kernlogik selbst bleibt unveraendert).
        const invalidFn = SolverCore.parseRatingCosts(Bands.bandsToSpec([{ lo: 90, hi: 85, cost: 7 }]));
        check('lo>hi-Band bleibt No-Op (Kosten bleiben 0)',
            invalidFn(85) === 0 && invalidFn(87) === 0 && invalidFn(90) === 0);

        // Leere Bandliste -> Kosten durchgehend 0 (aktuelles Verhalten, als
        // Testfall festgeschrieben statt ueberraschend).
        check('bandsToSpec([]) liefert leeren String', Bands.bandsToSpec([]) === '');
        const emptyFn = SolverCore.parseRatingCosts('');
        check('parseRatingCosts(\'\') liefert fuer jedes Rating 0',
            [0, 50, 84, 93, 99].every(r => emptyFn(r) === 0));

        // Format-Aequivalenz Lang-/Kurzform: bandsToSpec() emittiert seit
        // Ticket #7 Kurzform (lo:cost bei lo===hi, lo+:cost bei hi===99).
        // Bestandsnutzer mit gespeicherten Bands bekommen dadurch ein
        // anderes SPEC-STRING-Format als vorher - parseRatingCosts()
        // muss beide Formen fuer JEDES Rating 0..99 identisch behandeln,
        // sonst aendern sich die Kosten fuer Bestandsnutzer unbemerkt.
        const longForm = '0-80:0, 81-83:2, 84-84:1, 85-88:2, 89-90:3, 91-92:4, 93-99:12';
        const shortForm = SolverCore.DEFAULT_RATING_COST_SPEC;
        const longFn = SolverCore.parseRatingCosts(longForm);
        const shortFn = SolverCore.parseRatingCosts(shortForm);
        let parseMismatch = -1;
        for (let r = 0; r <= 99; r++) {
            if (longFn(r) !== shortFn(r)) { parseMismatch = r; break; }
        }
        check('parseRatingCosts: Lang- und Kurzform liefern fuer alle Ratings 0..99 identische Kosten',
            parseMismatch === -1, 'erster Unterschied bei Rating ' + parseMismatch);

        const equivPool = [];
        for (let r = 0; r <= 99; r++) equivPool.push({ rating: r, isStorage: false, groups: [], untradeable: false });
        const costOfLong = SolverCore.makeCostOf(equivPool, { ratingCostSpec: longForm });
        const costOfShort = SolverCore.makeCostOf(equivPool, { ratingCostSpec: shortForm });
        let costMismatch = -1;
        for (let r = 0; r <= 99; r++) {
            const p = { rating: r, isStorage: false, groups: [], untradeable: false };
            if (costOfLong(p) !== costOfShort(p)) { costMismatch = r; break; }
        }
        check('makeCostOf: Lang- und Kurzform liefern fuer alle Ratings 0..99 identische Kartenkosten',
            costMismatch === -1, 'erster Unterschied bei Rating ' + costMismatch);
    }
}

// ========== 24. Controller-Helfer-Konsolidierung: synthetischer Graph + Regression ==========
// getControllerChain()/findSbcController()/findLiveChallenge() liefen bisher nur
// als Text-Grep-Ziel (Abschnitt 8b-2e/21/22). Hier laufen die ECHTEN, per Marker
// extrahierten Funktionen gegen einen konstruierten View-Controller-Baum (Technik
// aus patterns/good/eingebetteten-code-exakt-testen.md), analog zum PC-/Handy-
// Unterschied aus LEARNINGS §19.
{
    const ctrlBlock = extractMarkerBlock(src, '// [CTRL-BEGIN]', '// [CTRL-END]');
    const sbcCtrlBlock = extractMarkerBlock(src, '// [SBCCTRL-BEGIN]', '// [SBCCTRL-END]');
    check('CTRL-Marker-Block gefunden (24)', !!ctrlBlock);
    check('SBCCTRL-Marker-Block gefunden (24)', !!sbcCtrlBlock);

    function loadHelpers(fakeWindow, STATE) {
        return new Function('window', 'STATE',
            ctrlBlock + '\n' + sbcCtrlBlock +
            '\nreturn { getControllerChain: getControllerChain, findSbcController: findSbcController, findLiveChallenge: findLiveChallenge };'
        )(fakeWindow, STATE);
    }
    // Erzeugt ein Objekt, dessen constructor.name === className ist (fuer die
    // /sbc/i-Klassennamen-Pruefung in den Helfern) - per computed-property-Trick,
    // ohne fuer jeden Testfall eine eigene class-Deklaration zu brauchen.
    function node(className, props) {
        const Ctor = ({ [className]: function () {} })[className];
        return Object.assign(new Ctor(), props || {});
    }
    // Verkettet nodes[i] -> nodes[i+1] ueber eine einzelne chainFn (reicht, da
    // getControllerChain() beim ersten Treffer aus chainFns weitergeht).
    function linkChain(nodes, fnName) {
        for (let i = 0; i + 1 < nodes.length; i++) {
            const nxt = nodes[i + 1];
            nodes[i][fnName] = function () { return nxt; };
        }
    }

    // (a) getControllerChain(): Reihenfolge root->Blatt, Tiefe 13 erreichbar.
    // Die konsolidierte controllerScan() begrenzte VORHER auf depth<12 (max. 12
    // Controller) - ein Baum mit 14 Controllern (Blatt bei Tiefe 13) haette den
    // 13. und 14. Controller verloren. Nach der Harmonisierung (Aktion 1, core-
    // Phase) liefert getControllerChain() alle 14.
    {
        const nodes = [];
        for (let i = 0; i < 14; i++) nodes.push(node('Filler' + i));
        linkChain(nodes, 'getCurrentViewController');
        const helpers = loadHelpers({ getAppMain: () => nodes[0] }, { sbc: { entity: null } });
        const chain = helpers.getControllerChain();
        check('getControllerChain: liefert alle 14 Controller in Reihenfolge (Tiefe 13 erreichbar)',
            chain.length === 14 && chain[0] === nodes[0] && chain[13] === nodes[13],
            'chain.length=' + chain.length);
    }

    // (b) findSbcController(): bei >=2 /sbc/i-Kandidaten mit Squad gewinnt GENAU
    // der LETZTE (Edge-Case aus patterns/bad/helfer-existiert-wird-umgangen.md /
    // Gap-Report - PC-Split-View zeigt mehrere sbc-artige Controller gleichzeitig).
    {
        const nodes = [];
        for (let i = 0; i < 6; i++) nodes.push(node('Filler' + i));
        nodes[2] = node('UTSBCSquadSplitViewController', { _squad: { id: 'squadA' } });
        nodes[5] = node('UTSBCSquadOverviewViewController', { _squad: { id: 'squadB' } });
        linkChain(nodes, 'getCurrentViewController');
        const helpers = loadHelpers({ getAppMain: () => nodes[0] }, { sbc: { entity: null } });
        const found = helpers.findSbcController();
        check('findSbcController: bei >=2 SBC-Kandidaten gewinnt der LETZTE, nicht der erste',
            found === nodes[5], found && found.constructor.name);
    }

    // (c) findLiveChallenge(): findet die Challenge ueber alle drei Key-Varianten.
    for (const key of ['_overviewController', 'leftController', '_leftController']) {
        const challenge = { id: 'ch-' + key };
        const root = node('SomeRoot');
        const leaf = node('UTSBCSquadOverviewViewController');
        leaf[key] = { _challenge: challenge };
        root.getCurrentViewController = () => leaf;
        const helpers = loadHelpers({ getAppMain: () => root }, { sbc: { entity: null } });
        check('findLiveChallenge: findet Challenge ueber Key "' + key + '"',
            helpers.findLiveChallenge() === challenge);
    }

    // (d) findLiveChallenge(): eigene _challenge direkt am SBC-Controller (kein
    // Unter-Controller) wird ebenfalls gefunden.
    {
        const challenge = { id: 'ch-direct' };
        const root = node('SomeRoot');
        const leaf = node('UTSBCSquadOverviewViewController', { _challenge: challenge });
        root.getCurrentViewController = () => leaf;
        const helpers = loadHelpers({ getAppMain: () => root }, { sbc: { entity: null } });
        check('findLiveChallenge: findet Challenge direkt am Controller (kein Unter-Controller)',
            helpers.findLiveChallenge() === challenge);
    }

    // (e) findLiveChallenge(): eine truthy-aber-nicht-Objekt _challenge (typeof-
    // Guard, uebernommen aus syncSbcWithOpenChallenge()s frueherer Inline-Fassung,
    // core-Phase) wird uebersprungen - Fallback auf STATE.sbc.entity greift.
    {
        const entityFallback = { id: 'entity-fallback' };
        const root = node('SomeRoot');
        const leaf = node('UTSBCSquadOverviewViewController', { _challenge: 'not-an-object' });
        root.getCurrentViewController = () => leaf;
        const helpers = loadHelpers({ getAppMain: () => root }, { sbc: { entity: entityFallback } });
        check('findLiveChallenge: truthy-aber-nicht-Objekt _challenge wird uebersprungen, STATE.sbc.entity-Fallback greift',
            helpers.findLiveChallenge() === entityFallback);
    }

    // (f) findLiveChallenge(): kein SBC-Controller im Baum -> STATE.sbc.entity-Fallback.
    {
        const entityFallback = { id: 'entity-fallback-2' };
        const root = node('SomeRoot');
        const helpers = loadHelpers({ getAppMain: () => root }, { sbc: { entity: entityFallback } });
        check('findLiveChallenge: ohne SBC-Controller im Baum liefert STATE.sbc.entity',
            helpers.findLiveChallenge() === entityFallback);
    }

    // (g) Statische Regression: controllerScan()/refreshOpenSbcView() rufen
    // getControllerChain() auf statt ihre eigene Traversal nachzubauen.
    const csFn = extractFunction(src, 'controllerScan');
    check('controllerScan ruft getControllerChain() auf', csFn.indexOf('getControllerChain()') > -1);
    check('controllerScan hat keinen eigenen chainFns-Literal-Block mehr', csFn.indexOf('chainFns') === -1);
    const rvFn = extractFunction(src, 'refreshOpenSbcView');
    check('refreshOpenSbcView ruft getControllerChain() auf', rvFn.indexOf('getControllerChain()') > -1);
    check('refreshOpenSbcView hat keinen eigenen chainFns-Literal-Block mehr', rvFn.indexOf('chainFns') === -1);

    // (h) Statische Regression: syncSbcWithOpenChallenge() ruft findLiveChallenge()
    // auf statt die Key-Liste erneut zu literalisieren, und meldet Fehlschlaege
    // ueber reportError() (diagnose-Phase).
    const syncFn = extractFunction(src, 'syncSbcWithOpenChallenge');
    check('syncSbcWithOpenChallenge ruft findLiveChallenge() auf', syncFn.indexOf('findLiveChallenge()') > -1);
    check('syncSbcWithOpenChallenge baut die Key-Liste nicht mehr selbst nach',
        syncFn.indexOf("'_overviewController'") === -1);
    check('syncSbcWithOpenChallenge meldet Fehlschlaege ueber reportError()', syncFn.indexOf('reportError(') > -1);

    // (i) Statische Regression: submitViaApp() (Submit-Weg 0) hat WARUM-Kommentare
    // an den bewusst NICHT konsolidierten Stellen und bleibt ohne Helfer-Aufruf.
    const svaFn = extractFunction(src, 'submitViaApp');
    check('submitViaApp: WARUM-Kommentar verweist auf LEARNINGS und "Nicht anfassen ohne Grund"',
        /Nicht anfassen ohne Grund/.test(svaFn) && /LEARNINGS/.test(svaFn));
    // Der WARUM-Kommentar selbst nennt die Helfer-Namen ("Bewusst NICHT
    // findSbcController()") - deshalb wird hier auf den tatsaechlichen
    // Aufruf-Pattern geprueft (Zuweisung/Zeichen direkt nach dem Namen), nicht
    // auf blosse Text-Abwesenheit.
    check('submitViaApp ruft findSbcController() nicht tatsaechlich auf (nur im WARUM-Kommentar erwaehnt)',
        !/[^.\w]findSbcController\(\)/.test(svaFn.replace(/\/\/.*$/gm, '')));
    check('submitViaApp ruft findLiveChallenge() nicht tatsaechlich auf (nur im WARUM-Kommentar erwaehnt)',
        !/[^.\w]findLiveChallenge\(\)/.test(svaFn.replace(/\/\/.*$/gm, '')));
    check('submitViaApp behaelt die eigene "letzter Treffer gewinnt"-Traversal (kein break, ctrl = c)',
        /if \(\/sbc\/i\.test\(n\) && \(c\._squad \|\| \(c\.getSquad && c\.getSquad\(\)\)\)\) \{ ctrl = c; \}/.test(svaFn));
}

// ========== 25. URL-Klassifikation (detectApiBase/classifyUrl): Anker vor der SBS_SBC_PREFIX_RE_SRC-Migration ==========
// Bislang keine einzige Assertion fuer detectApiBase/classifyUrl in dieser Datei
// (Gap-Report ea-app-anbindung, Iteration 0). Extrahiert per [URLCLS-BEGIN]/
// [URLCLS-END]-Marker (Technik aus patterns/good/eingebetteten-code-exakt-testen.md)
// und laeuft VOR der (sbs|sbc)-Regex-Zentralisierung gegen den unveraenderten
// Code gruen, damit die anschliessende SSOT-Migration Call-Site fuer Call-Site
// als verhaltensneutral belegt ist - ein Fehlgriff wuerde sonst erst live das
// Response-Routing (Pool-/SBC-Erkennung) stumm falsch befuellen.
{
    const urlClsBlock = extractMarkerBlock(src, '// [URLCLS-BEGIN]', '// [URLCLS-END]');
    check('URLCLS-Marker-Block gefunden', !!urlClsBlock);
    function buildUrlHelpers() {
        const STATE = { session: {}, diag: { utasSeen: 0, lastUtasPaths: [] }, sbc: { apiPrefix: 'sbs' } };
        const helpers = new Function('STATE', 'log', 'refreshDiagUI',
            urlClsBlock + '\nreturn { detectApiBase: detectApiBase, classifyUrl: classifyUrl };'
        )(STATE, function () {}, function () {});
        return { STATE: STATE, detectApiBase: helpers.detectApiBase, classifyUrl: helpers.classifyUrl };
    }

    // (a) classifyUrl: alle vier SBC-Endpunktformen, je mit sbs- UND sbc-Praefix,
    // ueber zwei verschiedene utas-Hosts (Host darf keine Rolle spielen).
    const hosts = ['utas.mob.v5.prd.futc-ext.gcp.ea.com', 'utas.external.s3.fut.ea.com'];
    for (const host of hosts) {
        for (const prefix of ['sbs', 'sbc']) {
            const base = 'https://' + host + '/ut/game/fc26/' + prefix;
            const { classifyUrl } = buildUrlHelpers();
            check('classifyUrl: ' + prefix + '@' + host + ' setId/.../challenges -> sbc-set-challenges',
                classifyUrl(base + '/setId/1037/challenges') === 'sbc-set-challenges');
            check('classifyUrl: ' + prefix + '@' + host + ' setId/.../challengeId/... -> sbc-challenge',
                classifyUrl(base + '/setId/1037/challengeId/3070') === 'sbc-challenge');
            check('classifyUrl: ' + prefix + '@' + host + ' challenge/{id} -> sbc-challenge',
                classifyUrl(base + '/challenge/3070') === 'sbc-challenge');
            check('classifyUrl: ' + prefix + '@' + host + ' sets -> sbc-sets',
                classifyUrl(base + '/sets') === 'sbc-sets');
            // "/storage" ohne "challenge"/"sets"-Substring, sonst matcht eine
            // der vorangehenden sbc-challenge/-sets-Pruefungen zuerst (keine
            // Endanker in classifyUrl - Reihenfolge/Substring-Treffer zaehlen).
            check('classifyUrl: ' + prefix + '@' + host + ' /storage -> storage (Fallback-Pfad)',
                classifyUrl(base + '/storage') === 'storage');
        }
    }
    // (b) classifyUrl: Nicht-SBC-Endpunkte weiterhin korrekt (Regression gegen
    // die Migration, die diese Zweige NICHT anfasst).
    {
        const { classifyUrl } = buildUrlHelpers();
        check('classifyUrl: club?... -> club',
            classifyUrl('https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/club?sort=desc') === 'club');
        check('classifyUrl: purchased/items -> unassigned',
            classifyUrl('https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/purchased/items') === 'unassigned');
        check('classifyUrl: storagepile?... -> storage (direkter Pfad, nicht der sbs|sbc-Fallback)',
            classifyUrl('https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/storagepile?count=10') === 'storage');
    }
    // (c) classifyUrl: Fremd-URLs und Beinahe-Treffer (Segment-Grenze "/sbs/"
    // bzw. "/sbc/" muss exakt sein, kein Teilstring-Treffer) -> null.
    {
        const { classifyUrl } = buildUrlHelpers();
        check('classifyUrl: fremde Domain ohne EA-Pfad -> null',
            classifyUrl('https://example.com/foo/bar') === null);
        check('classifyUrl: "sbsx"-Segment (kein exaktes sbs/sbc) -> null',
            classifyUrl('https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/sbsx/sets') === null);
        check('classifyUrl: "ssbc"-Segment (kein exaktes sbs/sbc) -> null',
            classifyUrl('https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/ssbc/sets') === null);
    }

    // (d) detectApiBase: Host-Variante + sbs/sbc-Praefix-Erkennung landet in
    // STATE.session.apiBase bzw. STATE.sbc.apiPrefix, unabhaengig vom Host.
    for (const host of hosts) {
        for (const prefix of ['sbs', 'sbc']) {
            const { STATE, detectApiBase } = buildUrlHelpers();
            const url = 'https://' + host + '/ut/game/fc26/' + prefix + '/sets';
            detectApiBase(url);
            check('detectApiBase: apiBase erkannt fuer Host ' + host,
                STATE.session.apiBase === 'https://' + host + '/ut/game/fc26/', STATE.session.apiBase);
            check('detectApiBase: apiPrefix "' + prefix + '" erkannt fuer Host ' + host,
                STATE.sbc.apiPrefix === prefix, STATE.sbc.apiPrefix);
        }
    }
    // (e) detectApiBase: kaputte/fremde URL wirft nicht (eigener try/catch).
    {
        const { detectApiBase } = buildUrlHelpers();
        let threw = false;
        try { detectApiBase(null); } catch (e) { threw = true; }
        check('detectApiBase: null-URL wirft nicht', !threw);
    }
    // (f) Statische Regression: kein "(sbs|sbc)"-Regex-Literal mehr dupliziert
    // (SSOT-Migration, core-Phase) - alle sieben ehemaligen Call-Sites leiten
    // jetzt aus SBS_SBC_PREFIX_RE_SRC ab.
    check('Kein "(sbs|sbc)"-Regex-Literal mehr im Quelltext (SSOT via SBS_SBC_PREFIX_RE_SRC)',
        (src.match(/\(sbs\|sbc\)/g) || []).length === 0);
    check('SBS_SBC_PREFIX_RE_SRC genau einmal definiert',
        (src.match(/const SBS_SBC_PREFIX_RE_SRC = /g) || []).length === 1);
}

// ========== 26. Migrations-Absicherung: extractMarkerBlock/extractFunction ==========
// Haelt die neuen Helfer (Kopf der Datei) gegen unabhaengig reimplementierte
// Kopien der URSPRUENGLICHEN Extraktions-Algorithmen byte-gleich - driftet die
// Helfer-Logik jemals von diesem Verhalten ab, faellt es hier auf, nicht erst
// stumm in einem der >20 umgezogenen Testbloecke oben (siehe
// docs/roadmap/shared-items/test-extraktions-helfer.md, "Migration").
{
    function oldMarkerBlock(beginMarker, endMarker) {
        const re = new RegExp(beginMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
            '([\\s\\S]*?)' + endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const mm = src.match(re);
        return mm ? mm[1] : null;
    }
    for (const name of ['SOLVER', 'SBCSCAN', 'BANDS', 'CTRL', 'SBCCTRL', 'URLCLS']) {
        const begin = '// [' + name + '-BEGIN]';
        const end = '// [' + name + '-END]';
        check('extractMarkerBlock(' + name + ') byte-gleich zur alten Regex-Extraktion',
            extractMarkerBlock(src, begin, end) === oldMarkerBlock(begin, end));
    }

    function oldExtractFunction(functionName) {
        let key = src.indexOf('function ' + functionName);
        if (key === -1) return null;
        if (src.slice(Math.max(0, key - 6), key) === 'async ') key -= 6;
        const openBrace = src.indexOf('{', src.indexOf('(', key));
        let depth = 0, close = -1;
        for (let i = openBrace; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
        }
        return close === -1 ? null : src.slice(key, close + 1);
    }
    // 'resolveFreshChallengeId' ist async (prueft die "async "-Praefix-Erkennung),
    // 'matchesPlannedSbc' und 'buildDiagReport' sind es nicht.
    for (const name of ['resolveFreshChallengeId', 'matchesPlannedSbc', 'buildDiagReport', 'isNormalCard']) {
        check('extractFunction(' + name + ') byte-gleich zur alten Klammer-Zaehlung',
            extractFunction(src, name) === oldExtractFunction(name));
    }
}

// ========== 27. Additive Post-Submit-Plausibilisierung: submitChallengeToEa ("ohne Response") ==========
// Fuehrt den echten "ohne Response"-Zweig aus submitChallengeToEa aus (Mock-
// Controller/Squad statt statischem Text-Match) - Beleg, dass die neue
// Plausibilisierung REIN additiv ist: in BEIDEN Faellen (isSquadEmpty true/false,
// dazu unlesbar) bleibt der Rueckgabewert { via: 'controller' } unveraendert,
// nur submitConfirmations unterscheidet sich (Edge-Case aus dem Gap-Report:
// kein throw/Retry allein wegen squadEmptyAfter === false).
{
    const fnSrc = extractFunction(src, 'submitChallengeToEa');
    check('Funktion submitChallengeToEa gefunden (27)', !!fnSrc);

    function runSubmit(squadEmptyAfter, opts) {
        opts = opts || {};
        const STATE = { diag: {
            submitCandidates: null, submitChallengeVia: null,
            submitWithoutResponseCount: 0, submitConfirmations: null
        } };
        const squad = {
            isSBCSquadEligible: () => true,
            isSquadEmpty: () => {
                if (opts.throwOnRead) throw new Error('boom (simuliert)');
                return squadEmptyAfter;
            }
        };
        const ctrl = { _squad: squad, submitChallenge: () => true }; // kein .then/.subscribe/.observe -> "ohne Response"
        const sandbox = {
            STATE: STATE,
            findSbcController: () => ctrl,
            getControllerChain: () => [],
            obsPromise: async (r) => r,
            responseOk: () => true,
            batchWait: () => Promise.resolve()
        };
        const keys = Object.keys(sandbox);
        const fn = new Function(keys.join(','),
            fnSrc + '\nreturn submitChallengeToEa;').apply(null, keys.map(k => sandbox[k]));
        return fn().then(r => ({ result: r, STATE: STATE }));
    }

    const results27 = [];
    results27.push(runSubmit(true).then(r => {
        check('Ohne Response + isSquadEmpty()===true: weiterhin { via: "controller" }',
            r.result && r.result.via === 'controller', JSON.stringify(r.result));
        const conf = (r.STATE.diag.submitConfirmations || [])[0];
        check('submitConfirmations traegt squadEmptyAfter=true',
            !!conf && conf.squadEmptyAfter === true && conf.hadResponse === false, JSON.stringify(conf));
    }));
    results27.push(runSubmit(false).then(r => {
        check('Ohne Response + isSquadEmpty()===false: DENNOCH { via: "controller" } ' +
            '(kein Abbruch/Retry - False-Positive-Edge-Case aus dem Gap-Report)',
            r.result && r.result.via === 'controller', JSON.stringify(r.result));
        const conf = (r.STATE.diag.submitConfirmations || [])[0];
        check('submitConfirmations traegt squadEmptyAfter=false',
            !!conf && conf.squadEmptyAfter === false, JSON.stringify(conf));
    }));
    results27.push(runSubmit(null, { throwOnRead: true }).then(r => {
        check('isSquadEmpty() wirft: DENNOCH { via: "controller" }, kein throw nach aussen',
            r.result && r.result.via === 'controller', JSON.stringify(r.result));
        const conf = (r.STATE.diag.submitConfirmations || [])[0];
        check('nicht lesbar -> squadEmptyAfter bleibt "unknown" statt einer geratenen Aussage',
            !!conf && conf.squadEmptyAfter === 'unknown', JSON.stringify(conf));
    }));
    pending.push(Promise.all(results27));
}

// ========== 28. usedChallengeIds als echte Sperre: isFreshMatchingInstance ==========
{
    const matchesSrc = extractFunction(src, 'matchesPlannedSbc');
    const freshSrc = extractFunction(src, 'isFreshMatchingInstance');
    check('Funktion isFreshMatchingInstance gefunden (28)', !!freshSrc);

    function buildFresh(STATE) {
        return new Function('STATE', matchesSrc + '\n' + freshSrc +
            '\nreturn isFreshMatchingInstance;')(STATE);
    }

    // Sperr-Fall (Pflicht, Gap-Report): dieselbe challengeId steckt bereits in
    // plan.usedChallengeIds - false, OBWOHL matchesPlannedSbc allein true waere.
    {
        const STATE = { sbc: { targetOVR: 84, formationSlots: 11, challengeId: '777' } };
        const plan = { targetOVR: 84, slots: 11, usedChallengeIds: ['777'] };
        check('isFreshMatchingInstance: false trotz passendem targetOVR/formationSlots, ' +
            'weil die challengeId schon in usedChallengeIds steht',
            buildFresh(STATE)(plan, STATE.sbc, true) === false);
    }
    // Normalfall/Re-Plan-Edge-Case (Pflicht, Gap-Report): frischer Plan, leere
    // usedChallengeIds wie onBatchPlanClick sie initialisiert - weiterhin true,
    // damit die Sperre den allerersten Batch-Schritt nicht blockiert.
    {
        const STATE = { sbc: { targetOVR: 84, formationSlots: 11, challengeId: '777' } };
        const plan = { targetOVR: 84, slots: 11, usedChallengeIds: [] };
        check('isFreshMatchingInstance: true bei frischem Plan (leere usedChallengeIds)',
            buildFresh(STATE)(plan, STATE.sbc, true) === true);
    }
    // squadEmpty === false blockiert weiterhin (unveraendertes Altverhalten).
    {
        const STATE = { sbc: { targetOVR: 84, formationSlots: 11, challengeId: '999' } };
        const plan = { targetOVR: 84, slots: 11, usedChallengeIds: [] };
        check('isFreshMatchingInstance: false bei squadEmpty===false (unveraendert)',
            buildFresh(STATE)(plan, STATE.sbc, false) === false);
    }
    // Verhaltensneutralitaet der Extraktion (Pflicht, Lift-Plan): OHNE Sperr-
    // Input (kein usedChallengeIds-Treffer) liefert isFreshMatchingInstance
    // GENAU dasselbe wie die alte Inline-Bedingung
    // "matchesPlannedSbc(plan) && empty !== false".
    {
        const STATE = { sbc: { targetOVR: 84, formationSlots: 11, challengeId: '1' } };
        const plan = { targetOVR: 84, slots: 11 }; // kein usedChallengeIds -> Altzustand
        const oldMatches = new Function('STATE', matchesSrc + '\nreturn matchesPlannedSbc;')(STATE);
        const oldCond = !!(oldMatches(plan) && true !== false);
        check('Verhaltensneutralitaet: isFreshMatchingInstance ohne Sperr-Input == alte Bedingung',
            buildFresh(STATE)(plan, STATE.sbc, true) === oldCond);
    }

    // Statischer Regressions-Check: der Re-Plan-Reset bleibt vorhanden - sonst
    // wuerde ein kuenftiger Refactor den allerersten Batch-Schritt lautlos
    // sperren (Edge-Case aus dem Gap-Report).
    const planFn = extractFunction(src, 'onBatchPlanClick');
    check('onBatchPlanClick setzt plan.usedChallengeIds beim Planen auf [] zurueck',
        planFn.indexOf('plan.usedChallengeIds = []') > -1);
}

// ========== 29. Verhaltenstest statt String-Grep: shouldTryBack + Mock-Ausfuehrung von openNextInstance ==========
{
    // Testfall A: reine Wertetabelle statt Text-Match.
    const fn = extractFunction(src, 'shouldTryBack');
    check('Funktion shouldTryBack gefunden (29)', !!fn);
    const shouldTryBack = new Function(fn + '\nreturn shouldTryBack;')();
    check('shouldTryBack(5) === true', shouldTryBack(5) === true);
    check('shouldTryBack(25) === true', shouldTryBack(25) === true);
    check('shouldTryBack(6) === false', shouldTryBack(6) === false);
    check('shouldTryBack(0) === false', shouldTryBack(0) === false);

    // Testfall B: die echte openNextInstance-Schleife mit Mock-Helfern
    // ausfuehren - Beleg, dass wentBack tatsaechlich gesetzt wird und die
    // Schleife danach per continue neu bewertet (indirekte Assertion ueber den
    // dokumentierten Seiteneffekt: clickChallengeRow wird bei i===10 erreicht,
    // obwohl "clicked" nie true wird).
    const nextFn = extractFunction(src, 'openNextInstance');
    check('Funktion openNextInstance gefunden (29)', !!nextFn);

    let iCounter = -1;
    const ctrlObj = { _squad: { isSquadEmpty: () => true } };
    const chRowCalls = [];
    const backCalls = [];
    const STATE29 = { sbc: { challengeId: 'x', formationSlots: 11 }, diag: { batchStuckCount: 0 } };
    const plan29 = { setName: 'TestSet', usedChallengeIds: [], targetOVR: 84, slots: 11 };
    const sandbox29 = {
        STATE: STATE29,
        dismissRewardPopup: () => {},
        syncSbcWithOpenChallenge: () => {},
        // ctrl bei i<=5 vorhanden (shouldTryBack-Zweig erreichbar), danach null
        // (simuliert den Ruecksprung in den Hub nach dem Zurueck-Klick).
        findSbcController: () => { iCounter++; return iCounter <= 5 ? ctrlObj : null; },
        popupState: () => ({ overlays: false, shield: { up: false } }),
        clickSetTile: () => ({ ok: false }),        // clicked bleibt false (Vorgabe des Testfalls)
        clickAllFilter: () => ({ ok: false }),
        clickChallengeRow: () => { chRowCalls.push(iCounter); return { ok: true }; },
        clickBackButton: () => { backCalls.push(iCounter); return { ok: true }; },
        setLooksRepeatable: () => ({ repeatable: true, status: 'Repeatable' }),
        matchesPlannedSbc: () => false,
        isFreshMatchingInstance: () => false,   // die "done"-Bedingung soll hier NIE greifen
        shouldTryBack: shouldTryBack,            // die echte, oben bereits gepruefte Funktion
        batchWait: () => Promise.resolve()
    };
    const keys29 = Object.keys(sandbox29);
    const runNext = new Function(keys29.join(','),
        nextFn + '\nreturn openNextInstance;').apply(null, keys29.map(k => sandbox29[k]));

    pending.push(runNext(plan29).then(function () {
        check('clickBackButton wird bei i===5 aufgerufen (shouldTryBack-Zweig erreicht)',
            backCalls.indexOf(5) > -1, JSON.stringify(backCalls));
        check('wentBack (indirekt): clickChallengeRow wird bei i===10 erreicht, ' +
            'obwohl "clicked" nie true wurde',
            chRowCalls.indexOf(10) > -1, JSON.stringify(chRowCalls));
    }));
}

// ========== 30. batchSteps-Ringpuffer um verlustfreie Fehler-Historie erweitert: recordBatchStep ==========
{
    const fn = extractFunction(src, 'recordBatchStep');
    check('Funktion recordBatchStep gefunden (30)', !!fn);
    const recordBatchStep = new Function(fn + '\nreturn recordBatchStep;')();

    // Mehrrunden-Testfall (Pflicht): frueh scheiternde Runde 2, dann mehr als
    // 6 weitere Runden - Runde 2 verschwindet aus dem 6er-Ring, bleibt aber in
    // batchFailedSteps auffindbar (die reale Konstellation statt der im
    // Gap-Report genannten, mit max. 10 Batch-Runden nicht erreichbaren
    // "Runde 9 von 12" - siehe Praezisierung im Lift-Plan).
    const diag = { batchSteps: null, batchFailedSteps: null };
    recordBatchStep(diag, 1, { ok: true, steps: [] });
    recordBatchStep(diag, 2, { ok: false, steps: [{ why: 'stuck' }] });
    for (let round = 3; round <= 9; round++) {
        recordBatchStep(diag, round, { ok: true, steps: [] });
    }
    check('batchSteps (6er-Ring, unveraendert): Runde 2 ist verdraengt',
        !diag.batchSteps.some(s => s.round === 2), JSON.stringify(diag.batchSteps.map(s => s.round)));
    check('batchSteps behaelt weiterhin genau die letzten 6 Runden',
        diag.batchSteps.length === 6 && diag.batchSteps[0].round === 4 &&
        diag.batchSteps[5].round === 9, JSON.stringify(diag.batchSteps.map(s => s.round)));
    check('batchFailedSteps: Runde 2 bleibt auffindbar (verlustfrei ueber den 6er-Ring hinaus)',
        !!diag.batchFailedSteps && diag.batchFailedSteps.some(s => s.round === 2 && s.ok === false),
        JSON.stringify(diag.batchFailedSteps));
    check('batchFailedSteps enthaelt nur gescheiterte Runden',
        diag.batchFailedSteps.length === 1);

    // Cap 30 (statt "unbegrenzt"): ueber mehrere Batch-Laeufe hinweg (der Ring
    // wird zwischen Laeufen nie zurueckgesetzt) fliegt die AELTESTE Runde raus.
    const diag2 = { batchSteps: null, batchFailedSteps: null };
    for (let round = 1; round <= 35; round++) {
        recordBatchStep(diag2, round, { ok: false, steps: [] });
    }
    check('batchFailedSteps: Cap bei 30 Eintraegen', diag2.batchFailedSteps.length === 30);
    check('batchFailedSteps: aelteste Runden fliegen zuerst raus (35 Runden -> 6..35 bleiben)',
        diag2.batchFailedSteps[0].round === 6 && diag2.batchFailedSteps[29].round === 35,
        JSON.stringify(diag2.batchFailedSteps.map(s => s.round)));

    const runFn = extractFunction(src, 'onBatchRunClick');
    check('onBatchRunClick ruft recordBatchStep(STATE.diag, i + 1, next) statt der Inline-Zeile',
        runFn.indexOf('recordBatchStep(STATE.diag, i + 1, next)') > -1);
}

// ========== 31. buildDiagReport(): EA-Controller-Traversal-Subbloecke faengt eigene Fehler ==========
{
    // hubScan/submitInfo/launcher rufen alle findSbcController()/
    // findLiveChallenge()/getControllerChain() auf - dieselbe undokumentierte
    // EA-Controller-Kette, die bei EA-Wandel als erstes bricht (siehe
    // patterns/good/stille-catches-nur-an-der-ea-grenze.md). Jeder dieser
    // Sub-Bloecke braucht einen EIGENEN catch (e), sonst reisst ein Fehler
    // darin die GESAMTE buildDiagReport() mit - und das Diagnose-Werkzeug,
    // das genau solche EA-Brueche sichtbar machen soll, faellt selbst
    // lautlos aus.
    const fnSrc = extractFunction(src, 'buildDiagReport');
    check('buildDiagReport() gefunden (Block 31)', !!fnSrc);

    const EA_TRAVERSAL_SUBBLOCKS = ['hubScan', 'submitInfo', 'launcher'];
    for (const name of EA_TRAVERSAL_SUBBLOCKS) {
        const marker = name + ': (function () {';
        const startIdx = fnSrc.indexOf(marker);
        check(marker.trim() + ' in buildDiagReport() gefunden', startIdx > -1, name);
        if (startIdx < 0) continue;
        const openBrace = startIdx + marker.length - 1;
        const closeBrace = matchingBraceIndex(fnSrc, openBrace);
        const blockSrc = fnSrc.slice(openBrace, closeBrace + 1);
        check(name + ' ruft EA-Controller-Traversal auf (Testannahme dieses Blocks)',
            /\b(findSbcController|findLiveChallenge|getControllerChain)\s*\(/.test(blockSrc));
        check(name + ' hat einen eigenen catch (e) zwischen (function () { und })()',
            /\bcatch\s*\(\s*e\s*\)/.test(blockSrc));
    }
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
