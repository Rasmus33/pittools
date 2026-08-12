// ==UserScript==
// @name         EA FC SBC Rating-Optimizer
// @namespace    https://github.com/sbc-optimizer
// @version      4.22.0
// @description  Optimiert SBC-Teams rein nach Rating (minimaler Rating-Waste, exakter Solver). Erkennt Ziel-OVR & Rarity-Vorgaben automatisch, bevorzugt Storage- und häufig vorhandene Karten, trägt das Team in die SBC-Auswahl ein.
// @author       SBC Optimizer
// @match        https://www.ea.com/*/fc/ut/webapp/*
// @match        https://www.ea.com/fc/ut/webapp/*
// @match        https://www.ea.com/*/ultimate-team/web-app/*
// @match        https://www.ea.com/ultimate-team/web-app/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Rasmus33/pittools/main/ea-fc-sbc-optimizer.user.js
// @downloadURL  https://raw.githubusercontent.com/Rasmus33/pittools/main/ea-fc-sbc-optimizer.user.js
// ==/UserScript==
// ACHTUNG: In den ==UserScript==-Block gehören AUSSCHLIESSLICH "@key value"-
// Zeilen. Freie Kommentare dazwischen markiert Tampermonkey als Fehler und
// kann die danach folgenden Metadaten (hier @updateURL/@downloadURL) still
// ignorieren - Erklärungen deshalb immer hierunter.
//
// Auto-Update: @updateURL/@downloadURL zeigen auf main, Push = Update auf allen
// Geräten. Tampermonkey vergleicht dazu @version, die MUSS also bei jeder
// Änderung hoch (siehe CLAUDE.md). @name/@namespace NIE ändern: die beiden
// bilden die Script-Identität, sonst legt Tampermonkey ein ZWEITES Script an
// statt dieses zu aktualisieren.
/*
 * ============================================================================
 *  EA FC SBC RATING-OPTIMIZER  (v2.0.0)
 * ----------------------------------------------------------------------------
 *  Änderungen gegenüber v1:
 *   - FIX: SBC-Endpunkte der Web App laufen über "sbs/..." — v1 lauschte nur
 *     auf "sbc/..." und hat deshalb nie etwas erkannt.
 *   - NEU: Zweite Datenzugriffs-Ebene über die internen App-Services
 *     (window.services.Club / .Item / .SBC). Funktioniert auch dann, wenn die
 *     Netzwerk-Interception nichts abfangen kann.
 *   - NEU: Hook auf services.SBC.loadChallenge — die geöffnete Challenge wird
 *     direkt als Objekt erfasst (Ziel-OVR, Rarity, IDs).
 *   - NEU: Generischer Requirement-Scanner (Deep-Scan) statt geratener
 *     Response-Strukturen.
 *   - NEU: Exakter DP-Solver (bounded knapsack) statt Greedy+Backtrack:
 *     garantiert minimaler Rating-Waste; Storage-Priorität und
 *     Abundance-Schonung als echte Tiebreaker.
 *   - NEU: Diagnose-Button — schreibt einen Debug-Report in die Konsole
 *     (ohne Session-Tokens), den man zur Fehlersuche weitergeben kann.
 *   - FIX: Leihspieler (loans) werden ausgeschlossen.
 *   - FIX: Header-Erfassung auch für Array-Form und XHR responseType=json.
 *
 *  Es geht ausschliesslich um Rating - Chemie, Formation, Positionen werden
 *  bewusst ignoriert (so vom Nutzer gewünscht).
 *
 *  Auswahl-Priorität der Spieler (bei gleichem Rating):
 *    1. Gold-Karten aus dem SBC-Storage
 *    2. Special-Karten aus dem SBC-Storage
 *    3. Gold-Karten aus dem Verein
 *    4. Special-Karten aus dem Verein
 *
 *  Zusätzlich: bei gleichem Waste werden Ratings bevorzugt, von denen man
 *  VIELE besitzt - seltene Ratings werden geschont.
 * ============================================================================
 */
(function () {
    'use strict';
    // ========================================================================
    //  0. GLOBALE KONSTANTEN & ZUSTAND
    // ========================================================================
    const VERSION = '4.22.0';
    const LOG_PREFIX = '[SBC-Optimizer]';
    // rareflag-Semantik (FUT-Standard):
    //   0 = common, 1 = rare  -> NORMALE Karten ("Gold" im Prioritäts-Sinn)
    //   ab 2 = Special-Version (TOTW, FUTTIES, Heroes, ...)
    // (Die alte Annahme "3/12 = Gold" war falsch herum und hat normale
    //  Vereins-Golds als Specials wegggefiltert.)
    function isNormalCard(rf) {
        return isNaN(rf) || rf === 0 || rf === 1;
    }
    const STATE = {
        session: {
            sid: null,               // X-UT-SID
            phishing: null,          // X-UT-PHISHING-TOKEN
            route: null,             // X-UT-Route
            nucleusId: null,         // Easw-Session-Data-Nucleus-Id
            apiBase: null            // z.B. https://utas.mob.v1.fut.ea.com/ut/game/fc26/
        },
        sbc: {
            setId: null,
            challengeId: null,
            squadId: null,
            targetOVR: null,
            formationSlots: 11,
            squadSlotTotal: null,
            rarityConstraints: [],       // [{ label, ids, count }]
            playerLevelConstraints: [],  // [{ label, minRating, count }]
            reqDump: [],                 // alle erkannten Requirement-Knoten
            apiPrefix: 'sbs',            // beobachtetes Pfad-Präfix (sbs oder sbc)
            entity: null                 // via services.SBC.loadChallenge erfasst
        },
        poolById: new Map(),         // id -> Player
        pool: [],                    // Array-Sicht auf poolById
        lastResult: null,
        loading: false,
        servicesHooked: false,
        cancelLoad: false,
        lastChallengeRaw: null,      // letzte SBC-Response (fürs Debugging)
        lastSetChallenges: null,     // gecachte Challenge-Liste des geöffneten Sets
        diag: {
            fetchSeen: 0,
            xhrSeen: 0,
            utasSeen: 0,
            lastUtasPaths: [],       // letzte utas-Pfade (IDs maskiert)
            lastErrors: [],          // letzte Fehlermeldungen (ohne Tokens)
            evoExcluded: 0           // ausgeschlossene Evolution-Karten
        }
    };
    function log(...args) { try { console.log(LOG_PREFIX, ...args); } catch (e) {} }
    function warn(...args) { try { console.warn(LOG_PREFIX, ...args); } catch (e) {} }
    function diagError(msg) {
        try {
            const arr = STATE.diag.lastErrors;
            arr.push(String(msg).slice(0, 300));
            if (arr.length > 24) arr.shift();
        } catch (e) {}
    }
    // ========================================================================
    //  1. FETCH / XHR INTERCEPTION  (ab document-start)
    // ========================================================================
    function pickHeader(headersLike, name) {
        if (!headersLike) return null;
        const lower = name.toLowerCase();
        // 1) fetch Headers-Instanz
        if (typeof headersLike.get === 'function') {
            try {
                const v = headersLike.get(name) || headersLike.get(lower);
                if (v) return v;
            } catch (e) {}
        }
        // 2) Array von [name, value]-Paaren
        if (Array.isArray(headersLike)) {
            for (const pair of headersLike) {
                if (pair && String(pair[0]).toLowerCase() === lower) return pair[1];
            }
            return null;
        }
        // 3) Plain-Objekt
        if (typeof headersLike === 'object') {
            for (const key in headersLike) {
                if (Object.prototype.hasOwnProperty.call(headersLike, key) &&
                    key.toLowerCase() === lower) {
                    return headersLike[key];
                }
            }
        }
        return null;
    }
    function absorbSessionHeaders(headersLike) {
        if (!headersLike) return;
        const s = STATE.session;
        const sid = pickHeader(headersLike, 'X-UT-SID');
        const phishing = pickHeader(headersLike, 'X-UT-PHISHING-TOKEN');
        const route = pickHeader(headersLike, 'X-UT-Route');
        const nucleus = pickHeader(headersLike, 'Easw-Session-Data-Nucleus-Id');
        if (sid && sid !== s.sid) { s.sid = sid; log('X-UT-SID erfasst'); refreshDiagUI(); }
        if (phishing) s.phishing = phishing;
        if (route) s.route = route;
        if (nucleus) s.nucleusId = nucleus;
    }
    // API-Base aus einer URL ableiten. Marker ist "/ut/game/{spiel}/" –
    // der Host kann variieren (utas.mob.v1.fut.ea.com, utas.external..., ...).
    function detectApiBase(url) {
        try {
            const u = String(url);
            const m = u.match(/^(https?:\/\/[^/]+\/ut\/game\/[^/]+\/)/i);
            if (m && m[1] && STATE.session.apiBase !== m[1]) {
                STATE.session.apiBase = m[1];
                log('API-Base erkannt:', m[1]);
                refreshDiagUI();
            }
            if (/\/ut\/game\//i.test(u)) {
                STATE.diag.utasSeen++;
                const path = u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
                    .replace(/\d{4,}/g, '{id}');
                const arr = STATE.diag.lastUtasPaths;
                if (arr[arr.length - 1] !== path) {
                    arr.push(path);
                    if (arr.length > 15) arr.shift();
                }
                // sbs- oder sbc-Präfix merken
                const pm = u.match(/\/ut\/game\/[^/]+\/(sbs|sbc)\//i);
                if (pm) STATE.sbc.apiPrefix = pm[1].toLowerCase();
            }
        } catch (e) {}
    }
    // Interessante Endpunkte. WICHTIG: Die Web App nutzt "sbs/..." für SBCs.
    function classifyUrl(url) {
        const u = String(url);
        // Liste aller Challenges eines Sets - HIER stehen die Anforderungen
        // (Ziel-OVR, Rarity) pro Challenge. Live verifiziert (fc26).
        if (/\/(sbs|sbc)\/setId\/\d+\/challenges/i.test(u)) return 'sbc-set-challenges';
        if (/\/(sbs|sbc)\/setId\/\d+\/challengeId\/\d+/i.test(u) ||
            /\/(sbs|sbc)\/challenge\/\d+/i.test(u)) return 'sbc-challenge';
        if (/\/(sbs|sbc)\/sets/i.test(u)) return 'sbc-sets';
        if (/\/club(\?|$)/i.test(u)) return 'club';
        if (/\/purchased\/items/i.test(u)) return 'unassigned';
        // SBC-Storage - Endpunkt heisst "storagepile". Live verifiziert (fc26).
        if (/\/storagepile(\?|$|\/)/i.test(u)) return 'storage';
        if (/\/(sbs|sbc)\/[^?]*storage/i.test(u)) return 'storage';
        return null;
    }
    function handleResponseBody(url, bodyText) {
        const kind = classifyUrl(url);
        if (!kind || !bodyText) return;
        let json;
        try { json = (typeof bodyText === 'string') ? JSON.parse(bodyText) : bodyText; }
        catch (e) { return; }
        try {
            if (kind === 'sbc-set-challenges') {
                // Challenge-Liste eines Sets: enthält die Anforderungen pro
                // Challenge. Cachen und (falls Challenge schon bekannt) anwenden.
                STATE.lastSetChallenges = json;
                STATE.lastChallengeRaw = json;
                const sm = String(url).match(/setId\/(\d+)/i);
                if (sm) STATE.sbc.setId = parseInt(sm[1], 10);
                applyFromSetChallenges();
            } else if (kind === 'sbc-challenge' || kind === 'sbc-sets') {
                STATE.lastChallengeRaw = json;
                parseSbcChallenge(json, url);
            } else if (kind === 'club' || kind === 'unassigned') {
                // Passiv mitlesen: was die App ohnehin lädt, wandert in den Pool.
                harvestItems(json, false);
            } else if (kind === 'storage') {
                harvestItems(json, true);
            }
        } catch (e) {
            warn('Fehler beim Verarbeiten einer Response:', e);
        }
    }
    // ---- fetch() Wrapper ---------------------------------------------------
    const _origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (_origFetch) {
        window.fetch = function (input, init) {
            try {
                STATE.diag.fetchSeen++;
                const url = (typeof input === 'string') ? input : (input && input.url);
                if (url) {
                    detectApiBase(url);
                    if (init && init.headers) absorbSessionHeaders(init.headers);
                    if (input && input.headers) absorbSessionHeaders(input.headers);
                }
            } catch (e) {}
            return _origFetch(input, init).then(function (resp) {
                try {
                    const url = (typeof input === 'string') ? input : (input && input.url);
                    if (url && classifyUrl(url)) {
                        resp.clone().text().then(function (txt) {
                            handleResponseBody(url, txt);
                        }).catch(function () {});
                    }
                } catch (e) {}
                return resp;
            });
        };
        log('fetch() Interception aktiv');
    }
    // ---- XMLHttpRequest Wrapper -------------------------------------------
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
        const origOpen = XHR.prototype.open;
        const origSend = XHR.prototype.send;
        const origSetHeader = XHR.prototype.setRequestHeader;
        XHR.prototype.open = function (method, url) {
            this.__sbcUrl = url;
            this.__sbcMethod = String(method || '').toUpperCase();
            this.__sbcHeaders = {};
            try { detectApiBase(url); } catch (e) {}
            return origOpen.apply(this, arguments);
        };
        XHR.prototype.setRequestHeader = function (name, value) {
            try {
                if (!this.__sbcHeaders) this.__sbcHeaders = {};
                this.__sbcHeaders[name] = value;
            } catch (e) {}
            return origSetHeader.apply(this, arguments);
        };
        XHR.prototype.send = function (body) {
            try {
                STATE.diag.xhrSeen++;
                if (this.__sbcHeaders) absorbSessionHeaders(this.__sbcHeaders);
                const url = this.__sbcUrl;
                // Referenz-Body mitschneiden: So sendet die App selbst einen
                // SBC-Squad (wenn man manuell einen Spieler einträgt).
                if (body && this.__sbcMethod === 'PUT' &&
                    /\/(sbs|sbc)\/challenge\/\d+\/squad/i.test(String(url))) {
                    try { STATE.diag.lastSquadPutBody = String(body).slice(0, 3000); } catch (e) {}
                }
                if (url && classifyUrl(url)) {
                    this.addEventListener('load', function () {
                        try {
                            let data = null;
                            const rt = this.responseType;
                            if (!rt || rt === 'text') data = this.responseText;
                            else if (rt === 'json' && this.response != null) data = this.response;
                            if (data) handleResponseBody(url, data);
                        } catch (e) {}
                    });
                }
            } catch (e) {}
            return origSend.apply(this, arguments);
        };
        log('XHR Interception aktiv');
    }
    // ========================================================================
    //  2. GENERISCHES REQUIREMENT-PARSING (Deep-Scan)
    // ------------------------------------------------------------------------
    //  Statt eine bestimmte Response-Struktur zu raten, durchsuchen wir den
    //  gesamten Objektgraphen (begrenzt) nach requirement-artigen Objekten.
    //  Funktioniert für Netzwerk-JSON UND für App-interne Entities.
    // ========================================================================
    function scopeString(o) {
        const cand = [o.scope, o.type, o.key, o.requirementKey, o.name];
        for (const c of cand) {
            if (typeof c === 'string' && c.length >= 3 && /[A-Za-z]/.test(c)) return c.toUpperCase();
        }
        return null;
    }
    function reqValue(o) {
        let v = (o.minimum != null) ? o.minimum
              : (o.eligibilityValue != null) ? o.eligibilityValue
              : (o.value != null) ? o.value
              : (Array.isArray(o.eligibilityValues) && o.eligibilityValues.length === 1) ? o.eligibilityValues[0]
              : o.count;
        v = parseInt(v, 10);
        return isNaN(v) ? null : v;
    }
    function reqIds(o) {
        const ids = o.eligibilityValues || o.values || o.rarityIds || [];
        return Array.isArray(ids) ? ids.map(Number).filter(n => !isNaN(n)) : [];
    }
    function reqCount(o, parents) {
        // EA hängt den Count ("Min. 4") oft an das ELTERN-Objekt der
        // Requirement-KV-Paare (UTSBCEligibilityRequirement.count), nicht an
        // das Wert-Objekt selbst - deshalb die Eltern-Kette mitprüfen.
        const chain = [o].concat(parents || []);
        const keys = ['count', 'requirementCount', 'keyCount', 'amount', 'minimum', '_count'];
        for (const node of chain) {
            if (!node || typeof node !== 'object') continue;
            for (const k of keys) {
                const c = parseInt(node[k], 10);
                if (!isNaN(c) && c >= 1 && c <= 11) return c;
            }
        }
        return 1;
    }
    function isDomOrWindow(o) {
        try {
            return (typeof Node !== 'undefined' && o instanceof Node) ||
                   (typeof Window !== 'undefined' && o instanceof Window);
        } catch (e) { return false; }
    }
    /**
     * Durchsucht ein Objekt (Response-JSON oder Challenge-Entity) nach
     * Team-Rating- und Rarity-Anforderungen sowie squadId.
     */
    function deepScanChallenge(root) {
        const out = { target: null, rarity: [], squadId: null, slots: null, playerLevel: [], quality: [], reqs: [] };
        if (!root || typeof root !== 'object') return out;
        const seen = new Set();
        const queue = [{ o: root, d: 0, par: [] }];
        let visited = 0;
        while (queue.length && visited < 20000) {
            const cur = queue.shift();
            const o = cur.o, d = cur.d, par = cur.par;
            if (!o || typeof o !== 'object' || seen.has(o) || d > 7 || isDomOrWindow(o)) continue;
            seen.add(o);
            visited++;
            // squadId nur aus explizit benannten Feldern
            if (out.squadId == null && o.squadId != null && (typeof o.squadId === 'number' || typeof o.squadId === 'string')) {
                out.squadId = o.squadId;
            }
            const scope = scopeString(o);
            if (scope) {
                const v = reqValue(o);
                // Roh-Dump für Transparenz/Diagnose (max 25 Einträge)
                if (out.reqs.length < 25 &&
                    (scope.indexOf('RATING') > -1 || scope.indexOf('RARITY') > -1 ||
                     scope.indexOf('PLAYER') > -1 || scope.indexOf('OVR') > -1 ||
                     scope.indexOf('LEVEL') > -1 || scope.indexOf('QUALITY') > -1 ||
                     scope.indexOf('CLUB') > -1 || scope.indexOf('LEAGUE') > -1 ||
                     scope.indexOf('NATION') > -1 || scope.indexOf('CHEM') > -1)) {
                    out.reqs.push({ scope: scope, value: v, ids: reqIds(o), count: reqCount(o, par) });
                }
                const isTeamRating =
                    scope.indexOf('TEAM_RATING') > -1 || scope.indexOf('SQUAD_RATING') > -1 ||
                    ((scope.indexOf('RATING') > -1 || scope.indexOf('OVR') > -1) &&
                     scope.indexOf('PLAYER') === -1 && scope.indexOf('CHEM') === -1);
                if (isTeamRating) {
                    if (v != null && v >= 40 && v <= 99) {
                        // höchste gefundene Team-Rating-Anforderung gewinnt
                        if (out.target == null || v > out.target) out.target = v;
                    }
                }
                // Spieler-Level-Vorgabe: "min. N Spieler mit Rating X+"
                const isPlayerLevel = scope.indexOf('PLAYER') > -1 &&
                    (scope.indexOf('RATING') > -1 || scope.indexOf('OVR') > -1 ||
                     scope.indexOf('LEVEL') > -1) &&
                    scope.indexOf('CHEM') === -1;
                if (isPlayerLevel && v != null && v >= 40 && v <= 99) {
                    out.playerLevel.push({ label: scope, minRating: v, count: reqCount(o, par) });
                }
                // Qualitäts-Vorgabe (Tausch-/Upgrade-SBCs ohne Team-Rating):
                // 1=Bronze, 2=Silber, 3=Gold.
                // EA benutzt dafür ZWEI Scope-Namen: PLAYER_QUALITY und
                // PLAYER_LEVEL. Bei PLAYER_LEVEL entscheidet der WERT, was
                // gemeint ist - 1..3 ist die Qualitätsstufe, ab 40 ein
                // Mindest-Rating (siehe isPlayerLevel oben). Live verifiziert
                // an einer "genau 1 Bronze-Spieler"-SBC: reqDump lieferte
                // PLAYER_LEVEL mit value 1, und ohne diesen Zweig wurde die
                // Vorgabe komplett ignoriert.
                const isQualityScope = scope.indexOf('QUALITY') > -1 ||
                    (scope.indexOf('LEVEL') > -1 && scope.indexOf('CHEM') === -1);
                if (isQualityScope && v != null && v >= 1 && v <= 3) {
                    out.quality.push({ label: scope, quality: Number(v), count: reqCount(o, par) });
                }
                if (scope.indexOf('RARITY') > -1) {
                    out.rarity.push({
                        label: scope,
                        ids: reqIds(o),
                        count: reqCount(o, par),
                        // Bei RARITY_GROUP ist der Wert die Gruppen-ID -
                        // Karten matchen über ihr "groups"-Feld.
                        groupId: (scope.indexOf('GROUP') > -1 && v != null) ? v : null
                    });
                }
            }
            // Slot-Anzahl (manche SBCs haben < 11 Spieler)
            if (out.slots == null && o.slots != null) {
                const s = parseInt(o.slots, 10);
                if (!isNaN(s) && s >= 1 && s <= 11) out.slots = s;
            }
            // Kinder einreihen
            const childPar = [o].concat(par).slice(0, 2);
            if (Array.isArray(o)) {
                if (o.length <= 2000) {
                    for (const child of o) {
                        if (child && typeof child === 'object') queue.push({ o: child, d: d + 1, par: childPar });
                    }
                }
            } else {
                for (const k in o) {
                    let child;
                    try { child = o[k]; } catch (e) { continue; }
                    if (child && typeof child === 'object' && typeof child !== 'function') {
                        queue.push({ o: child, d: d + 1, par: childPar });
                    }
                }
            }
        }
        // Duplikate entfernen (gleiche label+ids/values)
        function dedupe(arr, keyFn) {
            const seen = new Set(), res = [];
            for (const x of arr) {
                const key = keyFn(x);
                if (!seen.has(key)) { seen.add(key); res.push(x); }
            }
            return res;
        }
        out.rarity = dedupe(out.rarity, rc => rc.label + '|' + rc.ids.join(',') + '|' + rc.count);
        out.playerLevel = dedupe(out.playerLevel, pl => pl.label + '|' + pl.minRating + '|' + pl.count);
        out.quality = dedupe(out.quality, q => q.label + '|' + q.quality + '|' + q.count);
        out.reqs = dedupe(out.reqs, r => r.scope + '|' + r.value + '|' + r.count + '|' + r.ids.join(','));
        return out;
    }
    // Wechsel der aktiven Challenge: alte Anforderungen zurücksetzen, damit
    // nichts von der vorherigen SBC hängen bleibt.
    function setCurrentChallenge(cid) {
        if (cid == null) return;
        cid = parseInt(cid, 10);
        if (isNaN(cid) || STATE.sbc.challengeId === cid) return;
        STATE.sbc.challengeId = cid;
        STATE.sbc.targetOVR = null;
        STATE.sbc.squadId = null;
        STATE.sbc.rarityConstraints = [];
        STATE.sbc.playerLevelConstraints = [];
        STATE.sbc.qualityConstraints = [];
        STATE.sbc.reqDump = [];
        STATE.sbc.formationSlots = 11;
        STATE.sbc.squadSlotTotal = null;
        STATE.sbc.usableSlots = null;
        refreshSbcInfoUI();
    }
    // Im Challenge-Listen-JSON den Knoten der aktuell geöffneten Challenge finden.
    function findChallengeNode(root, cid) {
        if (!root || typeof root !== 'object' || cid == null) return null;
        const seen = new Set();
        const queue = [{ o: root, d: 0 }];
        let visited = 0;
        while (queue.length && visited < 20000) {
            const cur = queue.shift();
            const o = cur.o, d = cur.d;
            if (!o || typeof o !== 'object' || seen.has(o) || d > 6 || isDomOrWindow(o)) continue;
            seen.add(o);
            visited++;
            const oid = (o.challengeId != null) ? o.challengeId : o.id;
            // Nur Knoten akzeptieren, die wie eine Challenge aussehen
            if (oid != null && String(oid) === String(cid) &&
                (o.elgReq || o.requirements || o.eligibilityRequirements || o.name || o.challengeId != null)) {
                return o;
            }
            if (Array.isArray(o)) {
                for (const child of o) {
                    if (child && typeof child === 'object') queue.push({ o: child, d: d + 1 });
                }
            } else {
                for (const k in o) {
                    let child;
                    try { child = o[k]; } catch (e) { continue; }
                    if (child && typeof child === 'object') queue.push({ o: child, d: d + 1 });
                }
            }
        }
        return null;
    }
    // Anforderungen der aktuellen Challenge aus der gecachten Set-Liste ziehen.
    function applyFromSetChallenges() {
        if (!STATE.lastSetChallenges || STATE.sbc.challengeId == null) return;
        const node = findChallengeNode(STATE.lastSetChallenges, STATE.sbc.challengeId);
        if (node) {
            const scan = deepScanChallenge(node);
            applyScan(scan, 'Set-Challenges');
        }
    }
    function parseSbcChallenge(json, url) {
        const u = String(url);
        const sm = u.match(/setId\/(\d+)/i);
        if (sm) STATE.sbc.setId = parseInt(sm[1], 10);
        const cm = u.match(/challengeId\/(\d+)/i) || u.match(/challenge\/(\d+)/i);
        if (cm) setCurrentChallenge(cm[1]);
        // Gesamtzahl der Squad-Slots merken (Startelf + Bank) - wird beim
        // Eintragen gebraucht, die App sendet IMMER alle Slots.
        try {
            if (json && json.squad && Array.isArray(json.squad.players) && json.squad.players.length) {
                STATE.sbc.squadSlotTotal = json.squad.players.length;
            }
        } catch (e) {}
        // BRICK-SLOTS: manche SBCs (Tausch-/Provisions-Upgrades) sperren
        // einen Teil der 11 Slots. playerRequirements sagt exakt, welche
        // Indizes nutzbar sind - dort (und NUR dort) wird eingetragen.
        try {
            if (json && Array.isArray(json.playerRequirements) && json.playerRequirements.length) {
                const usable = [];
                for (const pr of json.playerRequirements) {
                    if (pr && pr.index != null && String(pr.playerType).toUpperCase() !== 'BRICK') {
                        usable.push(Number(pr.index));
                    }
                }
                if (usable.length) {
                    usable.sort((a, b) => a - b);
                    STATE.sbc.usableSlots = usable;
                    STATE.sbc.formationSlots = usable.length;
                    log('Nutzbare SBC-Slots:', usable.join(','), '(' + usable.length + ' von ' + json.playerRequirements.length + ')');
                    refreshSbcInfoUI();
                }
            }
        } catch (e) {}
        const scan = deepScanChallenge(json);
        applyScan(scan, 'Netzwerk');
        // Response selbst enthielt keinen Ziel-OVR (z.B. nur das Squad)?
        // -> Anforderungen aus der gecachten Challenge-Liste des Sets holen.
        if (STATE.sbc.targetOVR == null) applyFromSetChallenges();
    }
    function captureChallengeEntity(challenge) {
        if (!challenge || typeof challenge !== 'object') return;
        STATE.sbc.entity = challenge;
        if (challenge.id != null) setCurrentChallenge(challenge.id);
        if (challenge.setId != null) STATE.sbc.setId = challenge.setId;
        // Brick-Slots auch aus der Live-Entity erkennen (falls kein
        // frischer /squad-GET lief, z.B. bei Cache-Reopen).
        try {
            if (!STATE.sbc.usableSlots && challenge.squad &&
                typeof challenge.squad.getSBCSlots === 'function') {
                const slots = challenge.squad.getSBCSlots();
                if (Array.isArray(slots) && slots.length) {
                    const usable = [];
                    for (const s of slots) {
                        if (!s || s.index == null) continue;
                        const t = (s.playerType != null) ? s.playerType : s._playerType;
                        const brick = s.brick === true || s.isBrick === true ||
                            (t != null && String(t).toUpperCase().indexOf('BRICK') > -1);
                        if (!brick) usable.push(Number(s.index));
                    }
                    if (usable.length && usable.length < slots.length) {
                        usable.sort((a, b) => a - b);
                        STATE.sbc.usableSlots = usable;
                        STATE.sbc.formationSlots = usable.length;
                        log('Nutzbare SBC-Slots (Entity):', usable.join(','));
                    }
                }
            }
        } catch (e) {}
        const scan = deepScanChallenge(challenge);
        applyScan(scan, 'App-Service');
        if (STATE.sbc.targetOVR == null) applyFromSetChallenges();
    }
    function applyScan(scan, source) {
        let changed = false;
        if (scan.target != null) { STATE.sbc.targetOVR = scan.target; changed = true; }
        if (scan.squadId != null) { STATE.sbc.squadId = scan.squadId; changed = true; }
        // usableSlots (aus playerRequirements) ist präziser als jeder
        // "slots"-Fund im Objektbaum - dann nicht überschreiben.
        if (scan.slots != null && !STATE.sbc.usableSlots) { STATE.sbc.formationSlots = scan.slots; changed = true; }
        if (scan.rarity.length) { STATE.sbc.rarityConstraints = scan.rarity; changed = true; }
        if (scan.playerLevel.length) { STATE.sbc.playerLevelConstraints = scan.playerLevel; changed = true; }
        if (scan.quality && scan.quality.length) { STATE.sbc.qualityConstraints = scan.quality; changed = true; }
        if (scan.reqs.length) { STATE.sbc.reqDump = scan.reqs; changed = true; }
        if (changed) {
            log('SBC erkannt (' + source + '):', JSON.stringify({
                setId: STATE.sbc.setId,
                challengeId: STATE.sbc.challengeId,
                squadId: STATE.sbc.squadId,
                targetOVR: STATE.sbc.targetOVR,
                slots: STATE.sbc.formationSlots,
                rarity: STATE.sbc.rarityConstraints
            }));
            refreshSbcInfoUI();
        }
    }
    /**
     * SBC-Daten mit der OFFEN SICHTBAREN Challenge synchronisieren.
     * Der loadChallenge-Hook fängt nicht immer die richtige Challenge (die
     * App bedient Reopenings aus dem Cache, und Submit-/Reward-Antworten
     * können den Zustand verschmutzen - live gesehen nach Pack-Öffnen).
     * Die Wahrheit ist der Live-Controller der offenen Ansicht: dessen
     * _challenge wird hier durch dieselbe Erkennung gezogen wie der Hook.
     * setCurrentChallenge() setzt bei einer anderen Challenge-ID alle
     * Vorgaben sauber zurück.
     */
    function syncSbcWithOpenChallenge() {
        try {
            for (const c of getControllerChain()) {
                const n = (c.constructor && c.constructor.name) || '';
                if (!/sbc/i.test(n)) continue;
                let ch = null;
                for (const key of ['_overviewController', 'leftController', '_leftController']) {
                    const oc = c[key];
                    if (oc && oc._challenge && typeof oc._challenge === 'object') { ch = oc._challenge; break; }
                }
                ch = ch || (c._challenge && typeof c._challenge === 'object' ? c._challenge : null);
                if (ch) {
                    const prevId = STATE.sbc.challengeId;
                    captureChallengeEntity(ch);
                    if (STATE.sbc.challengeId !== prevId) {
                        log('SBC aus offener Ansicht synchronisiert: Challenge', STATE.sbc.challengeId, '(vorher', prevId + ')');
                    }
                    return true;
                }
            }
        } catch (e) { warn('SBC-Sync fehlgeschlagen:', e.message); }
        return false;
    }
    // ========================================================================
    //  3. SPIELER-DATENMODELL & NORMALISIERUNG
    // ========================================================================
    // EVOLUTION-Karten erkennen (EA-intern "Academy"). Die behalten die
    // rareflag einer normalen Karte, sollen aber NIE verbaut werden.
    function isEvolution(raw) {
        try {
            if (raw.academyId != null && Number(raw.academyId) > 0) return true;
            if (raw.academyItemId != null && Number(raw.academyItemId) > 0) return true;
            if (Array.isArray(raw.academyAttributes) && raw.academyAttributes.length) return true;
            if (raw.academyAttributes && typeof raw.academyAttributes === 'object' &&
                Object.keys(raw.academyAttributes).length) return true;
            if (raw.evolutionId != null && Number(raw.evolutionId) > 0) return true;
            if (raw.evolutionData || raw.evoPath || raw.isEvo === true || raw.isAcademy === true) return true;
            // Live verifiziert (fc26): Evos tragen tradableBeforeAcademy
            if (raw.tradableBeforeAcademy !== undefined && raw.tradableBeforeAcademy !== null) return true;
            if (typeof raw.isAcademyItem === 'function' && raw.isAcademyItem()) return true;
        } catch (e) {}
        return false;
    }
    function normalizePlayer(raw, fromStorage) {
        if (!raw || typeof raw !== 'object') return null;
        const itemType = raw.itemType || raw.type;
        if (itemType && String(itemType).toLowerCase() !== 'player') return null;
        // Leihspieler ausschliessen
        if (raw.loans != null && Number(raw.loans) > 0) return null;
        // KONZEPT-SPIELER ausschliessen (nicht im Besitz!) - mehrere mögliche Flags
        if (raw.concept === true || raw.isConcept === true || raw.conceptItem === true) return null;
        try { if (typeof raw.isConcept === 'function' && raw.isConcept()) return null; } catch (e) {}
        // EVOLUTIONS niemals verwenden
        if (isEvolution(raw)) { STATE.diag.evoExcluded++; return null; }
        const id = raw.id || raw.itemId;
        const rating = parseInt(raw.rating != null ? raw.rating : raw.ovr, 10);
        if (id == null || isNaN(rating)) return null;
        const rareflag = raw.rareflag != null ? raw.rareflag
                       : (raw.rarityId != null ? raw.rarityId : raw.rarity);
        const rf = parseInt(rareflag, 10);
        const isGold = isNormalCard(rf);
        return {
            id: id,
            assetId: raw.assetId || raw.definitionId || raw.resourceId || id,
            rating: rating,
            rareflag: isNaN(rf) ? null : rf,
            isGold: isGold,
            isSpecial: !isGold,
            isStorage: !!fromStorage,
            name: resolvePlayerName(raw),
            untradeable: raw.untradeable === true || raw.tradeable === false,
            // Rarity-GRUPPEN der Karte (live verifiziert, fc26): darüber lassen
            // sich Vorgaben wie "TOTW/TOTS/FOF/FUTTIES" (Gruppe 83) EXAKT matchen.
            groups: Array.isArray(raw.groups) ? raw.groups.map(Number) : null,
            raw: raw // Original behalten - wird fürs Eintragen über App-Services gebraucht
        };
    }
    function resolvePlayerName(raw) {
        const sd = raw.staticData || raw._staticData || {};
        return raw.name ||
               raw.commonName ||
               sd.name ||
               sd.commonName ||
               ((sd.firstName || raw.firstName || '') + ' ' + (sd.lastName || raw.lastName || '')).trim() ||
               ('#' + (raw.assetId || raw.definitionId || raw.id));
    }
    // ---- Gesperrte Karten aus PaleTools übernehmen --------------------------
    // PaleTools hat ein "lockPlayers"-Feature (Schloss auf der Karte) und warnt
    // sogar selbst, wenn eine gelockte Karte in eine SBC wandert
    // (plugins.lockPlayers.messages.sbcWarning). Wer eine Karte sperrt, will
    // sie behalten - also darf der Solver sie nicht verbauen.
    //
    // Der localStorage-KEY ist nicht dokumentiert und im Bundle nur dynamisch
    // zusammengesetzt ('paletools:' + …), deshalb wird formatunabhängig
    // gesucht: alle Keys mit "paletools", darin jeder Zweig, dessen Name "lock"
    // enthält, und daraus alles, was wie eine Item-ID aussieht (12-stellig).
    // Item-IDs können als Array-Werte ODER als Objekt-Keys vorliegen -> beides.
    function looksLikeItemId(x) {
        const n = Number(x);
        return isFinite(n) && n > 1e11 && n < 1e14 && Math.floor(n) === n;
    }
    function harvestIds(v, out, depth) {
        if (v == null || depth > 5 || out.size > 5000) return;
        if (looksLikeItemId(v)) { out.add(String(Number(v))); return; }
        if (Array.isArray(v)) { for (const x of v) harvestIds(x, out, depth + 1); return; }
        if (typeof v === 'object') {
            for (const k in v) {
                // { "916543482768": true } - der KEY ist die ID
                if (looksLikeItemId(k) && v[k]) out.add(String(Number(k)));
                harvestIds(v[k], out, depth + 1);
            }
        }
    }
    function findLockBranches(o, out, depth) {
        if (!o || depth > 6 || typeof o !== 'object') return;
        if (Array.isArray(o)) { for (const x of o) findLockBranches(x, out, depth + 1); return; }
        for (const k in o) {
            if (/lock/i.test(k)) harvestIds(o[k], out, 0);
            findLockBranches(o[k], out, depth + 1);
        }
    }
    function readPaletoolsLocks() {
        const ids = new Set();
        let keysScanned = 0;
        const keyInfo = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || k.toLowerCase().indexOf('paletools') < 0) continue;
                keysScanned++;
                // Key-Namen + Groesse in die Diagnose: findet die Suche unten
                // nichts, ist hier zu sehen, WO PaleTools seine Sperrliste
                // ablegt (der Key ist im Bundle nur dynamisch zusammengesetzt).
                try {
                    const val = localStorage.getItem(k) || '';
                    keyInfo.push({ key: k, len: val.length,
                                   head: val.slice(0, 120) });
                } catch (e) {}
                let raw = null;
                try { raw = localStorage.getItem(k); } catch (e) { continue; }
                if (!raw) continue;
                let obj = null;
                try { obj = JSON.parse(raw); } catch (e) { continue; }
                // Steht der Key selbst schon für die Sperrliste, ist der ganze
                // Wert die Quelle - sonst nur die "lock"-Zweige darin.
                if (/lock/i.test(k)) harvestIds(obj, ids, 0);
                else findLockBranches(obj, ids, 0);
            }
        } catch (e) { warn('Locks lesen fehlgeschlagen:', e && e.message); }
        STATE.diag.locks = {
            keysScanned: keysScanned,
            found: ids.size,
            sample: Array.from(ids).slice(0, 5),
            // Nur noetig, wenn found = 0: daran ist der richtige Key ablesbar.
            keys: keyInfo.slice(0, 12)
        };
        return ids;
    }
    // ---- Namen zur ANZEIGEZEIT auflösen -------------------------------------
    // Die rohen Club-/Storage-Items enthalten KEINEN Namen (im Diagnose-Report
    // an `rawKeys` zu sehen: nur assetId, rating, groups …) - deshalb landete in
    // der Vorschau immer "#assetId". Die App löst Namen über ihre eigenen
    // Item-Entities auf; ein solches wird hier bei Bedarf über dieselbe Factory
    // gebaut, die auch das Eintragen benutzt.
    // BEWUSST erst beim Anzeigen und mit Cache: für 8000 Pool-Karten wäre das
    // viel zu teuer, für die 11-55 angezeigten ist es unkritisch.
    const nameCache = new Map();
    function entityName(it) {
        if (!it) return null;
        const cands = [];
        try { if (typeof it.getStaticData === 'function') cands.push(it.getStaticData()); } catch (e) {}
        cands.push(it._staticData, it.staticData, it);
        for (const sd of cands) {
            if (!sd || typeof sd !== 'object') continue;
            const cn = sd.commonName || sd.name;
            if (cn && String(cn).trim()) return String(cn).trim();
            const full = ((sd.firstName || '') + ' ' + (sd.lastName || '')).trim();
            if (full) return full;
        }
        return null;
    }
    function displayName(p) {
        if (!p) return '?';
        const key = String(p.assetId || p.id);
        if (nameCache.has(key)) return nameCache.get(key);
        let n = null;
        // Falls EA den Namen doch mitliefert (dann ist er nicht "#…").
        if (p.name && String(p.name).charAt(0) !== '#') n = p.name;
        if (!n && p.raw && typeof window.UTItemEntityFactory === 'function') {
            try { n = entityName(new window.UTItemEntityFactory().createItem(p.raw)); }
            catch (e) {}
        }
        n = n || p.name || ('#' + key);
        nameCache.set(key, n);
        return n;
    }
    // Spieler in den Pool mergen. Storage-Flag gewinnt bei Duplikaten.
    function mergeIntoPool(players) {
        let added = 0;
        for (const p of players) {
            if (!p) continue;
            const existing = STATE.poolById.get(p.id);
            if (!existing) { STATE.poolById.set(p.id, p); added++; }
            else if (p.isStorage && !existing.isStorage) STATE.poolById.set(p.id, p);
        }
        if (added) {
            STATE.pool = Array.from(STATE.poolById.values());
            refreshSbcInfoUI();
        }
        return added;
    }
    // Verbaute Karten aus dem Pool nehmen (nach erfolgreichem Eintragen) -
    // so bleibt der Pool ohne Neu-Laden für die nächste SBC nutzbar.
    function removeFromPool(players) {
        try {
            let removed = 0;
            for (const p of players) {
                if (p && STATE.poolById.delete(p.id)) removed++;
            }
            if (removed) {
                STATE.pool = Array.from(STATE.poolById.values());
                if (ui.poolcount) ui.poolcount.textContent = String(STATE.pool.length);
                refreshSbcInfoUI();
                log(removed + ' verbaute Karten aus dem Pool entfernt (' + STATE.pool.length + ' übrig).');
            }
        } catch (e) { warn('removeFromPool:', e.message); }
    }
    function harvestItems(json, fromStorage) {
        const items = extractItems(json);
        if (!items.length) return 0;
        const players = [];
        for (const it of items) {
            const p = normalizePlayer(it, fromStorage);
            if (p) players.push(p);
        }
        const n = mergeIntoPool(players);
        if (n) log('Passiv erfasst:', n, 'Spieler (storage=' + !!fromStorage + ')');
        return n;
    }
    function extractItems(json) {
        if (!json) return [];
        if (Array.isArray(json.itemData)) return json.itemData;
        if (Array.isArray(json.items)) return json.items;
        if (Array.isArray(json.entries)) return json.entries;
        if (Array.isArray(json)) return json;
        return [];
    }
    // ========================================================================
    //  4. DATENZUGRIFF
    // ------------------------------------------------------------------------
    //  Ebene A: interne App-Services (window.services...) - bevorzugt,
    //           denn sie funktionieren ohne eigene Session-Header.
    //  Ebene B: direkte HTTP-Calls mit gecapturten Session-Headern.
    // ========================================================================
    function servicesAvailable() {
        try {
            return typeof window.services === 'object' && !!window.services &&
                   !!window.services.Club && !!window.services.Item;
        } catch (e) { return false; }
    }
    // ---- Ebene A: App-Services ----------------------------------------------
    function obsPromise(observable) {
        // EA-Observable -> Promise. observe(this, cb), cb(sender, response)
        return new Promise(function (resolve, reject) {
            const OBS = {};
            let done = false;
            try {
                observable.observe(OBS, function (sender, response) {
                    if (done) return;
                    done = true;
                    try { sender.unobserve(OBS); } catch (e) {}
                    resolve(response);
                });
            } catch (e) { reject(e); }
            setTimeout(function () {
                if (!done) { done = true; reject(new Error('Timeout beim Warten auf App-Service.')); }
            }, 30000);
        });
    }
    function responseItems(response) {
        if (!response) return [];
        const r = response.response || response.data || response;
        if (r && Array.isArray(r.items)) return r.items;
        if (Array.isArray(r)) return r;
        return [];
    }
    function responseOk(response) {
        if (!response) return false;
        if (response.success === false) return false;
        if (typeof response.status === 'number' && response.status >= 400) return false;
        return true;
    }
    async function fetchClubViaServices(onProgress) {
        const all = [];
        const svm = new window.UTBucketedItemSearchViewModel();
        const criteria = svm.searchCriteria;
        if (typeof window.SearchType !== 'undefined' && window.SearchType.PLAYER != null) {
            criteria.type = window.SearchType.PLAYER;
        }
        // Konzept-Spieler explizit ausschliessen, falls das Kriterium existiert
        try { if ('concept' in criteria) criteria.concept = false; } catch (e) {}
        const count = criteria.count || 91;
        let offset = 0;
        let rawSeen = 0;
        for (let page = 0; page < 300; page++) {
            if (STATE.cancelLoad) break;
            criteria.offset = offset;
            const response = await obsPromise(window.services.Club.search(criteria));
            if (!responseOk(response)) throw new Error('Club-Suche über App-Service fehlgeschlagen.');
            const items = responseItems(response);
            rawSeen += items.length;
            for (const it of items) {
                const p = normalizePlayer(it, false);
                if (p) all.push(p);
            }
            mergeIntoPool(all.splice(0));
            if (onProgress) onProgress(STATE.pool.length, null);
            if (items.length < count) break;
            // Notbremse: die Suche liefert offenbar auch Konzept-Spieler /
            // die ganze Datenbank. Die eigenen Karten sind zu diesem Zeitpunkt
            // längst im Pool (Konzept-Filter greift beim Normalisieren) -
            // also NICHT hart abbrechen, sondern mit dem Stand weitermachen.
            if (rawSeen > 30000) {
                warn('Club-Suche gestoppt nach ' + rawSeen + ' Roh-Items (Konzept-Datenbank?). Pool-Stand: ' + STATE.pool.length);
                diagError('Services-Club-Suche nach ' + rawSeen + ' Items gestoppt (Pool: ' + STATE.pool.length + ')');
                break;
            }
            offset += items.length;
        }
        return rawSeen;
    }
    async function fetchUnassignedViaServices() {
        const out = [];
        try {
            if (typeof window.services.Item.requestUnassignedItems === 'function') {
                const response = await obsPromise(window.services.Item.requestUnassignedItems());
                for (const it of responseItems(response)) {
                    const p = normalizePlayer(it, false);
                    if (p) out.push(p);
                }
            }
        } catch (e) { warn('Unassigned via App-Service fehlgeschlagen:', e); }
        return out;
    }
    async function fetchStorageViaServices() {
        const out = [];
        try {
            const svc = window.services.Item;
            const fns = ['requestStorageItems', 'requestSbcStorageItems'];
            for (const fn of fns) {
                if (typeof svc[fn] === 'function') {
                    const response = await obsPromise(svc[fn]());
                    for (const it of responseItems(response)) {
                        const p = normalizePlayer(it, true);
                        if (p) out.push(p);
                    }
                    if (out.length) break;
                }
            }
        } catch (e) { warn('Storage via App-Service fehlgeschlagen:', e); }
        return out;
    }
    // ---- Ebene B: direkte HTTP-Calls ----------------------------------------
    function sessionReady() {
        return !!(STATE.session.apiBase && STATE.session.sid);
    }
    function apiHeaders() {
        const h = { 'Accept': 'application/json' };
        const s = STATE.session;
        if (s.sid) h['X-UT-SID'] = s.sid;
        if (s.phishing) h['X-UT-PHISHING-TOKEN'] = s.phishing;
        if (s.route) h['X-UT-Route'] = s.route;
        if (s.nucleusId) h['Easw-Session-Data-Nucleus-Id'] = s.nucleusId;
        return h;
    }
    // WICHTIG: credentials 'omit'! Die Auth läuft komplett über die
    // X-UT-Header. Mit credentials:'include' blockiert der Browser die
    // Cross-Origin-Requests zur utas-API (CORS + Wildcard-Origin).
    function httpErrText(method, path, status) {
        return method + ' ' + path + ' -> HTTP ' + status +
            (status === 401 ? ' (Session abgelaufen? Kurz in der App navigieren, z.B. Verein öffnen, dann erneut versuchen.)' : '');
    }
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // Session-Refresh erzwingen: einen App-eigenen Request anstossen. Der darf
    // selbst mit 401 scheitern - die App re-authet daraufhin und unsere
    // Interception schnappt die FRISCHE SID auf. Entscheidend: wir warten,
    // bis die SID sich WIRKLICH geändert hat (Re-Auth braucht Zeit; ein fixer
    // 400ms-Schlaf war zu kurz - der Retry lief dann mit der alten SID los).
    async function nudgeSession() {
        const oldSid = STATE.session.sid;
        const svc = window.services && window.services.Item;
        // Verschiedene App-Requests durchprobieren: requestUnassignedItems
        // kann aus dem App-Cache bedient werden (kein Netz-Request -> keine
        // Re-Auth beobachtbar). Tradepile/Watchlist gehen zuverlässiger raus.
        const pokeFns = ['requestUnassignedItems', 'requestTradeItems', 'requestWatchedItems'];
        let pokeIdx = 0;
        const poke = async () => {
            try {
                for (let t = 0; t < pokeFns.length; t++) {
                    const fn = pokeFns[(pokeIdx + t) % pokeFns.length];
                    if (svc && typeof svc[fn] === 'function') {
                        pokeIdx = (pokeIdx + t + 1) % pokeFns.length;
                        await obsPromise(svc[fn]());
                        return;
                    }
                }
            } catch (e) {}
        };
        await poke();
        for (let i = 0; i < 32; i++) { // bis zu 8 Sekunden
            if (STATE.session.sid && STATE.session.sid !== oldSid) {
                log('Session erneuert (neue SID nach ' + ((i + 1) * 0.25).toFixed(1) + 's).');
                return true;
            }
            await sleep(250);
            // Weitere Anstösse über WECHSELNDE Endpunkte, falls der erste
            // aus dem Cache kam oder die App den 401 geschluckt hat.
            if (i === 8 || i === 20) await poke();
        }
        // SID unverändert heisst NICHT zwingend Fehler: bei einem
        // Rate-Limit-401 ist die Session noch gültig - der Aufrufer soll
        // nach kurzem Cooldown einfach nochmal versuchen.
        warn('Session-Nudge: SID unverändert (Session evtl. noch gültig / Rate-Limit).');
        return false;
    }
    async function apiGet(path, _attempt) {
        const url = STATE.session.apiBase + path.replace(/^\//, '');
        let resp;
        try {
            resp = await _origFetch(url, { method: 'GET', headers: apiHeaders(), credentials: 'omit' });
        } catch (e) {
            diagError('GET ' + path + ' -> ' + (e.message || e));
            throw e;
        }
        if (!resp.ok) {
            // 401 heisst entweder "Session abgelaufen" ODER "zu schnell"
            // (Rate-Limit). Versuch 1: App-Re-Auth anstossen. Versuch 2:
            // schlichter Cooldown - bei Rate-Limit ist die Session gültig.
            if (resp.status === 401 && (_attempt || 0) < 2) {
                if ((_attempt || 0) === 0) { await nudgeSession(); }
                else { await sleep(3000); }
                return apiGet(path, (_attempt || 0) + 1);
            }
            diagError('GET ' + path + ' -> HTTP ' + resp.status);
            throw new Error(httpErrText('GET', path, resp.status));
        }
        return resp.json();
    }
    async function apiPut(path, body, _attempt) {
        const url = STATE.session.apiBase + path.replace(/^\//, '');
        const headers = apiHeaders();
        headers['Content-Type'] = 'application/json';
        let resp;
        try {
            resp = await _origFetch(url, {
                method: 'PUT', headers: headers, credentials: 'omit',
                body: JSON.stringify(body)
            });
        } catch (e) {
            diagError('PUT ' + path + ' -> ' + (e.message || e));
            throw e;
        }
        if (!resp.ok) {
            if (resp.status === 401 && (_attempt || 0) < 2) {
                if ((_attempt || 0) === 0) { await nudgeSession(); }
                else { await sleep(3000); }
                return apiPut(path, body, (_attempt || 0) + 1);
            }
            // Fehler-BODY mitloggen - EA schreibt dort den Ablehnungsgrund
            // (z.B. "item not owned" bei veraltetem Pool).
            let bodyTxt = '';
            try { bodyTxt = (await resp.text()).slice(0, 200); } catch (e) {}
            diagError('PUT ' + path + ' -> HTTP ' + resp.status + (bodyTxt ? ' BODY: ' + bodyTxt : ''));
            throw new Error(httpErrText('PUT', path, resp.status));
        }
        try { return await resp.json(); } catch (e) { return {}; }
    }
    async function fetchClubViaHttp(onProgress) {
        let page = 0;
        let found = 0;
        const count = 91;
        let total = Infinity;
        let gotAny = false;
        STATE.loadIncomplete = false;
        while (page * count < total) {
            if (STATE.cancelLoad) break;
            const start = page * count;
            const path = 'club?sort=desc&sortBy=value&type=player&count=' + count + '&start=' + start;
            let json = null;
            // Pro Seite bis zu 3 Versuche (apiGet macht bei 401 zusätzlich
            // selbst einen Nudge+Retry) - abgelaufene Sessions mitten im
            // Laden haben sonst den halben Pool gekostet.
            for (let attempt = 0; attempt < 3 && !json; attempt++) {
                try { json = await apiGet(path); }
                catch (e) {
                    warn('Club-Fetch Fehler Seite', page, 'Versuch', attempt + 1, e.message);
                    if (attempt < 2) await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
                }
            }
            if (!json) {
                if (!gotAny) throw new Error('Club-Laden fehlgeschlagen (Session?). Bitte kurz in der App navigieren und erneut versuchen.');
                STATE.loadIncomplete = true;
                break;
            }
            gotAny = true;
            // Kurz atmen zwischen den Seiten - zu schnelle Pagination
            // provoziert Rate-Limit-401er (live bestätigt: 120ms war zu
            // schnell, Abbruch bei Seite ~55). 250ms ist der bewährte Wert.
            await new Promise(r => setTimeout(r, 250));
            const items = extractItems(json);
            if (json.totalItemCount != null) total = json.totalItemCount;
            else if (json.total != null) total = json.total;
            else if (items.length < count) total = start + items.length;
            const players = [];
            for (const it of items) {
                const p = normalizePlayer(it, false);
                if (p) players.push(p);
            }
            found += players.length;
            mergeIntoPool(players);
            if (onProgress) onProgress(STATE.pool.length, total === Infinity ? null : total);
            if (items.length === 0) break;
            page++;
            if (page > 300) break;
        }
        return found;
    }
    async function fetchUnassignedViaHttp() {
        const out = [];
        try {
            const json = await apiGet('purchased/items');
            for (const it of extractItems(json)) {
                const p = normalizePlayer(it, false);
                if (p) out.push(p);
            }
        } catch (e) { warn('Unassigned-Fetch Fehler:', e); }
        return out;
    }
    async function fetchStorageViaHttp() {
        const out = [];
        // "storagepile" ist der echte Endpunkt (live verifiziert, fc26).
        try {
            const json = await apiGet('storagepile');
            for (const it of extractItems(json)) {
                const p = normalizePlayer(it, true);
                if (p) out.push(p);
            }
        } catch (e) { warn('storagepile-Fetch Fehler:', e.message); }
        return out;
    }
    // ---- Kombinierter Pool-Load ---------------------------------------------
    async function loadPool(onProgress) {
        const canServices = servicesAvailable() &&
                            typeof window.UTBucketedItemSearchViewModel === 'function';
        if (!canServices && !sessionReady()) {
            throw new Error('Weder App-Services noch Session verfügbar. Bitte einmal durch die Web-App navigieren (z.B. Verein öffnen) und erneut versuchen. Details: Diagnose-Button.');
        }
        STATE.cancelLoad = false;
        let clubCount = 0, unassigned = [], storage = [];
        // PRIMÄR: HTTP-Club-Endpunkt. Der liefert nur Karten, die du wirklich
        // besitzt (keine Konzept-Spieler) und ist der dokumentierte Weg.
        if (sessionReady()) {
            log('Lade Pool über HTTP...');
            try {
                clubCount = await fetchClubViaHttp(onProgress);
            } catch (e) {
                warn('HTTP-Weg fehlgeschlagen:', e);
                clubCount = 0;
            }
        }
        // FALLBACK: App-Services (mit Konzept-Filter + Notbremse), nur wenn
        // der HTTP-Weg nichts geliefert hat. Fehler hier sind nicht fatal -
        // Storage/Unassigned werden trotzdem noch geladen.
        if (!clubCount && canServices && !STATE.cancelLoad) {
            log('Lade Pool über App-Services (Fallback)...');
            try {
                await fetchClubViaServices(onProgress);
            } catch (e) {
                warn('Services-Fallback fehlgeschlagen:', e);
                diagError('Services-Fallback: ' + (e.message || e));
            }
        }
        if (!STATE.cancelLoad) {
            unassigned = sessionReady() ? await fetchUnassignedViaHttp() : [];
            if (!unassigned.length && canServices) unassigned = await fetchUnassignedViaServices();
            storage = sessionReady() ? await fetchStorageViaHttp() : [];
            if (!storage.length && canServices) storage = await fetchStorageViaServices();
        }
        mergeIntoPool(unassigned);
        mergeIntoPool(storage); // Storage zuletzt: Storage-Flag gewinnt beim Merge
        log('Pool geladen:', STATE.pool.length, 'Spieler (Storage:', storage.length,
            ', Unassigned:', unassigned.length, ')' + (STATE.cancelLoad ? ' [abgebrochen]' : ''));
        if (STATE.loadIncomplete || (!storage.length && !STATE.cancelLoad)) {
            toast('ACHTUNG: Pool evtl. unvollständig geladen (' + STATE.pool.length + ' Karten' +
                (!storage.length ? ', kein Storage' : '') + '). Bitte "Spieler laden" erneut ausführen.', 'warn');
        }
        return STATE.pool;
    }
    // ========================================================================
    //  5. SOLVER  (exakter DP, rein Rating-basiert)
    // ------------------------------------------------------------------------
    //  Team-Rating-Formel: teamOVR = Math.round(sum / N)
    //  Für Ziel T gilt: minSum = N*T - floor(N/2)
    //
    //  Der Solver ist ein bounded-knapsack DP über Rating-Gruppen:
    //   - PRIMÄR: minimale Gesamtsumme >= minSum (= minimaler Waste, exakt)
    //   - SEKUNDÄR: Karten aus häufigen Ratings bevorzugen (Scarcity-Kosten
    //     1/Anzahl) -> seltene Ratings werden geschont
    //   - Innerhalb eines Ratings werden Karten in Prioritätsreihenfolge
    //     konsumiert: Storage-Gold -> Storage-Special -> Verein-Gold ->
    //     Verein-Special
    // ========================================================================
    // [SOLVER-BEGIN]
    const SolverCore = (function () {
        function priorityOf(p) {
            if (p.isStorage && p.isGold) return 1;
            if (p.isStorage && p.isSpecial) return 2;
            if (!p.isStorage && p.isGold) return 3;
            return 4; // Verein + Special
        }
        // Konsum-Reihenfolge innerhalb eines Ratings:
        //  1. Priorität (Storage-Gold -> Storage-Special -> Verein-Gold -> Verein-Special)
        //  2. Spieler-Duplikate: vom GRÖSSTEN Stapel desselben Spielers zuerst
        function makeConsumeCmp(list) {
            const counts = new Map();
            for (const p of list) {
                const k = (p.assetId != null) ? p.assetId : p.name;
                counts.set(k, (counts.get(k) || 0) + 1);
            }
            return function (a, b) {
                const pa = priorityOf(a), pb = priorityOf(b);
                if (pa !== pb) return pa - pb;
                const ka = (a.assetId != null) ? a.assetId : a.name;
                const kb = (b.assetId != null) ? b.assetId : b.name;
                return (counts.get(kb) || 0) - (counts.get(ka) || 0);
            };
        }
        /**
         * EXAKTE Squad-Rating-Formel von EA FC (community-verifiziert,
         * gleiche Formel wie im FC26-Solver von Regista6 / EasySBC):
         *   avg    = summe / n
         *   excess = SUMME( rating_i - avg )  für alle rating_i > avg
         *   rating = floor( round(summe + excess) / n )
         * Hohe Karten zählen also doppelt: in der Summe UND im Excess.
         */
        function squadRating(ratings) {
            const n = ratings.length;
            if (!n) return 0;
            let sum = 0;
            for (const r of ratings) sum += r;
            const avg = sum / n;
            let excess = 0;
            for (const r of ratings) if (r > avg) excess += r - avg;
            return Math.floor(Math.round(sum + excess) / n);
        }
        // Exakter Dezimalwert (wie ihn PaleTools anzeigt, z.B. 84.18)
        function squadRatingExact(ratings) {
            const n = ratings.length;
            if (!n) return 0;
            let sum = 0;
            for (const r of ratings) sum += r;
            const avg = sum / n;
            let excess = 0;
            for (const r of ratings) if (r > avg) excess += r - avg;
            return (sum + excess) / n;
        }
        // Ganzzahliges Rating-Mass V = N*(summe + excess) = N*sum + SUMME max(0, N*r - sum).
        // exakt = V / N². Das ist die Grösse, die minimiert wird ("84.0x statt 84.7").
        function squadV(ratings) {
            const n = ratings.length;
            let sum = 0;
            for (const r of ratings) sum += r;
            let v = n * sum;
            for (const r of ratings) {
                const d = n * r - sum;
                if (d > 0) v += d;
            }
            return v;
        }
        // Rating-Kosten-Tabelle (Pack-Ökonomie), editierbar im Panel.
        // Standard = Rasmus' Tabelle (Stand FUTTIES-Phase FC26).
        // Rasmus' Bewertung, Stand Aug 2026: 86er sind nicht mehr knapp und
        // liegen jetzt auf derselben Stufe wie 87-88, 85er ebenfalls billiger
        // (er hat davon reichlich). Die Tabelle ist im Panel editierbar und
        // wird in localStorage gemerkt - eine Änderung hier greift nur, wenn
        // dort noch nichts gespeichert ist oder "Zurücksetzen" gedrückt wird.
        const DEFAULT_RATING_COST_SPEC = '0-80:0, 81-83:2, 84:1, 85-88:2, 89-90:3, 91-92:4, 93+:12';
        function parseRatingCosts(spec) {
            const costs = new Array(100).fill(0);
            if (spec) {
                const tokens = String(spec).split(/[,;\n]+/);
                for (const t of tokens) {
                    const m = t.trim().match(/^(\d{1,2})(?:\s*-\s*(\d{1,2})|\s*\+)?\s*:\s*(\d+(?:[.,]\d+)?)$/);
                    if (!m) continue;
                    const lo = parseInt(m[1], 10);
                    const hi = m[2] != null ? parseInt(m[2], 10) : (t.indexOf('+') > -1 ? 99 : lo);
                    const cost = parseFloat(m[3].replace(',', '.'));
                    for (let r = lo; r <= Math.min(99, hi); r++) costs[r] = cost;
                }
            }
            return function (r) {
                r = Math.max(0, Math.min(99, r | 0));
                return costs[r] || 0;
            };
        }
        // TOTW-Karte (Team of the Week / Inform): rareflag 3.
        function isTotw(p) { return Number(p.rareflag) === 3; }
        // Gewicht der Summen-Überschreitung. Klein => innerhalb des
        // erlaubten Waste-Fensters entscheiden die KARTEN-Kosten.
        // Mit Max-Waste = 0 (Standard) ist das Fenster {stMin}, d.h. die
        // minimale Summe ist die harte Prämisse und die Karten-Kosten
        // brechen nur Gleichstände AUF der Minimalsumme. Erst wer Max-Waste
        // erhöht, erlaubt bewusst etwas mehr Summe, um teure Karten
        // (96er/93+) zu schonen.
        const WASTE_WEIGHT = 0.05;
        function matchesRarity(p, c) {
            if (!c) return p.isSpecial;
            // EXAKTES Matching über Rarity-GRUPPEN (live verifiziert, fc26):
            // Vorgabe "PLAYER_RARITY_GROUP 83" <=> 83 in p.groups.
            if (c.groupId != null && Array.isArray(p.groups)) {
                return p.groups.indexOf(Number(c.groupId)) > -1;
            }
            if (c.ids && c.ids.length) {
                const rf = Number(p.rareflag);
                return c.ids.map(Number).indexOf(rf) > -1;
            }
            // Fallback-Heuristik ohne Gruppen-Info: irgendeine Special-Karte
            return p.isSpecial;
        }
        /**
         * Bounded-Knapsack-DP mit Kartenkosten.
         * Liefert für jedes (Anzahl j, exp-Zähler e, Summe s) die minimalen
         * Kosten und kann die konkreten Spieler rekonstruieren.
         */
        function buildDp(players, kMax, sMax, costOf, exp, cmp) {
            const groups = new Map();
            for (const p of players) {
                if (!groups.has(p.rating)) groups.set(p.rating, []);
                groups.get(p.rating).push(p);
            }
            const ratings = Array.from(groups.keys()).sort((a, b) => a - b);
            // Verbrauchsreihenfolge innerhalb eines Ratings: KOSTEN zuerst
            // (Rarity-Schutz & Band-Kosten wirken), Konsum-Präferenz
            // (Storage, Duplikat-Stapel) als Tiebreak.
            for (const r of ratings) groups.get(r).sort((a, b) => (costOf(a) - costOf(b)) || cmp(a, b));
            const E = exp ? Math.max(0, exp.budget) + 1 : 1;
            const S = Math.max(0, sMax) + 1;
            const size = (kMax + 1) * E * S;
            const idx = (j, e, s) => (j * E + e) * S + s;
            let cur = new Float64Array(size).fill(Infinity);
            cur[idx(0, 0, 0)] = 0;
            const stageChoices = [];
            for (const r of ratings) {
                const list = groups.get(r);
                const c = Math.min(list.length, kMax);
                // kumulierte Kosten in Konsum-Reihenfolge
                const qCost = [0];
                for (let q = 1; q <= c; q++) qCost.push(qCost[q - 1] + costOf(list[q - 1]));
                const isExp = !!(exp && r >= exp.th);
                const next = new Float64Array(size).fill(Infinity);
                const choice = new Uint8Array(size);
                for (let j = 0; j <= kMax; j++) {
                    for (let e = 0; e < E; e++) {
                        for (let s = 0; s < S; s++) {
                            const base = cur[idx(j, e, s)];
                            if (base === Infinity) continue;
                            for (let q = 0; q <= c; q++) {
                                const nj = j + q;
                                if (nj > kMax) break;
                                const ns = s + q * r;
                                if (ns >= S) break;
                                const ne = isExp ? e + q : e;
                                if (ne >= E) break;
                                const cost = base + qCost[q];
                                const ii = idx(nj, ne, ns);
                                if (cost < next[ii]) { next[ii] = cost; choice[ii] = q; }
                            }
                        }
                    }
                }
                stageChoices.push(choice);
                cur = next;
            }
            return {
                E: E, S: S,
                cost: function (j, e, s) {
                    if (j < 0 || j > kMax || e < 0 || e >= E || s < 0 || s >= S) return Infinity;
                    return cur[idx(j, e, s)];
                },
                reconstruct: function (j, e, s) {
                    const picked = [];
                    for (let t = ratings.length - 1; t >= 0; t--) {
                        const r = ratings[t];
                        const isExp = !!(exp && r >= exp.th);
                        const q = stageChoices[t][idx(j, e, s)];
                        if (q > 0) {
                            const list = groups.get(r);
                            for (let x = 0; x < q; x++) picked.push(list[x]);
                            j -= q; s -= q * r;
                            if (isExp) e -= q;
                        }
                    }
                    return picked;
                }
            };
        }
        /**
         * Kern-Solver v3 - rechnet mit der ECHTEN Squad-Rating-Formel.
         *
         * Mathematische Grundlage: Für Gesamtsumme S und "Booster" (Spieler
         * über dem Durchschnitt, Anzahl b, Ratingsumme H) gilt
         *   rating >= T  <=>  N*(S + H) - b*S >= N²*T - floor(N/2)
         * Booster sind genau die Spieler mit rating >= floor(S/N)+1.
         * Der Solver sucht die kleinste machbare Gesamtsumme (stMin) und
         * optimiert im Fenster [stMin, stMin+maxWaste] die Kartenkosten.
         * Waste ist also relativ zum POOL-Minimum definiert.
         */
        /**
         * Rarity-Schutz als HARTE Grenze (Rasmus): Karten der geschützten
         * Gruppen (TOTW/TOTS/FOF/FUTTIES) werden für künftige SBC-Vorgaben
         * gebraucht. Fordert die SBC N davon, werden GENAU N reserviert und
         * alle weiteren gesperrt - lieber eine hohe Gold-Karte aus dem Verein
         * als unnötig eine zweite FUTTIES aus dem Storage.
         *
         * Warum hart und nicht über die Kosten: der Aufschlag (+8) konnte den
         * Storage-Rabatt nicht überstimmen. costOf halbiert die Basis für
         * Storage-Karten, und die Basis wächst mit alpha/n bei seltenen hohen
         * Ratings - ein 92er FUTTIES aus dem Storage landete bei 12.5, das
         * gleichwertige Vereins-Gold bei 13. Live passiert bei einem 90er-Team
         * (zwei FUTTIES verbaut, eine gefordert). Kosten-Feintuning hätte das
         * nur verschoben, nicht behoben.
         *
         * Ist die SBC so nicht lösbar, wird die Sperre aufgehoben und gewarnt -
         * gleiches Muster wie bei "max. teure Spieler".
         */
        function solve(poolAll, cfg) {
            const strict = solveCore(poolAll, cfg, true);
            if (strict && strict.ok) return strict;
            const loose = solveCore(poolAll, cfg, false);
            if (loose && loose.ok) {
                loose.warnings = (loose.warnings || []).concat(
                    'Ohne zusätzliche geschützte Karten (TOTW/TOTS/FOF/FUTTIES) ist die ' +
                    'SBC mit diesem Pool nicht lösbar - Schutz gelockert.');
                return loose;
            }
            // Beide gescheitert: die Meldung des LOCKEREN Versuchs ist die
            // aussagekräftigere (die Sperre war dort nicht die Ursache).
            return loose || strict;
        }
        function solveCore(poolAll, cfg, limitProtected) {
            const warnings = [];
            const N = cfg.slots || 11;
            const target = cfg.targetOVR;
            // ---- Pool filtern ----
            const minRating = cfg.minRating || 0;
            // Qualitäts-Vorgabe (Tausch-/Upgrade-SBCs): 1=Bronze(<=64),
            // 2=Silber(65-74), 3=Gold(>=75). Gilt als Band-Filter für das
            // ganze Team; bei mehreren Vorgaben zählt die höchste Qualität.
            let qLo = minRating, qHi = 99, qualityLabel = null, qualityLow = false;
            const qcs = (cfg.applyRarity === false) ? [] : (cfg.qualityConstraints || []);
            if (qcs.length) {
                const QBAND = { 1: [0, 64], 2: [65, 74], 3: [75, 99] };
                const q = qcs.reduce((m, c) => Math.max(m, Number(c.quality) || 1), 1);
                const band = QBAND[q] || [0, 99];
                qualityLabel = (q === 3) ? 'Gold' : (q === 2) ? 'Silber' : 'Bronze';
                qHi = band[1];
                // Bei BRONZE/SILBER wird das Min-Rating komplett ignoriert
                // (Rasmus): eine "1 Bronze-Spieler"-SBC ist mit Min-Rating 75
                // sonst nie lösbar, und der Wert ist für solche Vorgaben
                // schlicht bedeutungslos. Bei GOLD bleibt es als Untergrenze
                // wirksam - dort ist es der Normalfall und gewollt.
                qualityLow = (q === 1 || q === 2);
                qLo = qualityLow ? band[0] : Math.max(minRating, band[0]);
                if (qualityLow && minRating > band[0]) {
                    warnings.push('Qualitäts-Vorgabe ' + qualityLabel +
                        ': Min-Rating (' + minRating + ') wird ignoriert.');
                }
                if (qLo > qHi) qLo = band[0];
            }
            // GESPERRTE Karten (z.B. per PaleTools-Schloss) fliegen komplett
            // raus - wer eine Karte sperrt, will sie behalten. Bewusst VOR
            // allem anderen, damit sie auch nicht als Vorgabe-Karte oder Anker
            // reserviert werden kann.
            let lockedOut = 0;
            if (cfg.lockedIds && cfg.lockedIds.length) {
                const locked = new Set(cfg.lockedIds.map(String));
                const before = poolAll.length;
                poolAll = poolAll.filter(p => !locked.has(String(p.id)));
                lockedOut = before - poolAll.length;
                if (lockedOut) {
                    warnings.push(lockedOut + ' gesperrte Karte(n) ausgeschlossen.');
                }
            }
            let pool = poolAll.filter(p => p.rating >= qLo && p.rating <= qHi);
            if (cfg.specialOnlyFromStorage) {
                pool = pool.filter(p => !(p.isSpecial && !p.isStorage));
            }
            // Bei Bronze/Silber-Vorgaben NUR normale Karten: ein bronzenes
            // Special ist wertvoller als sein Rating, und für die Vorgabe
            // zählt es genauso wie eine 0815-Bronzekarte (rare oder non-rare
            // ist dabei egal - beides ist rareflag 0/1).
            if (qualityLow) {
                const plain = pool.filter(p => !p.isSpecial);
                if (plain.length >= N) pool = plain;
                else {
                    warnings.push('Zu wenige normale ' + qualityLabel +
                        '-Karten (' + plain.length + '/' + N + ') - Specials werden mitbenutzt.');
                }
            }
            // ---- SPIELER-EINDEUTIGKEIT (Fix für HTTP 460) ----
            // EA erlaubt denselben SPIELER (assetId) nur EINMAL pro Squad.
            // Duplikat-Karten (gleicher Spieler, mehrere Item-IDs, z.B. aus
            // Packs) führen sonst dazu, dass der Server einzelne Slots
            // ablehnt. Pro assetId bleibt genau EINE Karte im Lösungs-Pool:
            //   1. eine manuell gesetzte Karte (Anker / Rarity-Pick)
            //   2. eine, die die aktuelle Rarity-Vorgabe erfüllen kann
            //   3. eine Storage-Karte (Verbrauchs-Priorität)
            //   4. höchstes Rating, dann stabil kleinste id
            {
                const rcsForDedupe = (cfg.applyRarity === false) ? [] : (cfg.rarityConstraints || []);
                function dupeScore(p) {
                    let s = 0;
                    if (cfg.anchorId != null && String(p.id) === String(cfg.anchorId)) s += 1000;
                    if (cfg.rarityPickId != null && String(p.id) === String(cfg.rarityPickId)) s += 1000;
                    for (const rc of rcsForDedupe) { if (matchesRarity(p, rc)) { s += 100; break; } }
                    if (p.isStorage) s += 10;
                    return s;
                }
                const byAsset = new Map();
                for (const p of pool) {
                    const key = (p.assetId != null && p.assetId !== 0) ? 'a' + p.assetId : 'i' + p.id;
                    const cur = byAsset.get(key);
                    if (!cur) { byAsset.set(key, p); continue; }
                    const sp = dupeScore(p), sc = dupeScore(cur);
                    if (sp > sc ||
                        (sp === sc && (p.rating > cur.rating ||
                            (p.rating === cur.rating && Number(p.id) < Number(cur.id))))) {
                        byAsset.set(key, p);
                    }
                }
                if (byAsset.size < pool.length) pool = Array.from(byAsset.values());
            }
            const used = new Set();
            const reserved = [];
            const reserveCmp = makeConsumeCmp(pool);
            // ---- Kartenkosten (Band + persönliche Scarcity, Storage-Bonus) ----
            // VOR den Reservierungen definiert: auch Vorgabe-Karten werden
            // nach KOSTEN gewählt (87er TOTW mit Kosten 2 schlägt 85er mit 5).
            const bandFn = (typeof cfg.ratingCostFn === 'function')
                ? cfg.ratingCostFn
                : parseRatingCosts(cfg.ratingCostSpec != null ? cfg.ratingCostSpec : DEFAULT_RATING_COST_SPEC);
            let alpha = cfg.scarcityWeight != null ? cfg.scarcityWeight : 18;
            let beta = cfg.storageBonus != null ? cfg.storageBonus : 2;
            if (alpha <= 0) alpha = 1e-6;
            if (beta <= 0) beta = 1e-7;
            const countByRating = new Map();
            for (const p of pool) countByRating.set(p.rating, (countByRating.get(p.rating) || 0) + 1);
            // RARITY-SCHUTZ: Karten, die Requirement-Rarities erfüllen können
            // (TOTW/TOTS/FOF/FUTTIES = Rarity-Gruppe 83), sind wertvoller als
            // ihr Rating - sie werden für künftige SBC-Vorgaben gebraucht.
            // Sie bekommen einen festen Kosten-Aufschlag: ohne Vorgabe meidet
            // der Solver sie, mit Vorgabe wird GENAU die geforderte Anzahl
            // reserviert und der Rest trotzdem gemieden. Der Aufschlag wirkt
            // NACH dem Storage-Rabatt (wird also nicht halbiert).
            const guardGroups = Array.isArray(cfg.protectedGroups) && cfg.protectedGroups.length
                ? cfg.protectedGroups.map(Number) : [83];
            const guardCost = Math.max(0, cfg.rarityGuardCost != null ? Number(cfg.rarityGuardCost) : 8);
            function isProtectedRarity(p) {
                if (!guardCost || !Array.isArray(p.groups) || !p.groups.length) return false;
                for (const g of guardGroups) if (p.groups.indexOf(g) > -1) return true;
                return false;
            }
            // UNTRADEABLE bevorzugen: solche Karten lassen sich nicht
            // verkaufen, sind für SBCs aber vollwertig - sie zuerst zu
            // verbauen spart echte Coins. Rabatt wirkt wie der Rarity-Aufschlag
            // NACH dem Storage-Rabatt (wird also nicht halbiert).
            const untrBonus = Math.max(0, cfg.untradeableBonus != null
                ? Number(cfg.untradeableBonus) : 3);
            function costOf(p) {
                const n = countByRating.get(p.rating) || 1;
                const base = alpha / n + bandFn(p.rating);
                return (p.isStorage ? (base / 2 - beta) : base) +
                       (isProtectedRarity(p) ? guardCost : 0) -
                       (p.untradeable ? untrBonus : 0);
            }
            // ---- Anker ----
            if (cfg.anchorId != null && cfg.anchorId !== '') {
                const anchor = pool.find(p => String(p.id) === String(cfg.anchorId));
                if (anchor) { used.add(anchor.id); reserved.push(anchor); }
                else {
                    const inAll = poolAll.find(p => String(p.id) === String(cfg.anchorId));
                    warnings.push(inAll
                        ? 'Anker-Spieler ist durch die Filter ausgeschlossen und wurde ignoriert.'
                        : 'Anker-Spieler nicht im Pool gefunden und wurde ignoriert.');
                }
            }
            // ---- Manuell gewählte Karte für die Rarity-Vorgabe ----
            // (Rarity-GRUPPEN wie "TOTW/TOTS/FOF/FUTTIES" lassen sich nicht
            // zuverlässig automatisch auf rareflags mappen - der Nutzer wählt
            // die passende Karte selbst; sie zählt für jede Rarity-Vorgabe.)
            let forcedPickId = null;
            if (cfg.rarityPickId != null && cfg.rarityPickId !== '') {
                let pick = pool.find(p => String(p.id) === String(cfg.rarityPickId) && !used.has(p.id));
                if (!pick) {
                    const inAll = poolAll.find(p => String(p.id) === String(cfg.rarityPickId) && !used.has(p.id));
                    if (inAll) {
                        pick = inAll;
                        warnings.push('Gewählte Rarity-Karte ist durch die Filter ausgeschlossen - trotzdem verwendet.');
                    }
                }
                if (pick) {
                    used.add(pick.id);
                    reserved.push(pick);
                    forcedPickId = pick.id;
                    warnings.push('Rarity-Vorgabe: ' + pick.name + ' (' + pick.rating + ') manuell gesetzt.');
                } else {
                    warnings.push('Gewählte Rarity-Karte nicht im Pool gefunden - Automatik greift.');
                }
            }
            // ---- Spieler-Level-Vorgaben (z.B. "min. 10 Spieler mit 85+") ----
            // Bei SBCs OHNE Team-Rating (Tausch-/Provisions-Upgrades) gilt
            // die Min-OVR-Vorgabe praktisch immer für ALLE geforderten
            // Spieler ("4x 87+"; die Slot-Zahl IST die Spieleranzahl). EAs
            // Count-Feld ist im Objektbaum unzuverlässig auffindbar - darum
            // wird der Count hier auf die Slot-Zahl angehoben.
            let plBoosted = false;
            const plList = ((cfg.applyRarity === false) ? [] : (cfg.playerLevelConstraints || [])).map(function (pl) {
                if (!target && (pl.count || 1) < N) {
                    plBoosted = true;
                    return Object.assign({}, pl, { count: N });
                }
                return pl;
            });
            if (plBoosted) {
                warnings.push('Ohne Team-Rating: Min-OVR-Vorgabe auf alle ' + N + ' Slots angewendet.');
            }
            for (const pl of plList) {
                const needCount = pl.count || 1;
                let have = reserved.filter(p => p.rating >= pl.minRating).length;
                while (have < needCount) {
                    const cand = pool
                        .filter(p => !used.has(p.id) && p.rating >= pl.minRating)
                        .sort((a, b) => (costOf(a) - costOf(b)) || (a.rating - b.rating) || reserveCmp(a, b))[0];
                    if (!cand) {
                        return { ok: false, reason: 'Spieler-Vorgabe "min. ' + needCount + 'x ' + pl.minRating + '+" kann mit dem aktuellen Pool nicht erfüllt werden.', warnings: warnings };
                    }
                    used.add(cand.id);
                    reserved.push(cand);
                    warnings.push('Vorgabe ' + pl.minRating + '+: ' + cand.name + ' (' + cand.rating + ') reserviert.');
                    have++;
                }
            }
            // ---- Rarity-Vorgaben ----
            const rcList = (cfg.applyRarity === false) ? [] : (cfg.rarityConstraints || []);
            for (const rc of rcList) {
                const needCount = rc.count || 1;
                let have = reserved.filter(p => matchesRarity(p, rc) ||
                    (forcedPickId != null && p.id === forcedPickId)).length;
                while (have < needCount) {
                    // Quellen-Regel für Vorgaben (Rasmus):
                    //  - Storage: jede passende Karte (Special/TOTW) erlaubt
                    //  - Verein: NUR TOTW - andere Club-Specials kommen nie
                    //    in SBCs (wie Evolutions)
                    // Billigste passende Karte zuerst: 85er Club-TOTW schlägt
                    // 96er aus dem Storage.
                    const cand = poolAll
                        .filter(p => p.rating >= minRating && !used.has(p.id) && matchesRarity(p, rc) &&
                            (!cfg.specialOnlyFromStorage || p.isStorage || !p.isSpecial || isTotw(p)))
                        .sort((a, b) => (costOf(a) - costOf(b)) || (a.rating - b.rating) || reserveCmp(a, b))[0];
                    if (!cand) {
                        return { ok: false, reason: 'Rarity-Vorgabe "' + (rc.label || '?') + '" kann mit dem aktuellen Pool nicht erfüllt werden.', warnings: warnings };
                    }
                    used.add(cand.id);
                    reserved.push(cand);
                    warnings.push('Vorgabe ' + (rc.label || 'Rarity') + ': ' + cand.name + ' (' + cand.rating + (cand.isSpecial ? ', Special' : '') + ') reserviert.');
                    have++;
                }
            }
            // Transparenz: Vorgaben erkannt, aber Anwendung ausgeschaltet?
            if (cfg.applyRarity === false &&
                ((cfg.rarityConstraints || []).length || (cfg.playerLevelConstraints || []).length)) {
                warnings.push('ACHTUNG: SBC-Vorgaben erkannt, aber "Vorgaben automatisch erfüllen" ist AUS - das Team erfüllt sie evtl. nicht!');
            }
            if (reserved.length > N) {
                return { ok: false, reason: 'Mehr reservierte Spieler (' + reserved.length + ') als Slots (' + N + ').', warnings: warnings };
            }
            const k = N - reserved.length;
            const reservedSum = reserved.reduce((s, p) => s + p.rating, 0);
            let avail = pool.filter(p => !used.has(p.id));
            // Geschützte Karten, die NICHT für eine Vorgabe reserviert wurden,
            // aus der Suche nehmen (siehe solve()). Die reservierten sind schon
            // über `used` draussen, also bleibt genau die geforderte Anzahl.
            // Bleiben dadurch zu wenige Karten, scheitert dieser Durchlauf -
            // solve() wiederholt ihn dann ohne Sperre UND mit Warnung. Bewusst
            // kein stilles Überspringen hier: sonst würden zusätzliche
            // geschützte Karten unbemerkt verbaut.
            if (limitProtected) avail = avail.filter(p => !isProtectedRarity(p));
            if (avail.length < k) {
                return { ok: false, reason: 'Nicht genug passende Spieler im Pool (' + (avail.length + reserved.length) + ' < ' + N + '). Erst "Spieler laden" ausführen oder Filter lockern.', warnings: warnings };
            }
            const cmp = makeConsumeCmp(avail);
            // Pool-Transparenz: woraus wurde überhaupt gewählt?
            const poolInfo = (function () {
                if (!pool.length) return null;
                let lo = 99, hi = 0;
                for (const p of pool) { if (p.rating < lo) lo = p.rating; if (p.rating > hi) hi = p.rating; }
                return { count: pool.length, min: lo, max: hi };
            })();
            function finishTeam(team) {
                const sum = team.reduce((s, p) => s + p.rating, 0);
                const rats = team.map(p => p.rating);
                const ovr = squadRating(rats);
                const exact = squadRatingExact(rats);
                return {
                    ok: target ? ovr >= target : true,
                    players: team,
                    sum: sum,
                    ovr: ovr,
                    ovrExact: Math.round(exact * 100) / 100,
                    // "Waste" = Überschuss des EXAKTEN Ratings über das Ziel
                    // (z.B. +0.08 bei 84.08 / Ziel 84) - das ist die Grösse,
                    // die minimiert wird.
                    waste: target ? Math.round((exact - target) * 100) / 100 : 0,
                    target: target || null,
                    poolInfo: poolInfo,
                    reason: (target && ovr < target) ? ('Erreichter OVR ' + ovr + ' < Ziel ' + target + '.') : null,
                    warnings: warnings
                };
            }
            // ---- Kein Team-Rating erkannt: nur Vorgaben erfüllen, billig auffüllen ----
            if (!target) {
                if (!reserved.length && !qualityLabel) {
                    return { ok: false, reason: 'Kein Ziel-OVR und keine Vorgaben erkannt. Bitte SBC-Challenge öffnen (und ggf. Diagnose prüfen).', warnings: warnings };
                }
                if (qualityLabel) warnings.push('Qualitäts-Vorgabe ' + qualityLabel + ': billigste passende Karten (' + qLo + '-' + qHi + ').');
                const fillers = avail.slice().sort(qualityLow
                    // Bronze/Silber: NIEDRIGSTES Rating zuerst. Ueber die Kosten
                    // zu gehen waehlt sonst die HAEUFIGERE Karte (Scarcity-Term
                    // alpha/anzahl), nicht die niedrigste.
                    ? ((a, b) => (a.rating - b.rating) || (costOf(a) - costOf(b)) || cmp(a, b))
                    : ((a, b) => (costOf(a) - costOf(b)) || (a.rating - b.rating) || cmp(a, b))
                ).slice(0, k);
                if (reserved.length + fillers.length < N) {
                    return { ok: false, reason: 'Zu wenige passende Karten für die Vorgabe (' + (reserved.length + fillers.length) + '/' + N + ').', warnings: warnings };
                }
                return finishTeam(reserved.concat(fillers));
            }
            // ---- Max-teure-Beschränkung ----
            let exp = null;
            if (cfg.maxExpensiveEnabled) {
                const th = cfg.expensiveThreshold || 99;
                const budget = (cfg.maxExpensiveCount || 0) - reserved.filter(p => p.rating >= th).length;
                if (budget < 0) {
                    warnings.push('Max-teure-Vorgabe ist schon durch reservierte Spieler überschritten - Beschränkung ignoriert.');
                } else {
                    exp = { th: th, budget: budget };
                }
            }
            const NEED = N * N * target - Math.floor(N / 2);
            const sortedAsc = avail.slice().sort((a, b) => a.rating - b.rating);
            let kCheapest = 0;
            for (let i = 0; i < k; i++) kCheapest += sortedAsc[i].rating;
            const stLow = reservedSum + kCheapest;
            // Für die Quick-Obergrenze: höchste Ratings (reserviert + verfügbar)
            const allDesc = reserved.map(p => p.rating)
                .concat(avail.map(p => p.rating))
                .sort((a, b) => b - a)
                .slice(0, N);
            function quickUB(st) {
                let best = N * st; // b = 0
                let hs = 0;
                for (let b = 1; b <= allDesc.length; b++) {
                    hs += allDesc[b - 1];
                    const v = N * st + N * hs - b * st;
                    if (v > best) best = v;
                }
                return best;
            }
            function runSearch(expDims) {
                // Fenster in V-Einheiten: 1 Einheit = 1/121 Rating-Dezimal
                // (bei N=11). Innerhalb des Fensters über dem V-Minimum
                // entscheiden die KARTEN-Kosten.
                const windowV = Math.max(0, Math.round(
                    (cfg.maxOvershoot != null ? cfg.maxOvershoot : 0.10) * N * N));
                // Band-Cache: DPs hängen nur von der Booster-Grenze ab
                const bandCache = new Map();
                function bandFor(st) {
                    const rBoost = Math.floor(st / N) + 1;
                    let band = bandCache.get(rBoost);
                    if (!band) {
                        const lowP = avail.filter(p => p.rating < rBoost);
                        const highP = avail.filter(p => p.rating >= rBoost);
                        const sMaxLow = Math.min(k * Math.max(0, rBoost - 1), 1300);
                        const sMaxHigh = Math.min(k * 99, 1300);
                        band = {
                            rBoost: rBoost,
                            dpLow: buildDp(lowP, k, sMaxLow, costOf, expDims, cmp),
                            dpHigh: buildDp(highP, k, sMaxHigh, costOf, expDims, cmp)
                        };
                        bandCache.set(rBoost, band);
                    }
                    return band;
                }
                // Alle (Booster-Anzahl, Booster-Summe)-Kombos einer Gesamtsumme
                // durchgehen; cb(V, kosten, ref) für jede machbare Kombination.
                // V = N*(st + H) - b*st = N² * exaktes Rating.
                function scanSt(st, vCap, cb) {
                    const band = bandFor(st);
                    const S_target = st - reservedSum;
                    if (S_target < 0) return;
                    let bRes = 0, HRes = 0;
                    for (const p of reserved) {
                        if (p.rating >= band.rBoost) { bRes++; HRes += p.rating; }
                    }
                    const budget = expDims ? expDims.budget : 0;
                    for (let bA = 0; bA <= k; bA++) {
                        const b = bRes + bA;
                        const base = N * st + N * HRes - b * st;
                        // NEED <= V = base + N*HA <= vCap
                        const HAmin = Math.max(0, bA * band.rBoost,
                            Math.ceil((NEED - base) / N - 1e-9));
                        const HAcap = (vCap === Infinity)
                            ? Infinity : Math.floor((vCap - base) / N + 1e-9);
                        const HAmax = Math.min(band.dpHigh.S - 1, S_target, HAcap);
                        for (let HA = HAmin; HA <= HAmax; HA++) {
                            const sLow = S_target - HA;
                            const V = base + N * HA;
                            for (let eH = 0; eH <= budget; eH++) {
                                const cH = band.dpHigh.cost(bA, eH, HA);
                                if (cH === Infinity) continue;
                                for (let eL = 0; eL + eH <= budget; eL++) {
                                    const cL = band.dpLow.cost(k - bA, eL, sLow);
                                    if (cL === Infinity) continue;
                                    cb(V, cH + cL, { st: st, bA: bA, HA: HA, eH: eH, eL: eL, sLow: sLow });
                                    if (!expDims) break;
                                }
                                if (!expDims) break;
                            }
                        }
                    }
                }
                // Phase 1: erste machbare Lösung -> obere Schranke für V
                const stHardCap = stLow + 900;
                let vBound = -1;
                for (let st = stLow; st <= stHardCap && vBound < 0; st++) {
                    if (quickUB(st) < NEED) continue;
                    let found = -1;
                    scanSt(st, Infinity, function (V) {
                        if (found < 0 || V < found) found = V;
                    });
                    if (found >= 0) vBound = found;
                }
                if (vBound < 0) return null;
                // Phase 2: alle relevanten Summen scannen (V >= N*st begrenzt
                // die Summe nach oben); beste Kosten je V sammeln.
                let vMin = vBound;
                const bestByV = new Map();
                for (let st = stLow; st <= stHardCap; st++) {
                    if (N * st > vMin + windowV) break;
                    if (quickUB(st) < NEED) continue;
                    scanSt(st, vMin + windowV, function (V, cost, ref) {
                        if (V < NEED) return;
                        const cur = bestByV.get(V);
                        if (!cur || cost < cur.cost - 1e-12) {
                            bestByV.set(V, { cost: cost, ref: ref });
                        }
                        if (V < vMin) vMin = V;
                    });
                }
                // Auswahl: minimale Kosten im Fenster [vMin, vMin+windowV];
                // bei (nahezu) gleichen Kosten das kleinere V (näher am Ziel).
                let chosen = null;
                bestByV.forEach(function (cand, V) {
                    if (V > vMin + windowV) return;
                    const obj = cand.cost + (V - vMin) * 1e-4;
                    if (!chosen || obj < chosen.obj - 1e-12) {
                        chosen = { obj: obj, V: V, ref: cand.ref };
                    }
                });
                if (!chosen) return null;
                const band = bandFor(chosen.ref.st);
                const high = band.dpHigh.reconstruct(chosen.ref.bA, chosen.ref.eH, chosen.ref.HA);
                const low = band.dpLow.reconstruct(k - chosen.ref.bA, chosen.ref.eL, chosen.ref.sLow);
                return { team: reserved.concat(high, low), V: chosen.V, vMin: vMin };
            }
            let result = runSearch(exp);
            if (!result && exp) {
                result = runSearch(null);
                if (result) warnings.push('Max. teure Spieler (' + cfg.maxExpensiveCount + ' ab ' + exp.th + '+) ist mit diesem Pool nicht einhaltbar - Beschränkung gelockert.');
            }
            if (!result) {
                return { ok: false, reason: 'Ziel-OVR ' + target + ' ist mit dem aktuellen Pool nicht erreichbar. Filter lockern oder bessere Karten laden.', warnings: warnings };
            }
            return finishTeam(result.team);
        }
        /**
         * BATCH-PLANUNG: mehrere Teams für DIESELBE SBC hintereinander.
         * Jede Runde rechnet mit dem Pool OHNE die Karten der vorherigen
         * Runden - genau wie im echten Ablauf, wo verbaute Karten weg sind.
         * Wird eine Runde unlösbar, bricht die Planung ab und liefert die
         * bis dahin geplanten Teams samt Grund; so sieht man in der Vorschau
         * ehrlich "3 von 5 möglich" statt einer Überraschung mitten im Abgeben.
         */
        function planBatch(poolAll, cfg, count) {
            const n = Math.max(1, Math.min(20, Math.floor(count) || 1));
            const rounds = [];
            const usedIds = new Set();
            let stoppedReason = null;
            for (let i = 0; i < n; i++) {
                const pool = poolAll.filter(p => !usedIds.has(String(p.id)));
                const res = solve(pool, cfg);
                if (!res || !res.ok) {
                    stoppedReason = (res && res.reason) || 'Kein Team mehr möglich.';
                    break;
                }
                for (const p of res.players) usedIds.add(String(p.id));
                rounds.push(res);
            }
            return {
                rounds: rounds,
                planned: rounds.length,
                requested: n,
                stoppedReason: stoppedReason,
                // Alle verbauten IDs über alle Runden - zum Gegenprüfen, dass
                // keine Karte doppelt eingeplant wurde.
                usedIds: Array.from(usedIds)
            };
        }
        return {
            solve: solve,
            planBatch: planBatch,
            squadRating: squadRating,
            squadRatingExact: squadRatingExact,
            squadV: squadV,
            priorityOf: priorityOf,
            parseRatingCosts: parseRatingCosts,
            DEFAULT_RATING_COST_SPEC: DEFAULT_RATING_COST_SPEC,
            WASTE_WEIGHT: WASTE_WEIGHT
        };
    })();
    // [SOLVER-END]
    // ========================================================================
    //  6. IN SBC EINTRAGEN
    // ========================================================================
    // Weg A: über die App-eigenen Services (setPlayers + saveChallenge).
    // Nutzt dieselben Codepfade wie die App beim manuellen Eintragen -
    // damit stimmen Body-Format und interne Zustände garantiert.
    // Eintragen über den App-eigenen Weg: setPlayers + saveChallenge.
    // WICHTIG: Dieser Weg läuft über die HTTP-Schicht der App und bringt
    // deren automatische Session-Erneuerung mit (kein 401-Problem).
    async function submitViaServices(result) {
        const entity = STATE.sbc.entity;
        if (!entity) throw new Error('Keine Challenge-Entity erfasst.');
        const sbcSvc = window.services && window.services.SBC;
        if (!sbcSvc || typeof sbcSvc.saveChallenge !== 'function')
            throw new Error('services.SBC.saveChallenge nicht verfügbar.');
        const squad = entity.squad;
        if (!squad || typeof squad.setPlayers !== 'function')
            throw new Error('Challenge-Squad hat kein setPlayers().');
        const items = result.players.map(toItemEntity);
        // Für den SAVE-Pfad "silent" setzen (zweites Argument true) - das
        // triggert kein UI-Event und hält den Squad konsistent für saveChallenge.
        try { squad.setPlayers(items, true); }
        catch (e) { squad.setPlayers(items); }
        // Signatur-Varianten probieren
        let response = null;
        try { response = await obsPromise(sbcSvc.saveChallenge(entity)); } catch (e) { response = null; }
        if (!responseOk(response)) {
            try { response = await obsPromise(sbcSvc.saveChallenge(entity, squad)); } catch (e) { response = null; }
        }
        if (!responseOk(response)) {
            throw new Error('saveChallenge abgelehnt (Status ' + (response && response.status) + ').');
        }
        return true;
    }
    // Gesamtzahl der Squad-Slots (Startelf + Bank). Die App sendet beim
    // Eintragen IMMER alle Slots, unbenutzte mit id 0.
    function detectSquadSlotTotal() {
        try {
            if (STATE.diag.lastSquadPutBody) {
                const b = JSON.parse(STATE.diag.lastSquadPutBody);
                if (b && Array.isArray(b.players) && b.players.length) return b.players.length;
            }
        } catch (e) {}
        if (STATE.sbc.squadSlotTotal) return STATE.sbc.squadSlotTotal;
        return 23; // Standard der Web App (live beobachtet, fc26)
    }
    // Weg A: direkter HTTP-PUT im EXAKTEN Format der App
    // (live mitgeschnitten): alle Slots, itemData mit id + dream:false.
    async function submitViaHttp(result) {
        if (!STATE.sbc.challengeId)
            throw new Error('Keine Challenge-ID erkannt. Bitte die SBC-Challenge im Spiel öffnen.');
        if (!sessionReady())
            throw new Error('Keine Session für den HTTP-Eintrag erfasst. Bitte einmal durch die App navigieren (z.B. Verein öffnen) und erneut versuchen.');
        const total = Math.max(detectSquadSlotTotal(), result.players.length);
        // Spieler auf die NUTZBAREN Slots legen (Brick-Slots überspringen) -
        // sonst lehnt der Server mit 460 ab.
        const targetIdx = (Array.isArray(STATE.sbc.usableSlots) && STATE.sbc.usableSlots.length >= result.players.length)
            ? STATE.sbc.usableSlots
            : null;
        const byIndex = new Map();
        for (let i = 0; i < result.players.length; i++) {
            const idx = targetIdx ? targetIdx[i] : i;
            byIndex.set(idx, result.players[i].id);
        }
        const players = [];
        for (let i = 0; i < total; i++) {
            players.push({ index: i, itemData: { id: byIndex.get(i) || 0, dream: false } });
        }
        const pfx = STATE.sbc.apiPrefix || 'sbs';
        await apiPut(pfx + '/challenge/' + STATE.sbc.challengeId + '/squad', { players: players });
        return true;
    }
    // Server-Wahrheit: wie viele der gewünschten Spieler stehen WIRKLICH im
    // Squad? Erfolg misst sich daran, NICHT am PUT-Statuscode (EA liefert
    // teils 400/460 trotz erfolgreicher Speicherung).
    async function verifySquadCount(result) {
        try {
            const pfx = STATE.sbc.apiPrefix || 'sbs';
            const json = await apiGet(pfx + '/challenge/' + STATE.sbc.challengeId + '/squad');
            if (json && json.squad && Array.isArray(json.squad.players)) {
                const wantIds = new Set(result.players.map(p => Number(p.id)));
                let match = 0;
                for (const sl of json.squad.players) {
                    if (sl && sl.itemData && wantIds.has(Number(sl.itemData.id))) match++;
                }
                return match;
            }
        } catch (e) { warn('Squad-Verifikation fehlgeschlagen:', e.message); }
        return -1;
    }
    /**
     * WEG 0 - das komplette PaleTools-Rezept:
     *   1. ECHTE Item-Entities über die App-eigene UTItemEntityFactory aus
     *      unseren Pool-Rohdaten bauen (createItem(raw) - derselbe Weg, den
     *      PaleTools für purchased/items-JSON nutzt; funktioniert damit auch
     *      für Storage-Karten).
     *   2. Entities ins LIVE gebundene Squad des offenen Controllers setzen.
     *   3. services.SBC.saveChallenge(liveChallenge) - die App macht den PUT
     *      selbst UND aktualisiert ihre eigene Ansicht. Kein F5, kein
     *      manueller Repaint nötig.
     */
    async function submitViaApp(result) {
        if (typeof window.UTItemEntityFactory !== 'function')
            throw new Error('UTItemEntityFactory nicht verfügbar.');
        const sbcSvc = window.services && window.services.SBC;
        if (!sbcSvc || typeof sbcSvc.saveChallenge !== 'function')
            throw new Error('services.SBC.saveChallenge nicht verfügbar.');
        // Live-Controller der offenen SBC-Ansicht suchen
        let ctrl = null;
        for (const c of getControllerChain()) {
            const n = (c.constructor && c.constructor.name) || '';
            if (/sbc/i.test(n) && (c._squad || (c.getSquad && c.getSquad()))) { ctrl = c; }
        }
        if (!ctrl) throw new Error('Kein offener SBC-Squad-Controller gefunden (Challenge im Spiel öffnen).');
        const liveSquad = ctrl._squad || (ctrl.getSquad && ctrl.getSquad());
        if (!liveSquad || typeof liveSquad.setPlayers !== 'function')
            throw new Error('Live-Squad hat kein setPlayers().');
        // Die Challenge, an der die Ansicht hängt (PaleTools: _leftController._challenge)
        let challenge = null;
        for (const key of ['_overviewController', 'leftController', '_leftController']) {
            const oc = ctrl[key];
            if (oc && oc._challenge) { challenge = oc._challenge; break; }
        }
        challenge = challenge || ctrl._challenge || STATE.sbc.entity;
        if (!challenge) throw new Error('Keine Live-Challenge gefunden.');
        // Echte Entities über die App-Factory
        const factory = new window.UTItemEntityFactory();
        const entities = result.players.map(p => {
            if (!p.raw) throw new Error('Rohdaten fehlen für Karte ' + p.id);
            const it = factory.createItem(p.raw);
            if (!it || Number(it.id) !== Number(p.id)) throw new Error('Factory-Item unbrauchbar für ' + p.id);
            return it;
        });
        const cur = (typeof liveSquad.getPlayers === 'function') ? liveSquad.getPlayers() : null;
        const targetIdx = (Array.isArray(STATE.sbc.usableSlots) && STATE.sbc.usableSlots.length >= entities.length)
            ? STATE.sbc.usableSlots
            : null;
        const maxIdx = targetIdx ? targetIdx[entities.length - 1] : (entities.length - 1);
        const total = Math.max((cur && cur.length) || 0, maxIdx + 1);
        const arr = new Array(total);
        // Auf die NUTZBAREN Slots verteilen (Brick-Slots bleiben leer).
        for (let i = 0; i < entities.length; i++) arr[targetIdx ? targetIdx[i] : i] = entities[i];
        liveSquad.setPlayers(arr, true); // silent, wie PaleTools
        const resp = await obsPromise(sbcSvc.saveChallenge(challenge));
        if (!responseOk(resp))
            throw new Error('saveChallenge abgelehnt (Status ' + (resp && resp.status) + ').');
        return true;
    }
    async function submitToSbc(result) {
        if (!result || !result.players || result.players.length === 0)
            throw new Error('Kein Ergebnis zum Eintragen.');
        const need = result.players.length;
        let lastErr = null;
        // Weg 0: App-eigener Save (PaleTools-Rezept) - speichert UND
        // aktualisiert die offene Ansicht in einem Rutsch.
        try {
            await submitViaApp(result);
            const c0 = await verifySquadCount(result);
            if (c0 >= need) { STATE.diag.submitVia = 'app'; return { confirmed: c0, via: 'app' }; }
        } catch (e) { lastErr = e; warn('App-Eintrag meldete Fehler:', e.message); diagError('submitViaApp: ' + (e.message || e)); }
        // Weg A: HTTP-PUT im exakt mitgeschnittenen App-Format.
        try { await submitViaHttp(result); }
        catch (e) { lastErr = e; warn('HTTP-Eintrag meldete Fehler:', e.message); diagError('submitViaHttp: ' + (e.message || e)); }
        // Server fragen: sind die Spieler drin? (unabhängig vom PUT-Status)
        let confirmed = await verifySquadCount(result);
        if (confirmed >= need) { STATE.diag.submitVia = 'http'; return { confirmed: confirmed, via: 'http' }; }
        // Weg B: alter Services-Weg (Entity-Squad + saveChallenge).
        try { await submitViaServices(result); }
        catch (e) { lastErr = e; warn('Service-Eintrag meldete Fehler:', e.message); diagError('submitViaServices: ' + (e.message || e)); }
        confirmed = await verifySquadCount(result);
        if (confirmed >= need) { STATE.diag.submitVia = 'services'; return { confirmed: confirmed, via: 'services' }; }
        // Nichts hat gegriffen. 404/475 haben eine bekannte Ursache:
        // WIEDERHOLBARE SBCs bekommen pro Durchlauf eine NEUE challengeId.
        // Live gesehen: dieselbe SBC lief unter 3829, dann 3800, dann 3771 -
        // wer in die verbrauchte Instanz schreibt, bekommt 404 (weg) bzw. 475.
        // Das passiert nach mehreren Durchläufen derselben SBC, weil die
        // Ansicht/der Cache noch auf der alten Instanz steht.
        const msg = String((lastErr && lastErr.message) || '');
        if (/\b(404|475)\b/.test(msg)) {
            throw new Error('Die SBC-Instanz ist veraltet (Status aus ' + msg + '). ' +
                'Wiederholbare SBCs bekommen pro Durchlauf eine neue ID - bitte die ' +
                'SBC im Spiel einmal schliessen und neu öffnen, dann erneut optimieren.');
        }
        throw lastErr || new Error('Eintragen fehlgeschlagen (Server bestätigt ' + Math.max(0, confirmed) + '/' + need + ').');
    }
    // Spieler-Objekt in eine App-Entity umwandeln (für setPlayers).
    function toItemEntity(p) {
        try {
            if (typeof window.UTItemEntity === 'function') {
                if (p.raw && p.raw instanceof window.UTItemEntity) return p.raw;
                // Konstruktor mit Rohdaten zuerst - so initialisiert die App
                // ihre Items selbst (korrekte interne Felder statt Object.assign).
                if (p.raw) {
                    try {
                        const viaCtor = new window.UTItemEntity(p.raw);
                        if (viaCtor && Number(viaCtor.id) === Number(p.raw.id || p.id)) return viaCtor;
                    } catch (e) {}
                }
                const it = new window.UTItemEntity();
                if (p.raw) { try { Object.assign(it, p.raw); } catch (e) {} }
                if (it.id == null || it.id === 0) it.id = p.id;
                return it;
            }
        } catch (e) {}
        return p.raw || { id: p.id };
    }
    // View-Controller-Kette der App einsammeln (Root -> aktiver Controller).
    function getControllerChain() {
        const out = [];
        try {
            let cur = (typeof window.getAppMain === 'function') ? window.getAppMain() : null;
            const chainFns = ['getRootViewController', 'getPresentedViewController', 'getCurrentViewController', 'getCurrentController'];
            const visited = new Set();
            let depth = 0;
            while (cur && depth < 14 && !visited.has(cur)) {
                visited.add(cur);
                out.push(cur);
                let next = null;
                for (const fn of chainFns) {
                    if (typeof cur[fn] === 'function') {
                        try {
                            const c = cur[fn]();
                            if (c && typeof c === 'object' && !visited.has(c)) { next = c; break; }
                        } catch (e) {}
                    }
                }
                if (!next) break;
                cur = next; depth++;
            }
        } catch (e) {}
        return out;
    }
    // CONTROLLER-SCAN: läuft die View-Controller-Kette der App entlang und
    // sammelt Klassennamen, squad-bezogene Methoden und SBC-Felder des
    // aktiven Controllers - die Landkarte für gezielte UI-Refreshes.
    function controllerScan() {
        const out = [];
        try {
            let cur = (typeof window.getAppMain === 'function') ? window.getAppMain() : null;
            if (!cur) return ['getAppMain fehlt'];
            const chainFns = ['getRootViewController', 'getPresentedViewController', 'getCurrentViewController', 'getCurrentController'];
            const visited = new Set();
            let depth = 0;
            while (cur && depth < 12 && !visited.has(cur)) {
                visited.add(cur);
                out.push(((cur.constructor && cur.constructor.name) || '?'));
                let next = null;
                for (const fn of chainFns) {
                    if (typeof cur[fn] === 'function') {
                        try {
                            const cand = cur[fn]();
                            if (cand && typeof cand === 'object' && !visited.has(cand)) { next = cand; break; }
                        } catch (e) {}
                    }
                }
                if (!next) break;
                cur = next;
                depth++;
            }
            if (cur) {
                const methods = [];
                let proto = cur;
                while (proto && methods.length < 40) {
                    for (const k of Object.getOwnPropertyNames(proto)) {
                        try {
                            if (/squad|render|refresh|repaint|challenge/i.test(k) &&
                                typeof cur[k] === 'function' && methods.indexOf(k) < 0) methods.push(k);
                        } catch (e) {}
                    }
                    proto = Object.getPrototypeOf(proto);
                }
                out.push('METHODS: ' + methods.join(','));
                for (const k in cur) {
                    try {
                        const v = cur[k];
                        if (v && typeof v === 'object' && v.constructor &&
                            /sbc|squad/i.test(v.constructor.name)) {
                            out.push('FIELD ' + k + ': ' + v.constructor.name);
                            // Methoden + View-Klasse der Sub-Controller mitkartieren -
                            // dort hängt die sichtbare Pitch-Ansicht.
                            const ms = [];
                            let pr = v;
                            while (pr && pr !== Object.prototype && ms.length < 30) {
                                for (const n of Object.getOwnPropertyNames(pr)) {
                                    try {
                                        if (/squad|render|refresh|repaint|paint|update|rebuild/i.test(n) &&
                                            typeof v[n] === 'function' && ms.indexOf(n) < 0) ms.push(n);
                                    } catch (e) {}
                                }
                                pr = Object.getPrototypeOf(pr);
                            }
                            if (ms.length) out.push('  ' + k + '.METHODS: ' + ms.join(','));
                            let vw = null;
                            try { vw = (typeof v.getView === 'function') ? v.getView() : v._view; } catch (e) {}
                            if (vw && vw.constructor) {
                                const vms = [];
                                let vpr = vw;
                                while (vpr && vpr !== Object.prototype && vms.length < 30) {
                                    for (const n of Object.getOwnPropertyNames(vpr)) {
                                        try {
                                            if (/squad|render|refresh|repaint|paint|update|rebuild|slot/i.test(n) &&
                                                typeof vw[n] === 'function' && vms.indexOf(n) < 0) vms.push(n);
                                        } catch (e) {}
                                    }
                                    vpr = Object.getPrototypeOf(vpr);
                                }
                                out.push('  ' + k + '.VIEW ' + vw.constructor.name + ': ' + vms.join(','));
                            }
                        }
                    } catch (e) {}
                }
            }
        } catch (e) { out.push('Fehler: ' + (e.message || e)); }
        return out.slice(0, 80);
    }
    /**
     * VIEW-REFRESH (F5-Killer) nach PaleTools-Vorbild. Ablauf:
     *   1. Der Aufrufer hat die Challenge per Original-loadChallenge frisch
     *      vom Server geladen - die App hat dabei ECHTE Item-Entities gebaut.
     *   2. Diese echten Entities werden (falls nötig) ins live gebundene
     *      _squad des UTSBCSquadSplitViewController kopiert.
     *   3. overviewController.setSquad(liveSquad) bindet neu und pusht die
     *      Entities in die UTSBCSquadOverviewView (die sichtbare Pitch).
     * WICHTIG: hier laufen NIE selbstgebaute Pseudo-Items durch - die haben
     * die View mit "Cannot read isDream of undefined" crashen lassen.
     */
    function refreshOpenSbcView() {
        const report = [];
        let ok = false;
        try {
            let cur = (typeof window.getAppMain === 'function') ? window.getAppMain() : null;
            if (!cur) { STATE.diag.refreshLog = ['getAppMain fehlt']; return false; }
            const chainFns = ['getRootViewController', 'getPresentedViewController', 'getCurrentViewController', 'getCurrentController'];
            const visited = new Set();
            const controllers = [];
            let depth = 0;
            // Controller-Kette einsammeln
            while (cur && depth < 14 && !visited.has(cur)) {
                visited.add(cur);
                controllers.push(cur);
                let next = null;
                for (const fn of chainFns) {
                    if (typeof cur[fn] === 'function') {
                        try {
                            const c = cur[fn]();
                            if (c && typeof c === 'object' && !visited.has(c)) { next = c; break; }
                        } catch (e) {}
                    }
                }
                if (!next) break;
                cur = next; depth++;
            }
            function viewOf(o) {
                try { return (typeof o.getView === 'function') ? o.getView() : o._view; }
                catch (e) { return null; }
            }
            // Sieht ein Array nach echten, NICHT-leeren App-Item-Entities aus?
            // (mindestens eine Karte mit id > 0 - sonst würden wir ein volles
            // Live-Squad mit einem leeren Reload überschreiben)
            function looksLikeItems(arr) {
                if (!Array.isArray(arr) || !arr.length) return false;
                for (const p of arr) {
                    if (p && typeof p === 'object' && Number(p.id) > 0 &&
                        (p.rating != null || p.resourceId != null || p.definitionId != null)) return true;
                }
                return false;
            }
            const entity = STATE.sbc.entity;
            const srcSquad = entity && entity.squad;
            for (const ctrl of controllers) {
                const cname = (ctrl.constructor && ctrl.constructor.name) || '';
                if (!/sbc|squad/i.test(cname)) continue;
                const liveSquad = ctrl._squad || (ctrl.getSquad && ctrl.getSquad());
                if (!liveSquad) continue;
                // Falls die Ansicht an einem ANDEREN Squad-Objekt hängt als die
                // frisch vom Server geladene Challenge-Entity: die ECHTEN
                // Entities (von der App selbst gebaut) hinüberkopieren. Nie
                // wieder selbstgebaute Pseudo-Items - die haben die View mit
                // "isDream undefined" crashen lassen.
                if (srcSquad && srcSquad !== liveSquad &&
                    typeof srcSquad.getPlayers === 'function' &&
                    typeof liveSquad.setPlayers === 'function') {
                    try {
                        const ps = srcSquad.getPlayers();
                        if (looksLikeItems(ps)) {
                            liveSquad.setPlayers(ps, true);
                            report.push(cname + ': Server-Squad übernommen (' + ps.length + ' Slots)');
                        }
                    } catch (e) { report.push(cname + '.setPlayers FEHLER: ' + String(e && e.message).slice(0, 60)); }
                }
                // PaleTools-Rezept rückwärts: die Pitch-Ansicht hängt am
                // UTSBCSquadOverviewViewController. setSquad(liveSquad) bindet
                // neu und pusht die (jetzt echten) Entities in die View.
                const subsSeen = new Set();
                for (const key of ['_overviewController', 'leftController', '_leftController']) {
                    const oc = ctrl[key];
                    if (!oc || typeof oc !== 'object' || subsSeen.has(oc)) continue;
                    subsSeen.add(oc);
                    if (typeof oc.setSquad === 'function') {
                        try { oc.setSquad(liveSquad); report.push(key + '.setSquad(liveSquad)'); ok = true; }
                        catch (e) { report.push(key + '.setSquad FEHLER: ' + String(e && e.message).slice(0, 60)); }
                    }
                    if (!ok && typeof oc._pushSquadToView === 'function') {
                        try { oc._pushSquadToView(); report.push(key + '._pushSquadToView()'); ok = true; }
                        catch (e) { report.push(key + '._pushSquadToView FEHLER: ' + String(e && e.message).slice(0, 60)); }
                    }
                    const ovw = viewOf(oc);
                    if (!ok && ovw && typeof ovw.setSquad === 'function') {
                        try { ovw.setSquad(liveSquad); report.push(key + '.view.setSquad(liveSquad)'); ok = true; } catch (e) {}
                    }
                }
            }
            STATE.diag.refreshLog = report.slice(0, 40);
            log('View-Refresh:', ok ? 'ausgeführt' : 'keine Methode gefunden', '-', report.join(' | '));
        } catch (e) {
            warn('View-Refresh fehlgeschlagen:', e.message);
            diagError('refreshOpenSbcView: ' + (e.message || e));
        }
        return ok;
    }
    // App-Cache der Challenge vom Server neu laden (originale loadChallenge-
    // Funktion) - danach zeigt mindestens das NEU-ÖFFNEN der Challenge die
    // eingetragenen Spieler, ganz ohne F5.
    async function refreshChallengeCache() {
        try {
            if (STATE.origLoadChallenge && STATE.sbc.entity) {
                await obsPromise(STATE.origLoadChallenge(STATE.sbc.entity));
                log('Challenge-Cache der App vom Server neu geladen.');
                return true;
            }
        } catch (e) { warn('Cache-Refresh fehlgeschlagen:', e.message); }
        return false;
    }
    // ========================================================================
    //  7. UI-PANEL
    // ========================================================================
    let ui = {};
    // Pitroipa-Kopf (identisch zum App-Icon, app/res/mipmap-xhdpi) als Data-URI:
    // wird fuer den Menuepunkt in der EA-Leiste, den FAB und den Panel-Header
    // benutzt. Inline, weil externe Requests in der WebView-App unnoetig
    // fehlschlagen koennen.
    const ICON_URI = 'data:image/png;base64,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';
    function injectStyles() {
        const css = `
        #sbc-opt-fab {
            position: fixed; right: 22px; bottom: 22px; z-index: 999999;
            width: 56px; height: 56px; border-radius: 50%;
            background: linear-gradient(135deg,#00e0b8,#0077ff);
            color: #001018; font-size: 26px; border: none; cursor: grab;
            box-shadow: 0 4px 18px rgba(0,0,0,.5); display: flex;
            align-items: center; justify-content: center;
            transition: transform .15s ease; padding: 0; overflow: hidden;
            /* Ohne touch-action:none scrollt Android die Seite statt zu ziehen. */
            touch-action: none;
        }
        #sbc-opt-fab:hover { transform: scale(1.08); }
        #sbc-opt-fab.sbc-opt-dragging { cursor: grabbing; transform: scale(1.12); opacity: .9; }
        #sbc-opt-fab img {
            width: 38px; height: 38px; border-radius: 50%;
            pointer-events: none; display: block;
        }
        #sbc-opt-fab.sbc-opt-hidden { display: none; }
        /* Button in der SBC-Aktionsleiste (.sbc-button-container - dort stehen
           "Use Squad Builder" / "Clear Squad"). Die Klassen eines echten
           Nachbar-Buttons werden zur Laufzeit kopiert, hier nur das Nötige
           fuer Icon + Beschriftung. */
        #pittools-sbc-btn {
            display: inline-flex; align-items: center; justify-content: center;
            gap: 6px; cursor: pointer;
        }
        #pittools-sbc-btn img {
            width: 1.4em; height: 1.4em; border-radius: 50%;
            display: block; flex: 0 0 auto;
        }
        #pittools-sbc-btn.pittools-active { outline: 2px solid #00e0b8; }
        #sbc-opt-panel {
            position: fixed; right: 22px; bottom: 90px; z-index: 999999;
            width: 340px; max-height: 78vh; overflow-y: auto;
            background: #0f1620; color: #e6edf3; border: 1px solid #1f2b3a;
            border-radius: 14px; box-shadow: 0 8px 40px rgba(0,0,0,.6);
            font-family: 'Segoe UI', Roboto, sans-serif; font-size: 13px;
            display: none; padding: 0;
        }
        #sbc-opt-panel.open { display: block; }
        .sbc-opt-header {
            background: linear-gradient(135deg,#00e0b8,#0077ff);
            color:#001018; font-weight:700; font-size:15px;
            padding:12px 16px; border-radius:14px 14px 0 0;
            display:flex; justify-content:space-between; align-items:center;
            cursor:move; user-select:none; touch-action:none;
        }
        .sbc-opt-header img.sbc-opt-logo {
            width:18px; height:18px; border-radius:50%;
            vertical-align:-4px; margin-right:6px;
        }
        .sbc-opt-body { padding: 14px 16px; }
        #sbc-opt-advanced { margin: 4px 0 10px; }
        #sbc-opt-advanced summary {
            cursor: pointer; color: #9db2c8; font-weight: 600;
            padding: 8px 10px; background: #131e2b; border: 1px solid #1f2b3a;
            border-radius: 8px; user-select: none; list-style: none;
        }
        #sbc-opt-advanced summary::-webkit-details-marker { display: none; }
        #sbc-opt-advanced summary::before { content: '▸ '; color: #00e0b8; }
        #sbc-opt-advanced[open] summary::before { content: '▾ '; }
        #sbc-opt-advanced[open] summary { margin-bottom: 10px; }
        .sbc-opt-info {
            background:#131e2b; border:1px solid #1f2b3a; border-radius:8px;
            padding:8px 10px; margin-bottom:12px; line-height:1.6;
        }
        .sbc-opt-info b { color:#00e0b8; }
        .sbc-opt-debug { color:#7d93ab; font-size:11px; margin-top:4px; }
        .sbc-opt-row { margin-bottom:12px; }
        .sbc-opt-row label { display:block; margin-bottom:4px; color:#9db2c8; font-size:12px; }
        .sbc-opt-row input[type=number], .sbc-opt-row input[type=text], .sbc-opt-row select {
            width:100%; background:#0b1219; color:#e6edf3;
            border:1px solid #24405f; border-radius:6px; padding:7px 9px; font-size:13px;
        }
        .sbc-opt-inline { display:flex; align-items:center; gap:8px; }
        .sbc-opt-inline input[type=number] { flex:1; }
        .sbc-opt-toggle { display:flex; align-items:center; gap:8px; cursor:pointer; }
        .sbc-opt-toggle input { width:auto; }
        .sbc-opt-btn {
            width:100%; border:none; border-radius:8px; padding:10px;
            font-weight:700; font-size:13px; cursor:pointer; margin-top:6px;
        }
        .sbc-opt-btn.primary { background:#00e0b8; color:#001018; }
        .sbc-opt-btn.blue { background:#0077ff; color:#fff; }
        .sbc-opt-btn.ghost { background:#1c2938; color:#cfe0f2; }
        /* Fortschritt während des Batch-Laufs: mittig über allem, damit man
           nicht im Panel nach dem Status suchen muss. */
        #sbc-opt-progress {
            position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%);
            z-index: 1000000; display: none;
            background: #0f1620; color: #e6edf3; border: 1px solid #24405f;
            border-radius: 14px; box-shadow: 0 10px 50px rgba(0,0,0,.7);
            padding: 18px 22px; min-width: 300px; text-align: center;
            font-family: 'Segoe UI', Roboto, sans-serif;
        }
        #sbc-opt-progress.open { display: block; }
        #sbc-opt-progress .p-title {
            font-size: 17px; font-weight: 700; color: #00e0b8; margin-bottom: 2px;
        }
        #sbc-opt-progress .p-step { font-size: 13px; color: #9db2c8; margin-bottom: 12px; }
        #sbc-opt-progress .p-bar {
            height: 8px; background: #1c2938; border-radius: 5px; overflow: hidden;
        }
        #sbc-opt-progress .p-fill {
            height: 100%; width: 0%; border-radius: 5px;
            background: linear-gradient(90deg,#00e0b8,#0077ff);
            transition: width .3s ease;
        }
        #sbc-opt-progress .p-done { font-size: 12px; color: #7d93ab; margin-top: 10px; }
        /* Rot: gibt SBCs endgültig ab, das ist nicht rückholbar. */
        .sbc-opt-btn.danger { background:#c0392b; color:#fff; }
        .sbc-opt-btn:disabled { opacity:.5; cursor:not-allowed; }
        .sbc-opt-batch { margin-top:12px; padding-top:10px; border-top:1px solid #1f2b3a; }
        #sbc-opt-batch-preview:empty { display:none; }
        #sbc-opt-batch-preview {
            background:#131e2b; border:1px solid #1f2b3a; border-radius:8px;
            padding:8px 10px; margin-top:8px; font-size:12px; line-height:1.5;
            max-height:340px; overflow-y:auto;
        }
        .sbc-opt-batch-round { padding:3px 0; border-bottom:1px solid #1b2735; }
        .sbc-opt-batch-round:last-child { border-bottom:none; }
        .sbc-opt-batch-round b { color:#00e0b8; }
        .sbc-opt-batch-warn { color:#ffb454; }
        .sbc-opt-batch-bad { color:#ff6b6b; }
        .sbc-opt-batch-cards { margin:4px 0 2px; }
        .sbc-opt-batch-card {
            font-size:11px; color:#cfe0f2; padding:1px 0;
            white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        }
        .sbc-opt-batch-card .r {
            display:inline-block; min-width:22px; font-weight:700; color:#e6edf3;
        }
        .sbc-opt-batch-card .src { color:#7d93ab; }
        .sbc-opt-batch-card .rar { color:#9db2c8; }
        .sbc-opt-batch-card .untr { color:#6f8aa6; font-style:italic; }
        .sbc-opt-batch-card.prot .rar { color:#ffb454; font-weight:700; }
        .sbc-opt-result {
            margin-top:12px; background:#0b1219; border:1px solid #1f2b3a;
            border-radius:8px; padding:10px; display:none;
        }
        .sbc-opt-result.show { display:block; }
        .sbc-opt-player {
            display:flex; justify-content:space-between; align-items:center;
            padding:4px 2px; border-bottom:1px solid #16212e;
        }
        .sbc-opt-player:last-child { border-bottom:none; }
        .sbc-opt-badge {
            background:#00e0b8; color:#001018; font-weight:700;
            border-radius:5px; padding:1px 7px; font-size:12px; min-width:26px; text-align:center;
        }
        .sbc-opt-badge.special { background:#ffcf4d; }
        .sbc-opt-badge.storage { outline:2px solid #0077ff; }
        .sbc-opt-summary { margin:10px 0 4px; font-size:14px; }
        .sbc-opt-summary b { color:#00e0b8; }
        .sbc-opt-warn { color:#ffcf4d; font-size:12px; margin-top:6px; }
        .sbc-opt-bandhead, .sbc-opt-bandrow {
            display:grid; grid-template-columns: 16px 1fr 1fr 1fr 26px; gap:4px;
            align-items:center; margin-bottom:4px;
        }
        .sbc-opt-bandhead span { color:#7d93ab; font-size:11px; }
        .sbc-opt-bandrow input {
            width:100%; background:#0b1219; color:#e6edf3;
            border:1px solid #24405f; border-radius:6px; padding:4px 6px; font-size:12px;
        }
        .sbc-opt-bandrow button {
            background:#1c2938; color:#ff5470; border:none; border-radius:6px;
            cursor:pointer; padding:4px 0; font-size:12px;
        }
        .sbc-opt-bandrow .sbc-opt-draghandle {
            color:#7d93ab; cursor:grab; user-select:none; text-align:center;
            font-size:13px; line-height:1;
        }
        .sbc-opt-bandrow.sbc-opt-dragover { outline:2px dashed #00e0b8; border-radius:6px; }
        #sbc-opt-toast-wrap {
            position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
            z-index: 1000000; display:flex; flex-direction:column; gap:8px; align-items:center;
        }
        .sbc-opt-toast {
            background:#131e2b; color:#e6edf3; border:1px solid #24405f;
            border-left:4px solid #00e0b8; padding:10px 16px; border-radius:8px;
            font-family:'Segoe UI',sans-serif; font-size:13px; box-shadow:0 4px 20px rgba(0,0,0,.5);
            max-width:80vw;
        }
        .sbc-opt-toast.error { border-left-color:#ff5470; }
        .sbc-opt-toast.warn { border-left-color:#ffcf4d; }
        `;
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }
    function toast(msg, type) {
        let wrap = document.getElementById('sbc-opt-toast-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'sbc-opt-toast-wrap';
            document.body.appendChild(wrap);
        }
        const t = document.createElement('div');
        t.className = 'sbc-opt-toast ' + (type || '');
        t.textContent = msg;
        wrap.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 3800);
        setTimeout(() => { try { wrap.removeChild(t); } catch (e) {} }, 4300);
    }
    function buildPanel() {
        const fab = document.createElement('button');
        fab.id = 'sbc-opt-fab';
        fab.type = 'button';
        fab.title = 'PitTools v' + VERSION + ' (ziehen zum Verschieben)';
        const fabImg = document.createElement('img');
        fabImg.src = ICON_URI;
        fabImg.alt = '';
        fab.appendChild(fabImg);
        document.body.appendChild(fab);
        const panel = document.createElement('div');
        panel.id = 'sbc-opt-panel';
        panel.innerHTML = `
            <div class="sbc-opt-header">
                <span><img class="sbc-opt-logo" src="` + ICON_URI + `" alt="">PitTools <span style="font-size:11px;font-weight:400;opacity:.75;">v` + VERSION + `</span></span>
                <span id="sbc-opt-close" style="cursor:pointer;">✕</span>
            </div>
            <div class="sbc-opt-body">
                <div class="sbc-opt-info" id="sbc-opt-info">
                    Ziel-OVR: <b id="sbc-opt-target">–</b><br>
                    Vorgaben: <b id="sbc-opt-rarity">keine</b><br>
                    Spieler im Pool: <b id="sbc-opt-poolcount">0</b><br>
                    Status: <b id="sbc-opt-status">bereit</b>
                    <div class="sbc-opt-debug" id="sbc-opt-debug">API: – · SID: – · Services: –</div>
                </div>
                <button class="sbc-opt-btn ghost" id="sbc-opt-load">Spieler laden</button>
                <div class="sbc-opt-row">
                    <label>Min. Rating pro Spieler</label>
                    <input type="number" id="sbc-opt-minrating" value="75" min="1" max="99">
                </div>
                <div class="sbc-opt-row">
                    <label>Max. Rating-Überschuss über Minimum (z.B. 0.10 = bis 84.10 statt 84.00)</label>
                    <input type="number" id="sbc-opt-maxwaste" value="0.00" min="0" max="2" step="0.01">
                </div>
                <details id="sbc-opt-advanced">
                    <summary>Erweiterte Einstellungen</summary>
                <div class="sbc-opt-row">
                    <label class="sbc-opt-toggle">
                        <input type="checkbox" id="sbc-opt-applyrarity" checked>
                        Erkannte SBC-Vorgaben automatisch erfüllen (Rarity / Spieler-Level)
                    </label>
                </div>
                <div class="sbc-opt-row">
                    <label class="sbc-opt-toggle">
                        <input type="checkbox" id="sbc-opt-specialstorage" checked>
                        Special-Karten nur aus Storage
                    </label>
                </div>
                <div class="sbc-opt-row">
                    <label class="sbc-opt-toggle">
                        <input type="checkbox" id="sbc-opt-maxexp-en">
                        Max. teure Spieler begrenzen
                    </label>
                    <div class="sbc-opt-inline" style="margin-top:6px;">
                        <input type="number" id="sbc-opt-maxexp-count" value="4" min="0" max="11" title="max. Anzahl">
                        <span style="color:#9db2c8;">Stück ab</span>
                        <input type="number" id="sbc-opt-maxexp-th" value="88" min="1" max="99" title="Rating-Schwelle">
                        <span style="color:#9db2c8;">OVR</span>
                    </div>
                </div>
                <div class="sbc-opt-row">
                    <label>Rating-Kosten (höher = Karten dieser Stufe mehr schonen)</label>
                    <div class="sbc-opt-bandhead"><span></span><span>von</span><span>bis</span><span>Kosten</span><span></span></div>
                    <div id="sbc-opt-bands"></div>
                    <div class="sbc-opt-inline" style="margin-top:4px;">
                        <button class="sbc-opt-btn ghost" id="sbc-opt-band-add" style="margin:0;padding:5px;">+ Stufe</button>
                        <button class="sbc-opt-btn ghost" id="sbc-opt-band-reset" style="margin:0;padding:5px;">Zurücksetzen</button>
                    </div>
                </div>
                <div class="sbc-opt-row">
                    <label>Seltene Club-Karten schonen</label>
                    <select id="sbc-opt-scarcity">
                        <option value="0">Aus (nur Waste zählt)</option>
                        <option value="8">Leicht</option>
                        <option value="18" selected>Normal</option>
                        <option value="35">Stark</option>
                    </select>
                </div>
                <div class="sbc-opt-row">
                    <label>Storage-Karten bevorzugt verbrauchen</label>
                    <select id="sbc-opt-storagebonus">
                        <option value="0">Aus</option>
                        <option value="1">Leicht</option>
                        <option value="2" selected>Normal</option>
                        <option value="4">Stark</option>
                    </select>
                </div>
                <div class="sbc-opt-row">
                    <label>Unverkäufliche Karten zuerst verbauen (spart Coins)</label>
                    <select id="sbc-opt-untradeable">
                        <option value="0">Aus</option>
                        <option value="1">Leicht</option>
                        <option value="3" selected>Normal</option>
                        <option value="6">Stark</option>
                    </select>
                </div>
                <div class="sbc-opt-row">
                    <label class="sbc-opt-toggle">
                        <input type="checkbox" id="sbc-opt-uselocks" checked>
                        Gesperrte Karten (PaleTools-Schloss) nie verbauen
                    </label>
                </div>
                <div class="sbc-opt-row">
                    <label>Rarity-Karten schützen (TOTW/TOTS/FOF/FUTTIES)</label>
                    <select id="sbc-opt-rarityguard">
                        <option value="0">Aus</option>
                        <option value="4">Leicht</option>
                        <option value="8" selected>Normal</option>
                        <option value="20">Stark</option>
                    </select>
                </div>
                <div class="sbc-opt-row">
                    <label>Karte für Rarity-Vorgabe (z.B. TOTW/FUTTIES) - übersteuert die Automatik</label>
                    <input type="text" id="sbc-opt-raritypick-filter" placeholder="Name filtern..." style="margin-bottom:6px;">
                    <select id="sbc-opt-raritypick"><option value="">– automatisch wählen –</option></select>
                </div>
                </details>
                <button class="sbc-opt-btn primary" id="sbc-opt-run">Optimieren + Eintragen</button>
                <div class="sbc-opt-result" id="sbc-opt-result"></div>
                <button class="sbc-opt-btn blue" id="sbc-opt-submit" style="display:none;">Erneut eintragen</button>
                <!-- BATCH: dieselbe SBC mehrfach. Zwei Schritte - erst planen und
                     ansehen, dann EINE Freigabe für den ganzen Lauf. -->
                <div class="sbc-opt-batch">
                    <div class="sbc-opt-inline" style="margin-bottom:8px;">
                        <label style="margin:0;flex:1;">SBC mehrfach abschließen</label>
                        <input type="number" id="sbc-opt-batch-count" value="3" min="1" max="10"
                               style="width:64px;">
                    </div>
                    <button class="sbc-opt-btn ghost" id="sbc-opt-batch-plan">Teams planen (Vorschau)</button>
                    <div id="sbc-opt-batch-preview"></div>
                    <button class="sbc-opt-btn danger" id="sbc-opt-batch-run" style="display:none;">
                        Alle eintragen + abgeben
                    </button>
                </div>
                <button class="sbc-opt-btn ghost" id="sbc-opt-diag" style="margin-top:10px;">Diagnose in Konsole schreiben</button>
            </div>
        `;
        document.body.appendChild(panel);
        // Fortschritts-Overlay: bewusst ausserhalb des Panels, damit es auch
        // sichtbar ist, wenn das Panel zu ist.
        const prog = document.createElement('div');
        prog.id = 'sbc-opt-progress';
        prog.innerHTML = '<div class="p-title"></div><div class="p-step"></div>' +
            '<div class="p-bar"><div class="p-fill"></div></div>' +
            '<div class="p-done"></div>';
        document.body.appendChild(prog);
        ui = {
            progress: prog,
            progTitle: prog.querySelector('.p-title'),
            progStep: prog.querySelector('.p-step'),
            progFill: prog.querySelector('.p-fill'),
            progDone: prog.querySelector('.p-done'),
            fab, panel,
            target: panel.querySelector('#sbc-opt-target'),
            rarity: panel.querySelector('#sbc-opt-rarity'),
            poolcount: panel.querySelector('#sbc-opt-poolcount'),
            status: panel.querySelector('#sbc-opt-status'),
            debug: panel.querySelector('#sbc-opt-debug'),
            minrating: panel.querySelector('#sbc-opt-minrating'),
            maxwaste: panel.querySelector('#sbc-opt-maxwaste'),
            applyrarity: panel.querySelector('#sbc-opt-applyrarity'),
            specialstorage: panel.querySelector('#sbc-opt-specialstorage'),
            maxexpEn: panel.querySelector('#sbc-opt-maxexp-en'),
            maxexpCount: panel.querySelector('#sbc-opt-maxexp-count'),
            maxexpTh: panel.querySelector('#sbc-opt-maxexp-th'),
            scarcity: panel.querySelector('#sbc-opt-scarcity'),
            storagebonus: panel.querySelector('#sbc-opt-storagebonus'),
            untradeable: panel.querySelector('#sbc-opt-untradeable'),
            useLocks: panel.querySelector('#sbc-opt-uselocks'),
            rarityguard: panel.querySelector('#sbc-opt-rarityguard'),
            bands: panel.querySelector('#sbc-opt-bands'),
            bandAdd: panel.querySelector('#sbc-opt-band-add'),
            bandReset: panel.querySelector('#sbc-opt-band-reset'),
            rarityPickFilter: panel.querySelector('#sbc-opt-raritypick-filter'),
            rarityPick: panel.querySelector('#sbc-opt-raritypick'),
            load: panel.querySelector('#sbc-opt-load'),
            run: panel.querySelector('#sbc-opt-run'),
            result: panel.querySelector('#sbc-opt-result'),
            submit: panel.querySelector('#sbc-opt-submit'),
            diagBtn: panel.querySelector('#sbc-opt-diag'),
            batchCount: panel.querySelector('#sbc-opt-batch-count'),
            batchPlan: panel.querySelector('#sbc-opt-batch-plan'),
            batchPreview: panel.querySelector('#sbc-opt-batch-preview'),
            batchRun: panel.querySelector('#sbc-opt-batch-run')
        };
        panel.querySelector('#sbc-opt-close').addEventListener('click', () => panel.classList.remove('open'));
        makeDraggable(panel, panel.querySelector('.sbc-opt-header'), 'sbcOptPanelPos', {
            minVisible: 60, // Header muss greifbar bleiben
            ignore: (ev) => ev.target && ev.target.id === 'sbc-opt-close'
        });
        // Tippen (ohne Ziehen) oeffnet das Panel - siehe onTap in makeDraggable.
        // Bewusst KEIN zusaetzlicher click-Listener: der wuerde doppelt
        // umschalten, das Panel ginge auf und sofort wieder zu.
        makeDraggable(fab, fab, 'sbcOptFabPos', {
            onTap: function () { launcherClicks++; togglePanel(); }
        });
        ui.load.addEventListener('click', onLoadClick);
        ui.run.addEventListener('click', onRunClick);
        ui.submit.addEventListener('click', onSubmitClick);
        ui.diagBtn.addEventListener('click', onDiagClick);
        ui.batchPlan.addEventListener('click', onBatchPlanClick);
        ui.batchRun.addEventListener('click', onBatchRunClick);
        ui.rarityPickFilter.addEventListener('input', renderRarityPickOptions);
        // Zustand der "Erweiterte Einstellungen" merken
        const adv = panel.querySelector('#sbc-opt-advanced');
        try { if (localStorage.getItem('sbcOptAdvancedOpen') === '1') adv.open = true; } catch (e) {}
        adv.addEventListener('toggle', function () {
            try { localStorage.setItem('sbcOptAdvancedOpen', adv.open ? '1' : '0'); } catch (e) {}
        });
        initBandEditor();
        refreshSbcInfoUI();
        refreshDiagUI();
    }
    // ---- Rating-Kosten Band-Editor ------------------------------------------
    let ratingBands = [];
    function defaultBands() {
        return [
            { lo: 0, hi: 80, cost: 0 },
            { lo: 81, hi: 83, cost: 2 },
            { lo: 84, hi: 84, cost: 1 },
            { lo: 85, hi: 86, cost: 5 },
            { lo: 87, hi: 88, cost: 2 },
            { lo: 89, hi: 90, cost: 3 },
            { lo: 91, hi: 92, cost: 4 },
            { lo: 93, hi: 99, cost: 12 }
        ];
    }
    function bandsToSpec(bands) {
        return bands
            .filter(b => b.lo != null && b.hi != null && b.cost != null)
            .map(b => b.lo + '-' + b.hi + ':' + b.cost)
            .join(', ');
    }
    function saveBands() {
        try { localStorage.setItem('sbcOptRatingBands', JSON.stringify(ratingBands)); } catch (e) {}
    }
    function initBandEditor() {
        try {
            const saved = JSON.parse(localStorage.getItem('sbcOptRatingBands') || 'null');
            ratingBands = (Array.isArray(saved) && saved.length) ? saved : defaultBands();
        } catch (e) { ratingBands = defaultBands(); }
        renderBandRows();
        ui.bandAdd.addEventListener('click', function () {
            ratingBands.push({ lo: 75, hi: 99, cost: 0 });
            saveBands(); renderBandRows();
        });
        ui.bandReset.addEventListener('click', function () {
            ratingBands = defaultBands();
            saveBands(); renderBandRows();
            toast('Rating-Kosten auf Standard zurückgesetzt.', '');
        });
    }
    let bandDragIndex = null;
    function renderBandRows() {
        if (!ui.bands) return;
        ui.bands.innerHTML = '';
        ratingBands.forEach(function (band, i) {
            const row = document.createElement('div');
            row.className = 'sbc-opt-bandrow';
            // Drag-Handle zum Umsortieren der Zeilen
            const handle = document.createElement('span');
            handle.className = 'sbc-opt-draghandle';
            handle.textContent = '⠿';
            handle.title = 'Zeile verschieben (ziehen)';
            handle.draggable = true;
            handle.addEventListener('dragstart', function (ev) {
                bandDragIndex = i;
                try { ev.dataTransfer.setData('text/plain', String(i)); } catch (e) {}
                try { ev.dataTransfer.effectAllowed = 'move'; } catch (e) {}
            });
            row.addEventListener('dragover', function (ev) {
                if (bandDragIndex == null) return;
                ev.preventDefault();
                row.classList.add('sbc-opt-dragover');
            });
            row.addEventListener('dragleave', function () {
                row.classList.remove('sbc-opt-dragover');
            });
            row.addEventListener('drop', function (ev) {
                ev.preventDefault();
                row.classList.remove('sbc-opt-dragover');
                if (bandDragIndex == null || bandDragIndex === i) { bandDragIndex = null; return; }
                const moved = ratingBands.splice(bandDragIndex, 1)[0];
                ratingBands.splice(i, 0, moved);
                bandDragIndex = null;
                saveBands(); renderBandRows();
            });
            const lo = document.createElement('input');
            lo.type = 'number'; lo.min = '0'; lo.max = '99'; lo.value = band.lo;
            const hi = document.createElement('input');
            hi.type = 'number'; hi.min = '0'; hi.max = '99'; hi.value = band.hi;
            const cost = document.createElement('input');
            cost.type = 'number'; cost.min = '0'; cost.step = '0.5'; cost.value = band.cost;
            const del = document.createElement('button');
            del.textContent = '✕';
            del.title = 'Stufe entfernen';
            function upd() {
                band.lo = Math.max(0, Math.min(99, parseInt(lo.value, 10) || 0));
                band.hi = Math.max(0, Math.min(99, parseInt(hi.value, 10) || 0));
                band.cost = Math.max(0, parseFloat(String(cost.value).replace(',', '.')) || 0);
                saveBands();
            }
            lo.addEventListener('change', upd);
            hi.addEventListener('change', upd);
            cost.addEventListener('change', upd);
            del.addEventListener('click', function () {
                ratingBands.splice(i, 1);
                saveBands(); renderBandRows();
            });
            row.appendChild(handle); row.appendChild(lo); row.appendChild(hi); row.appendChild(cost); row.appendChild(del);
            ui.bands.appendChild(row);
        });
    }
    // Panel am Header verschiebbar machen; Position wird gemerkt.
    /**
     * Macht ein Element per Handle verschiebbar - Maus UND Finger.
     * Bewusst POINTER-Events: die alte Variante hoerte nur auf mousedown/
     * mousemove, war am Handy also gar nicht verschiebbar (und genau da wird
     * gearbeitet). setPointerCapture haelt den Zug fest, auch wenn der Finger
     * das Element verlaesst.
     *
     * opts.minVisible = wieviel Pixel Hoehe sichtbar bleiben muessen (beim
     * Panel reicht der Header, sonst kann man es nicht mehr zurueckholen).
     * opts.ignore     = Predicate, um Klicks auf Bedienelemente (z.B. ✕)
     *                   nicht als Zugbeginn zu behandeln.
     * opts.onTap      = wird bei pointerup gerufen, wenn NICHT gezogen wurde.
     *                   Bewusst nicht per 'click': das preventDefault in
     *                   pointerdown (gegen Textselektion/Scrollen) kann auf
     *                   Touch-Geraeten die Kompatibilitaets-Mausevents und
     *                   damit den Klick unterdruecken - und der Kreis ist der
     *                   Rueckfallweg, der zuverlaessig reagieren MUSS.
     * Setzt el.__sbcDragged = true, solange die Bewegung als Ziehen zaehlt.
     */
    function makeDraggable(el, handle, posKey, opts) {
        if (!el || !handle) return;
        opts = opts || {};
        const DRAG_THRESHOLD = 6; // px, darunter ist es ein Klick
        function applyPos(left, top) {
            const w = el.offsetWidth || 56;
            const h = opts.minVisible || el.offsetHeight || 56;
            left = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w));
            top = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h));
            el.style.left = left + 'px';
            el.style.top = top + 'px';
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }
        function savedPos() {
            try {
                const s = JSON.parse(localStorage.getItem(posKey) || 'null');
                if (s && typeof s.left === 'number' && typeof s.top === 'number') return s;
            } catch (e) {}
            return null;
        }
        const s0 = savedPos();
        if (s0) applyPos(s0.left, s0.top);
        // Nach Drehen des Handys / Tastatur-Einblendung kann die gemerkte
        // Position ausserhalb des Bildschirms liegen - dann zurueckholen.
        window.addEventListener('resize', function () {
            const s = savedPos();
            if (s) applyPos(s.left, s.top);
        });
        let dragging = false, offX = 0, offY = 0, startX = 0, startY = 0;
        handle.addEventListener('pointerdown', function (ev) {
            if (opts.ignore && opts.ignore(ev)) return;
            dragging = true;
            el.__sbcDragged = false;
            const rect = el.getBoundingClientRect();
            offX = ev.clientX - rect.left;
            offY = ev.clientY - rect.top;
            startX = ev.clientX;
            startY = ev.clientY;
            try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
            ev.preventDefault();
        });
        handle.addEventListener('pointermove', function (ev) {
            if (!dragging) return;
            if (Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
                Math.abs(ev.clientY - startY) > DRAG_THRESHOLD) {
                if (!el.__sbcDragged) {
                    el.__sbcDragged = true;
                    el.classList.add('sbc-opt-dragging');
                }
            }
            if (el.__sbcDragged) applyPos(ev.clientX - offX, ev.clientY - offY);
        });
        function endDrag(ev) {
            if (!dragging) return;
            dragging = false;
            el.classList.remove('sbc-opt-dragging');
            try { handle.releasePointerCapture(ev.pointerId); } catch (e) {}
            if (!el.__sbcDragged) {
                if (opts.onTap && ev.type === 'pointerup') opts.onTap();
                return;
            }
            try {
                const rect = el.getBoundingClientRect();
                localStorage.setItem(posKey, JSON.stringify({ left: rect.left, top: rect.top }));
            } catch (e) {}
        }
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);
    }
    // ---- Einstiegspunkte: Button in der SBC-Aktionsleiste + fliegender Kreis -
    // Der Weg ueber die globale Navigationsleiste (.ut-tab-bar) ist wieder
    // RAUS: im Hochformat bricht der Eintrag um, landet in der Totzone unter
    // dem nativen ⚙ der App und reagierte auf keinen Tap (LEARNINGS §9).
    // Jetzt: dort einhaengen, wo die SBC ihre eigenen Aktionen hat
    // ("Use Squad Builder" / "Clear Squad") - Container .sbc-button-container,
    // aus PaleTools' CSS als EA-Klasse verifiziert.
    const BTN_ID = 'pittools-sbc-btn';
    let btnAttachCount = 0;
    let launcherClicks = 0;
    /**
     * Sind wir im SBC-Bereich? Gemessen an der View-Controller-Kette der App
     * (dieselbe Quelle, aus der auch die Challenge gelesen wird).
     * WICHTIG: liefert die Kette nichts (z.B. vor dem App-Start), geben wir
     * true zurueck - lieber ein Knopf zu viel als gar kein Einstieg.
     */
    function inSbcView() {
        try {
            const chain = getControllerChain();
            if (!chain.length) return true;
            for (const c of chain) {
                const n = (c.constructor && c.constructor.name) || '';
                if (/sbc/i.test(n)) return true;
            }
        } catch (e) { return true; }
        return false;
    }
    /**
     * Holt das Panel zurueck, falls eine gemerkte Position ausserhalb des
     * Bildschirms liegt - sonst "passiert nichts", obwohl der Klick ankam.
     */
    function ensurePanelOnScreen() {
        const p = ui.panel;
        if (!p) return;
        try {
            const r = p.getBoundingClientRect();
            if (!r.width && !r.height) return;
            const off = r.right < 40 || r.left > window.innerWidth - 40 ||
                        r.bottom < 40 || r.top > window.innerHeight - 40;
            if (off) {
                p.style.left = ''; p.style.top = '';
                p.style.right = '22px'; p.style.bottom = '90px';
                try { localStorage.removeItem('sbcOptPanelPos'); } catch (e) {}
                warn('Panel lag ausserhalb des Bildschirms - Position zurueckgesetzt.');
            }
        } catch (e) {}
    }
    function togglePanel() {
        if (!ui.panel) return;
        const open = ui.panel.classList.toggle('open');
        if (open) ensurePanelOnScreen();
        const btn = document.getElementById(BTN_ID);
        if (btn) btn.classList.toggle('pittools-active', open);
    }
    /**
     * Die SBC-Aktionsleiste, sichtbar. Kann es mehrfach im DOM geben
     * (Hoch-/Querformat), unsichtbare sind nutzlos.
     */
    function sbcButtonContainer() {
        const all = document.querySelectorAll('.sbc-button-container');
        for (let i = 0; i < all.length; i++) {
            if (all[i].offsetParent !== null || all[i].getClientRects().length) return all[i];
        }
        return null;
    }
    function buildSbcButton(container) {
        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.type = 'button';
        btn.title = 'PitTools v' + VERSION;
        // Aussehen von einem echten Nachbar-Button erben: dessen Klassen sind
        // uns nicht bekannt (und koennen sich mit jedem EA-Update aendern),
        // kopieren ist robuster als raten.
        let donor = null;
        for (let i = 0; i < container.children.length; i++) {
            const ch = container.children[i];
            if (ch.id !== BTN_ID && ch.tagName === 'BUTTON' && ch.className) { donor = ch; break; }
        }
        btn.className = (donor ? donor.className + ' ' : '') + BTN_ID;
        const img = document.createElement('img');
        img.src = ICON_URI;
        img.alt = '';
        const lbl = document.createElement('span');
        lbl.textContent = 'PitTools';
        btn.appendChild(img);
        btn.appendChild(lbl);
        // KEIN Listener am Element: die EA-App baut die Leiste neu und kopiert
        // dabei Knoten - ein Klon haette den Listener verloren (Button sichtbar,
        // Klick tot). Stattdessen delegiert, siehe installLauncherDelegation().
        return btn;
    }
    /**
     * Klicks auf unseren Button - delegiert und in der Capture-Phase, damit
     * sie jedes Neu-Rendern der Leiste ueberleben und die EA-App nicht
     * zusaetzlich reagiert.
     * touchend UND click, weil die mobile EA-Ansicht Touches teils selbst
     * verarbeitet und dann gar kein click mehr entsteht. Die Entprellung
     * verhindert doppeltes Umschalten (= Panel auf und sofort wieder zu, was
     * genau wie "es passiert nichts" aussieht).
     */
    function installLauncherDelegation() {
        if (STATE.launcherDelegated) return;
        STATE.launcherDelegated = true;
        let last = 0;
        function onHit(ev) {
            try {
                const t = ev.target;
                if (!t || !t.closest || !t.closest('#' + BTN_ID)) return;
                ev.preventDefault();
                ev.stopPropagation();
                const now = Date.now();
                if (now - last < 400) return;
                last = now;
                launcherClicks++;
                togglePanel();
            } catch (e) {}
        }
        document.addEventListener('click', onHit, true);
        document.addEventListener('touchend', onHit, true);
    }
    /**
     * Haelt die Einstiegspunkte aktuell. Regeln:
     *  - Beides NUR im SBC-Bereich (Wunsch von Rasmus - sonst ist der Knopf
     *    ueberall im Weg). Beim Verlassen geht das Panel zu, damit es nicht
     *    ueber dem Transfermarkt schwebt.
     *  - Der fliegende Kreis ist der VERLAESSLICHE Weg und bleibt sichtbar.
     *    Der Button in der SBC-Leiste kommt zusaetzlich dazu, wo es geht -
     *    zweimal war ein eingehaengter Button live tot, deshalb wird der Kreis
     *    nicht mehr automatisch dafuer weggenommen.
     */
    function syncLauncher() {
        if (!ui.fab || !ui.panel) return;
        let btn = document.getElementById(BTN_ID);
        if (!inSbcView()) {
            if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
            ui.fab.classList.add('sbc-opt-hidden');
            if (ui.panel.classList.contains('open')) togglePanel();
            return;
        }
        ui.fab.classList.remove('sbc-opt-hidden');
        const cont = sbcButtonContainer();
        if (cont) {
            if (!btn || btn.parentNode !== cont) {
                if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
                btn = buildSbcButton(cont);
                cont.appendChild(btn);
                btnAttachCount++;
            }
            btn.classList.toggle('pittools-active', ui.panel.classList.contains('open'));
        } else if (btn && btn.parentNode) {
            btn.parentNode.removeChild(btn);
        }
    }
    function setStatus(txt) { if (ui.status) ui.status.textContent = txt; }
    function refreshSbcInfoUI() {
        if (!ui.target) return;
        ui.target.textContent = STATE.sbc.targetOVR || '–';
        const parts = [];
        for (const pl of (STATE.sbc.playerLevelConstraints || [])) {
            parts.push(pl.count + 'x ' + pl.minRating + '+');
        }
        for (const rc of (STATE.sbc.rarityConstraints || [])) {
            parts.push(rc.label + (rc.count > 1 ? ' x' + rc.count : ''));
        }
        for (const qc of (STATE.sbc.qualityConstraints || [])) {
            parts.push('Qualität: ' + (qc.quality === 3 ? 'Gold' : qc.quality === 2 ? 'Silber' : 'Bronze'));
        }
        ui.rarity.textContent = parts.length ? parts.join(', ') : 'keine';
        ui.poolcount.textContent = STATE.pool.length;
    }
    function refreshDiagUI() {
        if (!ui.debug) return;
        const s = STATE.session;
        ui.debug.textContent =
            'API: ' + (s.apiBase ? '✓' : '–') +
            ' · SID: ' + (s.sid ? '✓' : '–') +
            ' · Services: ' + (servicesAvailable() ? '✓' : '–') +
            ' · utas: ' + STATE.diag.utasSeen;
    }
    function buildDiagReport() {
        // Bewusst OHNE Session-Token-Werte!
        let servicesKeys = null;
        try {
            if (window.services && typeof window.services === 'object') {
                servicesKeys = Object.keys(window.services).slice(0, 60);
            }
        } catch (e) {}
        let challengeSample = null;
        try {
            if (STATE.lastChallengeRaw) {
                challengeSample = JSON.stringify(STATE.lastChallengeRaw).slice(0, 8000);
            }
        } catch (e) {}
        return {
            version: VERSION,
            url: location.href.split('?')[0],
            apiBaseDetected: STATE.session.apiBase,
            sidCaptured: !!STATE.session.sid,
            phishingCaptured: !!STATE.session.phishing,
            servicesAvailable: servicesAvailable(),
            servicesHooked: STATE.servicesHooked,
            servicesKeys: servicesKeys,
            hasSearchViewModel: typeof window.UTBucketedItemSearchViewModel === 'function',
            counts: {
                fetchSeen: STATE.diag.fetchSeen,
                xhrSeen: STATE.diag.xhrSeen,
                utasSeen: STATE.diag.utasSeen
            },
            lastUtasPaths: STATE.diag.lastUtasPaths,
            lastErrors: STATE.diag.lastErrors,
            uiScan: STATE.diag.uiScan || null,
            // Gesperrte Karten: wurden PaleTools-Locks gefunden und wie viele?
            locks: STATE.diag.locks || null,
            // Batch: was hat der Lauf pro Runde gesehen, als er die nächste
            // Instanz öffnen wollte? (Die Abbruchmeldung verweist darauf -
            // in v4.18.0 fehlte das Feld im Report, mein Fehler.)
            batchSteps: STATE.diag.batchSteps || null,
            // Der letzte fehlende Schritt: nach dem Abgeben landet die App im
            // SBC-HUB (mehrfach belegt), und loadChallenge() bringt die Ansicht
            // nicht zurück. Um die SBC wie von Hand anzuklicken, brauche ich die
            // Kachel-Elemente - hier ein Abzug davon, wenn wir im Hub stehen.
            hubScan: (function () {
                try {
                    const inHub = getControllerChain().some(c =>
                        /hub/i.test((c.constructor && c.constructor.name) || ''));
                    const out = { inHub: inHub, candidates: [] };
                    if (!inHub) return out;
                    // Alles, was nach SBC-Kachel/Set-Eintrag aussieht.
                    const sel = '[class*="sbc"],[class*="tile"],[class*="set"]';
                    const els = document.querySelectorAll(sel);
                    for (let i = 0; i < els.length && out.candidates.length < 40; i++) {
                        const e = els[i];
                        // Unsere eigene UI interessiert hier nicht - beim letzten
                        // Report hat sie die Liste vollgemacht.
                        if (String(e.className || '').indexOf('sbc-opt') > -1) continue;
                        if (!(e.offsetParent !== null || e.getClientRects().length)) continue;
                        const txt = (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 45);
                        if (!txt) continue;
                        const r = e.getBoundingClientRect();
                        if (r.width < 60 || r.height < 30) continue; // keine Mini-Elemente
                        out.candidates.push({
                            tag: e.tagName,
                            cls: String(e.className || '').slice(0, 70),
                            txt: txt,
                            w: Math.round(r.width), h: Math.round(r.height),
                            clickable: !!(e.onclick || e.getAttribute('role') === 'button')
                        });
                    }
                    return out;
                } catch (e) { return { error: String(e && e.message || e) }; }
            })(),
            // Submit-Diagnose: welcher Weg hat zuletzt gegriffen und ist
            // ueberhaupt eine Challenge offen?
            submitInfo: (function () {
                const svc = window.services && window.services.SBC;
                const ctrl = findSbcController();
                return {
                    saveChallengeThere: !!(svc && typeof svc.saveChallenge === "function"),
                    liveChallengeThere: !!findLiveChallenge(),
                    controllerName: (ctrl && ctrl.constructor && ctrl.constructor.name) || null
                };
            })(),
            // Einstiegspunkt-Diagnose: sitzt der Menüpunkt in der EA-Leiste
            // oder fällt die App auf den FAB zurück? tabBarCount zeigt, ob
            // mehrere (auch unsichtbare) Leisten im DOM stehen.
            launcher: (function () {
                function rect(el) {
                    try {
                        const r = el.getBoundingClientRect();
                        return { l: Math.round(r.left), t: Math.round(r.top),
                                 w: Math.round(r.width), h: Math.round(r.height) };
                    } catch (e) { return null; }
                }
                // Alle sichtbaren Buttons MIT Text - daraus ist der echte
                // Container der SBC-Aktionen ("Use Squad Builder" / "Clear
                // Squad") ablesbar, auch wenn .sbc-button-container in dieser
                // FC-Version anders heisst.
                let buttonDump = null;
                try {
                    buttonDump = [];
                    const btns = document.querySelectorAll('button');
                    for (let i = 0; i < btns.length && buttonDump.length < 25; i++) {
                        const b = btns[i];
                        if (!(b.offsetParent !== null || b.getClientRects().length)) continue;
                        const txt = (b.textContent || '').trim().slice(0, 40);
                        if (!txt) continue;
                        buttonDump.push({
                            txt: txt,
                            id: b.id || null,
                            cls: String(b.className || '').slice(0, 60),
                            parentCls: String((b.parentNode && b.parentNode.className) || '').slice(0, 60),
                            r: rect(b)
                        });
                    }
                } catch (e) {}
                let fabPos = null;
                try { fabPos = localStorage.getItem('sbcOptFabPos'); } catch (e) {}
                const btn = document.getElementById(BTN_ID);
                const cont = sbcButtonContainer();
                return {
                    inSbcView: inSbcView(),
                    controllerNames: (function () {
                        try {
                            return getControllerChain().map(function (c) {
                                return (c.constructor && c.constructor.name) || '?';
                            });
                        } catch (e) { return null; }
                    })(),
                    // Container der SBC-Aktionsleiste
                    containerSelector: '.sbc-button-container',
                    containerCount: document.querySelectorAll('.sbc-button-container').length,
                    containerVisible: !!cont,
                    containerRect: cont ? rect(cont) : null,
                    containerChildren: cont ? (function () {
                        const out = [];
                        for (let i = 0; i < cont.children.length && i < 12; i++) {
                            out.push({
                                tag: cont.children[i].tagName,
                                id: cont.children[i].id || null,
                                txt: (cont.children[i].textContent || '').trim().slice(0, 30),
                                cls: String(cont.children[i].className || '').slice(0, 60)
                            });
                        }
                        return out;
                    })() : null,
                    btnAttached: !!btn,
                    btnRect: btn ? rect(btn) : null,
                    btnAttachCount: btnAttachCount,
                    // 0 = unser Klick kommt gar nicht an; >0 = Klick kam an
                    // (dann liegt ein "es passiert nichts" am Panel, nicht am Button)
                    launcherClicks: launcherClicks,
                    visibleButtons: buttonDump,
                    viewport: { w: window.innerWidth, h: window.innerHeight,
                                dpr: window.devicePixelRatio || 1 },
                    fabVisible: !!(ui.fab && !ui.fab.classList.contains('sbc-opt-hidden')),
                    fabSavedPos: fabPos,
                    panelRect: ui.panel ? rect(ui.panel) : null,
                    panelOpen: !!(ui.panel && ui.panel.classList.contains('open'))
                };
            })(),
            refreshLog: STATE.diag.refreshLog || null,
            submitVia: STATE.diag.submitVia || null,
            controllerScan: controllerScan(),
            appSquadPutBodySample: STATE.diag.lastSquadPutBody || null,
            sbc: {
                setId: STATE.sbc.setId,
                challengeId: STATE.sbc.challengeId,
                squadId: STATE.sbc.squadId,
                targetOVR: STATE.sbc.targetOVR,
                slots: STATE.sbc.formationSlots,
                apiPrefix: STATE.sbc.apiPrefix,
                rarityConstraints: STATE.sbc.rarityConstraints,
                playerLevelConstraints: STATE.sbc.playerLevelConstraints,
                qualityConstraints: STATE.sbc.qualityConstraints || [],
                usableSlots: STATE.sbc.usableSlots || null,
                reqDump: STATE.sbc.reqDump,
                entityCaptured: !!STATE.sbc.entity,
                setChallengesCached: !!STATE.lastSetChallenges
            },
            poolSize: STATE.pool.length,
            // Verteilung der rareflags im Pool - zum Verifizieren der
            // Gold/Special-Klassifizierung
            rareflagHistogram: (function () {
                const m = {};
                for (const p of STATE.pool) {
                    const key = String(p.rareflag);
                    m[key] = (m[key] || 0) + 1;
                }
                return m;
            })(),
            poolSpecialCount: STATE.pool.filter(p => p.isSpecial).length,
            evoExcluded: STATE.diag.evoExcluded,
            // Struktur-Samples hoher Karten: verrät uns die echten Feldnamen,
            // falls Evolutions/Specials noch falsch klassifiziert werden.
            highCardSamples: STATE.pool
                .filter(p => p.rating >= 85)
                .slice(0, 5)
                .map(function (p) {
                    return {
                        id: p.id, rating: p.rating, rareflag: p.rareflag,
                        isSpecial: p.isSpecial, isStorage: p.isStorage,
                        rawKeys: p.raw ? Object.keys(p.raw).slice(0, 60) : null
                    };
                }),
            challengeResponseSample: challengeSample
        };
    }
    function onDiagClick() {
        const report = buildDiagReport();
        console.log(LOG_PREFIX + ' ===== DIAGNOSE-REPORT (bitte komplett kopieren) =====');
        console.log(JSON.stringify(report, null, 2));
        console.log(LOG_PREFIX + ' ===== ENDE DIAGNOSE-REPORT =====');
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(JSON.stringify(report, null, 2))
                    .then(() => toast('Diagnose in Konsole geschrieben und in Zwischenablage kopiert.', ''))
                    .catch(() => toast('Diagnose in Konsole geschrieben (F12 → Console).', ''));
                return;
            }
        } catch (e) {}
        toast('Diagnose in Konsole geschrieben (F12 → Console).', '');
    }
    // (Anker-Spieler-Feature auf Nutzerwunsch entfernt - der Solver kann
    // cfg.anchorId weiterhin, nur die UI dafür ist weg.)
    function renderAnchorOptions() {
        renderRarityPickOptions();
    }
    // Auswahl-Liste für die Rarity-Vorgabe: nur Special-Karten
    function renderRarityPickOptions() {
        if (!ui.rarityPick) return;
        const filter = (ui.rarityPickFilter.value || '').toLowerCase();
        const prev = ui.rarityPick.value;
        const list = STATE.pool
            .filter(p => p.isSpecial)
            .filter(p => !filter || (p.name || '').toLowerCase().indexOf(filter) > -1)
            .sort((a, b) => a.rating - b.rating)
            .slice(0, 300);
        let html = '<option value="">– automatisch wählen –</option>';
        for (const p of list) {
            html += '<option value="' + p.id + '">' + escapeHtml(p.name) + ' (' + p.rating +
                    (p.isStorage ? ', Storage' : '') + ')</option>';
        }
        ui.rarityPick.innerHTML = html;
        ui.rarityPick.value = prev;
    }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function readConfig() {
        return {
            targetOVR: STATE.sbc.targetOVR,
            slots: STATE.sbc.formationSlots || 11,
            minRating: parseInt(ui.minrating.value, 10) || 1,
            maxOvershoot: Math.max(0, parseFloat(String(ui.maxwaste.value).replace(',', '.')) || 0),
            applyRarity: ui.applyrarity.checked,
            specialOnlyFromStorage: ui.specialstorage.checked,
            maxExpensiveEnabled: ui.maxexpEn.checked,
            maxExpensiveCount: parseInt(ui.maxexpCount.value, 10) || 0,
            expensiveThreshold: parseInt(ui.maxexpTh.value, 10) || 99,
            scarcityWeight: parseFloat(ui.scarcity.value) || 0,
            storageBonus: parseFloat(ui.storagebonus.value) || 0,
            untradeableBonus: parseFloat(ui.untradeable.value) || 0,
            // Gesperrte Karten (PaleTools-Schloss) beim Optimieren frisch
            // einlesen - sie koennen sich zwischen zwei Laeufen aendern.
            lockedIds: ui.useLocks.checked ? Array.from(readPaletoolsLocks()) : [],
            rarityGuardCost: parseFloat(ui.rarityguard.value) || 0,
            ratingCostSpec: bandsToSpec(ratingBands),
            anchorId: null,
            rarityPickId: ui.rarityPick.value || null,
            rarityConstraints: STATE.sbc.rarityConstraints || [],
            qualityConstraints: STATE.sbc.qualityConstraints || [],
            playerLevelConstraints: STATE.sbc.playerLevelConstraints || []
        };
    }
    // Hintergrund-Ladung beim App-Start (gleiche Mechanik wie der Button,
    // nur ohne Klick). Fehler sind still - der Button bleibt der Notausgang.
    async function autoLoadPool() {
        if (STATE.loading || STATE.pool.length) return;
        STATE.loading = true;
        if (ui.load) ui.load.textContent = 'Abbrechen';
        setStatus('lade Spieler automatisch...');
        try {
            await loadPool((n, total) => {
                setStatus('lade (auto)... ' + n + (total ? ' / ' + total : ''));
                if (ui.poolcount) ui.poolcount.textContent = String(n);
            });
            refreshSbcInfoUI();
            renderAnchorOptions();
            setStatus('Pool bereit (' + STATE.pool.length + ')');
            toast('Spieler automatisch geladen: ' + STATE.pool.length + ' Karten.', '');
        } catch (e) {
            warn('Auto-Load fehlgeschlagen:', e.message);
            setStatus('Auto-Load fehlgeschlagen - bitte "Spieler laden" drücken');
        } finally {
            STATE.loading = false;
            STATE.cancelLoad = false;
            if (ui.load) ui.load.textContent = 'Spieler laden';
            refreshDiagUI();
        }
    }
    async function onLoadClick() {
        // Während des Ladens fungiert der Button als Abbrechen-Knopf.
        if (STATE.loading) {
            STATE.cancelLoad = true;
            setStatus('breche ab...');
            return;
        }
        STATE.loading = true;
        ui.load.textContent = 'Abbrechen';
        setStatus('lade Spieler...');
        // VOLL-REFRESH: alten Pool verwerfen. Der Merge behält sonst Karten,
        // die längst verbraucht/verkauft sind - und der Server lehnt solche
        // Karteileichen beim Eintragen mit 460 ab. Bei Fehlschlag wird der
        // alte Stand wiederhergestellt.
        const backupById = STATE.poolById, backupPool = STATE.pool;
        STATE.poolById = new Map();
        STATE.pool = [];
        try {
            await loadPool((n, total) => {
                setStatus('lade... ' + n + (total ? ' / ' + total : ''));
                ui.poolcount.textContent = String(n);
            });
            if (!STATE.pool.length) { STATE.poolById = backupById; STATE.pool = backupPool; }
            refreshSbcInfoUI();
            renderAnchorOptions();
            setStatus(STATE.cancelLoad ? 'abgebrochen (' + STATE.pool.length + ')' : 'Pool bereit (' + STATE.pool.length + ')');
            toast(STATE.pool.length + ' Spieler im Pool.', '');
        } catch (e) {
            if (!STATE.pool.length) { STATE.poolById = backupById; STATE.pool = backupPool; }
            setStatus('Fehler beim Laden');
            toast(e.message || 'Fehler beim Laden.', 'error');
            warn('Laden fehlgeschlagen:', e);
        } finally {
            STATE.loading = false;
            STATE.cancelLoad = false;
            ui.load.textContent = 'Spieler laden';
            refreshDiagUI();
        }
    }
    async function onRunClick() {
        // Erkennung IMMER mit der offen sichtbaren Challenge abgleichen -
        // der Hook-Zustand kann nach Pack-Öffnen/Submit veraltet sein.
        syncSbcWithOpenChallenge();
        if (!STATE.sbc.targetOVR && !(STATE.sbc.playerLevelConstraints || []).length &&
            !(STATE.sbc.rarityConstraints || []).length &&
            !(STATE.sbc.qualityConstraints || []).length) {
            toast('Kein Ziel-OVR erkannt. Bitte SBC-Challenge im Spiel öffnen (und ggf. Diagnose-Button nutzen).', 'error');
            return;
        }
        if (STATE.pool.length === 0) {
            toast('Pool leer. Bitte zuerst "Spieler laden".', 'error');
            return;
        }
        if (STATE.loadIncomplete) {
            toast('ACHTUNG: Der Pool ist unvollständig geladen (' + STATE.pool.length +
                ' Karten) - das Ergebnis kann schlechter oder unlösbar sein. Am besten erst "Spieler laden" erneut ausführen.', 'warn');
        }
        setStatus('optimiere...');
        ui.run.disabled = true;
        try {
            const cfg = readConfig();
            let res;
            try { res = SolverCore.solve(STATE.pool, cfg); }
            catch (e) { toast('Optimierungsfehler: ' + e.message, 'error'); setStatus('Fehler'); warn(e); return; }
            renderResult(res);
            if (res.ok) {
                setStatus('Lösung gefunden (OVR ' + res.ovr + ') - trage ein...');
                // Direkt eintragen - ein Klick, fertig. Der separate Button
                // bleibt als "Erneut eintragen"-Fallback sichtbar.
                await submitCurrentResult();
            } else {
                setStatus('keine Lösung');
                toast(res.reason || 'Keine Lösung gefunden.', 'error');
            }
        } finally {
            ui.run.disabled = false;
        }
    }
    function renderResult(res) {
        if (!ui.result) return;
        if (!res.ok && (!res.players || !res.players.length)) {
            ui.result.className = 'sbc-opt-result show';
            let h = '<div class="sbc-opt-warn">' + escapeHtml(res.reason || 'Keine Lösung.') + '</div>';
            for (const w of (res.warnings || [])) h += '<div class="sbc-opt-warn">⚠ ' + escapeHtml(w) + '</div>';
            ui.result.innerHTML = h;
            ui.submit.style.display = 'none';
            return;
        }
        let html = '';
        const players = res.players.slice().sort((a, b) => b.rating - a.rating);
        for (const p of players) {
            const badgeCls = 'sbc-opt-badge' + (p.isSpecial ? ' special' : '') + (p.isStorage ? ' storage' : '');
            html += '<div class="sbc-opt-player"><span>' + escapeHtml(displayName(p)) +
                    (p.isStorage ? ' <span style="color:#0077ff;font-size:11px;">[Storage]</span>' : '') +
                    '</span><span class="' + badgeCls + '">' + p.rating + '</span></div>';
        }
        const nStorage = res.players.filter(p => p.isStorage).length;
        const wasteTxt = (typeof res.waste === 'number')
            ? ((res.waste >= 0 ? '+' : '') + res.waste.toFixed(2)) : '–';
        html += '<div class="sbc-opt-summary">Team-OVR: <b>' + res.ovr + '</b>' +
                (res.ovrExact != null ? ' <span style="color:#9db2c8;">(' + res.ovrExact.toFixed(2) + ')</span>' : '') +
                (res.target ? ' / Ziel ' + res.target : '') +
                ' &nbsp; Überschuss: <b>' + wasteTxt + '</b>' +
                (nStorage ? ' &nbsp; Storage: <b>' + nStorage + '</b>' : '') + '</div>';
        if (res.poolInfo) {
            html += '<div style="color:#7d93ab;font-size:11px;">Pool nach Filtern: ' + res.poolInfo.count +
                    ' Karten (' + res.poolInfo.min + '–' + res.poolInfo.max + ')</div>';
        }
        for (const w of (res.warnings || [])) html += '<div class="sbc-opt-warn">⚠ ' + escapeHtml(w) + '</div>';
        if (!res.ok && res.reason) html += '<div class="sbc-opt-warn">⚠ ' + escapeHtml(res.reason) + '</div>';
        ui.result.className = 'sbc-opt-result show';
        ui.result.innerHTML = html;
        ui.submit.style.display = res.ok ? 'block' : 'none';
    }
    async function onSubmitClick() {
        await submitCurrentResult();
    }
    // ========================================================================
    //  BATCH: dieselbe SBC mehrfach abschliessen
    // ========================================================================
    // Der Knackpunkt: JEDE Wiederholung einer SBC hat eine EIGENE challengeId.
    // Die alte ID nach dem Abgeben weiterzubenutzen laedt die verbrauchte
    // Instanz (404/475) - deshalb ist der Anker das SET plus die Vorgaben, und
    // die frische Instanz kommt dadurch, dass die Set-Kachel im Hub geklickt
    // wird (siehe openNextInstance). Genau daran sind die ersten Versuche
    // gescheitert.
    function batchWait(ms) { return new Promise(r => setTimeout(r, ms)); }
    // ---- Fortschrittsanzeige fuer den Batch --------------------------------
    // Rasmus' Wunsch: "einfach ein Ladebalken und da steht SBC 1/5" - statt im
    // Panel nach dem Status zu suchen.
    function showProgress(cur, total, step, doneText) {
        if (!ui.progress) return;
        ui.progress.classList.add('open');
        ui.progTitle.textContent = 'SBC ' + cur + ' von ' + total;
        ui.progStep.textContent = step || '';
        const pct = Math.max(0, Math.min(100, Math.round(((cur - 1) / total) * 100)));
        ui.progFill.style.width = pct + '%';
        ui.progDone.textContent = doneText || '';
    }
    function finishProgress(text, ok) {
        if (!ui.progress) return;
        ui.progTitle.textContent = ok ? 'Fertig' : 'Gestoppt';
        ui.progTitle.style.color = ok ? '#00e0b8' : '#ff6b6b';
        ui.progStep.textContent = text || '';
        ui.progFill.style.width = '100%';
        // Kurz stehen lassen, damit man das Ergebnis liest.
        setTimeout(function () {
            if (ui.progress) {
                ui.progress.classList.remove('open');
                ui.progTitle.style.color = '#00e0b8';
            }
        }, ok ? 2600 : 5000);
    }
    /** Belohnungs-Dialog wegräumen (EAs eigener Popup-Manager). */
    function dismissRewardPopup() {
        let closed = false;
        try {
            const shield = window.gPopupClickShield;
            if (shield && typeof shield.closeActivePopup === 'function') {
                shield.closeActivePopup();
                closed = true;
            }
        } catch (e) {}
        // Zweiter Weg: ist der oberste präsentierte Controller ein Dialog,
        // bringt er sein eigenes Schliessen mit. Nach dem Abgeben koennen
        // mehrere Overlays hintereinander kommen.
        try {
            const chain = getControllerChain();
            const top = chain.length ? chain[chain.length - 1] : null;
            const n = (top && top.constructor && top.constructor.name) || '';
            if (top && /popup|dialog|reward|award/i.test(n)) {
                for (const m of ['close', 'dismiss', 'hide', 'onClose']) {
                    if (typeof top[m] === 'function') { top[m](); closed = true; break; }
                }
            }
        } catch (e) {}
        return closed;
    }
    /**
     * SBC endgültig abgeben - über die Methode des LIVE-CONTROLLERS. Der
     * Service-Weg mit Challenge-Argument kam live mit 403 zurück
     * (submitChallenge nimmt gar kein Argument), der Controller-Weg ist der,
     * den die App beim Klick auf ihren eigenen Submit-Button nimmt.
     * UNWIDERRUFLICH - nur aus dem Batch nach expliziter Freigabe.
     */
    async function submitChallengeToEa() {
        const ctrl = findSbcController();
        const liveSquad = ctrl && (ctrl._squad || (ctrl.getSquad && ctrl.getSquad()));
        if (liveSquad && typeof liveSquad.isSBCSquadEligible === 'function') {
            let eligible = null;
            try { eligible = liveSquad.isSBCSquadEligible(); } catch (e) {}
            if (eligible === false) {
                throw new Error('EA hält die SBC nicht für abgabefähig - wahrscheinlich ' +
                    'eine Vorgabe offen, die wir nicht abdecken. NICHT abgegeben.');
            }
        }
        const problems = [];
        if (ctrl && typeof ctrl.submitChallenge === 'function') {
            try {
                const r = ctrl.submitChallenge();
                let resp = null;
                if (r && (typeof r.then === 'function' || typeof r.subscribe === 'function' ||
                          typeof r.observe === 'function')) resp = await obsPromise(r);
                if (resp && !responseOk(resp)) problems.push('Controller: Status ' + resp.status);
                else { STATE.diag.submitChallengeVia = 'controller'; return { via: 'controller' }; }
            } catch (e) { problems.push('Controller: ' + (e && e.message || e)); }
        } else problems.push('Controller hat kein submitChallenge()');
        const svc = window.services && window.services.SBC;
        if (svc && typeof svc.submitChallenge === 'function') {
            try {
                const resp = await obsPromise(svc.submitChallenge());
                if (responseOk(resp)) { STATE.diag.submitChallengeVia = 'service'; return { via: 'service' }; }
                problems.push('Service: Status ' + (resp && resp.status));
            } catch (e) { problems.push('Service: ' + (e && e.message || e)); }
        }
        throw new Error('Abgeben fehlgeschlagen (' + problems.join(' | ') + ').');
    }
    /**
     * Nach dem Abgeben die NEUE Instanz derselben SBC oeffnen.
     * Reihenfolge: Dialog wegraeumen -> Challenge-Liste des Sets neu holen
     * (dort steht die frische challengeId) -> die passende laden -> warten, bis
     * der Squad-Controller wieder da ist.
     * Erkennung "passend": gleiche Vorgaben-Signatur wie beim Planen
     * (Ziel-OVR + Slots), NICHT die alte ID - die aendert sich ja gerade.
     */
    async function openNextInstance(plan) {
        const steps = [];
        const t0 = Date.now();
        let clicked = false;
        // Alle 300ms nachsehen statt jede Sekunde, und den Set-Klick SOFORT
        // versuchen. Aus dem Live-Log: der Controller war 4s nach dem Klick da,
        // die 4s Vorlauf und die vier Anlaeufe fuer die Challenge-Zeile waren
        // verschenkte Zeit - nach dem Kachel-Klick ist die Challenge direkt
        // offen (seen.detailsView war 1, rowView 0).
        // requestChallengesForSet ist raus: es lieferte freshId null und wird
        // nicht gebraucht, weil der Klick-Weg die frische Instanz mitbringt.
        for (let i = 0; i < 60; i++) {          // 60 x 300ms = max ~18s
            dismissRewardPopup();
            syncSbcWithOpenChallenge();
            const ctrl = findSbcController();
            const sq = ctrl && (ctrl._squad || (ctrl.getSquad && ctrl.getSquad()));
            let empty = null;
            try { if (sq && typeof sq.isSquadEmpty === 'function') empty = sq.isSquadEmpty(); }
            catch (e) {}
            if (ctrl && sq && matchesPlannedSbc(plan) && empty !== false) {
                steps.push({ ms: Date.now() - t0, done: true, clicked: clicked });
                return { ok: true, steps: steps };
            }
            // Im Hub: Set-Kachel anklicken. Erster Versuch sofort, danach
            // gelegentlich nachfassen (die Kachelliste braucht manchmal einen
            // Moment, bis sie gerendert ist).
            if (!ctrl && (!clicked || i === 20 || i === 40)) {
                const s1 = clickSetTile(plan);
                if (s1.ok) {
                    clicked = true;
                    steps.push({ ms: Date.now() - t0, setTile: s1 });
                    await batchWait(500);
                    continue;
                }
                if (i === 6 || i === 20) steps.push({ ms: Date.now() - t0, setTile: s1 });
            }
            // Nur falls das Set MEHRERE Challenges hat, steht eine Zeilenliste
            // offen - dann die erste anklicken.
            if (!ctrl && clicked && (i === 10 || i === 25)) {
                const s2 = clickChallengeRow();
                if (s2.ok) { steps.push({ ms: Date.now() - t0, chRow: s2 }); await batchWait(500); }
                else if (i === 10) steps.push({ ms: Date.now() - t0, chRow: s2 });
            }
            await batchWait(300);
        }
        return { ok: false, steps: steps };
    }
    /**
     * Im HUB die SBC wieder aufmachen - der Weg, den Rasmus von Hand geht.
     * Nach dem Abgeben steht die App im SBC-Hub, und
     * services.SBC.loadChallenge() laedt nur Daten ohne die Ansicht zu
     * wechseln (dreimal belegt). Also: Set-Kachel anklicken, dann die
     * Challenge-Zeile.
     *
     * Die Klassen sind EA-eigene (in PaleTools' Bundle verifiziert):
     *   .ut-sbc-set-tile-view              - Set-Kachel im Hub
     *   .ut-sbc-challenge-table-row-view   - Challenge-Zeile in der Set-Ansicht
     * Ein Klick darauf ist harmlos (oeffnet nur eine Ansicht) - anders als ein
     * geratener Klick in einem Belohnungs-Dialog.
     */
    /**
     * Vollständige Tap-Sequenz. Ein nacktes el.click() reicht NICHT: die
     * EA-Views hängen an ihrem eigenen Event-System (PaleTools registriert
     * dort mit `addTarget(…, EventType.TAP)`), das auf die Pointer-/Maus-Kette
     * hört. Live gesehen: der Set-Kachel-Klick meldete Erfolg, die Ansicht
     * reagierte aber nicht.
     */
    function clickLike(el) {
        if (!el) return false;
        const o = { bubbles: true, cancelable: true, view: window, button: 0 };
        let sent = 0;
        function fire(type, Ctor) {
            try { el.dispatchEvent(new Ctor(type, o)); sent++; } catch (e) {}
        }
        try {
            if (typeof window.PointerEvent === 'function') {
                fire('pointerdown', window.PointerEvent);
                fire('pointerup', window.PointerEvent);
            }
            fire('mousedown', MouseEvent);
            fire('mouseup', MouseEvent);
            fire('click', MouseEvent);
            return sent > 0;
        } catch (e) { return false; }
    }
    function visibleAll(sel) {
        const out = [];
        try {
            const els = document.querySelectorAll(sel);
            for (let i = 0; i < els.length; i++) {
                const e = els[i];
                if (e.offsetParent !== null || e.getClientRects().length) out.push(e);
            }
        } catch (e) {}
        return out;
    }
    /** Set-Kachel im Hub anklicken (per Set-Name). */
    function clickSetTile(plan) {
        const tiles = visibleAll('.ut-sbc-set-tile-view');
        if (!tiles.length) return { ok: false, why: 'keine Set-Kacheln sichtbar' };
        const want = String(plan.setName || '').trim().toLowerCase();
        let hit = null;
        if (want) {
            for (const t of tiles) {
                const txt = (t.textContent || '').replace(/\s+/g, ' ').toLowerCase();
                if (txt.indexOf(want) > -1) { hit = t; break; }
            }
        }
        if (!hit) return { ok: false, why: 'Set "' + (plan.setName || '?') + '" nicht gefunden (' + tiles.length + ' Kacheln)' };
        return { ok: clickLike(hit), why: 'Set-Kachel geklickt' };
    }
    /** Challenge-Zeile in der geoeffneten Set-Ansicht anklicken. */
    function clickChallengeRow() {
        let rows = visibleAll('.ut-sbc-challenge-table-row-view');
        if (!rows.length) rows = visibleAll('.ut-sbc-challenge-tile-view');
        if (!rows.length) rows = visibleAll('.ut-sbc-challenges-view--challenges > *');
        if (!rows.length) {
            return { ok: false, why: 'keine Challenge-Zeilen sichtbar', seen: {
                rowView: document.querySelectorAll('.ut-sbc-challenge-table-row-view').length,
                tileView: document.querySelectorAll('.ut-sbc-challenge-tile-view').length,
                container: document.querySelectorAll('.ut-sbc-challenges-view--challenges').length,
                detailsView: document.querySelectorAll('.ut-sbc-challenge-details-view').length
            } };
        }
        // Die erste Zeile ist die noch offene Wiederholung.
        return { ok: clickLike(rows[0]), why: rows.length + ' Zeile(n), erste geklickt' };
    }
    /** Passt die offene SBC zu dem, wofuer geplant wurde? (Vorgaben, nicht ID) */
    function matchesPlannedSbc(plan) {
        if (String(STATE.sbc.targetOVR || '') !== String(plan.targetOVR || '')) return false;
        if (Number(STATE.sbc.slots || 0) !== Number(plan.slots || 0)) return false;
        return true;
    }
    async function onBatchPlanClick() {
        syncSbcWithOpenChallenge();
        if (!STATE.sbc.targetOVR && !(STATE.sbc.playerLevelConstraints || []).length &&
            !(STATE.sbc.rarityConstraints || []).length &&
            !(STATE.sbc.qualityConstraints || []).length) {
            toast('Keine SBC-Vorgaben erkannt. Bitte Challenge im Spiel öffnen.', 'error');
            return;
        }
        if (!STATE.pool.length) { toast('Pool leer. Bitte zuerst "Spieler laden".', 'error'); return; }
        const want = Math.max(1, Math.min(10, parseInt(ui.batchCount.value, 10) || 1));
        ui.batchPlan.disabled = true;
        setStatus('plane ' + want + ' Teams...');
        try {
            const plan = SolverCore.planBatch(STATE.pool, readConfig(), want);
            // Anker ist das SET plus die Vorgaben - die challengeId aendert
            // sich pro Wiederholung und taugt nicht als Vergleich.
            plan.setId = STATE.sbc.setId;
            plan.targetOVR = STATE.sbc.targetOVR;
            plan.slots = STATE.sbc.slots;
            plan.usedChallengeIds = [];
            // Set-NAME: damit die richtige Kachel im Hub wiedergefunden wird
            // (der Controller haelt das Set als UTSBCSetEntity).
            plan.setEntity = (function () {
                try {
                    const c = findSbcController();
                    return (c && (c._set || c.set)) || null;
                } catch (e) { return null; }
            })();
            plan.setName = (plan.setEntity &&
                (plan.setEntity.name || plan.setEntity.setName)) || null;
            STATE.batch = plan;
            renderBatchPreview(plan);
            setStatus(plan.planned + ' von ' + want + ' Teams geplant');
        } catch (e) {
            toast('Batch-Planung fehlgeschlagen: ' + e.message, 'error');
            warn(e);
        } finally { ui.batchPlan.disabled = false; }
    }
    /** Kurzbezeichnung der Rarity. Die rareflag-NUMMER bleibt sichtbar -
     *  welche Zahl welches Event ist, weiss Rasmus besser als das Script. */
    function rarityLabel(p) {
        const rf = Number(p.rareflag);
        let base;
        if (rf === 3) base = 'TOTW';
        else if (rf === 0 || rf === 1) base = 'Gold';
        else base = 'Special rf' + rf;
        return base + ((p.groups && p.groups.indexOf(83) > -1) ? ' · Gruppe 83' : '');
    }
    function renderBatchPreview(plan) {
        const box = ui.batchPreview;
        if (!box) return;
        let html = '';
        plan.rounds.forEach(function (r, i) {
            const nStore = r.players.filter(p => p.isStorage).length;
            const nUntr = r.players.filter(p => p.untradeable).length;
            const nProt = r.players.filter(p => p.groups && p.groups.indexOf(83) > -1).length;
            html += '<div class="sbc-opt-batch-round"><b>Team ' + (i + 1) + ':</b> OVR ' +
                r.ovr + ' (' + r.ovrExact.toFixed(2) + ')' +
                '<br><span style="color:#9db2c8;">Storage ' + nStore +
                ' · unverkäuflich ' + nUntr +
                (nProt ? ' · <span class="sbc-opt-batch-warn">geschützt ' + nProt + '</span>' : '') +
                '</span><div class="sbc-opt-batch-cards">';
            for (const p of r.players.slice().sort((a, b) => b.rating - a.rating)) {
                const prot = !!(p.groups && p.groups.indexOf(83) > -1);
                html += '<div class="sbc-opt-batch-card' + (prot ? ' prot' : '') + '">' +
                    '<span class="r">' + p.rating + '</span> ' + escapeHtml(displayName(p)) +
                    ' <span class="src">' + (p.isStorage ? 'Storage' : 'Verein') + '</span>' +
                    ' <span class="rar">' + escapeHtml(rarityLabel(p)) + '</span>' +
                    (p.untradeable ? ' <span class="untr">unverkäuflich</span>' : '') + '</div>';
            }
            html += '</div>';
            for (const w of (r.warnings || [])) {
                html += '<span class="sbc-opt-batch-warn">⚠ ' + escapeHtml(w) + '</span><br>';
            }
            html += '</div>';
        });
        if (plan.stoppedReason) {
            html += '<div class="sbc-opt-batch-round sbc-opt-batch-bad">Nur ' + plan.planned +
                ' von ' + plan.requested + ' möglich: ' + escapeHtml(plan.stoppedReason) + '</div>';
        }
        box.innerHTML = html;
        ui.batchRun.style.display = plan.planned ? 'block' : 'none';
        ui.batchRun.disabled = false;
        ui.batchRun.textContent = 'Alle ' + plan.planned + ' eintragen + abgeben';
    }
    /**
     * Arbeitet den Plan ab: eintragen -> abgeben -> naechste Instanz oeffnen.
     * Bricht bei jeder Unstimmigkeit ab - "2 von 5 fertig" ist besser als eine
     * falsch abgegebene SBC.
     */
    async function onBatchRunClick() {
        const plan = STATE.batch;
        if (!plan || !plan.planned) { toast('Erst "Teams planen" ausführen.', 'error'); return; }
        const n = plan.planned;
        if (!window.confirm(n + ' SBC(s) werden eingetragen UND endgültig abgegeben.\n\n' +
                'Die verbauten Karten sind danach weg. Fortfahren?')) return;
        ui.batchRun.disabled = true;
        ui.batchPlan.disabled = true;
        ui.run.disabled = true;
        let done = 0, stopped = null;
        const doneLog = [];
        try {
            for (let i = 0; i < n; i++) {
                const round = plan.rounds[i];
                const tag = 'Batch ' + (i + 1) + '/' + n;
                const missing = round.players.filter(p =>
                    !STATE.pool.some(q => String(q.id) === String(p.id)));
                if (missing.length) {
                    throw new Error(tag + ': ' + missing.length + ' Karte(n) nicht mehr im Pool.');
                }
                showProgress(i + 1, n, 'prüfe SBC...', (doneLog.length ? doneLog.length + ' fertig' : ''));
                setStatus(tag + ': prüfe Challenge...');
                syncSbcWithOpenChallenge();
                if (!findSbcController() || !findLiveChallenge()) {
                    throw new Error(tag + ': keine offene SBC-Ansicht.');
                }
                if (!matchesPlannedSbc(plan)) {
                    throw new Error(tag + ': die offene SBC passt nicht zum Plan ' +
                        '(Ziel ' + STATE.sbc.targetOVR + '/' + STATE.sbc.slots + ' statt ' +
                        plan.targetOVR + '/' + plan.slots + '). Nichts eingetragen.');
                }
                // Die JETZT offene Instanz merken - sie ist nach dem Abgeben
                // verbraucht und darf beim Suchen der neuen nicht wieder kommen.
                if (STATE.sbc.challengeId != null) {
                    plan.usedChallengeIds.push(String(STATE.sbc.challengeId));
                }
                showProgress(i + 1, n, 'trage Team ein (OVR ' + round.ovr + ')...',
                    (doneLog.length ? doneLog.length + ' fertig' : ''));
                setStatus(tag + ': trage ein...');
                const sub = await submitToSbc(round);
                if (sub && sub.via !== 'app') { await refreshChallengeCache(); refreshOpenSbcView(); }
                removeFromPool(round.players);
                showProgress(i + 1, n, 'gebe ab...', (doneLog.length ? doneLog.length + ' fertig' : ''));
                setStatus(tag + ': gebe ab...');
                await submitChallengeToEa();
                done++;
                doneLog.push('Team ' + (i + 1) + ': OVR ' + round.ovr + ' abgegeben');
                log('[Batch] Team ' + (i + 1) + '/' + n + ' abgegeben (OVR ' + round.ovr + ').');
                if (i + 1 < n) {
                    showProgress(i + 2, n, 'öffne die nächste SBC...', (doneLog.length ? doneLog.length + ' fertig' : ''));
                    setStatus(tag + ': öffne die nächste Runde...');
                    const next = await openNextInstance(plan);
                    STATE.diag.batchSteps = (STATE.diag.batchSteps || []).concat([{
                        round: i + 1, ok: next.ok, steps: next.steps
                    }]).slice(-6);
                    if (!next.ok) {
                        throw new Error('Die nächste Runde liess sich nicht öffnen ' +
                            '(Diagnose schicken: batchSteps).');
                    }
                }
            }
        } catch (e) {
            stopped = (e && e.message) || String(e);
            warn('[Batch] gestoppt:', e);
            diagError('Batch gestoppt nach ' + done + '/' + n + ': ' + stopped);
        } finally {
            ui.batchPlan.disabled = false;
            ui.run.disabled = false;
            ui.batchRun.style.display = 'none';
            STATE.batch = null;   // Plan verbraucht - kein zweites Abgeben
            let html = doneLog.length
                ? '<div class="sbc-opt-batch-round">' + doneLog.map(escapeHtml).join('<br>') + '</div>' : '';
            if (stopped) {
                finishProgress(done + ' von ' + n + ' abgegeben · ' + stopped, false);
                setStatus('Batch gestoppt nach ' + done + '/' + n);
                toast('Batch gestoppt nach ' + done + ' von ' + n + ': ' + stopped, 'error');
                html += '<div class="sbc-opt-batch-round sbc-opt-batch-bad">Gestoppt: ' +
                    escapeHtml(stopped) + '</div>';
            } else {
                finishProgress(done + ' SBC(s) eingetragen und abgegeben', true);
                setStatus(done + ' SBC(s) abgegeben ✓');
                toast(done + ' von ' + n + ' SBCs eingetragen und abgegeben.', 'ok');
            }
            ui.batchPreview.innerHTML = html;
        }
    }
    // ---- Helfer, die auch die Diagnose nutzt -------------------------------
    // Der Lauf "mehrere SBCs automatisch abgeben" ist ausgebaut (siehe
    // LEARNINGS 9 und ROADMAP). Diese zwei Helfer bleiben, weil der
    // Diagnose-Report mit ihnen zeigt, ob eine Challenge offen ist.
    function findLiveChallenge() {
        for (const c of getControllerChain()) {
            const n = (c.constructor && c.constructor.name) || '';
            if (!/sbc/i.test(n)) continue;
            for (const key of ['_overviewController', 'leftController', '_leftController']) {
                const oc = c[key];
                if (oc && oc._challenge) return oc._challenge;
            }
            if (c._challenge) return c._challenge;
        }
        return STATE.sbc.entity || null;
    }
    /** Der SBC-Controller der offenen Ansicht (mit Squad). */
    function findSbcController() {
        let found = null;
        for (const c of getControllerChain()) {
            const n = (c.constructor && c.constructor.name) || '';
            if (/sbc/i.test(n) && (c._squad || (c.getSquad && c.getSquad()))) found = c;
        }
        return found;
    }
    async function submitCurrentResult() {
        const res = STATE.lastResult;
        if (!res || !res.ok) {
            toast('Kein gültiges Ergebnis zum Eintragen. Erst "Optimieren" ausführen.', 'error');
            return;
        }
        ui.submit.disabled = true;
        setStatus('trage in SBC ein...');
        try {
            // Sicherstellen, dass wir in die offen sichtbare Challenge eintragen.
            syncSbcWithOpenChallenge();
            const sub = await submitToSbc(res);
            let live = (sub.via === 'app'); // App-Save aktualisiert die Ansicht selbst
            if (!live) {
                // Fallback-Wege: Challenge vom Server neu laden (App baut echte
                // Entities) und die offene Ansicht gezielt neu binden.
                await refreshChallengeCache();
                live = refreshOpenSbcView() || live;
            }
            // Verbaute Karten sofort aus dem Pool nehmen - die nächste SBC
            // kann ohne Neu-Laden optimiert werden.
            removeFromPool(res.players);
            setStatus('eingetragen ✓ (' + sub.confirmed + ' bestätigt)');
            if (live) {
                toast('Team eingetragen ✓ Server bestätigt ' + sub.confirmed + ' Spieler. Prüfen und selbst auf Submit drücken.', '');
            } else {
                toast('Team eingetragen ✓ Server bestätigt ' + sub.confirmed + ' Spieler. Falls das Feld leer aussieht: Challenge einmal verlassen und neu öffnen.', 'warn');
            }
        } catch (e) {
            setStatus('Eintrag fehlgeschlagen');
            const hint = /460|400/.test(String(e && e.message))
                ? ' Tipp: Der Server lehnt vermutlich eine Karte ab, die nicht mehr verfügbar ist (Pool veraltet). Einmal "Spieler laden" drücken und neu optimieren.'
                : '';
            toast('Eintragen fehlgeschlagen: ' + (e.message || e) + hint, 'error');
        } finally {
            ui.submit.disabled = false;
        }
    }
    // ========================================================================
    //  8. BOOTSTRAP
    // ========================================================================
    function installServicesHooks() {
        try {
            if (STATE.servicesHooked) return;
            if (typeof window.services !== 'object' || !window.services || !window.services.SBC) return;
            const sbc = window.services.SBC;
            if (typeof sbc.loadChallenge === 'function') {
                const orig = sbc.loadChallenge;
                STATE.origLoadChallenge = orig.bind(sbc);
                sbc.loadChallenge = function (challenge) {
                    try { captureChallengeEntity(challenge); } catch (e) {}
                    return orig.apply(this, arguments);
                };
                log('Hook auf services.SBC.loadChallenge installiert.');
            }
            STATE.servicesHooked = true;
            refreshDiagUI();
        } catch (e) {}
    }
    function boot() {
        if (document.getElementById('sbc-opt-fab')) return;
        injectStyles();
        buildPanel();
        installLauncherDelegation();
        log('UI initialisiert. Version', VERSION);
    }
    function waitForBody() {
        if (document.body) { boot(); }
        else {
            const obs = new MutationObserver(() => {
                if (document.body) { obs.disconnect(); boot(); }
            });
            obs.observe(document.documentElement, { childList: true });
            window.addEventListener('DOMContentLoaded', boot);
        }
        // Die EA-App räumt das DOM teils um - UI ggf. wieder anhängen.
        setInterval(function () {
            try {
                if (document.body && ui.fab && !document.getElementById('sbc-opt-fab')) {
                    document.body.appendChild(ui.fab);
                    document.body.appendChild(ui.panel);
                }
                refreshDiagUI();
            } catch (e) {}
        }, 2000);
        // Menüpunkt in der EA-Leiste: häufiger als der 2s-Watchdog, damit er
        // beim View-Wechsel praktisch sofort steht. Kostet nur zwei
        // DOM-Lookups - deutlich billiger als ein Observer über die ganze App.
        setInterval(function () { try { syncLauncher(); } catch (e) {} }, 500);
        // App-Services erscheinen erst nach dem App-Start.
        setInterval(installServicesHooks, 1000);
        // AUTO-LOAD: den Pool EINMAL im Hintergrund laden, sobald die Session
        // steht - dann ist beim Öffnen der ersten SBC schon alles da und
        // "Spieler laden" ist nur noch für manuelle Aktualisierung nötig.
        setInterval(function () {
            try {
                if (STATE.autoLoadTried || STATE.loading || STATE.pool.length) return;
                if (!sessionReady() || !ui.load) return;
                STATE.autoLoadTried = true;
                setTimeout(autoLoadPool, 2500); // App kurz ankommen lassen
            } catch (e) {}
        }, 2000);
        // Session-Keep-Alive: alle 4 Minuten ein leichter App-Request, damit
        // die EA-Session nicht abläuft, während man im Panel arbeitet.
        // (Der Request läuft über die App selbst - frische SID wird dabei
        // automatisch von unserer Interception aufgeschnappt.)
        setInterval(function () {
            try {
                if (window.services && window.services.Item &&
                    typeof window.services.Item.requestUnassignedItems === 'function') {
                    obsPromise(window.services.Item.requestUnassignedItems())
                        .then(function (r) {
                            if (!responseOk(r)) warn('Keep-Alive: Session evtl. abgelaufen (Status', r && r.status, ')');
                        })
                        .catch(function () {});
                }
            } catch (e) {}
        }, 240000);
    }
    // Ergebnis von onRunClick für den Submit merken
    const _origSolve = SolverCore.solve;
    SolverCore.solve = function (pool, cfg) {
        const res = _origSolve(pool, cfg);
        STATE.lastResult = res;
        return res;
    };
    // Debug-Zugriff für die Konsole
    try { window.__SBC_OPT = { STATE: STATE, Solver: SolverCore, diag: buildDiagReport }; } catch (e) {}
    waitForBody();
})();
