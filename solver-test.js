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
        maxRatingEnabled: false, maxRating: 0,
        scarcityWeight: 0, storageBonus: 0,
        maxOvershoot: 0.10, applyRarity: true,
        ratingCostSpec: '0-99:0',
        anchorId: null, rarityPickId: null,
        rarityConstraints: [], playerLevelConstraints: []
    }, extra || {});
}

// Brute force über das V-Ziel (V = N² * exaktes Rating).
// Karten-Kosten kommen von SolverCore.makeCostOf() - der SSOT aus dem
// Userscript selbst (SOLVER-Block), keine eigenständige Nachbildung mehr
// (vorher cardCostFn(), nur per Kommentar synchron gehalten).
// quotaOk(team) ist optional: prüft pro vollständiger N-Kombination eine
// zusätzliche Nebenbedingung (z.B. "genau 1 Karte aus Rarity-Gruppe 83"),
// BEVOR V/Kosten verglichen werden - damit ist dieselbe Enumeration auch für
// Configs MIT Reservierungen (Rarity-/Qualitäts-Vorgaben) korrekt, siehe
// Ticket #57 / docs/roadmap/gaps/rating-solver.md. Ohne quotaOk unverändert
// wie zuvor (Test 3/4 rufen ohne dritten Parameter).
function bruteBest(pool, c, quotaOk) {
    const N = c.slots || 11;
    const T = c.targetOVR;
    const NEED = N * N * T - Math.floor(N / 2);
    const windowV = Math.round((c.maxOvershoot != null ? c.maxOvershoot : 0.10) * N * N);
    const cardCost = SolverCore.makeCostOf(pool, c);
    const n = pool.length;
    const feasible = [];
    const team = [];
    (function rec(start, cnt, cost) {
        if (cnt === N) {
            if (quotaOk && !quotaOk(team)) return;
            const V = SolverCore.squadV(team.map(p => p.rating));
            if (V >= NEED) feasible.push({ V: V, cost: cost });
            return;
        }
        if (n - start < N - cnt) return;
        for (let i = start; i < n; i++) {
            team.push(pool[i]);
            rec(i + 1, cnt + 1, cost + cardCost(pool[i]));
            team.pop();
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
// Brute-Force-Referenz für Quoten OHNE Ziel-Rating (Bronze/Silber-
// Qualitäts-Vorgaben, siehe 8d2/8b-2d): hier gibt es kein V-Minimum, sondern
// eine harte Kombinationsgrenze pro Stufe (quotaOk) und die Auswahl folgt
// Rasmus' Rangfolge "Storage vor Verein, dann niedrigstes Rating, dann
// Kosten" (CLAUDE.md). cardKey(p) liefert diese Rangfolge als vergleichbares
// Array; unter allen quotaOk-gültigen Kombinationen gewinnt die, deren
// SORTIERTES Key-Array elementweise am kleinsten ist (Tausch-Argument: bei
// unabhängigen Pro-Karten-Kosten ist das exakt die optimale Kombination -
// diese Funktion verifiziert das aber über eine ECHTE Enumeration aller
// Kombinationen, unabhängig vom Sortier-Code im Solver).
// Elementweiser Vergleich zweier gleichlanger Key-Tupel (z.B. [isStorage,
// rating, kosten]) - gemeinsamer Baustein für bruteBestQuota() und die
// Fuzz-Tests, die ihre Ergebnisse gegen dieselbe Rangfolge prüfen wollen.
function cmpKeyTuple(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}
function bruteBestQuota(pool, N, quotaOk, cardKey) {
    const n = pool.length;
    const team = [];
    let bestKeys = null, bestTeam = null;
    function isBetter(keysA, keysB) {
        for (let i = 0; i < keysA.length; i++) {
            const c = cmpKeyTuple(keysA[i], keysB[i]);
            if (c) return c < 0;
        }
        return false;
    }
    (function rec(start, cnt) {
        if (cnt === N) {
            if (!quotaOk(team)) return;
            const keys = team.map(cardKey).sort(cmpKeyTuple);
            if (!bestKeys || isBetter(keys, bestKeys)) { bestKeys = keys; bestTeam = team.slice(); }
            return;
        }
        if (n - start < N - cnt) return;
        for (let i = start; i < n; i++) {
            team.push(pool[i]);
            rec(i + 1, cnt + 1);
            team.pop();
        }
    })(0, 0);
    return bestTeam ? { team: bestTeam, keys: bestKeys } : null;
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

// ========== 6. Spieler-Dedupe: dupeScore-Rangfolge entscheidet, nicht
// Stapelgröße ==========
{
    // (a) dupeScore-Rangfolge (SPIELER-EINDEUTIGKEIT, dupeScore() im
    // Userscript): Storage (+10) ist eine EIGENE Stufe, kein Ausgleich gegen
    // Rating-Unterschiede. Zwei Duplikate derselben assetId, die Storage-
    // Karte mit dem NIEDRIGEREN Rating - sie muss trotzdem gewinnen. Die
    // beiden Duplikat-Ratings liegen bewusst außerhalb des Füllraster-
    // Ratings (80), damit poolInfo.min/max eindeutig zeigen, welche der
    // zwei Karten den Dedupe überlebt hat - unabhängig davon, ob sie am
    // Ende im Team landet (poolInfo wird VOR der Team-Auswahl berechnet).
    const filler = many(15, 80, {});
    const poolStorageWins = [].concat(filler,
        [P(70, { storage: true, assetId: 777 })],
        [P(95, { storage: false, assetId: 777 })]);
    const resA = SolverCore.solve(poolStorageWins, cfg(80, {}));
    check('dupeScore: Storage schlägt höheres Rating (eigene Stufe, kein Ausgleich)',
        resA.ok && resA.poolInfo && resA.poolInfo.min === 70 && resA.poolInfo.max === 80,
        JSON.stringify(resA.poolInfo));

    // Gegenprobe: Storage-Flag getauscht (jetzt die 95er-Karte Storage) -
    // das Ergebnis MUSS kippen. Ohne diese Gegenprobe wäre die Assertion
    // oben nicht von einem Zufall der Einfüge-/Sortier-Reihenfolge zu
    // unterscheiden (genau der Vorwurf, der Test 6 vorher traf).
    const poolFlipped = [].concat(filler,
        [P(70, { storage: false, assetId: 888 })],
        [P(95, { storage: true, assetId: 888 })]);
    const resAFlip = SolverCore.solve(poolFlipped, cfg(80, {}));
    check('dupeScore: Storage-Vorrang hängt am Flag, nicht an der Reihenfolge',
        resAFlip.ok && resAFlip.poolInfo && resAFlip.poolInfo.min === 80 && resAFlip.poolInfo.max === 95,
        JSON.stringify(resAFlip.poolInfo));

    // (b) 10-Duplikate-Kollaps auf 1 (Gap-Report-Reproduktion, Iteration 1):
    // 10 Kopien desselben Spielers (assetId 111) + 1 andere Karte (assetId
    // 222) + 15 Füllkarten. Die erwartete Pool-Größe nach der Dedupe wird
    // HIER aus der Konstruktion hergeleitet (Gesamt - wegfallende
    // Duplikate), nicht als Zahl geraten.
    const dupeCount = 10, altCount = 1, fillerCount = 15;
    const poolDupes = [].concat(
        many(dupeCount, 88, { storage: true, assetId: 111 }),
        many(altCount, 88, { storage: true, assetId: 222 }),
        many(fillerCount, 80, {}));
    const totalIn = dupeCount + altCount + fillerCount;
    const expectedAfterCollapse = totalIn - (dupeCount - 1);
    const resB = SolverCore.solve(poolDupes, cfg(81, { scarcityWeight: 18, storageBonus: 2, maxOvershoot: 0.5 }));
    check('Dedupe: ' + totalIn + ' Karten (10 Duplikate) kollabieren auf ' +
        expectedAfterCollapse + ' (poolInfo.count)',
        resB.ok && resB.poolInfo && resB.poolInfo.count === expectedAfterCollapse,
        JSON.stringify(resB.poolInfo));
}

// ========== 6b. Diagnose: internes Suchfenster ausgeschöpft vs. echte
// Unlösbarkeit ==========
{
    // Konstruktion, die das Suchfenster (stHardCap = stLow + 900, siehe
    // Herleitung im Userscript) gezielt sprengt, obwohl eine Lösung
    // existiert: 11 Karten Rating 99 (die einzig mögliche Lösung für Ziel
    // 99 bei 11 Slots) + 20 Füllkarten Rating 1 (die 11 GÜNSTIGSTEN im Pool,
    // drücken stLow auf 11). stHardCap wird damit 11 + 900 = 911 - die
    // tatsächlich benötigte Summe (11 * 99 = 1089) liegt darüber, die Suche
    // erschöpft ihr Fenster, obwohl squadV der 11 besten Karten (genau
    // diese) das Ziel rechnerisch erreicht.
    const poolWindow = [].concat(many(11, 99, {}), many(20, 1, {}));
    const resWindow = SolverCore.solve(poolWindow, cfg(99, {}));
    check('Diagnose: Suchfenster-Erschöpfung setzt das Flag',
        !resWindow.ok && resWindow.warnings.some(w => /internes Suchfenster/i.test(w)),
        JSON.stringify(resWindow.warnings));

    // Gegenprobe: ein Pool, dessen bestmögliche 11 Karten (hier: alle 15
    // vorhandenen, Rating 70) das Ziel 90 selbst im rechnerischen Optimum
    // nicht erreichen - kein Suchfenster-Artefakt, sondern eine echte
    // Ziel-OVR-Grenze. Das Flag darf hier NICHT gesetzt werden.
    const poolReal = many(15, 70, {});
    const resReal = SolverCore.solve(poolReal, cfg(90, {}));
    check('Diagnose: echte Unlösbarkeit bekommt KEIN Suchfenster-Flag',
        !resReal.ok && !resReal.warnings.some(w => /internes Suchfenster/i.test(w)),
        JSON.stringify(resReal.warnings));
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
    // permanentFailFrom (optional): ab diesem Call-Zaehler schlaegt JEDER
    // weitere Request fehl (alle 3 Versuche der betroffenen Seite) - simuliert
    // den dauerhaften Fehlschlag, der STATE.loadIncomplete auf true setzt.
    function runLoader(TOTAL, cap, withTotal, failPages, permanentFailFrom) {
        const calls = [];
        const warnCalls = [];
        const STATE = { pool: [], cancelLoad: false, diag: {}, loadIncomplete: false };
        const sandbox = {
            STATE: STATE,
            calls: calls,
            setTimeout: (f) => { f(); return 0; },   // kein echtes Warten im Test
            Date: Date,
            log: () => {}, warn: (...a) => { warnCalls.push(a.join(' ')); },
            extractItems: (j) => j.items,
            normalizePlayer: (it) => ({ id: it.id, rating: 80, assetId: it.id }),
            mergeIntoPool: (ps) => { STATE.pool.push.apply(STATE.pool, ps); },
            apiGet: async (path) => {
                const m = /count=(\d+)&start=(\d+)/.exec(path);
                const want = Number(m[1]), start = Number(m[2]);
                calls.push({ want: want, start: start });
                if ((failPages && failPages.indexOf(calls.length) > -1) ||
                    (permanentFailFrom && calls.length >= permanentFailFrom)) {
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
        return fn().then(found => ({ found: found, calls: calls, STATE: STATE, warnCalls: warnCalls }));
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

    // 6. Dauerhafter Fehlschlag (Ticket #56): STATE.loadIncomplete steht
    // zusaetzlich in clubLoad.loadIncomplete (JSON-Report ueber das bereits
    // vorhandene clubLoad-Feld) UND warn() wird an derselben Stelle gerufen
    // (App-Log-Kanal) - der bestehende STATE.loadIncomplete-Flag/Toast bleibt
    // unveraendert der einzige Trigger fuer onRunClick/onBatchPlanClick.
    results.push(runLoader(1000, 175, true, null, 2).then(r => {
        check('Dauerhafter Fehlschlag: STATE.loadIncomplete bleibt gesetzt',
            r.STATE.loadIncomplete === true);
        check('Dauerhafter Fehlschlag: clubLoad.loadIncomplete steht im Report-Feld',
            r.STATE.diag.clubLoad && r.STATE.diag.clubLoad.loadIncomplete === true,
            JSON.stringify(r.STATE.diag.clubLoad));
        check('Dauerhafter Fehlschlag: warn() wird an der Abbruchstelle gerufen',
            r.warnCalls.some(m => /unvollst/i.test(m)), JSON.stringify(r.warnCalls));
        check('Dauerhafter Fehlschlag: bereits geladene Karten der ersten Seite bleiben erhalten',
            r.found === 175, 'found=' + r.found);
    }));

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
        /submitToSbc\(result, true, batchProgress\)/.test(src) && /if \(!_retried\)/.test(src));

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

// ========== 10. Ticket #66: Max. Rating pro Spieler - harter Pool-Filter ==========
// Ersetzt den fruehereren "Max. teure Spieler"-Filter (per User-Auftrag
// ersatzlos entfernt, siehe LEARNINGS §44/CLAUDE.md): dieser Filter lockert
// sich NIE selbst, sondern meldet die Grenze im Fehlerfall.
{
    // (a) Harte Grenze: kein Team-Mitglied ueber maxRating, auch wenn 90er
    // im Pool billiger zum Ziel fuehren wuerden. Brute-Force-Gegenprobe
    // gegen den manuell vorgefilterten Pool - GENAU das, was der Filter tut.
    // Kleine Slot-Zahl (6), damit die Brute-Force-Enumeration handhabbar bleibt.
    const pool = [].concat(many(3, 90), many(6, 85), many(8, 80));
    const filterCfg = cfg(84, { slots: 6, maxOvershoot: 1, maxRatingEnabled: true, maxRating: 85 });
    const res = SolverCore.solve(pool, filterCfg);
    check('MaxRating: kein Team-Mitglied ueber der Grenze', res.ok &&
        res.players.every(p => p.rating <= 85),
        res.ok ? res.players.map(p => p.rating).join(',') : res.reason);
    const filteredPool = pool.filter(p => p.rating <= 85);
    const baseCfg = cfg(84, { slots: 6, maxOvershoot: 1 });
    const bb = bruteBest(filteredPool, baseCfg);
    check('MaxRating: Solver trifft das Brute-Force-Optimum des vorgefilterten Pools',
        res.ok && bb && Math.abs(solverObjective(res, filteredPool, baseCfg, bb.vMin) - bb.bestObj) < 1e-6,
        'team=' + (res.ok ? res.players.map(p => p.rating).join(',') : res.reason));

    // (b) Unloesbar MIT Filter: KEINE stille Lockerung (der Kardinalfehler des
    // alten Filters) - ok:false, und die Meldung nennt die Grenze.
    const res2 = SolverCore.solve(many(20, 80), cfg(95, { maxOvershoot: 0.5, maxRatingEnabled: true, maxRating: 85 }));
    check('MaxRating unloesbar: ok:false (keine stille Lockerung)', !res2.ok);
    check('MaxRating unloesbar: Meldung nennt die Grenze (Max-Rating 85)',
        (res2.reason && /Max-Rating 85/.test(res2.reason)) ||
        (res2.warnings || []).some(w => /Max-Rating 85/.test(w)),
        JSON.stringify(res2));

    // (c) Filter aus: byte-gleiches Ergebnis zur Baseline ohne die Felder.
    const resOff = SolverCore.solve(pool, cfg(84, { maxOvershoot: 1 }));
    const resExplicitOff = SolverCore.solve(pool, cfg(84, { maxOvershoot: 1, maxRatingEnabled: false, maxRating: 85 }));
    check('MaxRating aus: identisch zur Baseline ohne die Felder',
        JSON.stringify(resOff) === JSON.stringify(resExplicitOff));

    // (d) Entfernungs-Regression: kein maxExpensive/expensiveThreshold-Bezug
    // mehr im SOLVER-Block.
    check('SOLVER-Block: kein maxExpensive/expensiveThreshold-Bezug mehr (Ticket #66)',
        solverBlock.indexOf('maxExpensive') === -1 && solverBlock.indexOf('expensiveThreshold') === -1);
    check('Panel-HTML: kein sbc-opt-maxexp-Element mehr (Ticket #66 Entfernung)',
        src.indexOf('sbc-opt-maxexp') === -1);

    // (e) Validator-Fund: Vorgabe-über-Filter-Interaktion. Der Filter gilt
    // laut Ticket #66 AUCH für Vorgaben-Reservierungen (nicht nur die
    // Auffuellung) - eine Spieler-Level-Vorgabe "min. 2x 90+" darf mit
    // MaxRating 85 NICHT still erfuellt/ignoriert werden, sondern muss
    // ehrlich scheitern. Gegenprobe ohne Filter: derselbe Pool/dieselbe
    // Vorgabe ist trivial loesbar (3x 90er stehen bereit).
    const plExtra = {
        slots: 11, maxOvershoot: 2,
        playerLevelConstraints: [{ label: 'PLAYER_RATING', minRating: 90, count: 2 }]
    };
    const plPool = [].concat(many(3, 90), many(20, 84));
    const withFilter = SolverCore.solve(plPool, cfg(84, Object.assign({}, plExtra,
        { maxRatingEnabled: true, maxRating: 85 })));
    check('Vorgabe ueber Filter: 2x 90+ mit MaxRating 85 -> ok:false (keine stille Lockerung)',
        !withFilter.ok, JSON.stringify(withFilter));
    check('Vorgabe ueber Filter: Meldung benennt die unerfuellbare 90+-Vorgabe ehrlich',
        /90\+/.test(withFilter.reason || ''), JSON.stringify(withFilter));
    check('Vorgabe ueber Filter: zusaetzlich nennt eine Warnung die Max-Rating-Grenze',
        (withFilter.warnings || []).some(w => /Max-Rating 85/.test(w)), JSON.stringify(withFilter));
    const withoutFilter = SolverCore.solve(plPool, cfg(84, plExtra));
    check('Gegenprobe ohne Filter: dieselbe Vorgabe ist loesbar (trivial: 3x 90er im Pool)',
        withoutFilter.ok && withoutFilter.players.filter(p => p.rating >= 90).length >= 2,
        JSON.stringify(withoutFilter));
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
    // Untergrenze ist ein Extraktions-Sanity-Floor (hat die Regex den Block
    // wirklich erwischt?), KEINE Feldzaehlung - die exakte Vollstaendigkeit
    // erzwingt der Symmetrie-Test darunter in beide Richtungen. Eine harte
    // Zahl wuerde bei jedem neuen Feld driften (Stand iter6: 27 Felder).
    check('STATE.diag-Deklaration extrahiert (Sanity-Floor 18 Felder)',
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
    const extractNodeStateSrc = extractFunction(src, 'extractNodeState');
    check('Funktion extractNodeState gefunden', !!extractNodeStateSrc);
    const resolveSrc = extractFunction(src, 'resolveFreshChallengeId');
    check('Funktion resolveFreshChallengeId gefunden', !!resolveSrc);

    function buildResolver(jsonPayload, STATE) {
        return new Function('STATE', 'warn', 'apiGet', 'deepScanChallenge', 'isDomOrWindow',
            extractNodeStateSrc + '\n' + collectSrc + '\n' + resolveSrc + '\nreturn resolveFreshChallengeId;'
        )(STATE, function () {}, async function () { return jsonPayload; },
          scanExports.deepScanChallenge, scanExports.isDomOrWindow);
    }
    function node(cid, slots, extra) {
        return Object.assign({ challengeId: cid, name: 'Node ' + cid,
                 requirements: [{ scope: 'TEAM_RATING', minimum: 84 }], slots: slots }, extra || {});
    }

    const results = [];
    // Zwei simulierte Set-Challenge-Knoten mit gleichem Ziel-OVR, aber
    // unterschiedlichem formationSlots - der Plan will 11.
    const stA = { sbc: { setId: 1, challengeId: 'OLD', targetOVR: 84, formationSlots: 11 }, diag: {} };
    results.push(buildResolver([node('A', 11), node('B', 4)], stA)().then(id => {
        check('resolveFreshChallengeId: waehlt den Knoten mit passenden Slots',
            id === 'A', 'ergebnis=' + id);
        check('resolveFreshChallengeId: lehnt den Knoten mit falschen Slots ab',
            !stA.diag.staleRecover.candidates.some(c => c.id === 'B'),
            JSON.stringify(stA.diag.staleRecover));
        check('resolveFreshChallengeId: candidateCount zaehlt die WAHREN Treffer (Ticket #70)',
            stA.diag.staleRecover.candidateCount === 1, JSON.stringify(stA.diag.staleRecover));
    }));
    // Beide Knoten passen (Slots gleich) -> mehrdeutig, sauber null statt Raten.
    const stB = { sbc: { setId: 1, challengeId: 'OLD', targetOVR: 84, formationSlots: 11 }, diag: {} };
    results.push(buildResolver([node('A', 11), node('B', 11)], stB)().then(id => {
        check('resolveFreshChallengeId: mehrdeutig -> null statt raten', id === null, 'ergebnis=' + id);
        check('resolveFreshChallengeId: candidateCount=2 bei Mehrdeutigkeit (Ticket #70)',
            stB.diag.staleRecover.candidateCount === 2, JSON.stringify(stB.diag.staleRecover));
    }));
    // Kein Knoten passt -> Erschoepfung/Ablauf (Ticket #70, Live-Fall "84+ TOTW
    // Upgrade" Runde 9/10: staleRecover war {nodes: 1, candidates: []}).
    const stC = { sbc: { setId: 1, challengeId: 'OLD', targetOVR: 84, formationSlots: 11 }, diag: {} };
    results.push(buildResolver([], stC)().then(id => {
        check('resolveFreshChallengeId: keine Knoten -> null', id === null, 'ergebnis=' + id);
        check('resolveFreshChallengeId: candidateCount=0 bei Erschoepfung (Ticket #70)',
            stC.diag.staleRecover.candidateCount === 0, JSON.stringify(stC.diag.staleRecover));
    }));
    // nodeState (Ticket #70): der Knoten der ALTEN Id liefert status/repeatable/
    // timesCompleted/endTime, auch wenn er kein Kandidat ist (er wird ja explizit
    // ausgeschlossen) - Live-Sample-Felder aus dem Briefing.
    const stD = { sbc: { setId: 1, challengeId: 'OLD', targetOVR: 84, formationSlots: 11 }, diag: {} };
    results.push(buildResolver([node('OLD', 11, {
        status: 'NOT_STARTED', repeatable: false, timesCompleted: 3, endTime: 1755302400
    })], stD)().then(id => {
        check('resolveFreshChallengeId: nodeState wird aus dem Knoten der alten Id gelesen (Ticket #70)',
            stD.diag.staleRecover.nodeState &&
            stD.diag.staleRecover.nodeState.status === 'NOT_STARTED' &&
            stD.diag.staleRecover.nodeState.repeatable === false &&
            stD.diag.staleRecover.nodeState.timesCompleted === 3 &&
            stD.diag.staleRecover.nodeState.endTime === 1755302400,
            JSON.stringify(stD.diag.staleRecover));
    }));
    // Fehlende Felder werden null statt den Knoten zu verwerfen.
    const stE = { sbc: { setId: 1, challengeId: 'OLD', targetOVR: 84, formationSlots: 11 }, diag: {} };
    results.push(buildResolver([node('OLD', 11)], stE)().then(id => {
        check('resolveFreshChallengeId: nodeState-Felder fehlen -> null statt Absturz (Ticket #70)',
            stE.diag.staleRecover.nodeState &&
            stE.diag.staleRecover.nodeState.status === null &&
            stE.diag.staleRecover.nodeState.repeatable === null &&
            stE.diag.staleRecover.nodeState.timesCompleted === null &&
            stE.diag.staleRecover.nodeState.endTime === null,
            JSON.stringify(stE.diag.staleRecover));
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
    // Der Markerblock reicht bis hinter handleResponseBody - die Funktion ruft
    // reportError() sowie drei App-eigene Funktionen auf, die selbst NICHT
    // Teil des Blocks sind. Minimal gehaltene Stubs statt eines separat
    // gepflegten Duplikats der echten Logik (die an anderer Stelle bereits
    // abgedeckt ist, siehe parseSbcChallenge/applyFromSetChallenges/
    // harvestItems-Tests).
    function buildUrlHelpers(overrides) {
        overrides = overrides || {};
        const STATE = {
            session: {},
            diag: { utasSeen: 0, lastUtasPaths: [], lastErrors: [], utasUnclassified: 0, lastUnclassifiedPaths: [] },
            sbc: { apiPrefix: 'sbs' },
            lastSetChallenges: null,
            lastChallengeRaw: null
        };
        const reportError = overrides.reportError || function (label, e) {
            STATE.diag.lastErrors.push(label + ': ' + ((e && e.message) || String(e)));
        };
        const applyFromSetChallenges = overrides.applyFromSetChallenges || function () {};
        const parseSbcChallenge = overrides.parseSbcChallenge || function () {};
        const harvestItems = overrides.harvestItems || function () {};
        const helpers = new Function(
            'STATE', 'log', 'refreshDiagUI', 'reportError',
            'applyFromSetChallenges', 'parseSbcChallenge', 'harvestItems',
            urlClsBlock + '\nreturn { detectApiBase: detectApiBase, classifyUrl: classifyUrl, ' +
                'noteUnclassifiedUtas: noteUnclassifiedUtas, handleResponseBody: handleResponseBody };'
        )(STATE, function () {}, function () {}, reportError, applyFromSetChallenges, parseSbcChallenge, harvestItems);
        return {
            STATE: STATE,
            detectApiBase: helpers.detectApiBase,
            classifyUrl: helpers.classifyUrl,
            noteUnclassifiedUtas: helpers.noteUnclassifiedUtas,
            handleResponseBody: helpers.handleResponseBody
        };
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

    // (g) handleResponseBody: kaputtes JSON an einer bereits als SBC-relevant
    // klassifizierten URL -> reportError() landet im Report (Aktion 1, erster
    // Catch). Ohne diese Aenderung war der Fehlschlag komplett stumm.
    {
        const { handleResponseBody, STATE } = buildUrlHelpers();
        const sbcUrl = 'https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/sbs/sets';
        handleResponseBody(sbcUrl, '{invalid');
        check('handleResponseBody: kaputtes JSON an SBC-URL erzeugt einen lastErrors-Eintrag',
            STATE.diag.lastErrors.length === 1, JSON.stringify(STATE.diag.lastErrors));
        check('handleResponseBody: der Eintrag nennt "handleResponseBody("',
            STATE.diag.lastErrors[0].indexOf('handleResponseBody(') === 0, STATE.diag.lastErrors[0]);
    }
    // (h) handleResponseBody: kaputtes JSON an einer NICHT klassifizierten
    // (fremden) URL -> classifyUrl() liefert null, die Funktion kehrt VOR dem
    // JSON.parse-Versuch zurueck -> kein Log-Spam fuer Fremd-Traffic/HTML-
    // Fehlerseiten (siehe patterns/good/stille-catches-nur-an-der-ea-grenze.md).
    {
        const { handleResponseBody, STATE } = buildUrlHelpers();
        handleResponseBody('https://example.com/foo/bar', '{invalid');
        check('handleResponseBody: kaputtes JSON an Fremd-URL erzeugt KEINEN lastErrors-Eintrag',
            STATE.diag.lastErrors.length === 0, JSON.stringify(STATE.diag.lastErrors));
    }
    // (i) handleResponseBody: valides JSON, aber die nachgelagerte Verarbeitung
    // (hier parseSbcChallenge) wirft -> zweiter Catch meldet ebenfalls per
    // reportError() statt nur warn() (Aktion 1, zweiter Catch).
    {
        const { handleResponseBody, STATE } = buildUrlHelpers({
            parseSbcChallenge: function () { throw new Error('kaputte Challenge-Struktur'); }
        });
        const challengeUrl = 'https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/sbs/challenge/3070';
        handleResponseBody(challengeUrl, '{}');
        check('handleResponseBody: Fehler in der Verarbeitung (zweiter Catch) erzeugt einen lastErrors-Eintrag',
            STATE.diag.lastErrors.length === 1, JSON.stringify(STATE.diag.lastErrors));
        check('handleResponseBody: der Eintrag des zweiten Catches nennt ebenfalls "handleResponseBody("',
            STATE.diag.lastErrors[0].indexOf('handleResponseBody(') === 0, STATE.diag.lastErrors[0]);
    }

    // (j) noteUnclassifiedUtas: unbekannte, aber SBC-aehnliche /ut/game/-URL
    // (Aktion 2) -> eigener Zaehler + Sample-Ring, unabhaengig vom generischen
    // lastUtasPaths-Ring (der ALLEN utas-Traffic aufnimmt).
    {
        const { noteUnclassifiedUtas, STATE } = buildUrlHelpers();
        noteUnclassifiedUtas('https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/sbx/foo');
        check('noteUnclassifiedUtas: unbekannter Pfad zaehlt hoch',
            STATE.diag.utasUnclassified === 1, STATE.diag.utasUnclassified);
        check('noteUnclassifiedUtas: unbekannter Pfad landet im Sample-Ring',
            STATE.diag.lastUnclassifiedPaths.length === 1 &&
            STATE.diag.lastUnclassifiedPaths[0].indexOf('/sbx/foo') > -1,
            JSON.stringify(STATE.diag.lastUnclassifiedPaths));
    }
    // (k) noteUnclassifiedUtas: bereits klassifizierte URL -> kein Fehlalarm
    // fuer bekannten Traffic.
    {
        const { noteUnclassifiedUtas, STATE } = buildUrlHelpers();
        noteUnclassifiedUtas('https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/club?start=0');
        check('noteUnclassifiedUtas: bekannter Endpunkt zaehlt NICHT',
            STATE.diag.utasUnclassified === 0, STATE.diag.utasUnclassified);
    }
    // (l) noteUnclassifiedUtas: sechs verschiedene unbekannte Pfade
    // nacheinander -> Ring bleibt bei 5 Eintraegen (Cap-Verhalten wie beim
    // Vorbild lastUtasPaths).
    {
        const { noteUnclassifiedUtas, STATE } = buildUrlHelpers();
        for (let i = 1; i <= 6; i++) {
            noteUnclassifiedUtas('https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/sbx/foo' + i);
        }
        check('noteUnclassifiedUtas: Zaehler zaehlt alle sechs',
            STATE.diag.utasUnclassified === 6, STATE.diag.utasUnclassified);
        check('noteUnclassifiedUtas: Sample-Ring deckelt bei 5 Eintraegen',
            STATE.diag.lastUnclassifiedPaths.length === 5, STATE.diag.lastUnclassifiedPaths.length);
        check('noteUnclassifiedUtas: Ring enthaelt die JUENGSTEN 5 Pfade (foo2..foo6)',
            STATE.diag.lastUnclassifiedPaths.join(',').indexOf('foo1') === -1 &&
            STATE.diag.lastUnclassifiedPaths[4].indexOf('foo6') > -1,
            JSON.stringify(STATE.diag.lastUnclassifiedPaths));
    }
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

// ========== 28. usedChallengeIds-Sperre mit Daily-Ausnahme: isFreshMatchingInstance ==========
{
    const matchesSrc = extractFunction(src, 'matchesPlannedSbc');
    const freshSrc = extractFunction(src, 'isFreshMatchingInstance');
    check('Funktion isFreshMatchingInstance gefunden (28)', !!freshSrc);

    function buildFresh(STATE) {
        return new Function('STATE', matchesSrc + '\n' + freshSrc +
            '\nreturn isFreshMatchingInstance;')(STATE);
    }

    // Daily-Ausnahme (LIVE-Regression v4.46.0-v4.56.0, zwei Reports belegt):
    // Daily-SBCs setzen DIESELBE challengeId zurueck - die urspruengliche harte
    // Sperre (same-id -> immer false) blockierte dort jede zweite Runde
    // ("Batch gestoppt nach 1/6"). Seit v4.57.0 gilt: benutzte challengeId +
    // NACHWEISLICH leere Instanz (squadEmpty === true) = wieder frisch;
    // plan.sameIdReuse zaehlt das fuer die Diagnose mit.
    {
        const STATE = { sbc: { targetOVR: 84, formationSlots: 11, challengeId: '777' } };
        const plan = { targetOVR: 84, slots: 11, usedChallengeIds: ['777'] };
        check('isFreshMatchingInstance: true bei benutzter challengeId, wenn die ' +
            'Instanz nachweislich leer ist (Daily-Wiederverwendung, v4.57.0)',
            buildFresh(STATE)(plan, STATE.sbc, true) === true);
        check('isFreshMatchingInstance: sameIdReuse-Diagnosezaehler wurde erhoeht',
            plan.sameIdReuse === 1);
    }
    // Die Sperre traegt weiter, wo sie hingehoert: benutzte challengeId und
    // Leerheit UNBEKANNT (null) bleibt gesperrt - "unbekannt" reicht nicht.
    {
        const STATE = { sbc: { targetOVR: 84, formationSlots: 11, challengeId: '777' } };
        const plan = { targetOVR: 84, slots: 11, usedChallengeIds: ['777'] };
        check('isFreshMatchingInstance: false bei benutzter challengeId und ' +
            'squadEmpty===null (unbekannt bleibt gesperrt)',
            buildFresh(STATE)(plan, STATE.sbc, null) === false);
    }
    // Benutzte challengeId + volles Squad (fehlgeschlagene/alte Abgabe) bleibt
    // ebenfalls gesperrt.
    {
        const STATE = { sbc: { targetOVR: 84, formationSlots: 11, challengeId: '777' } };
        const plan = { targetOVR: 84, slots: 11, usedChallengeIds: ['777'] };
        check('isFreshMatchingInstance: false bei benutzter challengeId und ' +
            'squadEmpty===false (volles Squad bleibt gesperrt)',
            buildFresh(STATE)(plan, STATE.sbc, false) === false);
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

// ========== 32. Aktion 1: scopesSeen ungegated gegen die reqDump-Whitelist-Luecke ==========
{
    const scanBlock = extractMarkerBlock(src, '// [SBCSCAN-BEGIN]', '// [SBCSCAN-END]');
    check('SBCSCAN-Marker-Block gefunden (32)', !!scanBlock);
    const deepScanChallenge = new Function(scanBlock + '\nreturn deepScanChallenge;')();

    // "ARCHETYPE_GROUP" enthaelt keines der zehn Whitelist-Teilworte
    // (RATING/RARITY/PLAYER/OVR/LEVEL/QUALITY/CLUB/LEAGUE/NATION/CHEM) - eine
    // komplett neue EA-Scope-Familie, wie Mangel 1 im Gap-Report sie
    // beschreibt.
    const out = deepScanChallenge([{ scope: 'ARCHETYPE_GROUP', value: 5 }]);
    check('scopesSeen enthaelt den Whitelist-fremden Scope',
        out.scopesSeen.indexOf('ARCHETYPE_GROUP') > -1, JSON.stringify(out.scopesSeen));
    check('reqDump filtert ihn weiterhin heraus (Whitelist-Logik unveraendert)',
        !out.reqs.some(r => r.scope === 'ARCHETYPE_GROUP'), JSON.stringify(out.reqs));

    // Deckel bei 40 Eintraegen - das Set darf trotz 60 distinkter Scopes nicht
    // darueber wachsen.
    const many = [];
    for (let i = 0; i < 60; i++) many.push({ scope: 'UNKNOWN_SCOPE_' + i, value: i });
    const outCap = deepScanChallenge(many);
    check('scopesSeen ist bei 40 Eintraegen gedeckelt', outCap.scopesSeen.length === 40,
        'len=' + outCap.scopesSeen.length);

    // Gegenprobe: ein bekannter Whitelist-Scope landet weiterhin normal in
    // reqDump UND zusaetzlich in scopesSeen (keine Regression).
    const outKnown = deepScanChallenge([{ scope: 'PLAYER_RARITY_GROUP', value: 4 }]);
    check('bekannter Whitelist-Scope steht weiterhin in reqDump',
        outKnown.reqs.some(r => r.scope === 'PLAYER_RARITY_GROUP'));
    check('bekannter Whitelist-Scope steht auch in scopesSeen',
        outKnown.scopesSeen.indexOf('PLAYER_RARITY_GROUP') > -1);
}

// ========== 33. Aktion 2: Traversal-Kappung wird als scanStats sichtbar, ohne den Fund zu veraendern ==========
{
    // Baut eine einfache Kette gleichartiger Zwischenknoten (je ein "child"),
    // deren Blatt erst NACH `depth` Ebenen erreicht wird - EXAKT konstruiert
    // ueber die jeweilige Kappungsgrenze der drei Scanner.
    function chain(depth, leafProps) {
        let node = Object.assign({ isLeaf: true }, leafProps);
        for (let i = 0; i < depth; i++) node = { child: node };
        return node;
    }

    const scanBlock = extractMarkerBlock(src, '// [SBCSCAN-BEGIN]', '// [SBCSCAN-END]');
    check('SBCSCAN-Marker-Block gefunden (33)', !!scanBlock);
    const deepScanChallenge = new Function(scanBlock + '\nreturn deepScanChallenge;')();

    // deepScanChallenge kappt bei d > 7 - eine TEAM_RATING-Vorgabe 9 Ebenen
    // tief bleibt dadurch unerreicht (Regressions-Gegenprobe: target bleibt
    // null, GENAU wie vor dieser Iteration - scanStats macht das jetzt nur
    // SICHTBAR statt stillschweigend).
    const deep = deepScanChallenge(chain(9, { scope: 'TEAM_RATING', value: 84 }));
    check('vergrabene Vorgabe bleibt hinter der Tiefenkappung unerreicht (Regression)',
        deep.target === null);
    check('deepScanChallenge markiert depthCapped bei ueberschrittener Tiefe',
        deep.depthCapped === true, JSON.stringify({ depthCapped: deep.depthCapped, visitedCount: deep.visitedCount }));
    check('visitedCount zaehlt exakt bis zur Kappungstiefe (Wurzel + 7 Ebenen)',
        deep.visitedCount === 8, 'visited=' + deep.visitedCount);
    check('budgetExhausted bleibt false (Tiefenkappung, nicht Budget)',
        deep.budgetExhausted === false);

    // Gegenprobe: dieselbe Vorgabe FLACH (Tiefe 2) wird weiterhin gefunden,
    // depthCapped bleibt false - kein Kontrollfluss-Eingriff durch das neue Feld.
    const shallow = deepScanChallenge(chain(2, { scope: 'TEAM_RATING', value: 84 }));
    check('dieselbe Vorgabe flach bleibt unveraendert auffindbar', shallow.target === 84);
    check('depthCapped bleibt false, wenn die Tiefe nicht ueberschritten wird',
        shallow.depthCapped === false);

    // findChallengeNode()/collectChallengeNodes() kappen bei d > 6 - additiver
    // statsOut-Parameter, bestehende zweistellige Aufrufe bleiben unveraendert.
    const findSrc = extractFunction(src, 'findChallengeNode');
    check('Funktion findChallengeNode gefunden', !!findSrc);
    const collectSrc = extractFunction(src, 'collectChallengeNodes');
    check('Funktion collectChallengeNodes gefunden (33)', !!collectSrc);
    const isDomOrWindowSrc = extractFunction(src, 'isDomOrWindow');
    const buildTraversers = new Function('isDomOrWindow',
        findSrc + '\n' + collectSrc + '\nreturn { findChallengeNode: findChallengeNode, collectChallengeNodes: collectChallengeNodes };'
    )(new Function(isDomOrWindowSrc + '\nreturn isDomOrWindow;')());

    const deepNode = chain(8, { challengeId: 'DEEP', requirements: [] });
    check('findChallengeNode OHNE statsOut bleibt aufrufbar (Rueckwaertskompatibilitaet)',
        buildTraversers.findChallengeNode(deepNode, 'DEEP') === null);
    const findStats = {};
    check('findChallengeNode findet den zu tief vergrabenen Knoten weiterhin NICHT (Regression)',
        buildTraversers.findChallengeNode(deepNode, 'DEEP', findStats) === null);
    check('findChallengeNode markiert depthCapped im statsOut',
        findStats.findNode && findStats.findNode.depthCapped === true, JSON.stringify(findStats));

    const collectStats = {};
    const deepList = buildTraversers.collectChallengeNodes(deepNode, collectStats);
    check('collectChallengeNodes findet den zu tief vergrabenen Knoten weiterhin NICHT (Regression)',
        deepList.length === 0, JSON.stringify(deepList));
    check('collectChallengeNodes markiert depthCapped im statsOut',
        collectStats.collectNodes && collectStats.collectNodes.depthCapped === true, JSON.stringify(collectStats));

    // Gegenprobe: derselbe Knoten flach (Tiefe 2) wird weiterhin gefunden,
    // depthCapped bleibt false.
    const shallowNode = chain(2, { challengeId: 'SHALLOW', requirements: [] });
    const shallowStats = {};
    check('findChallengeNode findet den flachen Knoten weiterhin (Regression)',
        buildTraversers.findChallengeNode(shallowNode, 'SHALLOW', shallowStats) === shallowNode.child.child);
    check('findChallengeNode: depthCapped bleibt false ohne Kappung',
        shallowStats.findNode && shallowStats.findNode.depthCapped === false);
}

// ========== 34. Aktion 3: reqCountRaw()/reqCountDefaulted() markieren den 1-Fallback ==========
{
    const scanBlock = extractMarkerBlock(src, '// [SBCSCAN-BEGIN]', '// [SBCSCAN-END]');
    check('SBCSCAN-Marker-Block gefunden (34)', !!scanBlock);
    const scanExports = new Function(scanBlock +
        '\nreturn { reqCountRaw: reqCountRaw, reqCount: reqCount, reqCountDefaulted: reqCountDefaulted };')();

    // Kein bekannter Count-Key (count/requirementCount/keyCount/amount/minimum/
    // _count) weder am Objekt noch in den Eltern -> der alte 1-Fallback greift,
    // jetzt aber SICHTBAR markiert statt von einem echten Wert 1 ununterscheidbar.
    const noKey = { scope: 'PLAYER_OVERALL_RATING_MIN', value: 85 };
    check('reqCountRaw ohne bekannten Count-Key: count bleibt 1 (Regression)',
        scanExports.reqCountRaw(noKey, []).count === 1);
    check('reqCountRaw ohne bekannten Count-Key: defaulted ist true',
        scanExports.reqCountRaw(noKey, []).defaulted === true);
    check('reqCount() liefert weiterhin nur die Zahl (Wrapper-Vertrag, Regression)',
        scanExports.reqCount(noKey, []) === 1);
    check('reqCountDefaulted() spiegelt das Flag',
        scanExports.reqCountDefaulted(noKey, []) === true);

    // Bekannter Count-Key am Objekt selbst -> kein Fallback.
    const withCount = { scope: 'PLAYER_OVERALL_RATING_MIN', value: 85, count: 4 };
    check('reqCountRaw mit count-Feld: Zahl unveraendert (Regression)',
        scanExports.reqCountRaw(withCount, []).count === 4);
    check('reqCountRaw mit count-Feld: defaulted ist false',
        scanExports.reqCountRaw(withCount, []).defaulted === false);
    check('reqCount() liefert bei vorhandenem Count-Feld weiterhin dieselbe Zahl (Regression)',
        scanExports.reqCount(withCount, []) === 4);

    // Bekannter Count-Key im ELTERN-Objekt (EAs uebliche Ablage, siehe Kommentar
    // an reqCountRaw) -> ebenfalls kein Fallback.
    const parent = { requirementCount: 6 };
    check('reqCountRaw findet den Count in der Eltern-Kette: Zahl uebernommen (Regression)',
        scanExports.reqCountRaw(noKey, [parent]).count === 6);
    check('reqCountRaw findet den Count in der Eltern-Kette: defaulted ist false',
        scanExports.reqCountRaw(noKey, [parent]).defaulted === false);
}

// ========== 35. computeRareflagHistogram: Verhaltensgleichheit zur vormaligen IIFE + allSpecialFlagValues ==========
{
    const rarehistBlock = extractMarkerBlock(src, '// [RAREHIST-BEGIN]', '// [RAREHIST-END]');
    check('RAREHIST-Marker-Block gefunden', !!rarehistBlock);
    const computeRareflagHistogram = new Function(rarehistBlock + '\nreturn computeRareflagHistogram;')();

    function card(rareflag) { return { rareflag: rareflag }; }

    // (a) Fuenf haeufige Special-rareflags (je >= 3 Karten) plus EIN neuer,
    // seltener rareflag (1 Karte) - der seltene Wert darf NICHT in topSpecials
    // auftauchen (Cap-Verhalten unveraendert), MUSS aber als String in
    // allSpecialFlagValues stehen (Aktion 3 - vorher komplett unsichtbar).
    const pool = []
        .concat(new Array(3).fill(null).map(() => card(10)))
        .concat(new Array(4).fill(null).map(() => card(11)))
        .concat(new Array(5).fill(null).map(() => card(12)))
        .concat(new Array(6).fill(null).map(() => card(13)))
        .concat(new Array(7).fill(null).map(() => card(14)))
        .concat([card(99)]); // neu, selten: 1 Karte
    const out = computeRareflagHistogram(pool);
    check('computeRareflagHistogram: der seltene rareflag 99 fehlt in topSpecials (Cap 5 unveraendert)',
        out.topSpecials.indexOf('99:') === -1, out.topSpecials);
    check('computeRareflagHistogram: der seltene rareflag 99 steht in allSpecialFlagValues',
        out.allSpecialFlagValues.split(',').indexOf('99') > -1, out.allSpecialFlagValues);
    check('computeRareflagHistogram: allSpecialFlagValues enthaelt alle sechs distincten Specials',
        out.allSpecialFlagValues.split(',').length === 6, out.allSpecialFlagValues);

    // (b) Regression: 0_common/1_rare/3_totw/specialFlags/specialTotal bleiben
    // gegenueber der vormaligen anonymen IIFE unveraendert (reine Extraktion,
    // keine Verhaltensaenderung an den bereits genutzten Feldern).
    const regressionPool = [card(0), card(0), card(1), card(3), card(3), card(3)]
        .concat(new Array(3).fill(null).map(() => card(10)));
    const regOut = computeRareflagHistogram(regressionPool);
    check('computeRareflagHistogram: 0_common (Regression)', regOut['0_common'] === 2, regOut['0_common']);
    check('computeRareflagHistogram: 1_rare (Regression)', regOut['1_rare'] === 1, regOut['1_rare']);
    check('computeRareflagHistogram: 3_totw (Regression)', regOut['3_totw'] === 3, regOut['3_totw']);
    check('computeRareflagHistogram: specialFlags = 1 distincter Special-Wert (Regression)',
        regOut.specialFlags === 1, regOut.specialFlags);
    check('computeRareflagHistogram: specialTotal = 3 Karten mit diesem Wert (Regression)',
        regOut.specialTotal === 3, regOut.specialTotal);
    check('computeRareflagHistogram: topSpecials nennt den einzigen Special-Wert (Regression)',
        regOut.topSpecials === '10:3', regOut.topSpecials);

    // (c) leerer Pool wirft nicht und liefert leere/neutrale Felder.
    const emptyOut = computeRareflagHistogram([]);
    check('computeRareflagHistogram: leerer Pool wirft nicht und liefert 0/leere Felder',
        emptyOut['0_common'] === 0 && emptyOut.specialFlags === 0 && emptyOut.allSpecialFlagValues === '',
        JSON.stringify(emptyOut));

    // (d) buildDiagReport() ruft die extrahierte Funktion (kein toter Code,
    // die IIFE ist wirklich ersetzt statt nur daneben zu existieren).
    check('buildDiagReport() ruft computeRareflagHistogram(STATE.pool) auf',
        src.indexOf('rareflagHistogram: computeRareflagHistogram(STATE.pool)') > -1);
}

// ========== 36. Ticket #48: Fallback-Deep-Scan in applyFromSetChallenges aktualisiert scanStats ==========
{
    const scanBlock = extractMarkerBlock(src, '// [SBCSCAN-BEGIN]', '// [SBCSCAN-END]');
    check('SBCSCAN-Marker-Block gefunden (36)', !!scanBlock);
    const findSrc = extractFunction(src, 'findChallengeNode');
    check('Funktion findChallengeNode gefunden (36)', !!findSrc);
    const recordSrc = extractFunction(src, 'recordDeepScanStats');
    check('Funktion recordDeepScanStats gefunden (36)', !!recordSrc);
    const applySrc = extractFunction(src, 'applyFromSetChallenges');
    check('Funktion applyFromSetChallenges gefunden (36)', !!applySrc);

    // applyScan() selbst (Rating-/Solver-Anwendung samt UI-Refresh) ist fuer
    // diesen Test irrelevant - nur scanStats.deepScan wird geprueft, deshalb
    // als No-Op-Stub hereingereicht statt der riesigen echten Funktion.
    const buildApplyFromSetChallenges = new Function('STATE', 'applyScan',
        scanBlock + '\n' + findSrc + '\n' + recordSrc + '\n' + applySrc +
        '\nreturn applyFromSetChallenges;');

    // Ein Blatt-Knoten 9 Ebenen tief - EXAKT wie in Block 33 - kappt beim
    // Fallback-Scan (deepScanChallenge: d > 7) selbst konstruiert, damit
    // deepScan.depthCapped/visitedCount des Fallback-Scans NACHWEISLICH von
    // einem beliebigen, vorher gesetzten Wert verschieden sind.
    function chain(depth, leafProps) {
        let node = Object.assign({ isLeaf: true }, leafProps);
        for (let i = 0; i < depth; i++) node = { child: node };
        return node;
    }
    const deepNode = Object.assign(chain(9, { scope: 'TEAM_RATING', value: 84 }),
        { challengeId: 'C1', requirements: [] });

    // (a) Response ohne target: STATE.diag.scanStats.deepScan traegt noch die
    // Werte eines FRUEHEREN Scans (z.B. aus parseSbcChallenge/Netzwerk) -
    // deutlich verschieden vom Fallback-Scan, der hier gleich laeuft.
    const staleValue = { visitedCount: 12345, depthCapped: true, budgetExhausted: true };
    const STATE_a = {
        sbc: { challengeId: 'C1' },
        diag: { scanStats: { deepScan: Object.assign({}, staleValue) } },
        lastSetChallenges: { data: [deepNode] }
    };
    const applyFromSetChallenges_a = buildApplyFromSetChallenges(STATE_a, function () {});
    applyFromSetChallenges_a();
    check('Fallback-Scan ueberschreibt den veralteten deepScan-Eintrag (Ticket #48 - vorher stehengeblieben)',
        JSON.stringify(STATE_a.diag.scanStats.deepScan) !== JSON.stringify(staleValue),
        JSON.stringify(STATE_a.diag.scanStats.deepScan));
    check('Fallback-Scan traegt sein eigenes depthCapped ein (Knoten 9 Ebenen tief, Kappung bei d > 7)',
        STATE_a.diag.scanStats.deepScan.depthCapped === true,
        JSON.stringify(STATE_a.diag.scanStats.deepScan));
    check('Fallback-Scan traegt seinen eigenen visitedCount ein statt der veralteten Zahl',
        STATE_a.diag.scanStats.deepScan.visitedCount !== staleValue.visitedCount,
        JSON.stringify(STATE_a.diag.scanStats.deepScan));

    // (b) Gegenprobe Normalpfad: findChallengeNode findet KEINEN Knoten (kein
    // Fallback-Scan noetig, z.B. weil der Netzwerkpfad das Target bereits
    // hatte) - applyFromSetChallenges() darf dann NICHTS an scanStats.deepScan
    // aendern (Regression, kein Parse-/Anwendungsverhalten veraendert - AC 3).
    const STATE_b = {
        sbc: { challengeId: 'UNBEKANNT' },
        diag: { scanStats: { deepScan: Object.assign({}, staleValue) } },
        lastSetChallenges: { data: [deepNode] }
    };
    const applyFromSetChallenges_b = buildApplyFromSetChallenges(STATE_b, function () {});
    applyFromSetChallenges_b();
    check('Ohne gefundenen Knoten bleibt scanStats.deepScan unveraendert (Regression, kein Seiteneffekt)',
        JSON.stringify(STATE_b.diag.scanStats.deepScan) === JSON.stringify(staleValue),
        JSON.stringify(STATE_b.diag.scanStats.deepScan));

    // (c) Regression: die beiden BESTEHENDEN Aufrufstellen (Netzwerk-Antwort /
    // App-Service-Entity) riefen recordDeepScanStats() schon vor diesem Ticket
    // korrekt auf - unveraendert, NUR der Fallback-Pfad war die Luecke.
    const parseSrc = extractFunction(src, 'parseSbcChallenge');
    const captureSrc = extractFunction(src, 'captureChallengeEntity');
    // Seit v4.58.0 traegt der Aufruf ein Quell-Label (recordDeepScanStats(scan,
    // 'netzwerk'|'entity'|'set-node')) - die Invariante ist der AUFRUF selbst.
    check('parseSbcChallenge() ruft weiterhin recordDeepScanStats(scan, ...) auf (Regression)',
        /recordDeepScanStats\(scan[,)]/.test(parseSrc));
    check('captureChallengeEntity() ruft weiterhin recordDeepScanStats(scan, ...) auf (Regression)',
        /recordDeepScanStats\(scan[,)]/.test(captureSrc));
}

// ========== 37. Ticket #50: sbcButtonContainer() - additiver Text-Fallback ohne Primaerpfad-Verdraengung ==========
{
    const containerSrc = extractFunction(src, 'sbcButtonContainer');
    const byTextSrc = extractFunction(src, 'sbcButtonContainerByText');
    check('Funktion sbcButtonContainer gefunden (37)', !!containerSrc);
    check('Funktion sbcButtonContainerByText gefunden (37)', !!byTextSrc);

    // containerFallbackUsed ist im Produktcode ein modulweites `let` neben
    // btnAttachCount/launcherClicks (KEIN STATE.diag-Feld, LEARNINGS §25) -
    // hier als lokale Variable im selben Function-Scope nachgebildet, damit
    // die extrahierten Funktionen ihren Zaehler-Zugriff unveraendert
    // ausfuehren koennen.
    function loadContainerHelpers(fakeDocument) {
        return new Function('document',
            'let containerFallbackUsed = 0;\n' +
            byTextSrc + '\n' + containerSrc +
            '\nreturn { sbcButtonContainer: sbcButtonContainer, ' +
            'getFallbackUsed: function () { return containerFallbackUsed; } };'
        )(fakeDocument);
    }
    function visibleBtn(txt, parent) {
        return { offsetParent: {}, getClientRects: () => [{}], textContent: txt, parentNode: parent || null };
    }

    // (a) Primaerer Selektor UND Text-Fallback-Buttons gleichzeitig sichtbar -
    // der Reihenfolge-Beweis: die zurueckgegebene Referenz MUSS mit dem
    // Primaer-Element identisch sein (nicht nur "irgendein Treffer"), der
    // Fallback-Zaehler bleibt bei 0 - der Primaer-Loop bricht per `return`
    // ab, bevor der Fallback-Code ueberhaupt erreicht wird.
    {
        const primaryEl = { offsetParent: {}, getClientRects: () => [{}] };
        const fallbackParent = {};
        const fakeDocument = {
            querySelectorAll: function (sel) {
                if (sel === '.sbc-button-container') return [primaryEl];
                if (sel === 'button') {
                    return [visibleBtn('Use Squad Builder', fallbackParent),
                            visibleBtn('Clear Squad', fallbackParent)];
                }
                return [];
            }
        };
        const helpers = loadContainerHelpers(fakeDocument);
        check('Primaer-Selektor UND Fallback-Text-Treffer gleichzeitig: der Primaer-Loop gewinnt (Identitaet, nicht nur ein Treffer)',
            helpers.sbcButtonContainer() === primaryEl);
        check('Primaer-Loop gewinnt: containerFallbackUsed bleibt 0 (Fallback-Code strukturell unerreicht)',
            helpers.getFallbackUsed() === 0);
    }

    // (b) Primaer-Selektor liefert nichts, Fallback-Text-Buttons vorhanden ->
    // gemeinsamer Elternknoten der Treffer als Container, Zaehler +1.
    {
        const fallbackParent = {};
        const fakeDocument = {
            querySelectorAll: function (sel) {
                if (sel === '.sbc-button-container') return [];
                if (sel === 'button') {
                    return [visibleBtn('Use Squad Builder', fallbackParent),
                            visibleBtn('Clear Squad', fallbackParent)];
                }
                return [];
            }
        };
        const helpers = loadContainerHelpers(fakeDocument);
        check('Primaer-Selektor leer, Fallback-Text-Treffer vorhanden: gemeinsamer Elternknoten kommt zurueck',
            helpers.sbcButtonContainer() === fallbackParent);
        check('Fallback tatsaechlich benutzt: containerFallbackUsed steht auf 1',
            helpers.getFallbackUsed() === 1);
    }

    // (c) Beides liefert nichts -> null, Zaehler bleibt 0.
    {
        const fakeDocument = { querySelectorAll: function () { return []; } };
        const helpers = loadContainerHelpers(fakeDocument);
        check('Weder Primaer-Selektor noch Fallback-Text-Treffer: null',
            helpers.sbcButtonContainer() === null);
        check('Kein Treffer: containerFallbackUsed bleibt 0',
            helpers.getFallbackUsed() === 0);
    }

    // (d) uneindeutiger Fallback (Treffer mit unterschiedlichen Elternknoten,
    // z.B. weil EAs neuer Container ganz anders aufgebaut ist) -> nicht
    // raten, null statt eines falschen Containers.
    {
        const fakeDocument = {
            querySelectorAll: function (sel) {
                if (sel === '.sbc-button-container') return [];
                if (sel === 'button') return [visibleBtn('Use Squad Builder', {}), visibleBtn('Exchange', {})];
                return [];
            }
        };
        const helpers = loadContainerHelpers(fakeDocument);
        check('Fallback-Treffer mit UNTERSCHIEDLICHEN Elternknoten: uneindeutig -> null statt Raten',
            helpers.sbcButtonContainer() === null);
    }
}

// ========== 38. Ticket #50: inSbcView() - Fail-Open bei Fehlern, Kette bestimmt Sichtbarkeit ==========
{
    const inSbcViewSrc = extractFunction(src, 'inSbcView');
    check('Funktion inSbcView gefunden (38)', !!inSbcViewSrc);
    function loadInSbcView(fakeGetControllerChain) {
        return new Function('getControllerChain', inSbcViewSrc + '\nreturn inSbcView;')(fakeGetControllerChain);
    }
    check('inSbcView(): leere Kette -> true (kein Einstieg verstecken, bevor die App bereit ist)',
        loadInSbcView(() => [])() === true);
    check('inSbcView(): Kette mit .constructor.name passend zu /sbc/i -> true',
        loadInSbcView(() => [{ constructor: { name: 'UTSBCSquadSelectSummaryController' } }])() === true);
    check('inSbcView(): Kette ohne Treffer -> false',
        loadInSbcView(() => [{ constructor: { name: 'UTHomeHubController' } }])() === false);
    check('inSbcView(): werfende Kette -> true (bestehendes Fail-Open-Verhalten, als Testfall festgeschrieben)',
        loadInSbcView(() => { throw new Error('boom'); })() === true);
}

// ========== 39. Ticket #50: syncLauncher() nutzt sbcButtonContainer() statt eigener Selektor-Logik (DRY) ==========
{
    const syncLauncherSrc = extractFunction(src, 'syncLauncher');
    check('Funktion syncLauncher gefunden (39)', !!syncLauncherSrc);
    check('syncLauncher() ruft sbcButtonContainer() auf statt eine eigene Selektor-Logik zu duplizieren',
        syncLauncherSrc.indexOf('sbcButtonContainer()') > -1);
}

// ========== 40. Ticket #52: onRunClick() lehnt einen Klick waehrend STATE.loading ab ==========
// Analog zum Verhaltenstest in Abschnitt 29 (openNextInstance): die echte,
// per Marker extrahierte Funktion laeuft gegen ein gestubbtes ui/STATE, statt
// den Guard nur per Text-Grep zu belegen.
{
    const runFnSrc = extractFunction(src, 'onRunClick');
    check('Funktion onRunClick gefunden (40)', !!runFnSrc);

    function makeOnRunClickSandbox(loading) {
        const calls = { toast: [], setStatus: [], solve: 0, submit: 0, reportError: 0 };
        const STATE = {
            loading: loading,
            loadIncomplete: false,
            pool: [{ rating: 84 }],
            sbc: { targetOVR: 84, playerLevelConstraints: [], rarityConstraints: [], qualityConstraints: [] }
        };
        const ui = { run: { disabled: false } };
        const sandbox = {
            STATE: STATE,
            ui: ui,
            syncSbcWithOpenChallenge: () => {},
            toast: (msg, kind) => { calls.toast.push({ msg: msg, kind: kind }); },
            setStatus: (s) => { calls.setStatus.push(s); },
            readConfig: () => ({}),
            SolverCore: { solve: () => { calls.solve++; return { ok: true, ovr: 84, players: [] }; } },
            renderResult: () => {},
            submitCurrentResult: () => { calls.submit++; return Promise.resolve(); },
            reportError: () => { calls.reportError++; },
            anyDeepScanTruncated: () => false
        };
        const keys = Object.keys(sandbox);
        const fn = new Function(keys.join(','), runFnSrc + '\nreturn onRunClick;')
            .apply(null, keys.map(function (k) { return sandbox[k]; }));
        return { fn: fn, calls: calls, STATE: STATE, ui: ui };
    }

    const loadingCase = makeOnRunClickSandbox(true);
    pending.push(loadingCase.fn().then(function () {
        check('onRunClick: STATE.loading=true -> SolverCore.solve() wird NIE gerufen',
            loadingCase.calls.solve === 0);
        check('onRunClick: STATE.loading=true -> genau ein toast()-Aufruf, kein submitCurrentResult()',
            loadingCase.calls.toast.length === 1 && loadingCase.calls.submit === 0,
            JSON.stringify(loadingCase.calls));
    }));

    const normalCase = makeOnRunClickSandbox(false);
    pending.push(normalCase.fn().then(function () {
        check('onRunClick: STATE.loading=false -> Normalpfad unveraendert (solve + submit laufen genau einmal)',
            normalCase.calls.solve === 1 && normalCase.calls.submit === 1,
            JSON.stringify(normalCase.calls));
    }));
}

// ========== 41. Ticket #54: clickSetTile()/titleOf() - titleSource sichtbar, Fallback-Pfad erstmals getestet ==========
// Bisher lief nur ein Text-Grep gegen titleOf/tileTitle (solver-test.js:1859
// Kommentar-Treffer), die interne Matching-Logik selbst war ungetestet (Gap-
// Report batch-modus, Iteration 5). titleOf() faellt auf t.textContent zurueck,
// wenn keines von .tileTitle/.tileHeader/h1 existiert - genau der Volltext-
// Fallback, der laut LEARNINGS §9 (v4.23.0) live zum Teilstring-Fehlgriff
// fuehrte. titleSource macht sichtbar, welcher Pfad griff, OHNE das Matching
// selbst zu aendern - deshalb hier ein echter Verhaltenstest statt nur Text-Match.
{
    const fn = extractFunction(src, 'clickSetTile');
    check('Funktion clickSetTile gefunden (41)', !!fn);

    // Tile-Attrappe: subText simuliert den Inhalt von .tileTitle/.tileHeader/h1
    // (null = kein Titel-Element gefunden, EA hat nur die inneren Elemente
    // umgebaut), fullText simuliert t.textContent (Beschreibung + Belohnungen
    // inklusive - der ganze Kachel-Text).
    function makeTile(subText, fullText) {
        return {
            querySelector: function () { return subText == null ? null : { textContent: subText }; },
            textContent: fullText
        };
    }

    function run(tiles, setName) {
        const STATE = { diag: {} };
        const sandbox = {
            STATE: STATE,
            visibleAll: function () { return tiles; },
            clickLike: function () { STATE.diag.lastTap = { clicked: true }; return true; }
        };
        const keys = Object.keys(sandbox);
        const clickSetTileFn = new Function(keys.join(','), fn + '\nreturn clickSetTile;')
            .apply(null, keys.map(function (k) { return sandbox[k]; }));
        return clickSetTileFn({ setName: setName });
    }

    // (a) Titel kommt ueber das echte Titel-Element -> titleSource 'element'.
    {
        const tile = makeTile('Team of the Week', 'Team of the Week extra reward text');
        const r = run([tile], 'Team of the Week');
        check('(a) Element-Titel-Pfad: ok === true', r.ok === true, JSON.stringify(r));
        check('(a) Element-Titel-Pfad: titleSource === "element"',
            r.titleSource === 'element', JSON.stringify(r));
    }

    // (b) Kein Titel-Element gefunden -> Volltext-Fallback greift und trifft
    // ueber einen reinen Teilstring (die 2023 gefixte Fehlerklasse, jetzt aber
    // SICHTBAR statt unauffaellig).
    {
        const tile = makeTile(null, 'silver upgrade bundle bonus reward included');
        const r = run([tile], 'upgrade');
        check('(b) Volltext-Fallback: ok === true (Teilstring-Treffer)', r.ok === true, JSON.stringify(r));
        check('(b) Volltext-Fallback: titleSource === "fulltext"',
            r.titleSource === 'fulltext', JSON.stringify(r));
    }

    // (c) Gegenprobe: kein Treffer -> bisheriges Verhalten unveraendert (ok:false,
    // "titles" bleibt ein Array aus Klartext-Strings wie vor der Aenderung,
    // kein titleSource im Fehlerfall - es gibt keinen "how").
    {
        const tile = makeTile('Bronze Pack', 'Bronze Pack description');
        const r = run([tile], 'gold pack');
        check('(c) Kein Treffer: ok === false (unveraendertes Abbruchverhalten)', r.ok === false, JSON.stringify(r));
        check('(c) Kein Treffer: why === "Set nicht gefunden" (unveraendert)', r.why === 'Set nicht gefunden');
        check('(c) Kein Treffer: titles bleibt Array aus Klartext-Strings (kein Objekt-Format-Bruch)',
            Array.isArray(r.titles) && r.titles[0] === 'bronze pack', JSON.stringify(r.titles));
        check('(c) Kein Treffer: kein titleSource im Fehlerfall', r.titleSource === undefined, JSON.stringify(r));
    }
}

// ========== 42. Ticket #56: onBatchPlanClick warnt additiv bei STATE.loadIncomplete ==========
// Analog zum Verhaltenstest in Abschnitt 40 (onRunClick): die echte, per
// Marker extrahierte Funktion laeuft gegen ein gestubbtes ui/STATE. Prueft
// GENAU den Kontrast aus dem Gap-Report: onRunClick warnte schon, onBatchPlanClick
// nicht - jetzt warnt auch der Batch-Pfad, aber ADDITIV (Planen bleibt moeglich,
// kein neuer Abbruch, CLAUDE.md "Batch darf abgeben").
{
    const planFnSrc = extractFunction(src, 'onBatchPlanClick');
    check('Funktion onBatchPlanClick gefunden (42)', !!planFnSrc);

    function makeOnBatchPlanClickSandbox(loadIncomplete) {
        const calls = { toast: [], setStatus: [], planBatch: 0, renderBatchPreview: [], reportError: 0 };
        const STATE = {
            loadIncomplete: loadIncomplete,
            pool: [{ rating: 84 }],
            sbc: { targetOVR: 84, playerLevelConstraints: [], rarityConstraints: [], qualityConstraints: [],
                   setId: 's1', formationSlots: 11 },
            batch: null
        };
        const ui = { batchCount: { value: '3' }, batchPlan: { disabled: false } };
        const sandbox = {
            STATE: STATE,
            ui: ui,
            syncSbcWithOpenChallenge: () => {},
            toast: (msg, kind) => { calls.toast.push({ msg: msg, kind: kind }); },
            setStatus: (s) => { calls.setStatus.push(s); },
            readConfig: () => ({}),
            SolverCore: { planBatch: () => { calls.planBatch++; return { planned: 1, requested: 3, rounds: [] }; } },
            findSbcController: () => null,
            renderBatchPreview: (plan) => { calls.renderBatchPreview.push(plan); },
            reportError: () => { calls.reportError++; },
            anyDeepScanTruncated: () => false
        };
        const keys = Object.keys(sandbox);
        const fn = new Function(keys.join(','), planFnSrc + '\nreturn onBatchPlanClick;')
            .apply(null, keys.map(function (k) { return sandbox[k]; }));
        return { fn: fn, calls: calls, STATE: STATE, ui: ui };
    }

    const incompleteCase = makeOnBatchPlanClickSandbox(true);
    pending.push(incompleteCase.fn().then(function () {
        check('onBatchPlanClick: STATE.loadIncomplete=true -> genau ein warn-Toast VOR dem Planen',
            incompleteCase.calls.toast.length === 1 && incompleteCase.calls.toast[0].kind === 'warn',
            JSON.stringify(incompleteCase.calls.toast));
        check('onBatchPlanClick: Planen laeuft trotzdem (planBatch wird gerufen, KEIN Abbruch)',
            incompleteCase.calls.planBatch === 1);
        check('onBatchPlanClick: plan.poolLoadIncomplete steht fuer die Vorschau bereit',
            incompleteCase.calls.renderBatchPreview.length === 1 &&
            incompleteCase.calls.renderBatchPreview[0].poolLoadIncomplete === true,
            JSON.stringify(incompleteCase.calls.renderBatchPreview));
    }));

    const normalCase = makeOnBatchPlanClickSandbox(false);
    pending.push(normalCase.fn().then(function () {
        check('onBatchPlanClick: STATE.loadIncomplete=false -> kein Toast, Normalpfad unveraendert',
            normalCase.calls.toast.length === 0 && normalCase.calls.planBatch === 1,
            JSON.stringify(normalCase.calls));
        check('onBatchPlanClick: plan.poolLoadIncomplete === false im Normalfall',
            normalCase.calls.renderBatchPreview[0].poolLoadIncomplete === false,
            JSON.stringify(normalCase.calls.renderBatchPreview));
    }));
}

// ========== 43. Ticket #56: renderBatchPreview zeigt das poolLoadIncomplete-Banner ==========
{
    const renderFnSrc = extractFunction(src, 'renderBatchPreview');
    check('Funktion renderBatchPreview gefunden (43)', !!renderFnSrc);

    function runRender(plan) {
        const box = { innerHTML: '' };
        const ui = { batchPreview: box, batchRun: { style: {}, disabled: false } };
        const sandbox = {
            ui: ui,
            escapeHtml: (s) => String(s),
            displayName: (p) => '#' + p.id,
            rarityLabel: () => 'Gold'
        };
        const keys = Object.keys(sandbox);
        const fn = new Function(keys.join(','), renderFnSrc + '\nreturn renderBatchPreview;')
            .apply(null, keys.map(function (k) { return sandbox[k]; }));
        fn(plan);
        return box.innerHTML;
    }

    const plan = { planned: 1, requested: 1, rounds: [{ ovr: 84, ovrExact: 84.0, players: [], warnings: [] }] };
    const htmlIncomplete = runRender(Object.assign({}, plan, { poolLoadIncomplete: true }));
    check('renderBatchPreview: Banner erscheint bei poolLoadIncomplete=true',
        /unvollständig geladen/.test(htmlIncomplete), htmlIncomplete);

    const htmlComplete = runRender(Object.assign({}, plan, { poolLoadIncomplete: false }));
    check('renderBatchPreview: KEIN Banner bei poolLoadIncomplete=false',
        !/unvollständig geladen/.test(htmlComplete), htmlComplete);
}

// ========== 44. Ticket #56: readPaletoolsLocks - Pro-Key-Fehler zaehlen statt nur uebersprungen ==========
// Erweitert 8b-6: dort war nur der GESAMT-Loop-Abbruch abgedeckt (scanError),
// nicht der wahrscheinlichere Fall eines einzelnen kaputten Keys (Gap-Report
// Praxisfrage 3). skippedKeys zaehlt JEDEN Fall, reportError() meldet aber
// hoechstens einmal pro Session (STATE.locksSkipReported) - kein Spam bei
// vielen korrupten Keys.
{
    const fnSrc = [
        extractFunction(src, 'looksLikeItemId'),
        extractFunction(src, 'harvestIds'),
        extractFunction(src, 'findLockBranches'),
        extractFunction(src, 'readPaletoolsLocks')
    ].join('\n');

    function makeThrowingLocalStorage(map, throwOnGetItemKey) {
        const keys = Object.keys(map);
        return {
            get length() { return keys.length; },
            key: (i) => keys[i],
            getItem: (k) => {
                if (k === throwOnGetItemKey) throw new Error('SecurityError (simuliert)');
                return k in map ? map[k] : null;
            }
        };
    }

    // (a) Ein Key mit nicht-validem JSON: die uebrigen Locks kommen trotzdem an.
    {
        const map = {
            'paletools:locks:lockedItems': JSON.stringify([100664921, 190871]),
            'paletools:broken:corrupt': 'not-json{{{'
        };
        const localStorage = makeThrowingLocalStorage(map, null);
        const STATE = { diag: {}, locksSkipReported: false };
        const errors = [];
        function reportError(label, e) { errors.push(label + ': ' + (e && e.message)); }
        const mod = new Function('localStorage', 'STATE', 'reportError',
            fnSrc + '\nreturn { readPaletoolsLocks: readPaletoolsLocks };')(localStorage, STATE, reportError);
        const ids = mod.readPaletoolsLocks();
        check('(a) Kaputter Key: uebrige Locks kommen trotzdem an',
            ids.has('100664921') && ids.has('190871'), Array.from(ids).join(','));
        check('(a) Kaputter Key: skippedKeys zaehlt genau 1',
            STATE.diag.locks && STATE.diag.locks.skippedKeys === 1, JSON.stringify(STATE.diag.locks));
        check('(a) Kaputter Key: genau EIN reportError (kein Spam)', errors.length === 1, errors.join(','));
        check('(a) Kaputter Key: scanError bleibt null (kein Gesamt-Loop-Abbruch)',
            STATE.diag.locks && STATE.diag.locks.error === null, JSON.stringify(STATE.diag.locks));
    }

    // (b) Ein Key, dessen getItem() wirft (z.B. SecurityError): dieselbe Zaehlung.
    {
        const map = {
            'paletools:locks:lockedItems': JSON.stringify([100664921, 190871]),
            'paletools:broken:unreadable': JSON.stringify([1])
        };
        const localStorage = makeThrowingLocalStorage(map, 'paletools:broken:unreadable');
        const STATE = { diag: {}, locksSkipReported: false };
        const errors = [];
        function reportError(label, e) { errors.push(label + ': ' + (e && e.message)); }
        const mod = new Function('localStorage', 'STATE', 'reportError',
            fnSrc + '\nreturn { readPaletoolsLocks: readPaletoolsLocks };')(localStorage, STATE, reportError);
        const ids = mod.readPaletoolsLocks();
        check('(b) getItem() wirft: uebrige Locks kommen trotzdem an',
            ids.has('100664921') && ids.has('190871'), Array.from(ids).join(','));
        check('(b) getItem() wirft: skippedKeys zaehlt genau 1',
            STATE.diag.locks && STATE.diag.locks.skippedKeys === 1, JSON.stringify(STATE.diag.locks));
        check('(b) getItem() wirft: genau EIN reportError (kein Spam)', errors.length === 1, errors.join(','));
    }

    // (c) STATE.locksSkipReported bereits true (fruehere Runde derselben Session)
    // -> ein weiterer Skip zaehlt, meldet aber KEIN zusaetzliches reportError.
    {
        const map = {
            'paletools:locks:lockedItems': JSON.stringify([100664921]),
            'paletools:broken:corrupt': 'not-json{{{'
        };
        const localStorage = makeThrowingLocalStorage(map, null);
        const STATE = { diag: {}, locksSkipReported: true };
        const errors = [];
        function reportError(label, e) { errors.push(label + ': ' + (e && e.message)); }
        const mod = new Function('localStorage', 'STATE', 'reportError',
            fnSrc + '\nreturn { readPaletoolsLocks: readPaletoolsLocks };')(localStorage, STATE, reportError);
        mod.readPaletoolsLocks();
        check('(c) Bereits gemeldete Session: skippedKeys zaehlt trotzdem',
            STATE.diag.locks && STATE.diag.locks.skippedKeys === 1, JSON.stringify(STATE.diag.locks));
        check('(c) Bereits gemeldete Session: KEIN weiteres reportError', errors.length === 0, errors.join(','));
    }

    // Regression: der bestehende Gesamt-Loop-Abbruch-Test (8b-6) bleibt
    // unveraendert gruen - skippedKeys/locksSkipReported stehen NEBEN
    // scanError, ersetzen ihn nicht (Edge-Case aus dem Gap-Report).
    check('Regression: scanError-Feld existiert weiterhin neben skippedKeys',
        /error: scanError/.test(src) && /skippedKeys: skippedKeys/.test(src));
}

// ========== 45. Ticket #57: Eligible-Gate in submitChallengeToEa erstmals
// verhaltensgetestet (Gap-Report Iter. 6, Aktion 1) ==========
// Der Mock in Abschnitt 27 haelt isSBCSquadEligible fest auf () => true - der
// "if (eligible === false) throw" -Zweig (:4732-4735) lief in der gesamten
// Suite bisher NIE. Hier wird der echte Abbruch ausgeloest und per Spy auf
// ctrl.submitChallenge belegt, dass er VOR jedem Submit-Aufruf greift.
{
    const fnSrc = extractFunction(src, 'submitChallengeToEa');
    check('Funktion submitChallengeToEa gefunden (45)', !!fnSrc);

    function runWithEligible(eligibleValue, opts) {
        opts = opts || {};
        const STATE = { diag: {
            submitCandidates: null, submitChallengeVia: null,
            submitWithoutResponseCount: 0, submitConfirmations: null
        } };
        let submitCalls = 0;
        const squad = {
            isSBCSquadEligible: () => {
                if (opts.throwOnEligible) throw new Error('boom eligible (simuliert)');
                return eligibleValue;
            },
            isSquadEmpty: () => true
        };
        const ctrl = { _squad: squad, submitChallenge: () => { submitCalls++; return true; } };
        if (opts.noEligibleMethod) delete squad.isSBCSquadEligible;
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
        return fn().then(
            r => ({ ok: true, result: r, submitCalls: submitCalls }),
            e => ({ ok: false, error: e, submitCalls: submitCalls }));
    }

    const results45 = [];
    results45.push(runWithEligible(false).then(r => {
        check('eligible===false: wirft VOR jedem Submit-Aufruf statt still abzugeben',
            !r.ok && /NICHT abgegeben/.test(r.error && r.error.message),
            r.ok ? JSON.stringify(r.result) : (r.error && r.error.message));
        check('eligible===false: ctrl.submitChallenge wurde NIE aufgerufen',
            r.submitCalls === 0, 'submitCalls=' + r.submitCalls);
    }));
    results45.push(runWithEligible(true).then(r => {
        check('Gegenprobe eligible===true: Abgabe laeuft normal weiter (via controller)',
            r.ok && r.result && r.result.via === 'controller' && r.submitCalls === 1,
            r.ok ? (JSON.stringify(r.result) + ' calls=' + r.submitCalls) : (r.error && r.error.message));
    }));
    results45.push(runWithEligible(null, { throwOnEligible: true }).then(r => {
        check('isSBCSquadEligible() wirft beim Lesen: bestehender try/catch faengt das ' +
            '(eligible bleibt null) - weiterhin normale Abgabe, kein Abbruch',
            r.ok && r.result && r.result.via === 'controller' && r.submitCalls === 1,
            r.ok ? (JSON.stringify(r.result) + ' calls=' + r.submitCalls) : (r.error && r.error.message));
    }));
    results45.push(runWithEligible(null, { noEligibleMethod: true }).then(r => {
        check('Squad ohne isSBCSquadEligible()-Methode: Gate wird uebersprungen, normale Abgabe',
            r.ok && r.result && r.result.via === 'controller' && r.submitCalls === 1,
            r.ok ? (JSON.stringify(r.result) + ' calls=' + r.submitCalls) : (r.error && r.error.message));
    }));
    pending.push(Promise.all(results45));
}

// ========== 46. Ticket #57/#60: Brute-Force-Fuzzing MIT Rarity-Vorgabe
// (Gruppe 83, Gap-Report Iter. 6) - FIX verifiziert (reserveRarityWindowAware,
// LEARNINGS 41) ==========
// bruteBest() generalisiert (quotaOk-Parameter, siehe oben) und randomisiert
// gegen Configs MIT rarityConstraints laufen lassen - vorher hatte nur der
// reservierungsfreie Pfad (Test 4) ein Fuzz-Netz.
//
// Die Rarity-Reservierung in solveCore() (rcList-Schleife) probiert fuer
// Vorgaben MIT gesetztem target jetzt - bounded durch
// RARITY_WINDOW_TRIAL_CAP - alle infrage kommenden Kandidaten-Kombinationen
// tatsaechlich per DP durch (reserveRarityWindowAware()) und waehlt die
// Kombination mit dem kleinsten team-weiten V (Tiebreak Kosten), statt wie
// zuvor rein nach den Kosten der Vorgabe-Karte selbst zu sortieren. Der
// Minimal-Repro unten UND die 30x-Fuzz-Schleife pruefen das jetzt gegen die
// korrekte, per Brute-Force verifizierte Erwartung.
{
    const rand = mulberry32(57015701);
    let allMatch = true, detail = '';
    for (let t = 0; t < 30; t++) {
        // Genug Nicht-Gruppe-83-Alternativen (nNormal >= 11 >= k), damit
        // solve() im STRIKTEN Modus bleibt und "genau need" garantiert ist -
        // das lockere Fallback-Verhalten hat schon Test 8b2 als Einzelfall.
        const nNormal = 11 + Math.floor(rand() * 3);
        const nProt = 2 + Math.floor(rand() * 3);
        const need = 1 + Math.floor(rand() * Math.min(3, nProt));
        const pool = [];
        for (let i = 0; i < nNormal; i++) {
            pool.push(P(78 + Math.floor(rand() * 15), { storage: rand() < 0.3, groups: [19] }));
        }
        for (let i = 0; i < nProt; i++) {
            pool.push(P(78 + Math.floor(rand() * 15),
                { special: true, rareflag: 137, groups: [83], storage: rand() < 0.5 }));
        }
        const target = 80 + Math.floor(rand() * 8);
        const c = cfg(target, {
            maxOvershoot: Math.floor(rand() * 4) / 10,
            scarcityWeight: 18, storageBonus: 2,
            ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
            rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: need, groupId: 83 }]
        });
        const res = SolverCore.solve(pool, c);
        const quotaOk = (team) => team.filter(p =>
            Array.isArray(p.groups) && p.groups.indexOf(83) > -1).length === need;
        const bb = bruteBest(pool, c, quotaOk);
        if (bb === null) {
            if (res.ok) { allMatch = false; detail = 't' + t + ': brute (mit Quote ' + need + ') unloesbar, solver ok'; break; }
        } else {
            if (!res.ok) { allMatch = false; detail = 't' + t + ': brute loesbar (vMin=' + bb.vMin + '), solver nicht: ' + res.reason; break; }
            const gotProt = res.players.filter(p => p.groups && p.groups.indexOf(83) > -1).length;
            if (gotProt !== need) {
                allMatch = false; detail = 't' + t + ': solver liefert ' + gotProt + ' geschuetzte Karten statt ' + need; break;
            }
            const obj = solverObjective(res, pool, c, bb.vMin);
            if (Math.abs(obj - bb.bestObj) > 1e-6) {
                allMatch = false; detail = 't' + t + ': brute=' + bb.bestObj + ' solver=' + obj; break;
            }
            if (SolverCore.squadRating(res.players.map(p => p.rating)) < target) {
                allMatch = false; detail = 't' + t + ': Team erreicht Ziel nicht!'; break;
            }
        }
    }
    // Regel-Hierarchie aus CLAUDE.md: das "Max. Rating-Ueberschuss"-Fenster hat
    // Vorrang - Kosten entscheiden NUR innerhalb davon, "kein Rating
    // verschenken". Minimal-Repro (4 Slots, maxOvershoot 0): eine guenstigere,
    // aber HOEHER geratete Storage-Vorgabe-Karte (X, 91) UND eine teurere,
    // aber ZIELGENAUE Vereins-Karte (Y, 84) erfuellen beide dieselbe
    // Gruppe-83-Vorgabe - nur Y erreicht mit dem Rest des Pools 84.00 (waste 0)
    // exakt im Fenster.
    const minRepro = (function () {
        const X = P(91, { special: true, rareflag: 137, groups: [83], storage: true });
        const Y = P(84, { special: true, rareflag: 137, groups: [83], storage: false });
        const extra91 = P(91, { groups: [19] });
        const gold84 = many(3, 84, { groups: [19] });
        const pool = [X, Y, extra91].concat(gold84);
        const c = cfg(84, {
            slots: 4, maxOvershoot: 0,
            scarcityWeight: 18, storageBonus: 2,
            ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
            rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
        });
        return SolverCore.solve(pool, c);
    })();
    check('FIX verifiziert (war: bekannter Befund #57): Minimal-Repro (4 Slots, ' +
        'maxOvershoot 0, 1x Gruppe-83-Vorgabe) waehlt die zielgenaue Vereins-Karte Y ' +
        '(84) statt der guenstigeren, aber hoeher geraten Storage-Karte X (91) und ' +
        'erreicht ovrExact 84.00 (waste 0) - 30x-Fuzzing (Seed 57015701) findet KEINE ' +
        'Abweichung mehr (allMatch)',
        minRepro.ok && minRepro.ovrExact === 84 && minRepro.waste === 0 && allMatch,
        'minRepro.ok=' + minRepro.ok + ' ovrExact=' + (minRepro.ok && minRepro.ovrExact) +
        ' waste=' + (minRepro.ok && minRepro.waste) + ' fuzzDetail=' + detail);
}

// ========== 47. Ticket #57: Brute-Force-Fuzzing MIT Bronze/Silber-Quoten
// (Gap-Report Iter. 6, Aktion 3) ==========
// Explizite Zaehlungen, die sich schon zu N summieren (kein EA-Anzahl-
// Quirk hier - der ist per 8b-2d bereits deterministisch abgedeckt): reine
// Fuzz-Pruefung, dass die guenstigste Kombination pro Stufe wirklich
// gewaehlt wird (Rangfolge: Storage vor Verein, dann Rating, dann Kosten).
{
    const rand = mulberry32(830210);
    let allMatch = true, detail = '';
    for (let t = 0; t < 30; t++) {
        const N = 5 + Math.floor(rand() * 4); // 5..8 Slots, brute-force-tauglich
        const count1 = 1 + Math.floor(rand() * (N - 1)); // Bronze, 1..N-1
        const count2 = N - count1; // Silber, Rest
        const nBronze = count1 + 2 + Math.floor(rand() * 3); // Ueberschuss an Auswahl
        const nSilver = count2 + 2 + Math.floor(rand() * 3);
        const pool = [];
        for (let i = 0; i < nBronze; i++) {
            pool.push(P(30 + Math.floor(rand() * 35), { storage: rand() < 0.3, untradeable: rand() < 0.3 }));
        }
        for (let i = 0; i < nSilver; i++) {
            pool.push(P(65 + Math.floor(rand() * 10), { storage: rand() < 0.3, untradeable: rand() < 0.3 }));
        }
        const c = cfg(null, {
            targetOVR: null, slots: N, minRating: 0,
            qualityConstraints: [
                { label: 'PLAYER_LEVEL', quality: 1, count: count1 },
                { label: 'PLAYER_LEVEL', quality: 2, count: count2 }
            ],
            ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC
        });
        const res = SolverCore.solve(pool, c);
        const quotaOk = (team) => {
            const bronze = team.filter(p => p.rating <= 64).length;
            const silver = team.filter(p => p.rating >= 65 && p.rating <= 74).length;
            return bronze === count1 && silver === count2 && bronze + silver === N;
        };
        const costOf = SolverCore.makeCostOf(pool, c);
        const cardKey = (p) => [p.isStorage ? 0 : 1, p.rating, costOf(p)];
        const bb = bruteBestQuota(pool, N, quotaOk, cardKey);
        if (bb === null) {
            if (res.ok) { allMatch = false; detail = 't' + t + ': brute (Bronze ' + count1 + '/Silber ' + count2 + ') unloesbar, solver ok'; break; }
        } else {
            if (!res.ok) { allMatch = false; detail = 't' + t + ': brute loesbar, solver nicht: ' + res.reason; break; }
            if (!quotaOk(res.players)) {
                allMatch = false; detail = 't' + t + ': Solver-Team erfuellt die Quote nicht (' +
                    res.players.map(p => p.rating).join(',') + ')'; break;
            }
            const solverKeys = res.players.map(cardKey).sort(cmpKeyTuple);
            let sameQuality = solverKeys.length === bb.keys.length;
            if (sameQuality) {
                for (let i = 0; i < solverKeys.length; i++) {
                    if (cmpKeyTuple(solverKeys[i], bb.keys[i]) !== 0) { sameQuality = false; break; }
                }
            }
            if (!sameQuality) {
                allMatch = false;
                detail = 't' + t + ': solver=' + JSON.stringify(solverKeys) + ' brute=' + JSON.stringify(bb.keys);
                break;
            }
        }
    }
    check('30x Brute-Force-Paritaet MIT Bronze/Silber-Quoten (randomisierte Aufteilung)',
        allMatch, detail);
}

// ========== 48. Ticket #57: planBatch Mehrrunden-Fuzzing gegen unabhaengige
// Brute-Force-Referenz (Gap-Report Iter. 6, Aktion 3 - "eine Ebene hoeher") ==========
// Verifiziert PRO RUNDE Optimalitaet (wie Test 4/46) UND dass die naechste
// Runde tatsaechlich auf dem um die VORHERIGEN Spieler reduzierten
// Original-Pool rechnet - unabhaengig von planBatch()s eigener usedIds-
// Buchhaltung nachvollzogen, nicht einfach uebernommen.
{
    const rand = mulberry32(9182736);
    let allMatch = true, detail = '';
    for (let t = 0; t < 15; t++) {
        const n = 14 + Math.floor(rand() * 4); // 14..17 - reicht fuer 2 Runden a 6 Slots
        const pool = [];
        for (let i = 0; i < n; i++) {
            pool.push(P(75 + Math.floor(rand() * 14), { storage: rand() < 0.3 }));
        }
        const target = 76 + Math.floor(rand() * 6);
        const c = cfg(target, {
            slots: 6,
            maxOvershoot: Math.floor(rand() * 4) / 10,
            scarcityWeight: 18, storageBonus: 2,
            ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC
        });
        const rounds = 2;
        const b = SolverCore.planBatch(pool, c, rounds);

        let remaining = pool;
        let refRoundIdx = 0;
        for (; refRoundIdx < rounds; refRoundIdx++) {
            const bb = bruteBest(remaining, c);
            const round = b.rounds[refRoundIdx];
            if (bb === null) {
                if (round) { allMatch = false; detail = 't' + t + ' Runde ' + refRoundIdx + ': brute unloesbar, planBatch lieferte trotzdem'; }
                break;
            }
            if (!round) {
                allMatch = false; detail = 't' + t + ' Runde ' + refRoundIdx + ': brute loesbar (vMin=' + bb.vMin + '), planBatch stoppte: ' + b.stoppedReason;
                break;
            }
            const obj = solverObjective(round, remaining, c, bb.vMin);
            if (Math.abs(obj - bb.bestObj) > 1e-6) {
                allMatch = false; detail = 't' + t + ' Runde ' + refRoundIdx + ': brute=' + bb.bestObj + ' solver=' + obj;
                break;
            }
            // Naechste Runde: Referenz-Pool aus dem ORIGINAL-Pool neu gefiltert,
            // nicht planBatch()s eigenes usedIds uebernommen.
            const usedHere = new Set(round.players.map(p => p.id));
            remaining = remaining.filter(p => !usedHere.has(p.id));
        }
        if (!allMatch) break;
    }
    check('15x planBatch-Mehrrunden-Fuzzing: jede Runde brute-force-optimal, ' +
        'Pool-Verbrauch ueber Runden korrekt nachvollzogen', allMatch, detail);
}

// ========== 49. v4.58.0: Scan-Budget parametrisierbar + Anforderungs-Aeste zuerst ==========
// Live-Fall (Gold-Challenge, Set 1337): der Challenge-Knoten enthielt so viel
// Belohnungs-Metadaten (Kit-Namen, Player-Picks), dass das 20000er-Budget im
// Belohnungs-Ast erschoepft war, BEVOR die Gold-Anforderung erreicht wurde -
// Ergebnis: keinerlei Vorgaben erkannt. Zwei Gegenmassnahmen: (a) Schluessel,
// die nach Anforderungen aussehen (req/elig/constraint), werden VOR allem
// anderen gescannt; (b) JSON-Aufrufer duerfen ein hoeheres Budget mitgeben.
{
    const scanBlock = extractMarkerBlock(src, '// [SBCSCAN-BEGIN]', '// [SBCSCAN-END]');
    check('SBCSCAN-Marker-Block gefunden (49)', !!scanBlock);
    const deepScanChallenge = new Function(scanBlock + '\nreturn deepScanChallenge;')();

    // Nachbau des Live-Falls: breiter Belohnungs-Ast VOR dem Anforderungs-Ast
    // (Schluessel-Reihenfolge wie im Objekt-Literal), Anforderung unter elgReq.
    function bigAwards(n) {
        const arr = [];
        for (let i = 0; i < n; i++) arr.push({ kitName: 'KIT ' + i });
        return arr;
    }
    const root = {
        awards: bigAwards(500),
        elgReq: [{ scope: 'TEAM_RATING', value: 84 }]
    };

    // (a) Priorisierung: mit Mini-Budget 50 waere der awards-Ast allein schon
    // groesser - OHNE die unshift-Priorisierung bliebe target null (der
    // Anforderungs-Knoten stuende hinter 500 Kit-Knoten in der Queue).
    const small = deepScanChallenge(root, 50);
    check('Anforderungs-Ast (elgReq) wird trotz Mini-Budget VOR dem Belohnungs-Ast gefunden',
        small.target === 84, JSON.stringify({ target: small.target, visited: small.visitedCount }));
    check('Mini-Budget wird als budgetExhausted markiert (Queue nicht leer)',
        small.budgetExhausted === true);

    // (b) Budget-Parameter: ohne Argument gilt der Default - 502 Knoten liegen
    // weit darunter, alles wird gescannt, kein Exhaust-Flag.
    const dflt = deepScanChallenge(root);
    check('Default-Budget scannt denselben Baum vollstaendig (kein budgetExhausted)',
        dflt.budgetExhausted === false && dflt.target === 84);

    // Ergebnis-Neutralitaet der Priorisierung: bei ausreichendem Budget ist der
    // Fund identisch, egal ob die Anforderung frueh oder spaet drankommt.
    check('Priorisierung aendert das Ergebnis bei ausreichendem Budget nicht',
        dflt.target === small.target);
}

// ========== 50. Ticket #60: reserveRarityWindowAware() - Cap-Fallback,
// need>1 und Storage-Praeferenz gezielt konstruiert (LEARNINGS 41) ==========
// Ergaenzt Section 46 (Fuzzing) um gezielt konstruierte Einzelfaelle, deren
// Erwartungswerte per Brute-Force bzw. per SolverCore.makeCostOf() (SSOT,
// nicht aus dem Kopf) hergeleitet sind.

// (a) Kombinatorik-Schranke: 25 distinct-rating Gruppe-83-Kandidaten,
// need=3 -> C(25+3-1,3)=C(27,3)=2925 reisst RARITY_WINDOW_TRIAL_CAP (200)
// sicher. Erwartet: Ergebnis identisch mit dem UNVERAENDERTEN Kosten-Greedy
// (kein zweiter Fehlerpfad, additiver Fallback) UND die neue Warnung.
{
    const pool = [];
    for (let r = 60; r <= 84; r++) pool.push(P(r, { special: true, rareflag: 137, groups: [83] }));
    for (let i = 0; i < 15; i++) pool.push(P(90, { groups: [19] }));
    const c = cfg(84, {
        slots: 11, maxOvershoot: 3.0,
        scarcityWeight: 18, storageBonus: 2,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 3, groupId: 83 }]
    });
    const res = SolverCore.solve(pool, c);
    const costOf = SolverCore.makeCostOf(pool, c);
    const protectedCands = pool.filter(p => p.groups && p.groups.indexOf(83) > -1);
    // Der heutige (unveraenderte) Kosten-Greedy-Sortier-Ausdruck aus der
    // rcList-Schleife: Kosten aufsteigend, Rating als Tiebreak.
    const expectedIds = protectedCands.slice()
        .sort((a, b) => (costOf(a) - costOf(b)) || (a.rating - b.rating))
        .slice(0, 3).map(p => p.id).sort((a, b) => a - b);
    check('Ticket #60: Cap-Ueberschreitung (2925 Kombinationen > Cap 200) faellt ' +
        'auf den heutigen, unveraenderten Kosten-Greedy zurueck',
        res.ok && JSON.stringify(res.players.filter(p => p.groups && p.groups.indexOf(83) > -1)
            .map(p => p.id).sort((a, b) => a - b)) === JSON.stringify(expectedIds),
        res.ok ? ('picks=' + JSON.stringify(res.players.filter(p => p.groups && p.groups.indexOf(83) > -1).map(p => p.id))
            + ' expected=' + JSON.stringify(expectedIds)) : res.reason);
    check('Ticket #60: Cap-Ueberschreitung meldet die neue Fallback-Warnung',
        res.ok && (res.warnings || []).some(w => /Fensterbewusste Vorgaben-Wahl uebersprungen/.test(w)),
        JSON.stringify(res.warnings));
}

// (b) need>1 (2 von 4 Gruppe-83-Kandidaten): eine guenstige, aber zu hoch
// geratete Storage-Karte (A, 90) darf NICHT vor den beiden zielgenaueren,
// aber teureren Vereins-Karten (B 84, C 85) gewaehlt werden, wenn das
// Fenster (maxOvershoot 0) das nicht zulaesst - brute-force-verifiziert.
{
    const A = P(90, { special: true, rareflag: 137, groups: [83], storage: true });
    const B = P(84, { special: true, rareflag: 137, groups: [83], storage: false });
    const C = P(85, { special: true, rareflag: 137, groups: [83], storage: false });
    const D = P(88, { special: true, rareflag: 137, groups: [83], storage: true });
    const gold84 = many(4, 84, { groups: [19] });
    const pool = [A, B, C, D].concat(gold84);
    const c = cfg(84, {
        slots: 6, maxOvershoot: 0,
        scarcityWeight: 18, storageBonus: 2,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 2, groupId: 83 }]
    });
    const res = SolverCore.solve(pool, c);
    const quotaOk = (team) => team.filter(p => Array.isArray(p.groups) && p.groups.indexOf(83) > -1).length === 2;
    const bb = bruteBest(pool, c, quotaOk);
    check('Ticket #60: need=2 - brute-force-optimale Kombination (B+C statt A) ' +
        'exakt getroffen',
        res.ok && bb !== null && Math.abs(solverObjective(res, pool, c, bb.vMin) - bb.bestObj) < 1e-6,
        res.ok ? ('solver=' + solverObjective(res, pool, c, bb.vMin) + ' brute=' + (bb && bb.bestObj)) : res.reason);
}

// (c) Storage-Praeferenz INNERHALB des Fensters: eine Storage-Karte (88)
// UND eine Vereins-Karte (87, naeher am Ziel 84) sind beide fensterkonform
// (maxOvershoot 1.0) - die guenstigere Storage-Karte muss gewinnen, obwohl
// die Vereins-Karte das kleinere V liefern wuerde (Regel-Hierarchie:
// Fenster zuerst, dann Kosten - CLAUDE.md "Storage vor Verein").
{
    const storageCard = P(88, { special: true, rareflag: 137, groups: [83], storage: true });
    const clubCard = P(87, { special: true, rareflag: 137, groups: [83], storage: false });
    const gold84 = many(3, 84, { groups: [19] });
    const pool = [storageCard, clubCard].concat(gold84);
    const c = cfg(84, {
        slots: 4, maxOvershoot: 1.0,
        scarcityWeight: 18, storageBonus: 2,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    });
    const res = SolverCore.solve(pool, c);
    const quotaOk = (team) => team.filter(p => Array.isArray(p.groups) && p.groups.indexOf(83) > -1).length === 1;
    const bb = bruteBest(pool, c, quotaOk);
    check('Ticket #60: Storage-Karte (88) gewinnt innerhalb des Fensters gegen ' +
        'die naeher am Ziel liegende, aber teurere Vereins-Karte (87)',
        res.ok && bb !== null && Math.abs(solverObjective(res, pool, c, bb.vMin) - bb.bestObj) < 1e-6 &&
        res.players.some(p => p.groups && p.groups.indexOf(83) > -1 && p.isStorage),
        res.ok ? ('solver=' + solverObjective(res, pool, c, bb.vMin) + ' brute=' + (bb && bb.bestObj) +
            ' gotStorage=' + res.players.some(p => p.groups && p.groups.indexOf(83) > -1 && p.isStorage)) : res.reason);
}

// (d) Gegenprobe OHNE target: reserveRarityWindowAware() greift laut Code nur
// bei gesetztem target (`if (target && have < needCount)`) - ohne target
// bleibt die rcList-Schleife exakt beim bisherigen, hier NICHT geaenderten
// Kosten-Sortier-Ausdruck (derselbe Vergleichs-Ausdruck wie im Cap-Fallback
// oben). Dasselbe storage/club-Paar wie (c), aber ohne Ziel-OVR: die
// Auswahl folgt weiterhin reinem Kosten-Vergleich, unabhaengig vom
// Rating-Abstand zu irgendeinem Ziel (das es hier gar nicht gibt).
{
    const storageCard = P(88, { special: true, rareflag: 137, groups: [83], storage: true });
    const clubCard = P(87, { special: true, rareflag: 137, groups: [83], storage: false });
    const gold84 = many(3, 84, { groups: [19] });
    const pool = [storageCard, clubCard].concat(gold84);
    const c = cfg(null, {
        slots: 4, targetOVR: null,
        qualityConstraints: [{ label: 'PLAYER_LEVEL', quality: 3, count: 4 }],
        scarcityWeight: 18, storageBonus: 2,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 1, groupId: 83 }]
    });
    const res = SolverCore.solve(pool, c);
    const costOf = SolverCore.makeCostOf(pool, c);
    const cands = [storageCard, clubCard];
    const expected = cands.slice().sort((a, b) => (costOf(a) - costOf(b)) || (a.rating - b.rating))[0];
    check('Ticket #60 Gegenprobe (ohne target): rcList-Auswahl bleibt der ' +
        'unveraenderte Kosten-Sortier-Ausdruck (kein Fensterbewusster Pfad)',
        res.ok && res.players.some(p => p.id === expected.id),
        res.ok ? ('picks=' + res.players.filter(p => p.groups).map(p => p.id) + ' expected=' + expected.id) : res.reason);
}

// ========== 51. v4.60.0: Set-Challenges pro Set gekeyt + aktives Nachladen der elgReq-Quelle ==========
// Live-Fall (84+ TOTW, Report v4.58.0): lastSetChallenges hielt die Antwort
// eines ANDEREN Sets, der Knoten-Scan lief auf einem Stub und fand die
// TOTW-Vorgabe nie. Fix: (a) Cache pro setId, (b) applyFromSetChallenges
// bevorzugt den Pro-Set-Eintrag, (c) onRunClick laedt die Set-Challenges
// aktiv nach, wenn die Vorgaben leer/abgeschnitten aussehen.
{
    // (a) handleResponseBody keyt pro setId und kappt bei 5 (FIFO).
    const urlClsBlock51 = extractMarkerBlock(src, '// [URLCLS-BEGIN]', '// [URLCLS-END]');
    check('URLCLS-Block gefunden (51)', !!urlClsBlock51);
    function makeHandle51(STATE) {
        return new Function('STATE', 'reportError', 'applyFromSetChallenges',
            'parseSbcChallenge', 'harvestItems',
            urlClsBlock51 + '\nreturn handleResponseBody;')(
            STATE, () => {}, () => {}, () => {}, () => {});
    }
    {
        const STATE = { sbc: {}, diag: {}, lastSetChallenges: null,
            lastChallengeRaw: null, setChallengesBySet: {} };
        const handle = makeHandle51(STATE);
        const base = 'https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/sbs/setId/';
        handle(base + '1017/challenges', JSON.stringify({ marker: 'set1017' }));
        handle(base + '1356/challenges', JSON.stringify({ marker: 'set1356' }));
        check('Set-Challenges werden PRO setId gecacht (beide Sets nebeneinander)',
            STATE.setChallengesBySet[1017] && STATE.setChallengesBySet[1017].marker === 'set1017' &&
            STATE.setChallengesBySet[1356] && STATE.setChallengesBySet[1356].marker === 'set1356',
            JSON.stringify(Object.keys(STATE.setChallengesBySet)));
        check('lastSetChallenges zeigt weiter auf die letzte Antwort (Kompatibilitaet)',
            STATE.lastSetChallenges && STATE.lastSetChallenges.marker === 'set1356');
        for (let i = 0; i < 6; i++) handle(base + (2000 + i) + '/challenges', JSON.stringify({ n: i }));
        check('Pro-Set-Cache ist bei 5 Eintraegen gekappt (FIFO)',
            Object.keys(STATE.setChallengesBySet).length <= 5,
            JSON.stringify(Object.keys(STATE.setChallengesBySet)));
    }
    // (b) applyFromSetChallenges bevorzugt den Pro-Set-Eintrag vor dem
    // (moeglicherweise fremden) lastSetChallenges.
    {
        const applySrc = extractFunction(src, 'applyFromSetChallenges');
        check('Funktion applyFromSetChallenges gefunden (51)', !!applySrc);
        const seen = { firstArg: null };
        const STATE = {
            sbc: { setId: 1017, challengeId: 3026 },
            diag: {},
            lastSetChallenges: { marker: 'fremdesSet' },
            setChallengesBySet: { 1017: { marker: 'richtigesSet' } }
        };
        const apply = new Function('STATE', 'findChallengeNode', 'deepScanChallenge',
            'recordDeepScanStats', 'applyScan',
            applySrc + '\nreturn applyFromSetChallenges;')(
            STATE,
            (root) => { seen.firstArg = root; return null; },
            () => ({}), () => {}, () => {});
        apply();
        check('applyFromSetChallenges sucht im Pro-Set-Eintrag, nicht im fremden lastSetChallenges',
            seen.firstArg && seen.firstArg.marker === 'richtigesSet',
            JSON.stringify(seen.firstArg));
        seen.firstArg = null;
        STATE.setChallengesBySet = {};
        apply();
        check('Fallback auf lastSetChallenges bleibt erhalten (kein Pro-Set-Eintrag)',
            seen.firstArg && seen.firstArg.marker === 'fremdesSet');
    }
    // (c) onRunClick laedt aktiv nach, wenn die Vorgaben leer sind - und
    // arbeitet mit dem Ergebnis weiter (kein blinder Abbruch mehr).
    {
        const runFnSrc51 = extractFunction(src, 'onRunClick');
        function makeSandbox51(ensureImpl) {
            const calls = { toast: [], solve: 0, submit: 0, ensure: 0 };
            const STATE = {
                loading: false, loadIncomplete: false,
                pool: [{ rating: 84 }],
                setChallengesBySet: {},
                sbc: { targetOVR: null, playerLevelConstraints: [], rarityConstraints: [],
                       qualityConstraints: [], rareConstraints: [], setId: 1017 }
            };
            const ui = { run: { disabled: false } };
            const sandbox = {
                STATE: STATE, ui: ui,
                syncSbcWithOpenChallenge: () => {},
                toast: (msg, kind) => { calls.toast.push({ msg: msg, kind: kind }); },
                setStatus: () => {},
                readConfig: () => ({}),
                SolverCore: { solve: () => { calls.solve++; return { ok: true, ovr: 84, players: [] }; } },
                renderResult: () => {},
                submitCurrentResult: () => { calls.submit++; return Promise.resolve(); },
                reportError: () => {},
                anyDeepScanTruncated: () => false,
                ensureSetChallenges: () => { calls.ensure++; return Promise.resolve(ensureImpl(STATE)); }
            };
            const keys = Object.keys(sandbox);
            const fn = new Function(keys.join(','), runFnSrc51 + '\nreturn onRunClick;')
                .apply(null, keys.map(function (k) { return sandbox[k]; }));
            return { fn: fn, calls: calls };
        }
        const okCase = makeSandbox51((STATE) => { STATE.sbc.targetOVR = 84; return true; });
        pending.push(okCase.fn().then(function () {
            check('onRunClick: leere Vorgaben -> ensureSetChallenges wird gerufen',
                okCase.calls.ensure === 1);
            check('onRunClick: nachgeladene Vorgabe wird genutzt (solve laeuft)',
                okCase.calls.solve === 1, JSON.stringify(okCase.calls));
        }));
        const failCase = makeSandbox51(() => false);
        pending.push(failCase.fn().then(function () {
            check('onRunClick: bleibt alles leer, greift weiter der Abbruch mit Meldung',
                failCase.calls.solve === 0 && failCase.calls.toast.length === 1,
                JSON.stringify(failCase.calls));
        }));
    }
}

// ========== 52. Ticket #62/#64: Brute-Force-Fuzzing MIT Spieler-Level-Vorgabe
// (playerLevelConstraints) - FIX verifiziert (reserveWindowAware(), LEARNINGS
// 41) ==========
// Die Spieler-Level-Reservierung in solveCore() (plList-Schleife) probiert
// fuer Vorgaben MIT gesetztem target jetzt - wie die Rarity-Reservierung
// (Ticket #57/#60) - alle infrage kommenden Kandidaten-Kombinationen per DP
// durch (reserveWindowAware(), generalisiert aus dem Rarity-Pfad) und waehlt
// die Kombination mit dem kleinsten team-weiten V (Tiebreak Kosten), statt
// wie zuvor rein nach den Kosten der Vorgabe-Karte selbst zu sortieren. Analog
// zu Section 46 (Rarity) generalisiert bruteBest() gegen Configs MIT
// playerLevelConstraints - anders als bei der Rarity-Gruppe ist die Quote hier
// ein "mindestens", quotaOk prueft daher ">=" statt "===".
{
    const rand = mulberry32(62006200);
    let allMatch = true, detail = '';
    for (let t = 0; t < 30; t++) {
        // Genug Fuellkarten (nNormal >= 11 >= max. Slots), damit der Solver
        // nicht aus Mangel an Alternativen auf die Vorgabe-Kandidaten
        // zurueckgreifen muss - wie in Section 46.
        const nNormal = 11 + Math.floor(rand() * 3);
        const nHigh = 2 + Math.floor(rand() * 3);
        const minRatingC = 83 + Math.floor(rand() * 6); // 83..88
        const need = 1 + Math.floor(rand() * Math.min(3, nHigh));
        const pool = [];
        for (let i = 0; i < nNormal; i++) {
            pool.push(P(70 + Math.floor(rand() * Math.max(1, minRatingC - 70)), { storage: rand() < 0.3 }));
        }
        for (let i = 0; i < nHigh; i++) {
            pool.push(P(minRatingC + Math.floor(rand() * 10), { storage: rand() < 0.5 }));
        }
        const target = 78 + Math.floor(rand() * 8);
        const c = cfg(target, {
            maxOvershoot: Math.floor(rand() * 4) / 10,
            scarcityWeight: 18, storageBonus: 2,
            ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
            playerLevelConstraints: [{ label: 'PLAYER_RATING', minRating: minRatingC, count: need }]
        });
        const res = SolverCore.solve(pool, c);
        const quotaOk = (team) => team.filter(p => p.rating >= minRatingC).length >= need;
        const bb = bruteBest(pool, c, quotaOk);
        if (bb === null) {
            if (res.ok) { allMatch = false; detail = 't' + t + ': brute (mind. ' + need + 'x ' + minRatingC + '+) unloesbar, solver ok'; break; }
        } else {
            if (!res.ok) { allMatch = false; detail = 't' + t + ': brute loesbar (vMin=' + bb.vMin + '), solver nicht: ' + res.reason; break; }
            const gotHigh = res.players.filter(p => p.rating >= minRatingC).length;
            if (gotHigh < need) {
                allMatch = false; detail = 't' + t + ': solver liefert ' + gotHigh + ' Karten >= ' + minRatingC + ' statt mind. ' + need; break;
            }
            const obj = solverObjective(res, pool, c, bb.vMin);
            if (Math.abs(obj - bb.bestObj) > 1e-6) {
                allMatch = false; detail = 't' + t + ': brute=' + bb.bestObj + ' solver=' + obj; break;
            }
            if (SolverCore.squadRating(res.players.map(p => p.rating)) < target) {
                allMatch = false; detail = 't' + t + ': Team erreicht Ziel nicht!'; break;
            }
        }
    }
    // Regel-Hierarchie aus CLAUDE.md: das "Max. Rating-Ueberschuss"-Fenster hat
    // Vorrang - Kosten entscheiden NUR innerhalb davon, "kein Rating
    // verschenken". Minimal-Repro (4 Slots, maxOvershoot 0, "mind. 1x 88+"):
    // eine guenstigere, aber zu hoch geratete Storage-Karte (B, 93, Kosten 13)
    // und eine teurere, aber ZIELGENAUE Vereins-Karte (A, 92, Kosten 22)
    // erfuellen beide dieselbe Spieler-Level-Vorgabe - nur A erreicht mit dem
    // Rest des Pools ovrExact 84.13 (waste 6.13) statt 84.56 (waste 6.56).
    // Vor dem Fix (Ticket #62, dreifach verifiziert: bruteBest() oben,
    // eine zweite, unabhaengig implementierte Bitmask-Enumeration auf
    // demselben t2-Pool und eine vollstaendige manuelle Auflistung aller
    // C(6,4)=15 Kombinationen des Minimal-Repros) waehlte die plList-Schleife
    // ausschliesslich nach costOf() und lieferte 84.56/6.56 statt 84.13/6.13.
    const minRepro = (function () {
        const A = P(92, {});                 // Vereins-Karte, teurer, aber fenster-optimal
        const B = P(93, { storage: true });  // Storage-Karte, guenstiger, aber Ueberschuss
        const fillers = many(4, 78, {});
        const pool = [A, B].concat(fillers);
        const c = cfg(78, {
            slots: 4, maxOvershoot: 0,
            scarcityWeight: 18, storageBonus: 2,
            ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
            playerLevelConstraints: [{ label: 'PLAYER_RATING', minRating: 88, count: 1 }]
        });
        return SolverCore.solve(pool, c);
    })();
    check('FIX verifiziert (war: bekannter Befund #62): Minimal-Repro (4 Slots, ' +
        'maxOvershoot 0, "mind. 1x 88+") waehlt die zielgenaue Vereins-Karte A (92) ' +
        'statt der guenstigeren, aber hoeher geraten Storage-Karte B (93) und erreicht ' +
        'ovrExact 84.13 (waste 6.13) - 30x-Fuzzing (Seed 62006200) findet KEINE Abweichung ' +
        'mehr (allMatch)',
        minRepro.ok && minRepro.ovrExact === 84.13 && minRepro.waste === 6.13 && allMatch,
        'minRepro.ok=' + minRepro.ok + ' ovrExact=' + (minRepro.ok && minRepro.ovrExact) +
        ' waste=' + (minRepro.ok && minRepro.waste) + ' fuzzDetail=' + detail);
}

// ========== 53. Ticket #64: reserveWindowAware() generalisiert auf
// Spieler-Level-Vorgaben - Cap-Fallback, Gegenprobe und kombinierter
// Rarity+Spieler-Level-Fuzz (LEARNINGS 41) ==========

// (a) Kombinatorik-Schranke im Spieler-Level-Pfad: 40 distinct-rating
// Kandidaten (60..99, 1 Karte je Rating), need=3 -> C(40,3)=9880 reisst
// RARITY_WINDOW_TRIAL_CAP (200) sicher. Erwartet: dieselben drei Karten wie
// der heutige, unveraenderte Kosten-Greedy (additiver Fallback, kein
// zweiter Fehlerpfad) UND die (mit dem Rarity-Pfad geteilte) Cap-Warnung.
{
    const pool = [];
    for (let r = 60; r <= 99; r++) pool.push(P(r, {}));
    const c = cfg(84, {
        slots: 11, maxOvershoot: 3.0,
        scarcityWeight: 18, storageBonus: 2,
        ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
        playerLevelConstraints: [{ label: 'PLAYER_RATING', minRating: 60, count: 3 }]
    });
    const res = SolverCore.solve(pool, c);
    const costOf = SolverCore.makeCostOf(pool, c);
    // Der heutige (unveraenderte) Kosten-Greedy-Sortier-Ausdruck aus der
    // plList-Schleife: Kosten aufsteigend, Rating als Tiebreak.
    const expectedIds = pool.filter(p => p.rating >= 60).slice()
        .sort((a, b) => (costOf(a) - costOf(b)) || (a.rating - b.rating))
        .slice(0, 3).map(p => p.id).sort((a, b) => a - b);
    check('Ticket #64: Cap-Ueberschreitung im Spieler-Level-Pfad (40 Kandidaten, ' +
        'C(40,3)=9880 > Cap 200) reserviert dieselben drei Karten wie der heutige, ' +
        'unveraenderte Kosten-Greedy',
        res.ok && expectedIds.every(id => res.players.some(p => p.id === id)),
        res.ok ? ('teamIds=' + JSON.stringify(res.players.map(p => p.id)) +
            ' expected=' + JSON.stringify(expectedIds)) : res.reason);
    check('Ticket #64: Cap-Ueberschreitung im Spieler-Level-Pfad meldet dieselbe ' +
        '(mit dem Rarity-Pfad geteilte) Fallback-Warnung',
        res.ok && (res.warnings || []).some(w => /Fensterbewusste Vorgaben-Wahl uebersprungen/.test(w)),
        JSON.stringify(res.warnings));
}

// (b) Gegenprobe ohne playerLevelConstraints: das Verschieben von
// cmp/NEED/windowV/searchTeam()/reserveWindowAware() vor die Spieler-Level-
// Schleife (Ticket #64) darf den reservierungsfreien UND den Rarity-only-Pfad
// nicht veraendern - 30x-Fuzzing ohne jede playerLevelConstraint gegen
// dieselbe Brute-Force-Referenz wie Test 4/46, nur mit einem frischen Seed.
{
    const rand = mulberry32(64106410);
    let allMatch = true, detail = '';
    for (let t = 0; t < 30; t++) {
        const n = 12 + Math.floor(rand() * 4);
        const pool = [];
        for (let i = 0; i < n; i++) {
            pool.push(P(75 + Math.floor(rand() * 14), { storage: rand() < 0.3 }));
        }
        const target = 76 + Math.floor(rand() * 6);
        const c = cfg(target, {
            slots: 6,
            maxOvershoot: Math.floor(rand() * 4) / 10,
            scarcityWeight: 18, storageBonus: 2,
            ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC
            // playerLevelConstraints bleibt der cfg()-Default: []
        });
        const res = SolverCore.solve(pool, c);
        const bb = bruteBest(pool, c);
        if (bb === null) {
            if (res.ok) { allMatch = false; detail = 't' + t + ': brute unloesbar, solver ok'; break; }
        } else {
            if (!res.ok) { allMatch = false; detail = 't' + t + ': brute loesbar (vMin=' + bb.vMin + '), solver nicht: ' + res.reason; break; }
            const obj = solverObjective(res, pool, c, bb.vMin);
            if (Math.abs(obj - bb.bestObj) > 1e-6) {
                allMatch = false; detail = 't' + t + ': brute=' + bb.bestObj + ' solver=' + obj; break;
            }
        }
    }
    check('Ticket #64 Gegenprobe: ohne playerLevelConstraints byte-gleiches ' +
        'Verhalten (30x Brute-Force-Paritaet, kein Spieler-Level-Pfad beteiligt)',
        allMatch, detail);
}

// (c) Kombinierter Fuzz: Rarity- UND Spieler-Level-Vorgabe GLEICHZEITIG in
// derselben SBC - reserveWindowAware() laeuft sequenziell fuer BEIDE
// Vorgaben-Arten (erst Spieler-Level, dann Rarity, siehe solveCore()) auf
// demselben, sich veraendernden reserved-Zustand. quotaOk prueft beide
// Quoten gemeinsam gegen die unabhaengige Brute-Force-Referenz (bruteBest).
// Die Rarity-Kandidaten bleiben bewusst STRIKT unter minRatingC (disjunkt von
// den Spieler-Level-Kandidaten): eine Karte, die ZUFAELLIG beide Vorgaben
// gleichzeitig erfuellen koennte, deckt eine gemeinsame Joint-Optimierung
// ueber ZWEI VERSCHIEDENE Vorgaben-Typen hinweg auf, die ausserhalb des
// Ticket-Umfangs liegt (jede reserveWindowAware()-Instanz optimiert nur
// GEGEN BEREITS FEST reservierte Karten, nicht vorausschauend gegen eine
// SPAETER laufende, andersartige Vorgabe - siehe Ticket #64 followups).
{
    const rand = mulberry32(64006400);
    let allMatch = true, detail = '';
    for (let t = 0; t < 30; t++) {
        const nNormal = 11 + Math.floor(rand() * 3);
        const nHigh = 2 + Math.floor(rand() * 2);
        const nProt = 2 + Math.floor(rand() * 2);
        const minRatingC = 83 + Math.floor(rand() * 4); // 83..86
        const needHigh = 1 + Math.floor(rand() * Math.min(2, nHigh));
        const needProt = 1 + Math.floor(rand() * Math.min(2, nProt));
        const pool = [];
        for (let i = 0; i < nNormal; i++) {
            pool.push(P(70 + Math.floor(rand() * 8), { storage: rand() < 0.3, groups: [19] }));
        }
        for (let i = 0; i < nHigh; i++) {
            pool.push(P(minRatingC + Math.floor(rand() * 8), { storage: rand() < 0.5, groups: [19] }));
        }
        for (let i = 0; i < nProt; i++) {
            pool.push(P(70 + Math.floor(rand() * (minRatingC - 70)),
                { special: true, rareflag: 137, groups: [83], storage: rand() < 0.5 }));
        }
        const target = 80 + Math.floor(rand() * 6);
        const c = cfg(target, {
            maxOvershoot: Math.floor(rand() * 4) / 10,
            scarcityWeight: 18, storageBonus: 2,
            ratingCostSpec: SolverCore.DEFAULT_RATING_COST_SPEC,
            rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: needProt, groupId: 83 }],
            playerLevelConstraints: [{ label: 'PLAYER_RATING', minRating: minRatingC, count: needHigh }]
        });
        const res = SolverCore.solve(pool, c);
        const quotaOk = (team) => {
            const gotProt = team.filter(p => Array.isArray(p.groups) && p.groups.indexOf(83) > -1).length;
            const gotHigh = team.filter(p => p.rating >= minRatingC).length;
            return gotProt === needProt && gotHigh >= needHigh;
        };
        const bb = bruteBest(pool, c, quotaOk);
        if (bb === null) {
            if (res.ok) { allMatch = false; detail = 't' + t + ': brute (kombiniert) unloesbar, solver ok'; break; }
        } else {
            if (!res.ok) { allMatch = false; detail = 't' + t + ': brute loesbar (vMin=' + bb.vMin + '), solver nicht: ' + res.reason; break; }
            if (!quotaOk(res.players)) {
                allMatch = false; detail = 't' + t + ': Solver-Team erfuellt die kombinierte Quote nicht (Rarity ' +
                    res.players.filter(p => p.groups && p.groups.indexOf(83) > -1).length + '/' + needProt +
                    ', Spieler-Level ' + res.players.filter(p => p.rating >= minRatingC).length + '/' + needHigh + ')';
                break;
            }
            const obj = solverObjective(res, pool, c, bb.vMin);
            if (Math.abs(obj - bb.bestObj) > 1e-6) {
                allMatch = false; detail = 't' + t + ': brute=' + bb.bestObj + ' solver=' + obj; break;
            }
            if (SolverCore.squadRating(res.players.map(p => p.rating)) < target) {
                allMatch = false; detail = 't' + t + ': Team erreicht Ziel nicht!'; break;
            }
        }
    }
    check('30x kombinierter Brute-Force-Fuzz MIT Rarity- UND Spieler-Level-Vorgabe ' +
        'gleichzeitig (Ticket #64)', allMatch, detail);
}

// ========== 54. removeFromPool(): der letzte ungetestete Pool-Baustein ==========
// Iter-6-Re-Score-Restpunkt: der reportError-Umbau von #56 hatte hier als
// einziger keinen eigenen Verhaltenstest. Wie ueberall: echte extrahierte
// Funktion gegen gestubbtes STATE/ui, kein Text-Grep.
{
    const removeSrc = extractFunction(src, 'removeFromPool');
    check('Funktion removeFromPool gefunden (54)', !!removeSrc);

    function makeSandbox(refreshImpl) {
        const calls = { reportError: 0, log: [], refresh: 0 };
        const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
        const STATE = {
            poolById: new Map(cards.map(c => [c.id, c])),
            pool: cards.slice()
        };
        const ui = { poolcount: { textContent: '' } };
        const sandbox = {
            STATE: STATE, ui: ui,
            refreshSbcInfoUI: () => { calls.refresh++; if (refreshImpl) refreshImpl(); },
            log: (...a) => { calls.log.push(a.join(' ')); },
            reportError: () => { calls.reportError++; }
        };
        const keys = Object.keys(sandbox);
        const fn = new Function(keys.join(','), removeSrc + '\nreturn removeFromPool;')
            .apply(null, keys.map(k => sandbox[k]));
        return { fn: fn, calls: calls, STATE: STATE, ui: ui };
    }

    // (a) Normalfall: verbaute Karten fliegen raus, Pool-Array und Anzeige
    // werden neu aufgebaut.
    {
        const t = makeSandbox();
        t.fn([{ id: 'a' }, { id: 'c' }]);
        check('removeFromPool: verbaute Karten fliegen aus poolById UND pool',
            t.STATE.pool.length === 1 && t.STATE.pool[0].id === 'b' &&
            !t.STATE.poolById.has('a') && !t.STATE.poolById.has('c'));
        check('removeFromPool: Anzeige und UI-Refresh laufen genau einmal',
            t.ui.poolcount.textContent === '1' && t.calls.refresh === 1 &&
            t.calls.log.length === 1);
    }
    // (b) Unbekannte Ids: kein Umbau, kein Log, kein Refresh (removed === 0).
    {
        const t = makeSandbox();
        t.fn([{ id: 'zzz' }, null]);
        check('removeFromPool: unbekannte Ids veraendern nichts (kein Log/Refresh)',
            t.STATE.pool.length === 3 && t.calls.refresh === 0 &&
            t.calls.log.length === 0 && t.calls.reportError === 0);
    }
    // (c) Fehlerpfad (#56): wirft ein innerer Schritt, faengt der Catch das
    // ueber reportError sichtbar ab, statt den Aufrufer (Batch-Runde!)
    // abzuschiessen.
    {
        const t = makeSandbox(() => { throw new Error('kaputt'); });
        let threw = false;
        try { t.fn([{ id: 'a' }]); } catch (e) { threw = true; }
        check('removeFromPool: Fehler landet in reportError (genau 1x), nichts wirft nach aussen',
            !threw && t.calls.reportError === 1);
    }
}

// ========== 55. Ticket #66: readConfig() liest maxRatingEnabled/maxRating, altes maxexp-UI schadet nicht ==========
{
    const readConfigSrc = extractFunction(src, 'readConfig');
    check('Funktion readConfig gefunden (55)', !!readConfigSrc);

    function makeUi(overrides) {
        return Object.assign({
            minrating: { value: '75' },
            maxwaste: { value: '0.00' },
            applyrarity: { checked: true },
            specialstorage: { checked: true },
            maxRatingEn: { checked: false },
            maxRatingVal: { value: '85' },
            scarcity: { value: '18' },
            storagebonus: { value: '2' },
            untradeable: { value: '3' },
            useLocks: { checked: false },
            maxRare: { value: '77' },
            maxCommon: { value: '77' },
            rarityguard: { value: '8' },
            rarityPick: { value: '' }
        }, overrides || {});
    }
    function runReadConfig(uiOverrides) {
        const ui = makeUi(uiOverrides);
        const STATE = { sbc: { targetOVR: 84, formationSlots: 11 } };
        const sandbox = {
            STATE: STATE, ui: ui,
            ratingBands: [],
            bandsToSpec: () => '0-99:0',
            readPaletoolsLocks: () => new Set()
        };
        const keys = Object.keys(sandbox);
        const fn = new Function(keys.join(','), readConfigSrc + '\nreturn readConfig;')
            .apply(null, keys.map(k => sandbox[k]));
        return fn();
    }

    const off = runReadConfig();
    check('readConfig: maxRatingEnabled=false ohne Haekchen', off.maxRatingEnabled === false);
    const on = runReadConfig({ maxRatingEn: { checked: true }, maxRatingVal: { value: '83' } });
    check('readConfig: maxRatingEnabled/maxRating werden gelesen',
        on.maxRatingEnabled === true && on.maxRating === 83, JSON.stringify(on));
    check('readConfig: kein maxExpensive*-Feld mehr im Ergebnis (Ticket #66 Entfernung)',
        !('maxExpensiveEnabled' in on) && !('maxExpensiveCount' in on) && !('expensiveThreshold' in on));

    // Alt-Config-Vertraeglichkeit: ein DOM-Rest mit den alten maxexp-Feldern
    // (z.B. aus einem Zwischenzustand) darf readConfig() nicht zum Absturz
    // bringen - die Funktion referenziert sie schlicht nicht mehr.
    const legacy = runReadConfig({
        maxexpEn: { checked: true }, maxexpCount: { value: '4' }, maxexpTh: { value: '88' }
    });
    check('readConfig: alte maxexp-UI-Reste im Objekt werfen keinen Fehler',
        legacy.maxRatingEnabled === false && legacy.minRating === 75);
}

// ========== 56. Ticket #70: staleInstanceMessage() unterscheidet Erschoepfung von Mehrdeutigkeit ==========
{
    // Live (Report v4.61.0, "84+ TOTW Upgrade" Runde 9/10): resolveFreshChallengeId()
    // fand 0 Kandidaten, die Meldung riet trotzdem "schliessen und neu oeffnen" -
    // das hilft nicht, wenn EA das Set gar nicht mehr wiederholen laesst.
    const fnSrc = extractFunction(src, 'staleInstanceMessage');
    check('Funktion staleInstanceMessage gefunden (56)', !!fnSrc);
    const staleInstanceMessage = new Function(fnSrc + '\nreturn staleInstanceMessage;')();

    const exhausted = staleInstanceMessage('404', 0, { done: 8, total: 10 });
    check('0 Kandidaten: Erschoepfungs-Text statt "schliessen und neu oeffnen"',
        /Keine weitere Wiederholung verfügbar/.test(exhausted) &&
        /Limit erreicht oder abgelaufen/.test(exhausted) &&
        exhausted.indexOf('schliessen und neu') === -1, exhausted);
    check('0 Kandidaten: N von M aus dem Plan steht in der Meldung',
        /8 von 10 geschafft/.test(exhausted), exhausted);

    const exhaustedNoPlan = staleInstanceMessage('404', 0, null);
    check('0 Kandidaten ohne Batch-Kontext: Erschoepfungs-Text ohne N/M, kein Absturz',
        /Keine weitere Wiederholung verfügbar/.test(exhaustedNoPlan) &&
        exhaustedNoPlan.indexOf(' von ') === -1, exhaustedNoPlan);

    const ambiguous = staleInstanceMessage('475', 2, { done: 3, total: 5 });
    check('>=1 Kandidat (mehrdeutig): der bisherige Rat bleibt (schliessen und neu oeffnen)',
        /schliessen und neu/.test(ambiguous) &&
        ambiguous.indexOf('Keine weitere Wiederholung') === -1, ambiguous);

    const unknown = staleInstanceMessage('404', null, { done: 1, total: 4 });
    check('candidateCount unbekannt (Abruf fehlgeschlagen): faellt konservativ auf den bisherigen Rat zurueck',
        /schliessen und neu/.test(unknown), unknown);

    // submitToSbc() muss candidateCount aus STATE.diag.staleRecover lesen und an
    // staleInstanceMessage() weiterreichen - Absicherung gegen Wegrefactorn.
    const submitSrc = extractFunction(src, 'submitToSbc');
    check('submitToSbc uebergibt candidateCount und batchProgress an staleInstanceMessage (56)',
        /staleInstanceMessage\(msg, candidateCount, batchProgress\)/.test(submitSrc));
    check('submitToSbc verwirft einen staleRecover-Stand von einer anderen setId (56)',
        /staleRecover\.setId === STATE\.sbc\.setId/.test(submitSrc));

    // Der Batch-Lauf muss done/n als batchProgress durchreichen (sonst bliebe
    // "N von M geschafft" in der Praxis immer leer).
    const runFn = extractFunction(src, 'onBatchRunClick');
    check('onBatchRunClick reicht { done, total: n } an submitToSbc weiter (56)',
        /submitToSbc\(round, false, \{ done: done, total: n \}\)/.test(runFn));
}

// ========== 57. Ticket #68: Vorgabe-Kandidaten-Verfuegbarkeit (TOTW/Gruppe-83) ==========
{
    // Rasmus' O-Ton: "wie viele TOTW im Verein + Storage und wie viele
    // FUTTIES/FOF-Karten im Storage noch verfuegbar sind." Die Anzeige nutzt
    // GENAU dieselbe Eligibility wie die Reservierung
    // (SolverCore.reservationCandidates(), SSOT - keine Zweitlogik). Pool:
    // 2x TOTW Verein, 3x TOTW Storage, 1x FUTTIES Storage (Gruppe 83, kein
    // TOTW), 1x FUTTIES VEREIN (Gruppe 83, kein TOTW - muss ausgeschlossen
    // bleiben, Rasmus' harte Regel "Verein-Specials nie ausser TOTW").
    const totwClub = many(2, 84, { special: true, rareflag: 3, groups: [83] });
    const totwStorage = many(3, 85, { special: true, rareflag: 3, groups: [83], storage: true });
    const futtiesStorage = many(1, 90, { special: true, rareflag: 137, groups: [83], storage: true });
    const futtiesClub = many(1, 91, { special: true, rareflag: 137, groups: [83] });
    const filler = many(20, 80, { groups: [19] });
    const pool = [].concat(totwClub, totwStorage, futtiesStorage, futtiesClub, filler);
    const rc = { label: 'PLAYER_RARITY_GROUP', ids: [], count: 2, groupId: 83 };
    const cAvail = cfg(null, { specialOnlyFromStorage: true });

    // SSOT-Beweis: die Anzeige-Zählung ist exakt die Länge der Kandidatenliste,
    // die auch solveCore für dieselbe Vorgabe zieht (dieselbe Funktion, kein
    // zweiter Zähl-Weg).
    const avail = SolverCore.computeRarityAvailability(pool, cAvail, [rc]);
    const cands = SolverCore.reservationCandidates(pool, rc, cAvail);
    check('Ticket 68: Anzeige-Zählung == Reservierungs-Kandidatenliste (SSOT)',
        avail.perConstraint[0].available === cands.length,
        'available=' + avail.perConstraint[0].available + ' cands=' + cands.length);
    check('Ticket 68: 6 Kandidaten (2 Club-TOTW + 3 Storage-TOTW + 1 Storage-Special)',
        cands.length === 6, 'cands=' + cands.length);
    check('Ticket 68: needed spiegelt rc.count',
        avail.perConstraint[0].needed === 2);
    check('Ticket 68: Aufschlüsselung TOTW Verein/Storage + Specials Storage stimmt',
        avail.perConstraint[0].totwClub === 2 && avail.perConstraint[0].totwStorage === 3 &&
        avail.perConstraint[0].specialsStorage === 1,
        JSON.stringify(avail.perConstraint[0]));

    // Verein-Special-Ausschluss ausser TOTW: die Vereins-FUTTIES darf NIE als
    // Kandidat auftauchen, die Vereins-TOTW schon.
    check('Ticket 68: Vereins-FUTTIES (kein TOTW) wird ausgeschlossen',
        !cands.some(p => p.id === futtiesClub[0].id));
    check('Ticket 68: Vereins-TOTW bleibt Kandidat',
        cands.some(p => p.id === totwClub[0].id));

    // Ohne Rarity-Vorgabe: kompakte Dauerzeile über den gesamten Gruppe-83-Bestand.
    const availNone = SolverCore.computeRarityAvailability(pool, cAvail, []);
    check('Ticket 68: ohne Vorgabe keine perConstraint-Zeilen', availNone.perConstraint.length === 0);
    check('Ticket 68: Dauerzeile TOTW (Verein+Storage) korrekt', availNone.totw === 5,
        'totw=' + availNone.totw);
    check('Ticket 68: Dauerzeile Storage-Specials korrekt', availNone.specialsStorage === 1,
        'specialsStorage=' + availNone.specialsStorage);

    // Lock-Ausschluss: eine gesperrte TOTW-Storage-Karte fehlt in der Zählung -
    // derselbe Vorfilter wie solveCore (filterLockedCards()).
    const cLocked = cfg(null, { specialOnlyFromStorage: true, lockedIds: [totwStorage[0].id] });
    const availLocked = SolverCore.computeRarityAvailability(pool, cLocked, [rc]);
    check('Ticket 68: gesperrte Karte reduziert die Verfügbarkeit',
        availLocked.perConstraint[0].available === 5 &&
        availLocked.perConstraint[0].totwStorage === 2,
        JSON.stringify(availLocked.perConstraint[0]));

    // Max-Rating-Wirkung (seit v4.62.0 ein harter Vorfilter am solve()-Eingang,
    // Ticket #68 verlangt denselben Vorfilter für die Anzeige): eine Karte über
    // der Grenze darf nicht mitgezählt werden.
    const cCapped = cfg(null, { specialOnlyFromStorage: true, maxRatingEnabled: true, maxRating: 88 });
    const availCapped = SolverCore.computeRarityAvailability(pool, cCapped, [rc]);
    check('Ticket 68: Max-Rating-Filter schließt die 90er Storage-Special-Karte aus der Zählung aus',
        availCapped.perConstraint[0].available === 5 && availCapped.perConstraint[0].specialsStorage === 0,
        JSON.stringify(availCapped.perConstraint[0]));

    // Diff-Beweis, dass die REALE Reservierung in solveCore verhaltensgleich
    // bleibt: die von solve() tatsächlich reservierten Gruppe-83-Karten sind
    // eine Teilmenge dessen, was reservationCandidates() für dieselbe Vorgabe
    // als eligibel meldet (kein zweiter, abweichender Auswahl-Weg entstanden).
    const solvePool = [].concat(totwClub, totwStorage, futtiesStorage, many(9, 84, { groups: [19] }));
    const cSolve = cfg(84, {
        slots: 11, specialOnlyFromStorage: true, maxOvershoot: 5,
        rarityConstraints: [{ label: 'PLAYER_RARITY_GROUP', ids: [], count: 2, groupId: 83 }]
    });
    const res = SolverCore.solve(solvePool, cSolve);
    check('Ticket 68: Solve mit Gruppe-83-Vorgabe bleibt lösbar', res.ok, res.ok ? '' : res.reason);
    const reservedG83 = res.ok ? res.players.filter(p => (p.groups || []).indexOf(83) > -1) : [];
    check('Ticket 68: genau 2 Gruppe-83-Karten reserviert', reservedG83.length === 2,
        'n=' + reservedG83.length);
    const candsForSolve = SolverCore.reservationCandidates(solvePool, cSolve.rarityConstraints[0], cSolve);
    check('Ticket 68: jede reservierte Gruppe-83-Karte ist Kandidat laut reservationCandidates()',
        reservedG83.every(p => candsForSolve.some(c => c.id === p.id)));

    // Panel-Verdrahtung: refreshSbcInfoUI() hängt sich in den bestehenden
    // Aktualisierungspunkt ein (kein neuer Trigger), refreshAvailabilityUI()
    // nutzt SolverCore.computeRarityAvailability() - statischer Beleg gegen
    // eine künftige zweite Zähl-Logik im UI-Code.
    const refreshFn = extractFunction(src, 'refreshSbcInfoUI');
    check('Ticket 68: refreshSbcInfoUI() ruft refreshAvailabilityUI()',
        /refreshAvailabilityUI\(\)/.test(refreshFn));
    const availFn = extractFunction(src, 'refreshAvailabilityUI');
    check('Ticket 68: refreshAvailabilityUI() nutzt SolverCore.computeRarityAvailability (keine Zweitlogik)',
        /SolverCore\.computeRarityAvailability\(/.test(availFn));
    check('Ticket 68: Panel-DOM enthält den Verfügbarkeits-Block',
        src.indexOf('sbc-opt-availability') > -1);
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
