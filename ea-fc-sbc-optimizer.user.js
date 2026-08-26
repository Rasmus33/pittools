// ==UserScript==
// @name         EA FC SBC Rating-Optimizer
// @namespace    https://github.com/sbc-optimizer
// @version      5.6.0
// @description  Optimiert SBC-Teams rein nach Rating (minimaler Rating-Waste, exakter Solver). Erkennt Ziel-OVR & Rarity-Vorgaben automatisch, bevorzugt Storage- und häufig vorhandene Karten, trägt das Team in die SBC-Auswahl ein.
// @author       Rasmus Risse
// @copyright    2026 Rasmus Risse
// @license      PolyForm-Noncommercial-1.0.0; https://polyformproject.org/licenses/noncommercial/1.0.0
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
    const VERSION = '5.6.0';
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
            scopesSeen: [],              // ALLE erkannten Scope-Strings, ungefiltert (Whitelist-Gegenprobe)
            apiPrefix: 'sbs',            // beobachtetes Pfad-Präfix (sbs oder sbc)
            entity: null                 // via services.SBC.loadChallenge erfasst
        },
        poolById: new Map(),         // id -> Player
        pool: [],                    // Array-Sicht auf poolById
        lastResult: null,
        loading: false,
        servicesHooked: false,
        cancelLoad: false,
        locksSkipReported: false,    // schon einmal reportError() fuer einen uebersprungenen Lock-Key gemeldet? (verhindert Spam bei vielen korrupten Keys)
        lastChallengeRaw: null,      // letzte SBC-Response (fürs Debugging)
        lastSetChallenges: null,     // gecachte Challenge-Liste des geöffneten Sets
        // Set-Challenges PRO setId. Live-Fall (84+ TOTW, Report v4.58.0):
        // lastSetChallenges hielt die Antwort eines ANDEREN Sets, der
        // Knoten-Scan lief auf einem 5-Knoten-Stub und fand die
        // TOTW-Vorgabe nie - der Cache muss nach Set gekeyt sein.
        setChallengesBySet: {},
        // Pack-Opener (Store, Stufe 1, Ticket #69): letzte Enumeration + die
        // dazugehoerigen rohen Pack-Entities (fuer open()), gekeyt per
        // String(id) - Select-Optionswerte sind immer Strings.
        packGroups: [],
        packEntitiesById: new Map(),
        packOpenBusy: false,
        // Offene Ablage fuer Laufzeitzustand, den buildDiagReport() kopiert -
        // jedes tatsaechlich verwendete Feld MUSS hier deklariert sein
        // (solver-test.js prueft das symmetrisch: gelesen <-> deklariert <->
        // zugewiesen), sonst bleibt es im Report unbemerkt bei seinem
        // Initialwert stehen (siehe uiScan-Vorfall).
        diag: {
            fetchSeen: 0,
            xhrSeen: 0,
            utasSeen: 0,
            lastUtasPaths: [],       // letzte utas-Pfade (IDs maskiert)
            lastErrors: [],          // letzte Fehlermeldungen (ohne Tokens)
            evoExcluded: 0,          // ausgeschlossene Evolution-Karten
            lastSquadPutBody: null,  // letzter PUT-Body an den Squad (fuers 460-Debugging)
            staleRecover: null,      // Erholungsversuch bei veralteter challengeId
            staleSessionRetry: 0,    // Session-Erneuerungen nach 404/475
            throttle: null,          // EA weist ab: Anzahl/letzte Meldung (429/503/512/Failed to fetch)
            confirmDisabled: null,   // Abgabe-Bestaetigung abgeschaltet (eigene Notbremse)
            batchPlanTiming: null,   // Wo geht die Zeit beim Planen hin? (ms pro Phase)
            solverProfile: null,     // Solver-Innenleben: Stufen/Baender/Versuche pro Lauf
            poolCache: null,         // Pool-Cache: geschrieben? Groesse? Grund fuer Nein?
            poolCacheRead: null,     // Pool-Cache: benutzt? sonst WARUM nicht?
            submitIds: null,         // welche challengeId jeder Submit-Weg benutzt hat
            quota: null,             // SBC-Kontingent (Stunde/Tag)
            locks: null,             // PaleTools-Sperrliste: Anzahl + Beispiel-IDs
            clubLoad: null,          // Club-Ladelauf: Seitengroesse/Takt/Seiten/Retries/Dauer
            submitVia: null,         // welcher Submit-Weg zuletzt gegriffen hat (app/http/services)
            lastEligible: null,      // isSBCSquadEligible()-Ergebnis bei 403
            refreshLog: null,        // Protokoll des View-Refresh nach dem Abgeben
            uiScan: null,            // Panel/FAB/inSbcView-Snapshot zum Diagnose-Klick
            batchSteps: null,        // letzte Batch-Runden: ok/steps beim Oeffnen der naechsten Instanz
            batchFailedSteps: null,  // wie batchSteps, aber NUR ok:false-Runden, Cap 30 statt 6er-Ring (ueberlebt laengere Batches, siehe recordBatchStep)
            batchStuckCount: 0,      // wie oft der stuck-Diagnosezweig in openNextInstance auslöste (v4.36.0-Vorfall über mehrere Läufe hinweg messbar statt anekdotisch)
            lastTeam: null,          // zuletzt vom Solver geliefertes Team (ok/reason/cards/usedAssetsCount)
            submitCandidates: null,  // Controller.Methode-Kandidaten fuers Abgeben
            submitChallengeVia: null, // welcher Controller-/Service-Weg beim Abgeben gegriffen hat
            submitWithoutResponseCount: 0, // wie oft submitChallengeToEa ohne auswertbare Response als Erfolg durchging (LEARNINGS §9, v4.36.0: offen, ob Abgabe wirklich bestätigt war)
            submitCounterChecks: null, // Abgabe gegen EAs timesCompleted geprueft (vorher/nachher/bestaetigt)
            quotaDisabled: null,     // Kontingent-Messung nach EA-Ablehnung abgeschaltet
            submitConfirmations: null, // Post-Submit-Plausibilisierung im "ohne Response"-Zweig: via/hadResponse/squadEmptyAfter/ms je Versuch (reine Beobachtung, kein Abbruchkriterium)
            lastTap: null,           // letzter simulierter Tap: Events/Position/Abdeckung/Popup
            scanStats: null,         // Traversal-Metriken (visitedCount/depthCapped/budgetExhausted) von deepScan/findNode/collectNodes - reine Beobachtung, kein Abbruchkriterium (LEARNINGS 37)
            utasUnclassified: 0,     // /ut/game/-URLs, die classifyUrl() nicht zuordnen konnte (LEARNINGS 38)
            lastUnclassifiedPaths: [], // 5er-Ring der zugehoerigen Pfade (IDs maskiert)
            popupDismissCount: 0,    // wie oft dismissRewardPopup() seit App-Start wirklich etwas geschlossen hat (analog batchStuckCount, LEARNINGS §27)
            lastAward: null,         // EAs Antwort auf die letzte Abgabe (grantedChallengeAwards)
            queueScan: null,         // SBC-Reihe: die Challenges des offenen Sets (loadQueueList)
            packScan: null           // Pack-Opener (Ticket #69/#76): myPacks/lastRun/lastAllRun/runsCount/storageCounts/missingGlobals/errorForm, siehe mergePackScan() (LEARNINGS §46)
        }
    };
    function log(...args) { try { console.log(LOG_PREFIX, ...args); } catch (e) {} }
    function warn(...args) { try { console.warn(LOG_PREFIX, ...args); } catch (e) {} }
    // ======================================================================
    //  DROSSEL-ERKENNUNG
    // ======================================================================
    // Live (Report v4.77.0): "Failed to fetch" (9x), 503, 512 - und danach
    // PUT -> 475. Der 475 ist also die FOLGE davon, dass EA den Client abweist,
    // kein Zustandsproblem der Challenge. Ohne diese Unterscheidung erklaeren
    // wir seit Tagen das falsche Symptom.
    const THROTTLE_RE = /\b(426|429|503|512|521)\b|Failed to fetch|NetworkError|load failed/i;
    // Gedrosselt heisst: MEHRERE Fehler in kurzer Zeit. Gefuehrt wird deshalb
    // ein Ring der Fehler-ZEITPUNKTE, kein Zaehler.
    //
    // Warum nicht mehr "Zaehler, den ein Erfolg loescht" (war v4.79.0): live
    // standen 9x "Failed to fetch" plus ein 512 im Report - und der Zaehler auf
    // 0. Zwischen den Fehlern liegen 49 erfolgreiche Club-Seiten, er wurde also
    // dauernd zurueckgesetzt und stand nie auf 2. v4.78.0 war zu scharf
    // (ein Schluckauf brach den Batch ab), v4.79.0 war zu lasch (nie).
    // Erfolge loeschen die Vergangenheit jetzt nicht mehr - sie tragen nur
    // nichts bei.
    const THROTTLE_WINDOW_MS = 60000;
    const THROTTLE_MIN_HITS = 3;
    // Requests, die NUR der Diagnose/Bestaetigung dienen. Werden sie
    // abgewiesen, sagt das nichts darueber, ob eine Abgabe ankommt - und darf
    // deshalb keinen Batch stoppen. Live (Report v4.87.0) liefen die Abgaben
    // (Zaehler 844->845->846), waehrend genau diese Pfade 426/429/512 bekamen
    // und der Abbruch dann bei 3 von 5 zuschlug.
    const THROTTLE_OPTIONAL_RE = /\/challenges(\?|$)|sbs\/sets/i;
    function noteThrottle(msg) {
        if (!THROTTLE_RE.test(String(msg || ''))) return false;
        const t = STATE.diag.throttle ||
                  (STATE.diag.throttle = { count: 0, hits: [], last: null, lastAt: 0 });
        if (!Array.isArray(t.hits)) t.hits = [];
        const now = Date.now();
        const optional = THROTTLE_OPTIONAL_RE.test(String(msg || ''));
        if (!Array.isArray(t.hard)) t.hard = [];
        if (!optional) t.hard.push(now);
        t.hits.push(now);
        // Nur das Fenster behalten - und hart deckeln, damit der Report nicht
        // von Zeitstempeln ertrinkt.
        t.hits = t.hits.filter(x => now - x < THROTTLE_WINDOW_MS).slice(-40);
        t.hard = t.hard.filter(x => now - x < THROTTLE_WINDOW_MS).slice(-40);
        t.count = t.hits.length;
        t.hardCount = t.hard.length;
        t.total = (t.total || 0) + 1;
        t.last = String(msg).slice(0, 120);
        t.lastAt = now;
        return true;
    }
    /**
     * Eine erfolgreiche Anfrage wird nur GEZAEHLT. Sie darf die Fehler-Historie
     * NICHT loeschen: sonst genuegt ein erfolgreicher Request zwischen zwei
     * Fehlern, um die Erkennung auszuschalten - genau das ist live passiert.
     */
    function noteRequestOk() {
        const t = STATE.diag.throttle;
        if (!t) return;
        t.recovered = (t.recovered || 0) + 1;
    }
    /** Wie viele Fehler liegen im Fenster? (alle, auch die optionalen) */
    function throttleHits(nowMs) {
        const t = STATE.diag.throttle;
        if (!t || !Array.isArray(t.hits)) return 0;
        const now = nowMs != null ? nowMs : Date.now();
        return t.hits.filter(x => now - x < THROTTLE_WINDOW_MS).length;
    }
    /**
     * Nur die Fehler an Requests, die wir WIRKLICH brauchen. Der Batch bricht
     * hieran ab - nicht an abgewiesenen Bestaetigungen (das waere unsere eigene
     * Last als Sperre missdeutet).
     */
    function throttleHardHits(nowMs) {
        const t = STATE.diag.throttle;
        if (!t || !Array.isArray(t.hard)) return 0;
        const now = nowMs != null ? nowMs : Date.now();
        return t.hard.filter(x => now - x < THROTTLE_WINDOW_MS).length;
    }
    /**
     * Wird gerade gedrosselt? Drei Fehler im Fenster - ein einzelner Aussetzer
     * (live: EIN 503 beim Club-Laden, danach 49 Seiten fehlerfrei) faengt sich
     * ueber die Retries selbst und darf keinen Batch abwuergen.
     */
    function throttledNow() {
        return throttleHardHits() >= THROTTLE_MIN_HITS;
    }
    function throttleNote() {
        const n = throttleHits();
        if (!n) return '';
        const t = STATE.diag.throttle;
        return ' EA weist gerade Anfragen ab (' + n + 'x in ' +
               Math.round(THROTTLE_WINDOW_MS / 1000) + 's, zuletzt: ' +
               (t && t.last) + ') - das ist der wahrscheinliche Grund. Kurz warten und ' +
               'erneut versuchen; ein Neustart der App hilft oft auch.';
    }
    function diagError(msg) {
        // KEIN noteThrottle() hier (war v4.78.0 und falsch): diagError bekommt
        // auch unsere EIGENEN zusammengesetzten Meldungen, und die zitieren den
        // Fehlertext. Der Zaehler hat sich dadurch selbst hochgezaehlt - im
        // Report stand die eigene Abbruchmeldung als "Beweis" fuer Drosselung.
        // Gezaehlt wird jetzt an der Request-Schicht (apiGet/apiPut).
        try {
            const arr = STATE.diag.lastErrors;
            arr.push(String(msg).slice(0, 300));
            if (arr.length > 24) arr.shift();
        } catch (e) {}
    }
    // warn() + diagError() in einem Aufruf - fuer reportwuerdige eigene Fehler.
    // NICHT fuer die bewusst stillen Catches an der EA-Grenze (Fremd-Objekte,
    // deren Fehlschlag folgenlos bleibt - siehe
    // patterns/good/stille-catches-nur-an-der-ea-grenze.md).
    function reportError(label, e) {
        warn(label + ':', e);
        diagError(label + ': ' + ((e && e.message) || String(e)));
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
    // [URLCLS-BEGIN]
    // EA nutzt wahlweise "sbs" oder "sbc" als API-Pfad-Segment (LEARNINGS,
    // Abschnitt "API-Zugriff") - alle sieben URL-Klassifikationen unten leiten
    // ihre Regex aus DIESER EINEN Quelle ab statt das Wissen erneut zu
    // literalisieren. Einmalig kompiliert: kein new RegExp() im heissen
    // fetch/XHR-Interception-Pfad.
    const SBS_SBC_PREFIX_RE_SRC = 'sbs|sbc';
    const RE_SBS_SBC_PREFIX_PATH = new RegExp('\\/ut\\/game\\/[^/]+\\/(' + SBS_SBC_PREFIX_RE_SRC + ')\\/', 'i');
    const RE_SBC_SET_CHALLENGES = new RegExp('\\/(' + SBS_SBC_PREFIX_RE_SRC + ')\\/setId\\/\\d+\\/challenges', 'i');
    const RE_SBC_CHALLENGE_BY_SET = new RegExp('\\/(' + SBS_SBC_PREFIX_RE_SRC + ')\\/setId\\/\\d+\\/challengeId\\/\\d+', 'i');
    const RE_SBC_CHALLENGE_BY_ID = new RegExp('\\/(' + SBS_SBC_PREFIX_RE_SRC + ')\\/challenge\\/\\d+', 'i');
    const RE_SBC_SETS = new RegExp('\\/(' + SBS_SBC_PREFIX_RE_SRC + ')\\/sets', 'i');
    const RE_SBC_STORAGE_FALLBACK = new RegExp('\\/(' + SBS_SBC_PREFIX_RE_SRC + ')\\/[^?]*storage', 'i');
    const RE_SBC_SQUAD_PUT = new RegExp('\\/(' + SBS_SBC_PREFIX_RE_SRC + ')\\/challenge\\/\\d+\\/squad', 'i');
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
                const pm = u.match(RE_SBS_SBC_PREFIX_PATH);
                if (pm) STATE.sbc.apiPrefix = pm[1].toLowerCase();
            }
        } catch (e) {}
    }
    // Interessante Endpunkte. WICHTIG: Die Web App nutzt "sbs/..." für SBCs.
    function classifyUrl(url) {
        const u = String(url);
        // Liste aller Challenges eines Sets - HIER stehen die Anforderungen
        // (Ziel-OVR, Rarity) pro Challenge. Live verifiziert (fc26).
        if (RE_SBC_SET_CHALLENGES.test(u)) return 'sbc-set-challenges';
        if (RE_SBC_CHALLENGE_BY_SET.test(u) ||
            RE_SBC_CHALLENGE_BY_ID.test(u)) return 'sbc-challenge';
        if (RE_SBC_SETS.test(u)) return 'sbc-sets';
        if (/\/club(\?|$)/i.test(u)) return 'club';
        if (/\/purchased\/items/i.test(u)) return 'unassigned';
        // SBC-Storage - Endpunkt heisst "storagepile". Live verifiziert (fc26).
        if (/\/storagepile(\?|$|\/)/i.test(u)) return 'storage';
        if (RE_SBC_STORAGE_FALLBACK.test(u)) return 'storage';
        return null;
    }
    // Eigener Zaehler + 5er-Ring fuer /ut/game/-URLs, die classifyUrl() NICHT
    // zuordnen kann - der generische lastUtasPaths-Ring (15 Slots, ALLER
    // utas-Traffic) kann einen seltenen neuen Endpunkt durch haeufigen
    // bekannten Traffic (Club-Pagination, Storage) verdraengen, bevor je ein
    // Diagnose-Report gezogen wird. Bewusst KEIN warn/diagError: das ist keine
    // Fehlermeldung, sondern eine reine Beobachtung unbekannten, aber
    // regulaeren Traffics.
    function noteUnclassifiedUtas(url) {
        try {
            const u = String(url);
            if (/\/ut\/game\//i.test(u) && classifyUrl(u) === null) {
                STATE.diag.utasUnclassified = (STATE.diag.utasUnclassified || 0) + 1;
                const path = u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
                    .replace(/\d{4,}/g, '{id}');
                STATE.diag.lastUnclassifiedPaths.push(path);
                if (STATE.diag.lastUnclassifiedPaths.length > 5) STATE.diag.lastUnclassifiedPaths.shift();
            }
        } catch (e) {}
    }
    // Pro-Set-Challenge-Cache mit ECHTER Einfuege-Reihenfolge (Kappung 5).
    // Object.keys() liefert integer-artige Keys NUMERISCH aufsteigend, nicht
    // in Einfuege-Reihenfolge - die alte "sids[0]"-Verdraengung traf damit
    // das KLEINSTE setId statt des aeltesten und konnte das gerade frisch
    // gecachte Set sofort wieder loeschen (Nacht-Review 16.08.).
    function cacheSetChallenges(sid, json) {
        const cache = STATE.setChallengesBySet;
        if (!cache) return;
        const order = STATE.setChallengesOrder = STATE.setChallengesOrder || [];
        const key = String(sid);
        if (!(key in cache) && order.indexOf(key) === -1) order.push(key);
        cache[key] = json;
        while (order.length > 5) delete cache[order.shift()];
    }
    /**
     * EAs Antwort auf eine Abgabe festhalten. `grantedChallengeAwards` steht
     * NUR in dieser Antwort - sie ist der Beweis, dass EA die Challenge
     * angenommen hat, und zwar pro Challenge statt pro Set.
     */
    function noteChallengeAward(json, url) {
        try {
            let cid = json.challengeId;
            if (cid == null && url) {
                const m = String(url).match(/challenge\/(\d+)/i);
                if (m) cid = parseInt(m[1], 10);
            }
            STATE.lastAward = {
                challengeId: (cid != null) ? cid : null,
                setId: (json.setId != null) ? json.setId : null,
                at: Date.now(),
                awards: (json.grantedChallengeAwards || []).length
            };
            STATE.diag.lastAward = STATE.lastAward;
        } catch (e) { reportError('noteChallengeAward', e); }
    }
    /**
     * Bestaetigt EAs Antwort die Abgabe DIESER Challenge? Rein, damit die
     * Bedingung testbar ist - sie entscheidet, ob ein Reihen-Lauf weiterlaeuft
     * oder abbricht.
     * Verlangt drei Dinge: eine Belohnung (leere Liste zaehlt nicht), dieselbe
     * challengeId (eine Antwort von vorher darf nicht die naechste Runde
     * bestaetigen) und einen Zeitpunkt NACH dem Abgeben.
     */
    function awardConfirms(award, challengeId, sinceMs) {
        if (!award || !(award.awards > 0)) return false;
        if (challengeId != null && award.challengeId != null &&
            String(award.challengeId) !== String(challengeId)) return false;
        if (sinceMs != null && !(award.at >= sinceMs)) return false;
        return true;
    }
    function handleResponseBody(url, bodyText) {
        const kind = classifyUrl(url);
        if (!kind || !bodyText) return;
        let json;
        try { json = (typeof bodyText === 'string') ? JSON.parse(bodyText) : bodyText; }
        catch (e) { reportError('handleResponseBody(' + kind + '): parse', e); return; }
        try {
            if (kind === 'sbc-set-challenges') {
                // Challenge-Liste eines Sets: enthält die Anforderungen pro
                // Challenge. Cachen und (falls Challenge schon bekannt) anwenden.
                STATE.lastSetChallenges = json;
                STATE.lastChallengeRaw = json;
                const sm = String(url).match(/setId\/(\d+)/i);
                if (sm) {
                    const sid = parseInt(sm[1], 10);
                    STATE.sbc.setId = sid;
                    // Pro-Set-Cache (Kappung 5, Einfuege-Reihenfolge):
                    // lastSetChallenges allein wurde live vom zuletzt
                    // geoeffneten Set ueberschrieben.
                    cacheSetChallenges(sid, json);
                }
                applyFromSetChallenges();
            } else if (kind === 'sbc-challenge' || kind === 'sbc-sets') {
                STATE.lastChallengeRaw = json;
                // ANTWORT AUF EINE ABGABE. EA schickt darin die zugeteilte
                // Belohnung - der direkteste Beweis, dass die Abgabe
                // angekommen ist. Live (Report v4.99.0) war das der einzige
                // Beleg: der Set-Zaehler stand auf 0, weil das Set nicht
                // wiederholbar ist, und der Batch hielt eine erfolgreiche
                // Abgabe fuer gescheitert.
                if (json && Array.isArray(json.grantedChallengeAwards)) {
                    noteChallengeAward(json, url);
                }
                parseSbcChallenge(json, url);
            } else if (kind === 'club' || kind === 'unassigned') {
                // Passiv mitlesen: was die App ohnehin lädt, wandert in den Pool.
                harvestItems(json, false);
            } else if (kind === 'storage') {
                harvestItems(json, true);
            }
        } catch (e) {
            reportError('handleResponseBody(' + kind + ')', e);
        }
    }
    // [URLCLS-END]
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
                    if (url) noteUnclassifiedUtas(url);
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
                    RE_SBC_SQUAD_PUT.test(String(url))) {
                    try { STATE.diag.lastSquadPutBody = String(body).slice(0, 3000); } catch (e) {}
                }
                if (url) noteUnclassifiedUtas(url);
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
    // [SBCSCAN-BEGIN]
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
    function reqCountRaw(o, parents) {
        // EA hängt den Count ("Min. 4") oft an das ELTERN-Objekt der
        // Requirement-KV-Paare (UTSBCEligibilityRequirement.count), nicht an
        // das Wert-Objekt selbst - deshalb die Eltern-Kette mitprüfen.
        const chain = [o].concat(parents || []);
        const keys = ['count', 'requirementCount', 'keyCount', 'amount', 'minimum', '_count'];
        for (const node of chain) {
            if (!node || typeof node !== 'object') continue;
            for (const k of keys) {
                const c = parseInt(node[k], 10);
                if (!isNaN(c) && c >= 1 && c <= 11) return { count: c, defaulted: false };
            }
        }
        return { count: 1, defaulted: true };
    }
    function reqCount(o, parents) { return reqCountRaw(o, parents).count; }
    function reqCountDefaulted(o, parents) { return reqCountRaw(o, parents).defaulted; }
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
    // budget: Traversal-Deckel (Default 20000). JSON-Baeume (Netzwerk/Set-Liste)
    // duerfen mehr (60000): live belegt (Gold-Challenge, Set 1337) enthielt der
    // Challenge-Knoten so viel Belohnungs-Metadaten (Kit-Namen, Player-Picks),
    // dass 20000 Knoten erschoepft waren, BEVOR die Gold-Anforderung erreicht
    // wurde - Ergebnis: keinerlei Vorgaben erkannt, Solver baute regellos.
    // Der Live-Entity-Scan bleibt bei 20000 (Objektgraph der App, unbegrenzt).
    function deepScanChallenge(root, budget) {
        const out = { target: null, rarity: [], squadId: null, slots: null, playerLevel: [], quality: [], rare: [], reqs: [], scopesSeen: [] };
        if (!root || typeof root !== 'object') return out;
        const BUDGET = (budget > 0) ? budget : 20000;
        const seen = new Set();
        const queue = [{ o: root, d: 0, par: [] }];
        let visited = 0;
        // JEDER erkannte Scope-String landet hier, unabhaengig von der
        // reqDump-Whitelist unten (:490-497) - macht eine komplett neue
        // EA-Scope-Familie sichtbar, statt spurlos zu verschwinden (siehe
        // docs/roadmap/gaps/sbc-vorgaben-erkennung.md, Mangel 1). Deckel bei
        // 40 Eintraegen, analog zum bestehenden out.reqs.length < 25-Deckel.
        const scopesSeenSet = new Set();
        // Wird true, sobald die Tiefengrenze (d > 7) selbst einen Knoten
        // aussortiert - anders als seen.has(o)/isDomOrWindow(o), die
        // strukturell unverdaechtige Knoten ueberspringen, zeigt das
        // tatsaechliches Abschneiden des Traversals an (siehe
        // docs/roadmap/gaps/sbc-vorgaben-erkennung.md, Mangel 2).
        let depthSkipped = false;
        while (queue.length && visited < BUDGET) {
            const cur = queue.shift();
            const o = cur.o, d = cur.d, par = cur.par;
            if (!o || typeof o !== 'object' || seen.has(o) || isDomOrWindow(o)) continue;
            if (d > 7) { depthSkipped = true; continue; }
            seen.add(o);
            visited++;
            // squadId nur aus explizit benannten Feldern
            if (out.squadId == null && o.squadId != null && (typeof o.squadId === 'number' || typeof o.squadId === 'string')) {
                out.squadId = o.squadId;
            }
            const scope = scopeString(o);
            if (scope) {
                if (scopesSeenSet.size < 40) scopesSeenSet.add(scope);
                const v = reqValue(o);
                // matchedAs zeigt, welcher der unten folgenden, sich
                // gegenseitig ausschliessenden Zweige tatsaechlich griff -
                // 'unclassified' deckt exakt die Luecke aus dem
                // PLAYER_LEVEL-Dual-Use-Bug ab (LEARNINGS 6/11): ein Scope wie
                // PLAYER_LEVEL erfuellt sowohl isPlayerLevel als auch
                // isQualityScope strukturell, aber nur EIN Wertebereich
                // (40-99 bzw. 1-3) loest den jeweiligen Zweig unten aus; ein
                // Wert dazwischen (4-39) faellt durch beide und bleibt sichtbar
                // 'unclassified' statt lautlos zu verschwinden.
                let matchedAs = 'unclassified';
                const isTeamRating =
                    scope.indexOf('TEAM_RATING') > -1 || scope.indexOf('SQUAD_RATING') > -1 ||
                    ((scope.indexOf('RATING') > -1 || scope.indexOf('OVR') > -1) &&
                     scope.indexOf('PLAYER') === -1 && scope.indexOf('CHEM') === -1);
                if (isTeamRating) {
                    if (v != null && v >= 40 && v <= 99) {
                        // höchste gefundene Team-Rating-Anforderung gewinnt
                        if (out.target == null || v > out.target) out.target = v;
                        matchedAs = 'TEAM_RATING';
                    }
                }
                // Spieler-Level-Vorgabe: "min. N Spieler mit Rating X+"
                const isPlayerLevel = scope.indexOf('PLAYER') > -1 &&
                    (scope.indexOf('RATING') > -1 || scope.indexOf('OVR') > -1 ||
                     scope.indexOf('LEVEL') > -1) &&
                    scope.indexOf('CHEM') === -1;
                if (isPlayerLevel && v != null && v >= 40 && v <= 99) {
                    out.playerLevel.push({ label: scope, minRating: v, count: reqCount(o, par), countDefaulted: reqCountDefaulted(o, par) });
                    matchedAs = 'PLAYER_LEVEL';
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
                    out.quality.push({ label: scope, quality: Number(v), count: reqCount(o, par), countDefaulted: reqCountDefaulted(o, par) });
                    matchedAs = 'PLAYER_QUALITY';
                }
                // KEIN Substring-Match auf "RARE" hier! Das hat live
                // SPIELERNAMEN getroffen ("Carrarese Calcio", "Brian Ferrares",
                // "Rareș Ilie") und Phantom-Vorgaben erzeugt. Die echte
                // Rare-Anforderung kommt als PLAYER_RARITY_GROUP mit Wert 4
                // (Gruppe 4 = Rare) und wird unten regulaer erfasst.
                if (scope.indexOf('RARITY') > -1) {
                    out.rarity.push({
                        label: scope,
                        ids: reqIds(o),
                        count: reqCount(o, par),
                        countDefaulted: reqCountDefaulted(o, par),
                        // Bei RARITY_GROUP ist der Wert die Gruppen-ID -
                        // Karten matchen über ihr "groups"-Feld.
                        groupId: (scope.indexOf('GROUP') > -1 && v != null) ? v : null
                    });
                    matchedAs = 'RARITY';
                }
                // Roh-Dump für Transparenz/Diagnose (max 25 Einträge)
                if (out.reqs.length < 25 &&
                    (scope.indexOf('RATING') > -1 || scope.indexOf('RARITY') > -1 ||
                     scope.indexOf('PLAYER') > -1 || scope.indexOf('OVR') > -1 ||
                     scope.indexOf('LEVEL') > -1 || scope.indexOf('QUALITY') > -1 ||
                     scope.indexOf('CLUB') > -1 || scope.indexOf('LEAGUE') > -1 ||
                     scope.indexOf('NATION') > -1 || scope.indexOf('CHEM') > -1)) {
                    out.reqs.push({ scope: scope, value: v, ids: reqIds(o), count: reqCount(o, par), matchedAs: matchedAs, countDefaulted: reqCountDefaulted(o, par) });
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
                        // Anforderungs-Aeste ZUERST scannen (elgReq, requirements,
                        // eligibility, constraints ...): live belegt (Gold-
                        // Challenge, Set 1337) frass ein riesiger Belohnungs-Ast
                        // (Kits/Player-Picks) das komplette Budget, bevor die
                        // Vorgaben dran waren. Die Priorisierung aendert bei
                        // ausreichendem Budget NICHTS am Ergebnis (Sammel-Logik
                        // ist reihenfolgeunabhaengig, target nimmt das Maximum) -
                        // sie entscheidet nur, was bei knappem Budget zuerst kommt.
                        if (/req|elig|constraint/i.test(k)) {
                            queue.unshift({ o: child, d: d + 1, par: childPar });
                        } else {
                            queue.push({ o: child, d: d + 1, par: childPar });
                        }
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
        out.rare = dedupe(out.rare || [], r => r.label + '|' + r.count);
        out.quality = dedupe(out.quality, q => q.label + '|' + q.quality + '|' + q.count);
        out.reqs = dedupe(out.reqs, r => r.scope + '|' + r.value + '|' + r.count + '|' + r.ids.join(','));
        out.scopesSeen = Array.from(scopesSeenSet);
        // Reines Beobachtungsfeld (siehe docs/LEARNINGS.md 37) - KEIN
        // Abbruch-/Warnungskriterium. budgetExhausted/depthCapped bedeuten
        // NICHT zwingend, dass eine Vorgabe fehlt: die BFS kann sie laengst
        // gefunden haben, bevor Budget/Tiefe ausgeschoepft war.
        out.visitedCount = visited;
        out.depthCapped = depthSkipped;
        out.budgetExhausted = (visited >= BUDGET && queue.length > 0);
        return out;
    }
    // [SBCSCAN-END]
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
        STATE.sbc.otherScopes = [];
        STATE.sbc.rareConstraints = [];
        STATE.sbc.reqDump = [];
        STATE.sbc.scopesSeen = [];
        STATE.sbc.formationSlots = 11;
        STATE.sbc.squadSlotTotal = null;
        STATE.sbc.usableSlots = null;
        refreshSbcInfoUI();
    }
    // Im Challenge-Listen-JSON den Knoten der aktuell geöffneten Challenge finden.
    // statsOut (additiv, optional): schreibt statsOut.findNode = { visitedCount,
    // depthCapped, budgetExhausted } - reines Beobachtungsfeld, siehe
    // docs/LEARNINGS.md 37. Bestehende Aufrufe ohne dritten Parameter bleiben
    // unveraendert funktionsfaehig.
    function findChallengeNode(root, cid, statsOut) {
        if (!root || typeof root !== 'object' || cid == null) return null;
        const seen = new Set();
        const queue = [{ o: root, d: 0 }];
        let visited = 0;
        let depthCapped = false;
        function writeStats() {
            if (statsOut) {
                statsOut.findNode = { visitedCount: visited, depthCapped: depthCapped,
                    budgetExhausted: (visited >= 20000 && queue.length > 0) };
            }
        }
        while (queue.length && visited < 20000) {
            const cur = queue.shift();
            const o = cur.o, d = cur.d;
            if (!o || typeof o !== 'object' || seen.has(o) || isDomOrWindow(o)) continue;
            if (d > 6) { depthCapped = true; continue; }
            seen.add(o);
            visited++;
            const oid = (o.challengeId != null) ? o.challengeId : o.id;
            // Nur Knoten akzeptieren, die wie eine Challenge aussehen
            if (oid != null && String(oid) === String(cid) &&
                (o.elgReq || o.requirements || o.eligibilityRequirements || o.name || o.challengeId != null)) {
                writeStats();
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
        writeStats();
        return null;
    }
    /**
     * ALLE Challenge-Knoten einer Set-Antwort sammeln (nicht nur den mit einer
     * bestimmten ID). Wird gebraucht, um nach einem 404/475 die frische Instanz
     * derselben SBC zu finden: wiederholbare SBCs bekommen pro Durchlauf eine
     * neue challengeId, und die Ansicht steht danach auf der verbrauchten.
     * statsOut (additiv, optional): schreibt statsOut.collectNodes = { visitedCount,
     * depthCapped, budgetExhausted }, analog zu findChallengeNode().
     */
    function collectChallengeNodes(root, statsOut) {
        const out = [];
        if (!root || typeof root !== 'object') return out;
        const seen = new Set();
        const queue = [{ o: root, d: 0 }];
        let visited = 0;
        let depthCapped = false;
        while (queue.length && visited < 20000) {
            const cur = queue.shift();
            const o = cur.o, d = cur.d;
            if (!o || typeof o !== 'object' || seen.has(o) || isDomOrWindow(o)) continue;
            if (d > 6) { depthCapped = true; continue; }
            seen.add(o);
            visited++;
            if (o.challengeId != null &&
                (o.elgReq || o.requirements || o.eligibilityRequirements || o.name)) {
                out.push(o);
            }
            if (Array.isArray(o)) {
                for (const child of o) {
                    if (child && typeof child === 'object') queue.push({ o: child, d: d + 1 });
                }
            } else {
                for (const k of Object.keys(o)) {
                    let child;
                    try { child = o[k]; } catch (e) { continue; }
                    if (child && typeof child === 'object') queue.push({ o: child, d: d + 1 });
                }
            }
        }
        if (statsOut) {
            statsOut.collectNodes = { visitedCount: visited, depthCapped: depthCapped,
                budgetExhausted: (visited >= 20000 && queue.length > 0) };
        }
        return out;
    }
    /**
     * Liest die Erschoepfungs-/Ablauf-Felder, die EAs Set-Challenges-Knoten
     * laut Live-Sample tragen (status, repeatable, timesCompleted, endTime) -
     * fehlt eines, bleibt es null statt den ganzen Knoten zu verwerfen.
     */
    // ======================================================================
    //  SBC-KONTINGENT (Rasmus: 90 pro voller Stunde, 300 pro Tag)
    // ======================================================================
    // Warum das ueberhaupt geht: EA fuehrt pro SET einen SERVERSEITIGEN
    // Zaehler `timesCompleted` (im Hub steht er als "Completed 623 times").
    // Die Summe ueber alle Sets ist also die Gesamtzahl abgeschlossener SBCs
    // des ACCOUNTS - und damit geraeteuebergreifend: was Mike am Handy macht,
    // steht in derselben Zahl. Live belegt: zwischen zwei Reports stieg der
    // Zaehler von Set 1356 von 609 auf 615.
    //
    // Was NICHT geht: EA liefert keinen "heute"-Zaehler. Deshalb Stichproben:
    // (Zeitpunkt, Summe) landen in localStorage, und "seit X" ist die Differenz
    // zur aeltesten Probe innerhalb des Fensters. Fehlt eine Probe von VOR dem
    // Fenster, ist das Ergebnis eine UNTERGRENZE - und wird auch so benannt,
    // nicht als exakte Zahl verkauft.
    // ======================================================================
    //  POOL-CACHE (nur der Verein)
    // ======================================================================
    // Logs vom 24.08.: drei komplette Pool-Ladevorgaenge in einer Sitzung, je
    // 16-24s fuer 8459 Karten - weil die Seite dreimal neu geladen wurde
    // (Session weg -> Login -> neues Dokument). Der Verein kostet 50 Requests,
    // Unassigned und Storage zusammen zwei. Also wird nur der Verein
    // gespeichert; die beiden kleinen Listen kommen immer frisch.
    //
    // Gespeichert wird in IndexedDB, nicht in localStorage: jede Karte schleppt
    // ihr EA-Rohobjekt mit (fuer UTItemEntityFactory beim Eintragen
    // unverzichtbar, siehe LEARNINGS 5), und 8500 davon sprengen die
    // localStorage-Grenze. Abgelegt wird ein JSON-STRING - kein
    // structuredClone: die Rohobjekte aus dem Services-Fallback koennen
    // Funktionen tragen, und die wuerden das Klonen zum Scheitern bringen.
    const POOL_DB = 'sbcOptPoolCache';
    const POOL_STORE = 'pool';
    const POOL_CACHE_KEY = 'club';
    const POOL_CACHE_V = 1;
    const POOL_CACHE_TTL_MS = 10 * 60 * 1000;      // s. Sperre 1
    const POOL_CACHE_MAX_BYTES = 80 * 1024 * 1024; // Notbremse gegen Ausufern
    const POOL_CACHE_TOGGLE = 'sbcOptPoolCacheOn';
    function poolCacheEnabled() {
        try { return localStorage.getItem(POOL_CACHE_TOGGLE) !== '0'; }
        catch (e) { return true; }
    }
    function idbOpen() {
        return new Promise(function (res, rej) {
            if (!window.indexedDB) { rej(new Error('IndexedDB nicht verfügbar')); return; }
            const req = indexedDB.open(POOL_DB, 1);
            req.onupgradeneeded = function () {
                const db = req.result;
                if (!db.objectStoreNames.contains(POOL_STORE)) db.createObjectStore(POOL_STORE);
            };
            req.onsuccess = function () { res(req.result); };
            req.onerror = function () { rej(req.error || new Error('IndexedDB open')); };
        });
    }
    function idbRun(mode, fn) {
        return idbOpen().then(function (db) {
            return new Promise(function (res, rej) {
                const tx = db.transaction(POOL_STORE, mode);
                const st = tx.objectStore(POOL_STORE);
                let out = null;
                try { out = fn(st); } catch (e) { rej(e); return; }
                tx.oncomplete = function () {
                    try { db.close(); } catch (e) {}
                    res(out && out.result !== undefined ? out.result : null);
                };
                tx.onerror = function () {
                    try { db.close(); } catch (e) {}
                    rej(tx.error || new Error('IndexedDB tx'));
                };
                tx.onabort = function () {
                    try { db.close(); } catch (e) {}
                    rej(tx.error || new Error('IndexedDB abort'));
                };
            });
        });
    }
    /**
     * Was beim Vereins-Laden mitgeschrieben wird, damit der Cache spaeter
     * pruefbar ist: EAs Gesamtzahl, die Ids der ERSTEN Seite (nach Wert
     * sortiert - dort schlaegt jede wertvolle Neuerwerbung auf) und die Karten.
     */
    let clubHarvest = null;
    function clubHarvestBegin() {
        clubHarvest = { total: null, firstIds: [], players: [], ok: false };
    }
    function clubHarvestPage(page, items, players, total) {
        if (!clubHarvest) return;
        if (total != null && total !== Infinity) clubHarvest.total = total;
        if (page === 0) {
            clubHarvest.firstIds = items.map(function (it) {
                return String((it && (it.id != null ? it.id : it.itemId)) || '');
            }).filter(Boolean);
        }
        for (const p of players) clubHarvest.players.push(p);
    }
    function clubHarvestDone(complete) {
        if (clubHarvest) clubHarvest.ok = !!complete;
    }
    /**
     * Karten, die WIR seit dem Cache-Stand verbraucht haben. Nur Vereins-Karten
     * zaehlen in EAs totalItemCount - deshalb wird gegen die Id-Liste des
     * Caches geprueft und nicht gegen das isStorage-Flag (Unassigned traegt
     * dasselbe Flag wie Verein).
     */
    let poolCacheState = null;   // { ids: Set, consumed: Set }
    function poolCacheNoteRemoved(players) {
        if (!poolCacheState) return;
        for (const p of players) {
            if (!p) continue;
            const k = String(p.id);
            if (poolCacheState.ids.has(k)) poolCacheState.consumed.add(k);
        }
        schedulePoolCacheSave();
    }
    // Schreiben ist gross (mehrere MB) - deshalb nicht bei jeder Aenderung
    // sofort, sondern gebuendelt. Es geht um das Ueberleben eines Neuladens,
    // nicht um Millisekunden.
    let poolCacheSaveTimer = null;
    function schedulePoolCacheSave() {
        if (poolCacheSaveTimer) return;
        poolCacheSaveTimer = setTimeout(function () {
            poolCacheSaveTimer = null;
            savePoolCache();
        }, 8000);
    }
    async function savePoolCache() {
        if (!poolCacheEnabled() || !poolCacheState) return;
        const st = poolCacheState;
        try {
            const payload = {
                v: POOL_CACHE_V,
                t: st.t,
                script: VERSION,
                user: st.user,
                total: st.total,
                firstIds: st.firstIds,
                consumed: Array.from(st.consumed),
                players: st.players
            };
            const json = JSON.stringify(payload);
            if (json.length > POOL_CACHE_MAX_BYTES) {
                STATE.diag.poolCache = { wrote: false, reason: 'zu gross: ' + json.length };
                return;
            }
            const t0 = Date.now();
            await idbRun('readwrite', function (store) { store.put(json, POOL_CACHE_KEY); });
            STATE.diag.poolCache = {
                wrote: true, chars: json.length, players: st.players.length,
                consumed: st.consumed.size, ms: Date.now() - t0
            };
            log('Pool-Cache geschrieben: ' + st.players.length + ' Vereins-Karten, ' +
                Math.round(json.length / 1024) + ' KB, ' + (Date.now() - t0) + 'ms.');
        } catch (e) {
            STATE.diag.poolCache = { wrote: false, reason: String(e && e.message || e) };
            warn('Pool-Cache konnte nicht geschrieben werden:', e && e.message);
        }
    }
    /** Den Cache nach dem Vereins-Laden anlegen. */
    function adoptClubHarvest() {
        if (!poolCacheEnabled() || !clubHarvest || !clubHarvest.ok) return;
        if (clubHarvest.total == null || !clubHarvest.players.length) return;
        const ids = new Set(clubHarvest.players.map(function (p) { return String(p.id); }));
        poolCacheState = {
            t: Date.now(),
            user: STATE.session.nucleusId || null,
            total: clubHarvest.total,
            firstIds: clubHarvest.firstIds,
            players: clubHarvest.players,
            ids: ids,
            consumed: new Set()
        };
        savePoolCache();
    }
    /** Cache verwerfen - nach einer von EA abgelehnten Karte oder auf Wunsch. */
    async function dropPoolCache(why) {
        poolCacheState = null;
        try { await idbRun('readwrite', function (store) { store.delete(POOL_CACHE_KEY); }); }
        catch (e) {}
        STATE.diag.poolCache = { wrote: false, reason: 'verworfen: ' + (why || '') };
        log('Pool-Cache verworfen' + (why ? ' (' + why + ')' : '') + '.');
    }
    /**
     * Versuchen, den Verein aus dem Cache zu nehmen. Liefert einen Bericht
     * (immer, auch bei Ablehnung - er landet in der Diagnose, damit nie
     * geraten werden muss, WARUM voll geladen wurde).
     */
    async function tryPoolCache() {
        const rep = { used: false, reason: null, age: null, players: 0 };
        if (!poolCacheEnabled()) { rep.reason = 'abgeschaltet'; return rep; }
        if (!sessionReady()) { rep.reason = 'keine Session'; return rep; }
        let payload = null;
        try {
            const json = await idbRun('readonly', function (store) {
                return store.get(POOL_CACHE_KEY);
            });
            if (!json) { rep.reason = 'kein Cache'; return rep; }
            payload = JSON.parse(json);
        } catch (e) {
            rep.reason = 'nicht lesbar: ' + String(e && e.message || e);
            return rep;
        }
        // --- Sperre 1 + 2: Format, Version, Konto, Alter -------------------
        if (!payload || payload.v !== POOL_CACHE_V) { rep.reason = 'anderes Format'; return rep; }
        if (payload.script !== VERSION) { rep.reason = 'andere Script-Version'; return rep; }
        rep.age = Date.now() - (payload.t || 0);
        if (rep.age > POOL_CACHE_TTL_MS) {
            rep.reason = 'zu alt (' + Math.round(rep.age / 1000) + 's)';
            return rep;
        }
        const user = STATE.session.nucleusId || null;
        if (payload.user && user && String(payload.user) !== String(user)) {
            rep.reason = 'anderes Konto';
            return rep;
        }
        if (!Array.isArray(payload.players) || !payload.players.length) {
            rep.reason = 'leer'; return rep;
        }
        // --- Sperre 3: EIN Request muss den Stand bestaetigen --------------
        let json0 = null;
        try {
            json0 = await apiGet('club?sort=desc&sortBy=value&type=player&count=175&start=0');
        } catch (e) {
            rep.reason = 'Prüf-Request fehlgeschlagen: ' + String(e && e.message || e);
            return rep;
        }
        const consumed = new Set((payload.consumed || []).map(String));
        const expect = payload.total - consumed.size;
        if (json0.totalItemCount != null && Number(json0.totalItemCount) !== expect) {
            rep.reason = 'Verein hat sich geändert (EA: ' + json0.totalItemCount +
                         ', erwartet: ' + expect + ')';
            return rep;
        }
        const known = new Set(payload.players.map(function (p) { return String(p.id); }));
        for (const it of extractItems(json0)) {
            const k = String((it && (it.id != null ? it.id : it.itemId)) || '');
            if (!k) continue;
            if (!known.has(k) || consumed.has(k)) {
                rep.reason = 'neue/unbekannte Karte auf Seite 1 (' + k + ')';
                return rep;
            }
        }
        // --- angenommen -----------------------------------------------------
        const usable = payload.players.filter(function (p) {
            return p && !consumed.has(String(p.id));
        });
        mergeIntoPool(usable);
        poolCacheState = {
            t: payload.t,
            user: payload.user,
            total: payload.total,
            firstIds: payload.firstIds || [],
            players: payload.players,
            ids: known,
            consumed: consumed
        };
        rep.used = true;
        rep.players = usable.length;
        log('Verein aus dem Cache: ' + usable.length + ' Karten (' +
            Math.round(rep.age / 1000) + 's alt, 1 Prüf-Request statt ~50).');
        return rep;
    }
    // ======================================================================
    //  SCRIPT-STARTS: wie oft entsteht der JS-Kontext neu?
    // ======================================================================
    // Befund Mike: "der Pool wird jedes Mal neu geladen, wenn ich eine SBC
    // starte". Der Auto-Load kann das nicht sein - er laeuft pro Kontext genau
    // einmal (STATE.autoLoadTried). Also ist das DOKUMENT neu, und damit ist
    // alles weg: Pool, Session-Interception, erkannte Vorgaben.
    // localStorage ueberlebt den Wechsel - hier landet deshalb jeder Start.
    const RUNS_KEY = 'sbcOptScriptRuns';
    /**
     * Wie ist dieses Dokument entstanden?
     *   'back_forward' - Verlaufs-Navigation (in der App: web.goBack())
     *   'reload'       - echtes Neuladen
     *   'navigate'     - neuer Aufruf (z.B. loadUrl nach einem App-Neustart)
     * Unterscheidet damit die App-Ursachen voneinander, statt sie zu raten.
     */
    function navigationKind() {
        try {
            const e = performance.getEntriesByType('navigation');
            if (e && e.length && e[0].type) return String(e[0].type);
        } catch (err) {}
        try {
            // Aeltere WebViews: nur der Zahlen-Code (0=navigate,1=reload,2=back_forward).
            const t = performance.navigation && performance.navigation.type;
            if (t === 1) return 'reload';
            if (t === 2) return 'back_forward';
            if (t === 0) return 'navigate';
        } catch (err) {}
        return null;
    }
    function loadScriptRuns() {
        try {
            const raw = localStorage.getItem(RUNS_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr.filter(x => x && x.t) : [];
        } catch (e) { return []; }
    }
    /** Einen Start festhalten. Rein beobachtend - aendert kein Verhalten. */
    function noteScriptRun() {
        try {
            const arr = loadScriptRuns();
            arr.push({ t: Date.now(), nav: navigationKind(), v: VERSION });
            // 12 reichen: es geht um "wie oft in den letzten Minuten", nicht
            // um eine Historie.
            const keep = arr.slice(-12);
            localStorage.setItem(RUNS_KEY, JSON.stringify(keep));
            if (keep.length > 1) {
                const prev = keep[keep.length - 2];
                log('Script-Start #' + keep.length + ' (' + (navigationKind() || '?') +
                    '), letzter Start vor ' +
                    Math.round((Date.now() - prev.t) / 1000) + 's.');
            }
            return keep;
        } catch (e) { return []; }
    }
    const QUOTA_KEY = 'sbcOptQuotaEvents';
    const QUOTA_LEGACY_KEY = 'sbcOptQuotaSamples';
    const QUOTA_SETS_KEY = 'sbcOptQuotaSets';
    const QUOTA_HOUR_LIMIT = 90;
    const QUOTA_DAY_LIMIT = 300;
    /**
     * Der Zaehler fuehrt EREIGNISSE, nicht Summen: { t, inc, src, prevT }.
     * Warum nicht Summen (war bis v4.79.0 so und zaehlte falsch): SBC-Sets
     * rotieren. Die Differenz zweier Gesamtsummen aus verschiedenen Stunden
     * mischt "abgeschlossen" mit "Set ist aus der Liste verschwunden" - eine
     * 5x gemachte SBC, die danach wegfaellt, senkt die Summe sogar.
     * src: 'local'  = eigene, von EAs Zaehler bestaetigte Abgabe (exakt)
     *      'server' = Zuwachs anderer Geraete, aus einem Set-Vergleich
     */
    function quotaLoadSamples() {
        try {
            const raw = localStorage.getItem(QUOTA_KEY);
            if (raw) {
                const arr = JSON.parse(raw);
                return Array.isArray(arr)
                    ? arr.filter(x => x && x.t && typeof x.inc === 'number') : [];
            }
        } catch (e) { return []; }
        // Einmalige Uebernahme des alten Summen-Formats: aus aufeinander
        // folgenden Summen die (nicht-negativen) Zuwaechse bilden. Lieber
        // uebernehmen als wegwerfen - die Zahlen sind bis 36h alt.
        try {
            const raw = localStorage.getItem(QUOTA_LEGACY_KEY);
            if (!raw) return [];
            const old = JSON.parse(raw);
            if (!Array.isArray(old)) return [];
            const out = [];
            let prev = null;
            for (const x of old) {
                if (!x || !x.t || x.total == null) continue;
                if (prev != null) {
                    out.push({ t: x.t, inc: Math.max(0, x.total - prev), src: 'server', prevT: null });
                }
                prev = x.total;
            }
            return out.filter(x => x.inc > 0);
        } catch (e) { return []; }
    }
    function quotaSaveSamples(arr) {
        // 36h aufbewahren: deckt Tages- und Stundenfenster ab, bleibt klein.
        const cut = Date.now() - 36 * 3600 * 1000;
        const keep = arr.filter(x => x.t >= cut).slice(-500);
        try { localStorage.setItem(QUOTA_KEY, JSON.stringify(keep)); } catch (e) {}
        return keep;
    }
    /** Ein Ereignis ablegen. inc <= 0 wird ignoriert (kein Rauschen im Log). */
    function quotaAddEvent(inc, src, prevT) {
        const n = Number(inc);
        if (!isFinite(n) || n <= 0) return null;
        const arr = quotaLoadSamples();
        arr.push({ t: Date.now(), inc: n, src: src || 'local',
                   prevT: (prevT != null ? prevT : null) });
        quotaSaveSamples(arr);
        STATE.diag.quota = quotaUsage();
        return n;
    }
    /** Letzter Set-Stand vom Server: { t, sets: { setId: timesCompleted } }. */
    function quotaLoadSets() {
        try {
            const raw = localStorage.getItem(QUOTA_SETS_KEY);
            if (!raw) return null;
            const o = JSON.parse(raw);
            return (o && o.t && o.sets && typeof o.sets === 'object') ? o : null;
        } catch (e) { return null; }
    }
    function quotaSaveSets(sets) {
        try {
            localStorage.setItem(QUOTA_SETS_KEY,
                JSON.stringify({ t: Date.now(), sets: sets }));
        } catch (e) {}
    }
    /** timesCompleted PRO SET aus einer sbs/sets-Antwort. */
    function sumTimesCompleted(json) {
        let sum = 0, sets = 0;
        const bySet = {};
        const seen = new Set();
        const queue = [{ o: json, d: 0 }];
        let visited = 0;
        while (queue.length && visited < 20000) {
            const cur = queue.shift();
            const o = cur.o, d = cur.d;
            if (!o || typeof o !== 'object' || seen.has(o) || d > 6) continue;
            seen.add(o);
            visited++;
            // Ein Set-Knoten: hat setId UND timesCompleted. Challenge-Knoten
            // tragen dieselbe Zahl NICHT (sonst wuerde doppelt gezaehlt).
            if (o.setId != null && typeof o.timesCompleted === 'number') {
                // Pro setId nur EINMAL - dieselbe Set-Id kann in einer Antwort
                // mehrfach auftauchen (Hub + Kategorie), und ein Doppeleintrag
                // wuerde die Zahl verdoppeln.
                const k = String(o.setId);
                if (!Object.prototype.hasOwnProperty.call(bySet, k)) {
                    bySet[k] = o.timesCompleted;
                    sum += o.timesCompleted;
                    sets++;
                }
            }
            const kids = Array.isArray(o) ? o : Object.keys(o).map(k => {
                try { return o[k]; } catch (e) { return null; }
            });
            for (const c of kids) if (c && typeof c === 'object') queue.push({ o: c, d: d + 1 });
        }
        return { sum: sum, sets: sets, bySet: bySet };
    }
    /**
     * Zuwachs zwischen zwei Set-Staenden: PRO SET, und nur positive Deltas.
     * Sets, die im neuen Stand fehlen, zaehlen 0 (abgelaufen/aus der Liste) -
     * sonst schlaegt eine Rotation als "negativer Verbrauch" durch.
     * Neu aufgetauchte Sets zaehlen ebenfalls 0: ihr timesCompleted kann aus
     * beliebig alter Zeit stammen.
     */
    function quotaSetsDelta(prevSets, nowSets) {
        let inc = 0;
        for (const k in nowSets) {
            if (!Object.prototype.hasOwnProperty.call(nowSets, k)) continue;
            if (!Object.prototype.hasOwnProperty.call(prevSets, k)) continue;
            const d = Number(nowSets[k]) - Number(prevSets[k]);
            if (d > 0) inc += d;
        }
        return inc;
    }
    function sumOfSets(sets) {
        let sum = 0;
        for (const k in sets) {
            if (Object.prototype.hasOwnProperty.call(sets, k)) sum += Number(sets[k]) || 0;
        }
        return sum;
    }
    /**
     * Verbrauch im laufenden Stundenfenster (voller Stunde, wie EA es zaehlt)
     * und seit Mitternacht: Summe der Ereignisse im Fenster.
     * exact=false heisst Untergrenze - entweder weil ein Server-Delta ueber die
     * Fenstergrenze reicht, oder weil seit der letzten eigenen Abgabe keine
     * Server-Messung lief (dann sind fremde Geraete unbekannt).
     */
    function quotaUsage(nowMs) {
        const now = nowMs != null ? nowMs : Date.now();
        const arr = quotaLoadSamples();
        const snap = quotaLoadSets();
        if (!arr.length && !snap) {
            return { total: null, hour: null, day: null, samples: 0 };
        }
        const d = new Date(now);
        const hourStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
        const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const lastEventT = arr.length ? arr[arr.length - 1].t : 0;
        function since(boundary) {
            let used = 0;
            let exact = true;
            for (const e of arr) {
                if (e.t <= boundary) continue;
                used += e.inc;
                // Vergleichspunkt vor der Grenze (oder unbekannt): das Delta
                // kann Aktivitaet aus dem vorigen Fenster mitzaehlen.
                if (e.src === 'server' && (e.prevT == null || e.prevT < boundary)) exact = false;
            }
            // Fremdgeraete werden nur bei einer Server-Messung sichtbar. Ist
            // seit dem letzten Ereignis keine gelaufen, ist das eine Untergrenze.
            if (!snap || snap.t < lastEventT) exact = false;
            return { used: used, exact: exact, since: boundary };
        }
        return {
            total: snap ? sumOfSets(snap.sets) : null,
            stamp: snap ? snap.t : null,
            samples: arr.length,
            lastEvent: arr.length ? arr[arr.length - 1] : null,
            hour: since(hourStart),
            day: since(dayStart),
            hourLimit: QUOTA_HOUR_LIMIT,
            dayLimit: QUOTA_DAY_LIMIT
        };
    }
    // NOTBREMSE. Lehnt EA einen Kontingent-Request ab (429 = zu viele
    // Requests, dazu 426/512/521), wird fuer den Rest der Sitzung nicht mehr
    // gemessen. Live hat genau das 23 Fehlversuche in Folge produziert und
    // vermutlich die EA-UI mit lahmgelegt - eine Diagnose-Annehmlichkeit darf
    // den Betrieb nie gefaehrden (LEARNINGS 7).
    let quotaDisabled = false;
    function quotaNoteFailure(e) {
        const msg = String((e && e.message) || e || '');
        if (/\b(426|429|512|521)\b/.test(msg)) {
            quotaDisabled = true;
            STATE.diag.quotaDisabled = 'abgeschaltet nach: ' + msg.slice(0, 80);
            warn('Kontingent-Messung abgeschaltet (EA lehnt ab):', msg);
        }
        return null;
    }
    /**
     * Server-Messung ueber ALLE Sets. Schwerer Request - nur beim Laden und
     * EINMAL am Batch-Ende, NIE im Batch-Takt (LEARNINGS 7).
     * Der Zuwachs gegenueber dem letzten Stand wird um das bereinigt, was wir
     * selbst schon gezaehlt haben; uebrig bleiben die anderen Geraete.
     */
    async function quotaMeasure() {
        if (quotaDisabled) return null;
        let json = null;
        try { json = await apiGet('sbs/sets'); }
        catch (e) { return quotaNoteFailure(e); }
        const r = sumTimesCompleted(json);
        if (!r.sets) return null;
        const prev = quotaLoadSets();
        if (prev) {
            const raw = quotaSetsDelta(prev.sets, r.bySet);
            // Was wir seit dem letzten Stand selbst gezaehlt haben, steckt in
            // dieser Zahl schon drin - sonst wuerde jede eigene Abgabe doppelt
            // zaehlen (einmal lokal, einmal ueber den Server).
            let own = 0;
            for (const e of quotaLoadSamples()) {
                if (e.src === 'local' && e.t > prev.t) own += e.inc;
            }
            const other = Math.max(0, raw - own);
            if (other > 0) quotaAddEvent(other, 'server', prev.t);
        }
        quotaSaveSets(r.bySet);
        STATE.diag.quota = quotaUsage();
        return r.sum;
    }
    /**
     * timesCompleted NUR fuer ein Set - der leichte Weg, und genau die Zahl,
     * die eine Abgabe bestaetigt. Liefert null, wenn nicht lesbar; dann wird
     * NICHTS behauptet.
     */
    // EIGENE Notbremse fuer die Bestaetigung - NICHT die vom Kontingent.
    // Live (Report v4.79.0) hat ein einzelner HTTP 512 auf
    // sbs/setId/1356/challenges die Kontingent-Notbremse ausgeloest, und weil
    // setTimesCompleted() an DEMSELBEN Schalter hing, war damit auch die
    // Abgabe-Bestaetigung tot: sechs Runden mit confirmed:null, danach 475/404.
    // Die Notbremse schuetzt vor einem Request-Sturm auf das SCHWERE sbs/sets;
    // dieser Weg hier ist leicht (ein Set) und eine Korrektheits-Pruefung.
    let confirmDisabled = false;
    let confirmFailStreak = 0;
    // Warum war die letzte Messung null? 'request' = der Request selbst ist
    // gescheitert (429, Failed to fetch) - ein MESSPROBLEM. 'unreadable' = die
    // Antwort kam, enthielt aber keine brauchbare Zahl. Die Unterscheidung
    // entscheidet, ob der Batch abbricht: live (Report v4.85.0) hat ein
    // doppelter 429 einen Batch gestoppt, obwohl beide Abgaben durchgingen.
    let confirmLastFail = null;
    async function setTimesCompleted(setId) {
        if (confirmDisabled || setId == null) {
            confirmLastFail = confirmDisabled ? 'request' : null;
            return null;
        }
        try {
            const json = await apiGet('sbs/setId/' + setId + '/challenges');
            const r = sumTimesCompleted(json);
            confirmFailStreak = 0;
            confirmLastFail = 'unreadable';
            if (r.sets) { confirmLastFail = null; return r.sum; }
            // Faellt die Set-Ebene in dieser Antwort weg, hilft der
            // Challenge-Knoten: extractNodeState liest dieselbe Zahl.
            const nodes = collectChallengeNodes(json);
            for (const n of nodes) {
                if (n && typeof n.timesCompleted === 'number') {
                    confirmLastFail = null;
                    return n.timesCompleted;
                }
            }
            return null;
        } catch (e) {
            confirmLastFail = 'request';
            // Erst nach DREI Fehlschlaegen in Folge aufgeben - und dann
            // sichtbar, nicht still. Ein einzelner 512 darf die Pruefung nicht
            // fuer die Sitzung abschalten.
            confirmFailStreak++;
            if (confirmFailStreak >= 3) {
                confirmDisabled = true;
                STATE.diag.confirmDisabled = 'nach 3 Fehlschlägen, zuletzt: ' +
                    String((e && e.message) || e).slice(0, 80);
                warn('Abgabe-Bestätigung abgeschaltet:', e && e.message);
            }
            return null;
        }
    }
    /** Eine Zeile fuer das Panel - oder null, wenn es nichts zu sagen gibt. */
    /**
     * Zusatz fuer Fehlermeldungen: steht der Stundenzaehler nahe am Limit, ist
     * das EA-Kontingent die wahrscheinlichste Ursache fuer ein abgelehntes
     * Eintragen. Ohne Messung wird NICHTS behauptet.
     */
    function quotaHint() {
        const u = quotaUsage();
        if (!u || !u.hour) return '';
        const near = u.hour.used >= Math.floor(QUOTA_HOUR_LIMIT * 0.8) ||
                     (u.day && u.day.used >= Math.floor(QUOTA_DAY_LIMIT * 0.8));
        if (!near) return '';
        return ' Wahrscheinliche Ursache: EAs SBC-Kontingent - ' +
            (u.hour.exact ? '' : 'mind. ') + u.hour.used + ' von ' + QUOTA_HOUR_LIMIT +
            ' in dieser Stunde' +
            (u.day ? ', ' + (u.day.exact ? '' : 'mind. ') + u.day.used + ' von ' +
                     QUOTA_DAY_LIMIT + ' heute' : '') + '.';
    }
    function quotaText(u) {
        // NICHT an u.total haengen (war so bis v4.81.0 und war falsch): total
        // kommt aus dem Server-Stand. Scheitert die Server-Messung - etwa weil
        // die Notbremse nach einem 429 greift -, bleibt total null, WAEHREND
        // die eigenen bestaetigten Abgaben laengst gezaehlt sind. Das Panel
        // sagte dann "noch keine Messung", obwohl es 5 zaehlte: genau der
        // Befund, den der Zaehler-Umbau abstellen sollte.
        if (!u || (u.total == null && !u.hour && !u.day)) return null;
        function part(name, w, limit) {
            if (!w) return name + ': –';
            return name + ': ' + (w.exact ? '' : 'mind. ') + w.used + '/' + limit;
        }
        return part('Stunde', u.hour, u.hourLimit) + ' · ' + part('Heute', u.day, u.dayLimit);
    }
    function extractNodeState(n) {
        return {
            status: (n && n.status != null) ? n.status : null,
            repeatable: (n && n.repeatable != null) ? n.repeatable : null,
            timesCompleted: (n && n.timesCompleted != null) ? n.timesCompleted : null,
            endTime: (n && n.endTime != null) ? n.endTime : null
        };
    }
    /**
     * Nach einem 404/475 die FRISCHE Instanz derselben SBC finden: Challenge-
     * Liste des Sets neu holen und den Knoten nehmen, dessen Vorgaben zur
     * geplanten Signatur passen (Ziel-OVR + Slots) - NICHT einfach den ersten.
     * Sonst landet das Team in einer fremden SBC.
     * Liefert die neue challengeId oder null.
     */
    async function resolveFreshChallengeId() {
        const setId = STATE.sbc.setId;
        const oldId = STATE.sbc.challengeId;
        const wantTarget = STATE.sbc.targetOVR;
        const wantSlots = STATE.sbc.formationSlots;
        if (setId == null) return null;
        let json = null;
        try { json = await apiGet('sbs/setId/' + setId + '/challenges'); }
        catch (e) {
            // WICHTIG: hier ist die ABFRAGE gescheitert, nicht die Suche. Vorher
            // gab es in diesem Fall nur ein null und KEINEN Diagnose-Eintrag -
            // im Report stand dann `staleRecover: null`, und "konnte nicht
            // nachsehen" war von "nichts gefunden" nicht zu unterscheiden.
            // Live (Report v4.89.0) war es ein HTTP 429, weil das Tageslimit
            // ueberschritten war; die Meldung schob es auf die Challenge.
            warn('Frische Challenge holen fehlgeschlagen:', e && e.message);
            STATE.diag.staleRecover = { setId: setId, oldId: oldId,
                lookupFailed: String((e && e.message) || e).slice(0, 120) };
            return null;
        }
        STATE.diag.scanStats = STATE.diag.scanStats || {};
        const nodes = collectChallengeNodes(json, STATE.diag.scanStats);
        STATE.diag.staleRecover = { setId: setId, oldId: oldId, nodes: nodes.length,
                                    wantTarget: wantTarget, wantSlots: wantSlots };
        // Der Knoten der ALTEN Id, falls EA ihn in der frischen Liste noch
        // zeigt - erklaert einen 404/475 (z.B. status "COMPLETE" statt weg).
        const oldNode = nodes.find(n => String(n.challengeId) === String(oldId));
        if (oldNode) STATE.diag.staleRecover.nodeState = extractNodeState(oldNode);
        const cands = [];
        const candDetails = [];
        for (const n of nodes) {
            if (String(n.challengeId) === String(oldId)) continue;
            let scan = null;
            try { scan = deepScanChallenge(n); } catch (e) { continue; }
            if (!scan) continue;
            const okTarget = (wantTarget == null) || (String(scan.target) === String(wantTarget));
            const okSlots = (wantSlots == null) || (scan.slots == null) ||
                            (Number(scan.slots) === Number(wantSlots));
            if (okTarget && okSlots) {
                cands.push(n.challengeId);
                candDetails.push(Object.assign({ id: n.challengeId }, extractNodeState(n)));
            }
        }
        // candidateCount bleibt die WAHRE Anzahl (candidates ist auf 5 gedeckelt) -
        // submitToSbc() braucht genau 0-vs-nicht-0, um die Erschoepfungs-Meldung
        // (LEARNINGS 9/35) von der Mehrdeutig-Meldung zu unterscheiden.
        STATE.diag.staleRecover.candidateCount = cands.length;
        STATE.diag.staleRecover.candidates = candDetails.slice(0, 5);
        if (cands.length !== 1) {
            // Mehrdeutig oder nichts gefunden: lieber sauber melden als in die
            // falsche SBC schreiben.
            return null;
        }
        STATE.lastSetChallenges = json;
        // Auch den Pro-Set-Cache aktualisieren: applyFromSetChallenges()
        // bevorzugt ihn - ohne dieses Update wuerde nach der Recovery der
        // VERALTETE Cache-Stand gewinnen, die neue challengeId darin nie
        // gefunden und der frische Vorgaben-Scan still nie angewendet
        // (Nacht-Review 16.08.). typeof-Guard: solver-test.js extrahiert
        // diese Funktion standalone, ohne den URLCLS-Block.
        if (typeof cacheSetChallenges === 'function') cacheSetChallenges(setId, json);
        else if (STATE.setChallengesBySet) STATE.setChallengesBySet[setId] = json;
        return cands[0];
    }
    // Anforderungen der aktuellen Challenge aus der gecachten Set-Liste ziehen.
    function applyFromSetChallenges() {
        // Bevorzugt den Pro-Set-Cache: lastSetChallenges kann vom zuletzt
        // geoeffneten ANDEREN Set stammen (Live-Fall 84+ TOTW, v4.58.0-Report).
        const src = (STATE.sbc.setId != null &&
            (STATE.setChallengesBySet || {})[STATE.sbc.setId]) ||
            STATE.lastSetChallenges;
        if (!src || STATE.sbc.challengeId == null) return;
        STATE.diag.scanStats = STATE.diag.scanStats || {};
        const node = findChallengeNode(src, STATE.sbc.challengeId, STATE.diag.scanStats);
        if (node) {
            const scan = deepScanChallenge(node, 60000);
            recordDeepScanStats(scan, 'set-node');
            applyScan(scan, 'Set-Challenges');
        }
    }
    // Traversal-Metriken von deepScanChallenge() (Aktion 2, LEARNINGS 37) in
    // denselben STATE.diag.scanStats-Zweig wie findChallengeNode()/
    // collectChallengeNodes() uebernehmen - reine Beobachtung, kein
    // Abbruchkriterium. source unterscheidet die drei Aufrufer (netzwerk/
    // set-node/entity) - noetig geworden, weil beim Gold-Challenge-Fall nicht
    // erkennbar war, WELCHER Scan das Budget erschoepft hatte; deepScanBySource
    // sammelt den jeweils letzten Stand pro Quelle.
    function recordDeepScanStats(scan, source) {
        STATE.diag.scanStats = STATE.diag.scanStats || {};
        const entry = { visitedCount: scan.visitedCount,
            depthCapped: scan.depthCapped, budgetExhausted: scan.budgetExhausted,
            source: source || null };
        STATE.diag.scanStats.deepScan = entry;
        STATE.diag.scanStats.deepScanBySource = STATE.diag.scanStats.deepScanBySource || {};
        if (source) STATE.diag.scanStats.deepScanBySource[source] = entry;
    }
    // Wurde IRGENDEIN Vorgaben-Scan abgeschnitten? Anders als die (zurueck-
    // genommene) v4.34.0-Warnung urteilt das NICHT ueber reqDump-Inhalte,
    // sondern ueber ein hartes Traversal-Faktum - und wird nur als Hinweis
    // benutzt, nie als Abbruch.
    function anyDeepScanTruncated() {
        const by = (STATE.diag.scanStats || {}).deepScanBySource || {};
        for (const k in by) { if (by[k] && by[k].budgetExhausted) return true; }
        return false;
    }
    // Set-Challenges fuer das AKTUELLE Set aktiv nachladen (ein GET, laeuft
    // durch die normale 401-Kaskade von apiGet). Die zuverlaessigste Quelle
    // fuer Vorgaben ist der elgReq-Block dieser Antwort (klein, exakt,
    // req/elig-priorisiert gescannt) - der Live-Entity-Scan kann dagegen im
    // App-Objektgraphen ertrinken (Live-Fall 84+ TOTW: Vorgabe nie gefunden).
    // Rein additiv: laedt nur, wenn fuer dieses Set noch nichts gecacht ist.
    async function ensureSetChallenges(reason) {
        const sid = STATE.sbc.setId;
        if (sid == null) return false;
        if (STATE.setChallengesBySet[sid]) { applyFromSetChallenges(); return true; }
        try {
            const json = await apiGet((STATE.sbc.apiPrefix || 'sbs') + '/setId/' + sid + '/challenges');
            if (json) {
                if (typeof cacheSetChallenges === 'function') cacheSetChallenges(sid, json);
                else STATE.setChallengesBySet[sid] = json;
                STATE.lastSetChallenges = json;
                applyFromSetChallenges();
                log('Set-Challenges nachgeladen (' + reason + '), setId', sid);
                return true;
            }
        } catch (e) { reportError('ensureSetChallenges(' + reason + ')', e); }
        return false;
    }
    // ======================================================================
    //  SBC-REIHE: die Challenges EINES Sets als Liste
    // ======================================================================
    // Rasmus' Beispiel ist ein Set mit drei Challenges (89-/90-/91-Rated
    // Squad). EA liefert sie in EINER Antwort - .../sbs/setId/<id>/challenges,
    // dieselbe, aus der die Vorgaben-Erkennung ohnehin schon liest. Hier wird
    // sie nur pro Challenge ausgewertet statt nur fuer die offene.
    /**
     * Ist der Name brauchbar? EA liefert manchmal Lokalisierungs-Schluessel
     * ("*GLOBAL.…") statt Text - die sollen NICHT als Bezeichnung durchgehen,
     * sonst steht in der Auswahl Kauderwelsch statt "89-Rated Squad".
     */
    function challengeNodeName(node, target) {
        const raw = node && (node.name || node.challengeName);
        const txt = (typeof raw === 'string') ? raw.replace(/\s+/g, ' ').trim() : '';
        if (txt && txt.charAt(0) !== '*' && txt.indexOf('GLOBAL.') !== 0) return txt;
        return (target != null) ? ('Ziel-OVR ' + target) : 'SBC';
    }
    /** Gilt die Challenge laut EA als erledigt/zu? */
    function challengeNodeDone(st) {
        return !!(st && st.status != null && /COMPLETE|CLOSED|EXPIRED/i.test(String(st.status)));
    }
    /**
     * Aus einer Set-Challenges-Antwort die Liste der Challenges bauen.
     * Reine Funktion (nur collectChallengeNodes/deepScanChallenge) - deshalb
     * ohne DOM und ohne Netz testbar.
     * Doppelte challengeIds werden zusammengefasst: EAs Antwort haengt
     * denselben Knoten je nach Set mehrfach in den Baum, und eine SBC zweimal
     * in der Auswahl waere schlimmer als ein fehlender Eintrag.
     */
    function buildChallengeList(json, statsOut) {
        const out = [];
        if (!json) return out;
        const nodes = collectChallengeNodes(json, statsOut || null);
        const seen = {};
        for (const n of nodes) {
            const id = n.challengeId;
            if (id == null || seen[String(id)]) continue;
            let scan = null;
            try { scan = deepScanChallenge(n, 60000); } catch (e) { continue; }
            if (!scan) continue;
            seen[String(id)] = true;
            const st = extractNodeState(n);
            out.push({
                id: id,
                name: challengeNodeName(n, scan.target),
                target: scan.target,
                // EAs eigene Ordnungszahl. Sie ist der Anker fuer die
                // Navigation: der NAME ist keiner (Live: sechs Challenges
                // heissen "91-Rated Squad").
                priority: (typeof n.priority === 'number') ? n.priority : null,
                // Wiederholbar? Entscheidet, ob EAs Set-Zaehler eine Abgabe
                // ueberhaupt WIDERLEGEN kann: bei einem nicht wiederholbaren
                // Set bleibt timesCompleted auf 0 (live: Icon-Set 1406,
                // "Completed 0 times" bei 2 von 20 fertigen Challenges).
                repeatable: (typeof n.repeatable === 'boolean') ? n.repeatable : null,
                slots: scan.slots,
                // Nur fuer die Diagnose: im Live-Report war slots durchweg
                // null (EAs Challenge-Knoten hat kein slots-Feld, nur
                // "formation":"f442"). Damit ist beim naechsten Bericht
                // ablesbar, ob 11 die richtige Annahme war.
                formation: (typeof n.formation === 'string') ? n.formation : null,
                done: challengeNodeDone(st),
                state: st,
                scan: scan
            });
        }
        // Reihenfolge wie im SPIEL: EAs eigene `priority`. Vorher habe ich
        // nach Ziel-OVR sortiert - bei drei Challenges (89/90/91) dasselbe
        // Ergebnis, bei zwanzig aber eine andere Liste als die, die Rasmus vor
        // sich hat. Und nur EAs Reihenfolge taugt als Positions-Anker.
        // Ohne priority (nicht jede Antwort fuehrt es) bleibt die alte Regel
        // als Rueckfall: Ziel-OVR, dann Id - damit die Liste nie in der
        // zufaelligen Reihenfolge des Objekt-Durchlaufs steht.
        out.sort(function (a, b) {
            const pa = (a.priority == null) ? null : a.priority;
            const pb = (b.priority == null) ? null : b.priority;
            if (pa != null && pb != null && pa !== pb) return pa - pb;
            if (pa != null && pb == null) return -1;
            if (pa == null && pb != null) return 1;
            const ta = (a.target == null) ? 1e9 : a.target;
            const tb = (b.target == null) ? 1e9 : b.target;
            if (ta !== tb) return ta - tb;
            return Number(a.id) - Number(b.id);
        });
        // ERST JETZT die Position: sie muss die Reihenfolge widerspiegeln, in
        // der die Zeilen im Spiel stehen. rowCount reist mit, damit der
        // Aufrufer pruefen kann, ob die sichtbare Liste ueberhaupt komplett
        // ist - eine Position in einer gefilterten Liste waere falsch.
        for (let i = 0; i < out.length; i++) {
            out[i].rowIndex = i;
            out[i].rowCount = out.length;
        }
        return out;
    }
    /**
     * Die Vorgaben EINER Challenge in eine Solver-Konfiguration gießen.
     * Basis ist die Panel-Konfiguration (Min-Rating, Kosten, Schutz-Modus …);
     * ueberschrieben wird nur, was CHALLENGE-spezifisch ist. Rein, damit die
     * Zuordnung nicht still verrutscht - sie ist der Kern der Reihe: jede
     * Challenge hat ihr EIGENES Ziel.
     */
    function cfgForChallenge(baseCfg, step) {
        const scan = (step && step.scan) || {};
        return Object.assign({}, baseCfg, {
            targetOVR: (step && step.target != null) ? step.target : null,
            slots: (step && step.slots) || 11,
            rarityConstraints: scan.rarity || [],
            qualityConstraints: scan.quality || [],
            rareConstraints: scan.rare || [],
            playerLevelConstraints: scan.playerLevel || []
        });
    }
    /**
     * Die ausgewaehlten Challenges der Reihe nach planen. Jede Runde rechnet
     * auf dem Pool OHNE die Karten der vorigen Runden - genau wie der Batch,
     * sonst wuerde dieselbe Karte zweimal verplant.
     * Bricht NICHT ab, wenn eine Challenge nicht loesbar ist: sie wird
     * uebersprungen und benannt. "Zwei von drei geplant" ist brauchbar, ein
     * leerer Plan wegen der dritten nicht.
     */
    function beginQueue(pool, baseCfg) {
        return { rounds: [], skipped: [], avail: (pool || []).slice(), baseCfg: baseCfg };
    }
    /**
     * EINE Challenge planen und die verbauten Karten aus dem Restpool nehmen.
     * Der Einzelschritt ist eigen, weil die UI zwischen zwei Challenges an den
     * Browser zurueckgeben MUSS - eine durchgehende Schleife ueber mehrere
     * Solver-Laeufe friert die Seite ein (dieselbe Ursache wie beim
     * Team-Planen, v4.86.0).
     */
    function queueRound(st, step, solveFn) {
        const solve = solveFn || SolverCore.solve;
        const cfg = cfgForChallenge(st.baseCfg, step);
        let r = null;
        try { r = solve(st.avail, cfg); }
        catch (e) { r = { ok: false, reason: String((e && e.message) || e) }; }
        if (!r || !r.ok) {
            st.skipped.push({ step: step, reason: (r && r.reason) || 'unbekannt' });
            return null;
        }
        r.challengeId = step.id;
        r.challengeName = step.name;
        r.target = step.target;
        r.slots = cfg.slots;
        // Die Position in EAs Liste - der eigentliche Navigations-Anker.
        r.rowIndex = step.rowIndex;
        r.rowCount = step.rowCount;
        r.repeatable = step.repeatable;
        // Die Konfiguration DIESER Runde am Ergebnis festhalten: der Plan-Check
        // prueft Vorgaben pro Runde, und in der Reihe sind sie verschieden.
        r.cfg = cfg;
        st.rounds.push(r);
        const used = {};
        for (const p of r.players || []) used[String(p.id)] = true;
        st.avail = st.avail.filter(function (p) { return !used[String(p.id)]; });
        return r;
    }
    function finishQueue(st) {
        return { rounds: st.rounds, planned: st.rounds.length, skipped: st.skipped };
    }
    /**
     * Alles auf einmal - dieselbe Logik wie der UI-Weg, nur ohne Pausen.
     * Bricht NICHT ab, wenn eine Challenge nicht loesbar ist: sie wird
     * uebersprungen und benannt. "Zwei von drei geplant" ist brauchbar, ein
     * leerer Plan wegen der dritten nicht.
     */
    function planChallengeQueue(steps, pool, baseCfg, solveFn) {
        const st = beginQueue(pool, baseCfg);
        for (const step of steps || []) queueRound(st, step, solveFn);
        return finishQueue(st);
    }
    /**
     * Aus einer geplanten RUNDE den Navigations-Anker bauen.
     * Eigene Funktion, weil genau diese Umformung der Fehler war: die Runde
     * traegt ihre Id als `challengeId`, der Oeffner liest `id`. Ein
     * fremdgeformtes Objekt einfach weiterzugeben hat 18 Sekunden gegen eine
     * unerfuellbare Bedingung laufen lassen.
     */
    function roundToStep(round) {
        if (!round) return null;
        return {
            id: round.challengeId,
            name: round.challengeName,
            target: round.target,
            slots: round.slots,
            rowIndex: round.rowIndex,
            rowCount: round.rowCount
        };
    }
    /**
     * Passt die OFFENE SBC zu der Runde, die jetzt eingetragen werden soll?
     * Batch und Reihe haben verschiedene Anker:
     *   Batch: das SET plus die Vorgaben - jede Wiederholung hat eine neue
     *          challengeId (LEARNINGS 9), sie taugt dort nicht zum Vergleich.
     *   Reihe: die challengeId SELBST - hier ist sie stabil, und sie ist der
     *          einzige Beweis, dass die richtige der drei Challenges offen ist.
     * Zusaetzlich immer Ziel-OVR und Slots: ein Fehlgriff in der Liste kostet
     * so einen Abbruch statt ein Team in der falschen SBC.
     */
    function matchesPlannedRound(plan, i, sbcState) {
        const sbc = sbcState || STATE.sbc;
        if (!plan || plan.mode !== 'reihe') return matchesPlannedSbc(plan, sbc);
        const r = (plan.rounds || [])[i];
        if (!r) return false;
        if (String(sbc.challengeId) !== String(r.challengeId)) return false;
        if (String(sbc.targetOVR || '') !== String(r.target || '')) return false;
        return Number(sbc.formationSlots || 0) === Number(r.slots || 0);
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
        const scan = deepScanChallenge(json, 60000);
        recordDeepScanStats(scan, 'netzwerk');
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
        recordDeepScanStats(scan, 'entity');
        applyScan(scan, 'App-Service');
        if (STATE.sbc.targetOVR == null) applyFromSetChallenges();
    }
    function applyScan(scan, source) {
        let changed = false;
        // UNGEGATED (nicht hinter dem scan.reqs.length-Gate unten): ein neuer
        // Scope kann auftreten, ohne dass scan.reqs etwas enthaelt - genau
        // die Whitelist-Luecke aus docs/roadmap/gaps/sbc-vorgaben-erkennung.md,
        // Mangel 1.
        STATE.sbc.scopesSeen = scan.scopesSeen || [];
        if (scan.target != null) { STATE.sbc.targetOVR = scan.target; changed = true; }
        if (scan.squadId != null) { STATE.sbc.squadId = scan.squadId; changed = true; }
        // usableSlots (aus playerRequirements) ist präziser als jeder
        // "slots"-Fund im Objektbaum - dann nicht überschreiben.
        if (scan.slots != null && !STATE.sbc.usableSlots) { STATE.sbc.formationSlots = scan.slots; changed = true; }
        if (scan.rarity.length) { STATE.sbc.rarityConstraints = scan.rarity; changed = true; }
        if (scan.playerLevel.length) { STATE.sbc.playerLevelConstraints = scan.playerLevel; changed = true; }
        if (scan.quality && scan.quality.length) { STATE.sbc.qualityConstraints = scan.quality; changed = true; }
        if (scan.rare && scan.rare.length) { STATE.sbc.rareConstraints = scan.rare; changed = true; }
        if (scan.reqs.length) {
            STATE.sbc.reqDump = scan.reqs;
            // NUR INFORMATIV, KEINE Warnung mehr. In v4.34.0 habe ich Scopes
            // ohne Wert als "Vorgabe, die wir nicht abdecken" gedeutet und
            // gewarnt. Das war falsch: "PLAYER" und "CLUB MEMBER" sind die
            // Eligibility-Scopes, die JEDE SBC hat ("Spieler-Items aus deinem
            // Verein"). Live bewiesen an einer SBC, die einwandfrei durchlief
            // (lastErrors leer, lastTeam ok, submitVia app) und trotzdem die
            // Warnung bekam. Ausserdem enthaelt reqDump je nach gescanntem
            // Knoten gar nicht die echten Vorgaben - TEAM_RATING fehlte dort,
            // obwohl das Ziel-OVR erkannt war. Aus dieser Liste laesst sich
            // "unerfuellbar" also nicht ableiten. Wer das wirklich wissen will,
            // fragt EA selbst: _squad.isSBCSquadEligible().
            const BOILERPLATE = ['PLAYER', 'CLUB MEMBER', 'CLUBMEMBER', 'ITEM'];
            const other = [];
            for (const r of scan.reqs) {
                const sc = String(r.scope || '').toUpperCase();
                if (!sc || r.value != null) continue;
                if (BOILERPLATE.indexOf(sc) > -1) continue;
                if (other.indexOf(sc) < 0) other.push(sc.slice(0, 40));
            }
            STATE.sbc.otherScopes = other;
            changed = true;
        }
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
            // findLiveChallenge() ist SSOT fuer dieselbe Suche (Q4/Q5, siehe
            // patterns/bad/helfer-existiert-wird-umgangen.md) - liefert zusaetzlich
            // STATE.sbc.entity als Fallback (reine Erweiterung: captureChallengeEntity()
            // no-op bei Nicht-Objekten, kein Verlust eines bestehenden Rueckgabewerts).
            const ch = findLiveChallenge();
            if (ch) {
                const prevId = STATE.sbc.challengeId;
                captureChallengeEntity(ch);
                if (STATE.sbc.challengeId !== prevId) {
                    log('SBC aus offener Ansicht synchronisiert: Challenge', STATE.sbc.challengeId, '(vorher', prevId + ')');
                }
                return true;
            }
        } catch (e) { reportError('syncSbcWithOpenChallenge', e); }
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
            // FUT-Standard: rareflag 0 = Common (non-rare), 1 = Rare.
            // Manche Gold-SBCs verlangen "min. N Rare" - der Rest soll dann
            // Common sein, damit keine Rare-Karte unnoetig verbraucht wird.
            isRare: rf === 1,
            isCommon: rf === 0,
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
    // PaleTools speichert in lockedItems KEINE 12-stelligen Item-IDs, sondern
    // kuerzere Zahlen (live: [100664921, 190871, 225733, 50332136, ...]) - also
    // assetId/resourceId, der SPIELER statt der einzelnen Karte. Die Schwelle
    // 1e11 hat deshalb alles verworfen. Da wir nur in Zweigen mit "lock" im
    // Namen suchen, genuegt "positive ganze Zahl ab 1000".
    function looksLikeItemId(x) {
        const n = Number(x);
        return isFinite(n) && n >= 1000 && n < 1e14 && Math.floor(n) === n &&
               typeof x !== 'boolean';
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
        let skippedKeys = 0;
        const keyInfo = [];
        // Bricht die Schleife mitten drin ab, bleibt die Sperrliste unvollstaendig,
        // OHNE dass der Report das zeigt (CLAUDE.md: gesperrte Karten NIEMALS
        // verbauen - ein stiller Teilausfall koennte das unterlaufen). scanError
        // macht das im Report explizit sichtbar statt nur ueber niedrige Zahlen
        // erraten zu werden.
        let scanError = null;
        // Keys, deren Wert erkennbar kein JSON ist (base64 & Co.) - erwartbar,
        // deshalb getrennt von den echten Defekten (skippedKeys).
        let nonJsonKeys = 0;
        // EIN einzelner kaputter Key (nicht lesbar ODER kein valides JSON) darf
        // die restlichen Locks nicht kosten - deshalb pro Key ueberspringen statt
        // die ganze Schleife abzubrechen. skippedKeys zaehlt JEDEN Fall, ein
        // reportError() aber nur einmal pro Session (STATE.locksSkipReported) -
        // sonst waeren 50 korrupte Keys 50 identische Konsolen-/Report-Zeilen.
        function markSkipped(k, e) {
            skippedKeys++;
            if (!STATE.locksSkipReported) {
                STATE.locksSkipReported = true;
                reportError('readPaletoolsLocks: Key uebersprungen (' + k + ')', e);
            }
        }
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
                try { raw = localStorage.getItem(k); } catch (e) { markSkipped(k, e); continue; }
                if (!raw) continue;
                // Ein Wert, der nicht mit einer geschweiften oder eckigen
                // Klammer beginnt, war nie JSON - PaleTools legt z.B.
                // `paletools:settings` base64-kodiert ab ("eyJlbmFibG..."). Das
                // ist KEIN Defekt und gehoert nicht als Fehler in den Report;
                // live stand genau diese Zeile in jedem Log und lenkte von den
                // echten Meldungen ab. Ueberspringen ohne markSkipped, aber im
                // Zaehler sichtbar.
                // Geprueft wird ueber Zeichencodes (123 = geschweift, 91 =
                // eckig): Klammer-LITERALE in dieser Datei bringen die
                // Funktions-Extraktion der Test-Suite aus dem Takt.
                const code = raw.replace(/^\s+/, '').charCodeAt(0);
                if (code !== 123 && code !== 91) { nonJsonKeys++; continue; }
                let obj = null;
                try { obj = JSON.parse(raw); } catch (e) { markSkipped(k, e); continue; }
                // Steht der Key selbst schon für die Sperrliste, ist der ganze
                // Wert die Quelle - sonst nur die "lock"-Zweige darin.
                // ACHTUNG: "lockedPacks" enthaelt PACK-IDs ([1030, 20038, ...]),
                // keine Karten. Mit der niedrigen Schwelle in looksLikeItemId
                // wuerden die sonst als gesperrte Karten gelten und still eine
                // brauchbare Karte aus dem Pool nehmen.
                if (/pack/i.test(k)) continue;
                if (/lockeditem/i.test(k)) harvestIds(obj, ids, 0);
                else if (/lock/i.test(k)) harvestIds(obj, ids, 0);
                else findLockBranches(obj, ids, 0);
            }
        } catch (e) {
            scanError = (e && e.message) || String(e);
            reportError('Locks lesen fehlgeschlagen', e);
        }
        STATE.diag.locks = {
            nonJsonKeys: nonJsonKeys,
            keysScanned: keysScanned,
            found: ids.size,
            sample: Array.from(ids).slice(0, 5),
            // Nur noetig, wenn found = 0: daran ist der richtige Key ablesbar.
            keys: keyInfo.slice(0, 12),
            error: scanError,
            // Pro-Key uebersprungen (nicht lesbar / kein valides JSON) - anders
            // als scanError (Gesamt-Loop-Abbruch) bleibt die Suche bei den
            // restlichen Keys hier weiter aktiv.
            skippedKeys: skippedKeys
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
                // Der Cache muss wissen, was weg ist - sonst stimmt seine
                // Pruefzahl gegen EAs totalItemCount beim naechsten Start nicht.
                poolCacheNoteRemoved(players);
            }
        } catch (e) { reportError('removeFromPool', e); }
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
        } catch (e) { reportError('Unassigned via Service fehlgeschlagen', e); }
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
        } catch (e) { reportError('Storage via Service fehlgeschlagen', e); }
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
    // apiGet/apiPut bauen dieselbe Nudge->Sleep->Retry-Kaskade absichtlich
    // JEDER FUER SICH nach statt sie in einen gemeinsamen
    // apiRequest(method, path, body, _attempt)-Kern zu ziehen: solver-test.js
    // hat aktuell keine Coverage der 401-Retry-Kaskade selbst (nur eine
    // Attrappe fuer den Pagination-Loader), eine Extraktion waere also nicht
    // verhaltensneutral belegbar. Dazu muesste der _attempt-Zaehler PRO
    // Methode/Pfad zaehlen - ein gemeinsamer Kern liefe sonst Gefahr, einen
    // laufenden GET- und PUT-Retry denselben Zaehler teilen zu lassen.
    // Kandidat fuer eine Folge-Iteration, sobald ein Mock-Testharness fuer
    // apiGet/apiPut existiert (analog zum fetchClubViaHttp-Test).
    async function apiGet(path, _attempt) {
        const url = STATE.session.apiBase + path.replace(/^\//, '');
        let resp;
        try {
            resp = await _origFetch(url, { method: 'GET', headers: apiHeaders(), credentials: 'omit' });
        } catch (e) {
            noteThrottle('GET ' + path + ' -> ' + (e.message || e));
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
            noteThrottle('GET ' + path + ' -> HTTP ' + resp.status);
            diagError('GET ' + path + ' -> HTTP ' + resp.status);
            throw new Error(httpErrText('GET', path, resp.status));
        }
        // Erfolg: der Client ist offensichtlich nicht blockiert.
        noteRequestOk();
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
            noteThrottle('PUT ' + path + ' -> ' + (e.message || e));
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
            noteThrottle('PUT ' + path + ' -> HTTP ' + resp.status);
            diagError('PUT ' + path + ' -> HTTP ' + resp.status + (bodyTxt ? ' BODY: ' + bodyTxt : ''));
            throw new Error(httpErrText('PUT', path, resp.status));
        }
        noteRequestOk();
        try { return await resp.json(); } catch (e) { return {}; }
    }
    async function fetchClubViaHttp(onProgress) {
        let page = 0;
        let found = 0;
        clubHarvestBegin();
        // GROESSERE SEITEN. 91 war geraten; PaleTools faehrt laut seinen
        // Settings mit maxItemsCount 150, EA nimmt also mehr als 91. Wir fragen
        // 175 an und lernen die echte Obergrenze aus der ERSTEN Antwort: liefert
        // EA weniger Items als angefragt, obwohl laut totalItemCount noch welche
        // fehlen, ist das die Kappung - dann wird mit diesem Wert weitergefahren.
        // 8400 Karten: 92 Seiten bei 91, rund 48 bei 175.
        let count = 175;
        let calibrated = false;
        // TAKT statt SCHLAFEN. Vorher wurde NACH jeder Antwort 250ms gewartet,
        // die Periode war also Latenz + 250ms (~450ms). Jetzt wird der ABSTAND
        // ZWISCHEN DEN STARTS getaktet, die Latenz laeuft mit. Der Takt ist mit
        // 300ms bewusst etwas langsamer als die reine Rechnung erlaubt und
        // wird bei JEDEM Fehlversuch groesser (Rate-Limit-401er haben schon
        // einmal einen Ladevorgang gekostet, LEARNINGS 7) - der Lauf bremst
        // sich also selbst ein, statt auf einen festen Wert zu wetten.
        let gap = 300;
        let total = Infinity;
        let gotAny = false;
        STATE.loadIncomplete = false;
        STATE.diag.clubLoad = { pageSize: count, gap: gap, pages: 0, retries: 0, ms: 0, loadIncomplete: false };
        const t0 = Date.now();
        while (page * count < total) {
            if (STATE.cancelLoad) break;
            const start = page * count;
            const tStart = Date.now();
            const path = 'club?sort=desc&sortBy=value&type=player&count=' + count + '&start=' + start;
            let json = null;
            // Pro Seite bis zu 3 Versuche (apiGet macht bei 401 zusätzlich
            // selbst einen Nudge+Retry) - abgelaufene Sessions mitten im
            // Laden haben sonst den halben Pool gekostet.
            for (let attempt = 0; attempt < 3 && !json; attempt++) {
                try { json = await apiGet(path); }
                catch (e) {
                    warn('Club-Fetch Fehler Seite', page, 'Versuch', attempt + 1, e.message);
                    // Selbst einbremsen: jeder Fehlversuch erhoeht den Takt
                    // dauerhaft. Ein Rate-Limit soll den Lauf verlangsamen,
                    // nicht abbrechen.
                    gap = Math.min(900, gap + 150);
                    STATE.diag.clubLoad.retries++;
                    STATE.diag.clubLoad.gap = gap;
                    if (attempt < 2) await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
                }
            }
            if (!json) {
                if (!gotAny) throw new Error('Club-Laden fehlgeschlagen (Session?). Bitte kurz in der App navigieren und erneut versuchen.');
                STATE.loadIncomplete = true;
                // Beide Debug-Kanaele: clubLoad.loadIncomplete steht im JSON-
                // Report (buildDiagReport gibt clubLoad komplett zurueck),
                // warn() landet im App-Log-Ringpuffer - der bestehende Toast
                // (loadPool/onRunClick) bleibt zusaetzlich unveraendert bestehen.
                STATE.diag.clubLoad.loadIncomplete = true;
                warn('Club-Laden dauerhaft fehlgeschlagen ab Seite', page, '- Pool bleibt unvollstaendig.');
                break;
            }
            gotAny = true;
            const items = extractItems(json);
            if (json.totalItemCount != null) total = json.totalItemCount;
            else if (json.total != null) total = json.total;
            // Seitengroesse kalibrieren: kamen weniger Items als angefragt,
            // obwohl laut total noch welche fehlen, hat EA gekappt. WICHTIG:
            // das muss VOR dem "weniger Items = fertig"-Schluss stehen, sonst
            // bricht der Lauf nach der ersten Seite ab.
            if (!calibrated && items.length > 0 && items.length < count &&
                total !== Infinity && start + items.length < total) {
                count = items.length;
                calibrated = true;
                STATE.diag.clubLoad.pageSize = count;
                log('Club-Seitengroesse von EA gekappt auf ' + count + ' - damit weiter.');
            }
            calibrated = true;
            if (total === Infinity && items.length < count) total = start + items.length;
            const players = [];
            for (const it of items) {
                const p = normalizePlayer(it, false);
                if (p) players.push(p);
            }
            found += players.length;
            clubHarvestPage(page, items, players, total);
            mergeIntoPool(players);
            if (onProgress) onProgress(STATE.pool.length, total === Infinity ? null : total);
            if (items.length === 0) break;
            page++;
            if (page > 300) break;
            // Rest des Takts abwarten - die Latenz der gerade beantworteten
            // Seite zaehlt mit, es wird also nicht doppelt gewartet.
            const restMs = gap - (Date.now() - tStart);
            if (restMs > 0) await new Promise(r => setTimeout(r, restMs));
        }
        STATE.diag.clubLoad.pages = page;
        STATE.diag.clubLoad.ms = Date.now() - t0;
        // Nur ein VOLLSTAENDIGER Durchlauf darf in den Cache: ein abgebrochener
        // oder unvollstaendiger Verein wuerde als "kompletter Pool" gelten und
        // die naechste SBC schlechter oder unloesbar machen.
        clubHarvestDone(!STATE.cancelLoad && !STATE.diag.clubLoad.loadIncomplete);
        log('Verein geladen: ' + found + ' Spieler in ' + page + ' Seiten (' +
            count + ' pro Seite, ' + STATE.diag.clubLoad.ms + 'ms, Takt ' + gap + 'ms).');
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
        } catch (e) { reportError('Unassigned-Fetch Fehler', e); }
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
        } catch (e) { reportError('storagepile-Fetch Fehler', e); }
        return out;
    }
    // ---- Kombinierter Pool-Load ---------------------------------------------
    /**
     * Unassigned + Storage: zusammen zwei Requests. Werden NIE gecacht -
     * sie sind billig, und so bleibt die Cache-Buchhaltung auf den Verein
     * beschraenkt (nur der zaehlt in EAs totalItemCount).
     */
    async function loadPoolSmallLists() {
        const canServices = servicesAvailable() &&
                            typeof window.UTBucketedItemSearchViewModel === 'function';
        let unassigned = sessionReady() ? await fetchUnassignedViaHttp() : [];
        if (!unassigned.length && canServices) unassigned = await fetchUnassignedViaServices();
        let storage = sessionReady() ? await fetchStorageViaHttp() : [];
        if (!storage.length && canServices) storage = await fetchStorageViaServices();
        mergeIntoPool(unassigned);
        mergeIntoPool(storage); // Storage zuletzt: Storage-Flag gewinnt beim Merge
        return { unassigned: unassigned.length, storage: storage.length };
    }
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
        adoptClubHarvest();
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
        // Konsum-Reihenfolge innerhalb eines Ratings: Priorität
        // (Storage-Gold -> Storage-Special -> Verein-Gold -> Verein-Special).
        // Kein Duplikat-Stapel-Tiebreak nötig: die SPIELER-EINDEUTIGKEIT weiter
        // oben lässt pro assetId strukturell nur eine Karte in pool/avail
        // übrig, bevor makeConsumeCmp() überhaupt aufgerufen wird - ein
        // zweites Vergleichsglied nach Stapelgröße könnte hier nie mehr als
        // eine Karte je Schlüssel sehen (jeder Aufrufer bekommt ausschließlich
        // schon deduplizierte Listen, siehe reserveCmp/cmp unten).
        function makeConsumeCmp() {
            return function (a, b) {
                return priorityOf(a) - priorityOf(b);
            };
        }
        // Sortier-Komparator "Storage vor Verein -> niedrigstes Rating ->
        // Kosten -> Tiebreak", an vier Stellen im Solver identisch gebraucht
        // (Bronze/Silber-Quoten, Rare-ohne-Ziel-Reservierung, Gold-Rare-
        // Reservierung ohne Ziel-OVR, Auffüll-Karten ohne Ziel-OVR).
        // tiebreakCmp kommt von zwei Konstruktionsstellen: reserveCmp
        // (makeConsumeCmp() am Lösungs-Pool) und cmp (makeConsumeCmp() am
        // Rest-Pool nach Reservierung).
        function makeFillCmp(costOf, tiebreakCmp) {
            return function (a, b) {
                return ((b.isStorage ? 1 : 0) - (a.isStorage ? 1 : 0)) ||
                    (a.rating - b.rating) || (costOf(a) - costOf(b)) || tiebreakCmp(a, b);
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
        // Kombinatorik-Schranke fuer reserveWindowAware() (Ticket #60/#64,
        // LEARNINGS 41): Anzahl der (Rating -> Anzahl)-Aufteilungen, die PRO
        // VORGABE (Rarity- UND playerLevel-Reservierung teilen sich die
        // Schranke) tatsaechlich per DP durchprobiert werden, bevor auf den
        // Kosten-Greedy zurueckgefallen wird. Konservativ fuer Reaktionszeit
        // am Handy geschaetzt (Lift-Plan), nicht am realen Geraet gemessen -
        // ein spaeterer Live-Befund kann den Wert mit eigenem Beleg anpassen.
        const RARITY_WINDOW_TRIAL_CAP = 200;
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
        // Kartenkosten (Band + persönliche Scarcity, Storage-Bonus, Rarity-
        // Schutz-Aufschlag, Untradeable-Rabatt) als modul-weite Factory statt
        // einer Closure innerhalb von solveCore: solver-test.js baut damit
        // dieselbe Formel per SolverCore.makeCostOf() auf, statt sie als
        // eigenständige cardCostFn() nachzubilden (SSOT, vorher nur per
        // Kommentar "MUSS synchron bleiben" abgesichert).
        function makeCostOf(pool, cfg) {
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
            // SCHUTZ-MODUS (Produktregel von Rasmus, 25.08.2026): EA hat die
            // Seltenheitsgruppe veraendert - waehrend FUTTIES bekommt JEDE
            // gezogene Karte Gruppe 83, damit ist die Gruppe nicht mehr
            // wertvoll. Der harte Schutz zieht deshalb auf Vereins-TOTW um.
            //   'vereinTotw' (Default) - nur TOTW aus dem VEREIN ist hart
            //                            geschuetzt; Storage ist Verbrauchs-
            //                            material, auch als Special.
            //   'gruppe83'             - das alte Verhalten, falls EA
            //                            zurueckdreht (ohne neue Version).
            //   'aus'                  - kein harter Schutz.
            const rarityMode = cfg.rarityMode || 'vereinTotw';
            function isProtectedRarity(p) {
                if (!guardCost || rarityMode === 'aus') return false;
                if (rarityMode === 'vereinTotw') {
                    // Nur der Verein ist ein Lager, aus dem nichts verschwinden
                    // soll. Storage-TOTW bleibt nutzbar (siehe totwSoftCost).
                    return isTotw(p) && !p.isStorage;
                }
                // rareflag 3 = TOTW = Rarity-Gruppe 83. Der Schutz darf NICHT
                // allein am groups-Feld haengen: ein TOTW-Payload OHNE groups
                // waere sonst ungeschuetzt und (Flachkosten unten) sogar die
                // billigste Karte seiner Stufe - Kosten-Identitaet (rareflag)
                // und Schutz-Identitaet (groups) muessen dieselbe Karte meinen
                // (Nacht-Review 16.08., LEARNINGS 49).
                if (guardGroups.indexOf(83) > -1 && isTotw(p)) return true;
                if (!Array.isArray(p.groups) || !p.groups.length) return false;
                for (const g of guardGroups) if (p.groups.indexOf(g) > -1) return true;
                return false;
            }
            // UNTRADEABLE bevorzugen: solche Karten lassen sich nicht
            // verkaufen, sind für SBCs aber vollwertig - sie zuerst zu
            // verbauen spart echte Coins. Rabatt wirkt wie der Rarity-Aufschlag
            // NACH dem Storage-Rabatt (wird also nicht halbiert).
            const untrBonus = Math.max(0, cfg.untradeableBonus != null
                ? Number(cfg.untradeableBonus) : 3);
            // Aufschlag fuer TOTW, die NICHT hart geschuetzt sind (also aus dem
            // Storage): "trotzdem nicht unnoetigerweise benutzen".
            const totwSoft = Math.max(0, cfg.totwSoftCost != null
                ? Number(cfg.totwSoftCost) : 8);
            // Aufschlag fuer sonstige Specials - stellt "Gold-Storage vor
            // Special-Storage" her, ohne Specials zu blockieren.
            const specialSoft = Math.max(0, cfg.specialCost != null
                ? Number(cfg.specialCost) : 1);
            function costOf(p) {
                const n = countByRating.get(p.rating) || 1;
                // TOTW (rareflag 3) sind wertgleich - die Rating-Kosten-
                // Baender gelten fuer sie NICHT (Produktregel von Rasmus,
                // 16.08.): ein 87er-TOTW ist nicht "teurer" als ein 84er,
                // nur weil 87er-GOLD im Band teuer ist. Stattdessen ein
                // minimaler Rating-Anteil (rating/1000) als Tiebreak:
                // niedrigere TOTW werden bei sonst gleicher Eignung zuerst
                // verbraucht ("hoehere sind besser, aber nur minimal").
                // Scarcity/Storage/Untradeable/Rarity-Schutz wirken weiter.
                const band = isTotw(p) ? (p.rating / 1000) : bandFn(p.rating);
                const base = alpha / n + band;
                // WEICHE Aufschlaege, beide NACH dem Storage-Rabatt (also nicht
                // halbiert) - sie verbieten nichts, sie ordnen nur:
                //  - Storage-TOTW: "TOTW nicht unnoetigerweise benutzen". Ein
                //    Aufschlag, kein Verbot: bei gleichem Rating geht jede
                //    andere Karte vor, gebraucht wird sie trotzdem.
                //  - Storage-Specials: der kleine Aufschlag stellt die von
                //    Rasmus genannte Reihenfolge her - "gold storage ->
                //    special storage -> gold verein". Klein, weil Specials fuer
                //    hohe Ratings unverzichtbar sind: bei gleichem Rating geht
                //    Gold vor, bei fehlendem Rating gewinnt der Special.
                const soft = (!isProtectedRarity(p) && isTotw(p) ? totwSoft : 0) +
                             (!isTotw(p) && p.isSpecial ? specialSoft : 0);
                return (p.isStorage ? (base / 2 - beta) : base) +
                       (isProtectedRarity(p) ? guardCost : 0) + soft -
                       (p.untradeable ? untrBonus : 0);
            }
            costOf.isProtectedRarity = isProtectedRarity;
            return costOf;
        }
        function matchesRarity(p, c) {
            if (!c) return p.isSpecial;
            // EXAKTES Matching über Rarity-GRUPPEN (live verifiziert, fc26):
            // Vorgabe "PLAYER_RARITY_GROUP 83" <=> 83 in p.groups.
            // Gruppe 4 = "Rare" (live: eine "Rare: Min. 6"-SBC schickt
            // PLAYER_RARITY_GROUP mit Wert 4). Das ist eine Karten-EIGENSCHAFT,
            // nicht ein Event - deshalb hier zusaetzlich ueber rareflag 1
            // pruefen, falls EA die 4 nicht in p.groups mitschickt.
            if (Number(c.groupId) === 4) {
                return p.isRare || (Array.isArray(p.groups) && p.groups.indexOf(4) > -1);
            }
            // Gruppe 83 analog ueber rareflag absichern: TOTW ist rareflag 3 -
            // auch ohne groups-Feld erfuellt ein TOTW eine Gruppe-83-Vorgabe
            // (dieselbe Identitaets-Regel wie isProtectedRarity, Nacht-Review
            // 16.08. - sonst waere die Karte geschuetzt, aber nie waehlbar).
            if (Number(c.groupId) === 83 && isTotw(p)) return true;
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
        // Kandidaten-Eligibility fuer eine Rarity-Vorgabe - SSOT fuer die
        // Reservierung IN solveCore (drei Call-Sites, vorher identischer Code
        // dreimal) UND die Panel-Anzeige "N verfuegbar" (computeRarityAvailability
        // unten, Ticket #68): freeCard/inQualityBand kommen als Parameter, weil
        // sie in solveCore von used/usedAssets bzw. der aktiven Qualitaets-
        // Vorgabe abhaengen - die Anzeige braucht diese Einschraenkungen nicht
        // und nutzt die Defaults (immer frei, jedes Rating im Fenster).
        function reservationCandidates(poolAll, rc, cfg, opts) {
            opts = opts || {};
            const freeCard = opts.freeCard || function () { return true; };
            const inQualityBand = opts.inQualityBand || function () { return true; };
            const lo = opts.lo != null ? opts.lo : 0;
            const hi = opts.hi != null ? opts.hi : 99;
            return poolAll.filter(function (p) {
                return p.rating >= lo && p.rating <= hi && freeCard(p) && inQualityBand(p) &&
                    matchesRarity(p, rc) &&
                    (!cfg.specialOnlyFromStorage || p.isStorage || !p.isSpecial || isTotw(p));
            });
        }
        // PaleTools sperrt den SPIELER, nicht die einzelne Karte: in
        // lockedItems stehen kurze Zahlen (assetId/resourceId), keine
        // 12-stelligen Item-IDs. Deshalb alle drei Spalten vergleichen.
        function isLockedOut(p, lockedSet) {
            return lockedSet.has(String(p.id)) ||
                (p.assetId != null && lockedSet.has(String(p.assetId))) ||
                (p.raw && p.raw.resourceId != null && lockedSet.has(String(p.raw.resourceId))) ||
                (p.resourceId != null && lockedSet.has(String(p.resourceId)));
        }
        // Gesperrte Karten (z.B. per PaleTools-Schloss) fliegen komplett raus -
        // wer eine Karte sperrt, will sie behalten. SSOT fuer solveCore UND die
        // Panel-Verfuegbarkeits-Anzeige (Ticket #68), die denselben Bestand
        // sehen muss wie eine tatsaechliche Reservierung.
        function filterLockedCards(poolAll, cfg, warnings) {
            if (!cfg.lockedIds || !cfg.lockedIds.length) return poolAll;
            const locked = new Set(cfg.lockedIds.map(String));
            const before = poolAll.length;
            const out = poolAll.filter(function (p) { return !isLockedOut(p, locked); });
            const removed = before - out.length;
            if (removed && warnings) warnings.push(removed + ' gesperrte Karte(n) ausgeschlossen.');
            return out;
        }
        // Max. Rating pro Spieler (Ticket #66): HARTER Pool-Vorfilter, SSOT
        // fuer solve() UND die Panel-Verfuegbarkeits-Anzeige (Ticket #68) -
        // beide muessen dieselbe Karte ab derselben Grenze ausschliessen.
        function applyMaxRatingFilter(poolAll, cfg) {
            return (cfg.maxRatingEnabled && cfg.maxRating)
                ? poolAll.filter(function (p) { return p.rating <= cfg.maxRating; })
                : poolAll;
        }
        /**
         * Bounded-Knapsack-DP mit Kartenkosten.
         * Liefert für jedes (Anzahl j, exp-Zähler e, Summe s) die minimalen
         * Kosten und kann die konkreten Spieler rekonstruieren.
         *
         * exp: generische dritte DP-Dimension (Zähler + Budget für Karten ab
         * einer Schwelle) - seit v4.62.0 an ALLEN Call-Sites null, war die
         * Dimension des entfernten "Max. teure Spieler"-Filters (Ticket #66,
         * LEARNINGS §44: der Filter lockerte sich bei Unlösbarkeit selbst,
         * "Max. Rating pro Spieler" ersetzt ihn als harter Pool-Vorfilter vor
         * solveCore statt als DP-Dimension). Bleibt als Mechanismus stehen,
         * weil der DP-Kern laut Vorgabe nicht angefasst wird - ein künftiger
         * "höchstens N Karten ab Rating X"-Filter könnte hier wieder andocken.
         */
        function buildDp(players, kMax, sMax, costOf, exp, cmp) {
            const groups = new Map();
            for (const p of players) {
                if (!groups.has(p.rating)) groups.set(p.rating, []);
                groups.get(p.rating).push(p);
            }
            const ratings = Array.from(groups.keys()).sort((a, b) => a - b);
            // Kleinstes und groesstes Rating im DP - Grenzen der erreichbaren
            // Summen (siehe Schleife unten).
            const rMinDp = ratings.length ? ratings[0] : 0;
            const rMaxDp = ratings.length ? ratings[ratings.length - 1] : 0;
            // Verbrauchsreihenfolge innerhalb eines Ratings: KOSTEN zuerst
            // (Rarity-Schutz & Band-Kosten wirken), Konsum-Präferenz
            // (Storage) als Tiebreak.
            for (const r of ratings) groups.get(r).sort((a, b) => (costOf(a) - costOf(b)) || cmp(a, b));
            const E = exp ? Math.max(0, exp.budget) + 1 : 1;
            const S = Math.max(0, sMax) + 1;
            const size = (kMax + 1) * E * S;
            const idx = (j, e, s) => (j * E + e) * S + s;
            // ZWEI Puffer im Wechsel. Die Kosten-Tabelle der vorigen Stufe wird
            // nach dem Wechsel nicht mehr gelesen, nur die Wahl-Tabellen muessen
            // fuer reconstruct() erhalten bleiben. Vorher entstand pro
            // Rating-Stufe ein neues Float64Array - bei ~20 Stufen, 15.600
            // Zellen und ueber 100 buildDp-Aufrufen pro Runde sind das
            // hunderte MB Allokation. Identische Zahlen, nur ohne den Muell.
            let cur = new Float64Array(size).fill(Infinity);
            let spare = new Float64Array(size);
            cur[idx(0, 0, 0)] = 0;
            const stageChoices = [];
            for (const r of ratings) {
                const list = groups.get(r);
                const c = Math.min(list.length, kMax);
                // kumulierte Kosten in Konsum-Reihenfolge
                const qCost = [0];
                for (let q = 1; q <= c; q++) qCost.push(qCost[q - 1] + costOf(list[q - 1]));
                const isExp = !!(exp && r >= exp.th);
                const next = spare.fill(Infinity);
                const choice = new Uint8Array(size);
                for (let j = 0; j <= kMax; j++) {
                    // NUR ERREICHBARE SUMMEN (v4.90.0). j Karten haben immer
                    // eine Summe zwischen j*kleinstes und j*groesstes Rating -
                    // alles ausserhalb ist unerreichbar und stand vorher
                    // trotzdem in der Schleife. Bei Ratings 75-98 und 11 Slots
                    // sind das rund 1300 statt 11.000 Zustaende. Exakt: die
                    // uebersprungenen Zellen bleiben Infinity, genau wie vorher,
                    // und geschrieben wird ohnehin nur innerhalb dieser Grenzen
                    // (s+q*r liegt fuer j+q Karten wieder im Band).
                    const sLo = j * rMinDp;
                    const sHi = Math.min(S - 1, j * rMaxDp);
                    if (sLo > sHi) continue;
                    for (let e = 0; e < E; e++) {
                        for (let s = sLo; s <= sHi; s++) {
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
                spare = cur;      // der alte cur wird der naechste Puffer
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
         * Ist die SBC so nicht lösbar, wird die Sperre aufgehoben und gewarnt.
         */
        // Profile der letzten Solver-Laeufe. Der Block bleibt rein: die UI holt
        // sie ueber SolverCore.lastProfiles() ab und legt sie in die Diagnose.
        const solverProfiles = [];
        function lastProfiles() { return solverProfiles.slice(-6); }
        function stampProfile() {
            const p = solverProfiles[solverProfiles.length - 1];
            if (p && !p.ms) p.ms = Date.now() - p.t0;
        }
        function solve(poolAll, cfg) {
            // Max. Rating pro Spieler (Ticket #66): HARTER Pool-Vorfilter, VOR
            // jeder Reservierung/Suche - eine Karte über der Grenze wird nie
            // verwendet, auch nicht fuer Vorgaben. Anders als die Rarity-Sperre
            // oben lockert sich dieser Filter NIE selbst; Unloesbarkeit wird
            // unten explizit gemeldet (LEARNINGS §44).
            const rawPool = poolAll;
            poolAll = applyMaxRatingFilter(poolAll, cfg);
            // Die MANUELL gewaehlte Rarity-Karte ueberlebt den Max-Rating-
            // Vorfilter (Nacht-Review 16.08.): die explizite Wahl schlaegt
            // Filter - dieselbe Semantik wie der "trotzdem verwendet"-Pfad in
            // solveCore. Vorher fraß der Vorfilter den Pick still, die
            // Automatik reservierte eine ANDERE Karte und die Meldung
            // behauptete falsch "nicht im Pool gefunden". Gesperrte Karten
            // bleiben tabu: filterLockedCards() laeuft in solveCore NACH
            // diesem Re-Add.
            if (cfg.rarityPickId != null && cfg.rarityPickId !== '' &&
                !poolAll.some(p => String(p.id) === String(cfg.rarityPickId))) {
                const pickRaw = rawPool.find(p => String(p.id) === String(cfg.rarityPickId));
                if (pickRaw) poolAll = poolAll.concat([pickRaw]);
            }
            const strict = solveCore(poolAll, cfg, true);
            stampProfile();
            if (strict && strict.ok) return strict;
            const loose = solveCore(poolAll, cfg, false);
            stampProfile();
            if (loose && loose.ok) {
                loose.warnings = (loose.warnings || []).concat(
                    'Ohne zusätzliche geschützte Karten (' +
                    (cfg.rarityMode === 'gruppe83' ? 'TOTW/TOTS/FOF/FUTTIES'
                                                   : 'TOTW aus dem Verein') +
                    ') ist die SBC mit diesem Pool nicht lösbar - Schutz gelockert.');
                return loose;
            }
            // Beide gescheitert: die Meldung des LOCKEREN Versuchs ist die
            // aussagekräftigere (die Sperre war dort nicht die Ursache).
            const result = loose || strict;
            if (result && !result.ok && cfg.maxRatingEnabled && cfg.maxRating) {
                // Live-Fall 16.08.: "Rarity-Vorgabe nicht erfüllbar" bei 43
                // TOTW im Pool - ALLE lagen über dem aktiven Max-Rating.
                // Ein Filter, der still die Vorgabe-Kandidaten frisst, macht
                // die Meldung irreführend - deshalb steht die Ursache jetzt
                // IN der Meldung, nicht nur als Warnung darunter.
                try {
                    const parts = [];
                    const rcs = (cfg.applyRarity === false) ? [] : (cfg.rarityConstraints || []);
                    for (const rc of rcs) {
                        const pre = rawPool.filter(function (p) { return matchesRarity(p, rc); }).length;
                        const post = poolAll.filter(function (p) { return matchesRarity(p, rc); }).length;
                        if (pre > 0 && post === 0) {
                            parts.push('alle ' + pre + ' Kandidaten für "' + (rc.label || 'Rarity') +
                                '" liegen über Max-Rating ' + cfg.maxRating);
                        }
                    }
                    if (parts.length) {
                        result.reason = (result.reason || 'Nicht lösbar.') +
                            ' Ursache: ' + parts.join('; ') + ' - Max-Rating-Filter lockern oder ausschalten.';
                    }
                } catch (e) {}
                result.warnings = (result.warnings || []).concat(
                    'Mit Max-Rating ' + cfg.maxRating + ' nicht lösbar - Filter lockern?');
            }
            return result;
        }
        function solveCore(poolAll, cfg, limitProtected) {
            // SELBSTMESSUNG. Rasmus: "warum sind es so viel mehr ratings? ...
            // irgendwas muss auch noch anders sein." Er hat recht: ein
            // nachgebauter Pool vergleichbarer Groesse braucht 222ms, der echte
            // 3100ms. Statt weiter zu modellieren zaehlt der Solver selbst -
            // Rating-Stufen, Baender, Versuche, Summen-Schranken - und legt das
            // Profil in die Diagnose. Kostet nichts Messbares (ein paar Zaehler
            // pro Band) und beantwortet die Frage beim naechsten Report.
            const prof = { ms: 0, poolIn: (poolAll || []).length, poolFill: 0,
                           ratingsFill: 0, trials: 0, bands: 0, buildDp: 0,
                           ratingsLow: 0, ratingsHigh: 0, sMaxLow: 0, sMaxHigh: 0,
                           strict: !!limitProtected };
            prof.t0 = Date.now();
            solverProfiles.push(prof);
            while (solverProfiles.length > 6) solverProfiles.shift();
            // Warnungen: KEINE Dubletten. Vorher stand die gelockerte
            // Rare-Grenze sechsmal untereinander im Panel (einmal pro Slot) -
            // die eine wichtige Meldung ging darin unter.
            const warnings = [];
            const rawPush = warnings.push.bind(warnings);
            warnings.push = function (w) {
                if (warnings.indexOf(w) === -1) rawPush(w);
                return warnings.length;
            };
            const N = cfg.slots || 11;
            const target = cfg.targetOVR;
            // ---- Pool filtern ----
            const minRating = cfg.minRating || 0;
            // Qualitäts-Vorgabe (Tausch-/Upgrade-SBCs): 1=Bronze(<=64),
            // 2=Silber(65-74), 3=Gold(>=75). Gilt als Band-Filter für das
            // ganze Team; bei mehreren Vorgaben zählt die höchste Qualität.
            let qLo = minRating, qHi = 99, qualityLabel = null, qualityLow = false;
            // qTiers ist nur bei GEMISCHTEN Vorgaben gesetzt (Live-Fall: "Daily
            // Common Gold Upgrade" mit Bronze Min. 5 + Silber Min. 5 auf 10
            // Slots). Vorher gewann hier Math.max, also Silber - und der GANZE
            // Pool wurde auf 65-74 gefiltert: 10x Silber, 0 Bronze, dazu ein
            // "ok". Ein still falsches Team ist schlimmer als ein Abbruch.
            let qTiers = null;
            const qcs = (cfg.applyRarity === false) ? [] : (cfg.qualityConstraints || []);
            const QBAND_ALL = { 1: [0, 64], 2: [65, 74], 3: [75, 99] };
            const QNAME_ALL = { 1: 'Bronze', 2: 'Silber', 3: 'Gold' };
            if (qcs.length > 1) {
                const tiers = [];
                for (const c of qcs) {
                    const q = Number(c.quality) || 1;
                    const seen = tiers.filter(t => t.q === q)[0];
                    if (seen) seen.count = Math.max(seen.count, Number(c.count) || 1);
                    else tiers.push({ q: q, count: Number(c.count) || 1 });
                }
                tiers.sort((a, b) => a.q - b.q);
                if (tiers.length > 1) {
                    for (const t of tiers) {
                        t.lo = QBAND_ALL[t.q][0];
                        t.hi = QBAND_ALL[t.q][1];
                        t.label = QNAME_ALL[t.q] || ('Stufe ' + t.q);
                    }
                    // EAs Count-Feld ist unzuverlaessig (LEARNINGS 6): der
                    // Live-Report zeigt count 1 bei je 5 geforderten Karten.
                    // Bei EINER Stufe hilft "gilt fuer alle Slots"; bei zwei
                    // Stufen geht das nicht. Loesung: die genannten Anzahlen
                    // sind das MINIMUM, die restlichen Slots werden gleichmaessig
                    // verteilt - der Rest geht an die NIEDRIGSTE Stufe, die ist
                    // billiger. Das trifft den Live-Fall (1/1 auf 10 Slots ->
                    // 5 Bronze + 5 Silber) und bei "Min. N"-Vorgaben ist
                    // Mehrliefern unschaedlich.
                    const stated = tiers.reduce((a, t) => a + t.count, 0);
                    if (stated < N) {
                        const base = Math.floor((N - stated) / tiers.length);
                        let rest = (N - stated) - base * tiers.length;
                        for (const t of tiers) {
                            t.count += base;
                            if (rest > 0) { t.count++; rest--; }
                        }
                        warnings.push('Gemischte Vorgabe: EA nennt nur ' + stated +
                            ' von ' + N + ' Spielern - Rest gleichmaessig verteilt (' +
                            tiers.map(t => t.count + 'x ' + t.label).join(' + ') +
                            '). Passt das nicht, bitte Diagnose schicken.');
                    }
                    qTiers = tiers;
                    qualityLabel = tiers.map(t => t.count + 'x ' + t.label).join(' + ');
                    qualityLow = tiers.some(t => t.q === 1 || t.q === 2);
                    qLo = Math.min.apply(null, tiers.map(t => t.lo));
                    qHi = Math.max.apply(null, tiers.map(t => t.hi));
                    if (qualityLow && minRating > qLo) {
                        warnings.push('Gemischte Vorgabe: Min-Rating (' + minRating +
                            ') wird ignoriert.');
                    }
                }
            }
            if (qcs.length && !qTiers) {
                const QBAND = QBAND_ALL;
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
            poolAll = filterLockedCards(poolAll, cfg, warnings);
            // Bei gemischten Vorgaben ist das erlaubte Fenster NICHT
            // durchgehend (Bronze 0-64 + Gold 75-99 laesst Silber aus), darum
            // ein Praedikat statt eines Bereichs.
            const inQBand = qTiers
                ? ((p) => qTiers.some(t => p.rating >= t.lo && p.rating <= t.hi))
                : ((p) => p.rating >= qLo && p.rating <= qHi);
            let pool = poolAll.filter(inQBand);
            if (cfg.specialOnlyFromStorage) {
                // TOTW-AUSNAHME (Produktregel, Live-Fall 16.08.): "Verein-
                // Specials NIE in SBCs - einzige Ausnahme: TOTW (rareflag 3)".
                // Genau diese Ausnahme fehlte hier: der Filter warf Verein-TOTW
                // mit raus, die Reservierung (reservationCandidates hat die
                // Ausnahme korrekt) bekam den schon leergefilterten Pool und
                // meldete "Rarity-Vorgabe nicht erfuellbar" trotz 43 TOTW.
                pool = pool.filter(p => !(p.isSpecial && !p.isStorage && !isTotw(p)));
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
            // Die Vorgaben-Reservierungen greifen bewusst auf poolAll zu (dort
            // sind auch Vereins-TOTW und Karten unter dem Min-Rating drin, die
            // fuer eine Vorgabe erlaubt sind). poolAll ist aber NICHT nach
            // assetId dedupliziert - eine Vorgabe-Karte und eine Auffuell-Karte
            // konnten so derselbe SPIELER sein, und EA lehnt das mit 460 ab.
            // Darum dieselbe Dedupe-Regel noch einmal auf poolAll.
            {
                const seenAsset = new Map();
                for (const p of poolAll) {
                    const key = (p.assetId != null && p.assetId !== 0) ? 'a' + p.assetId : 'i' + p.id;
                    const cur = seenAsset.get(key);
                    if (!cur || p.rating > cur.rating ||
                        (p.rating === cur.rating && Number(p.id) < Number(cur.id))) {
                        seenAsset.set(key, p);
                    }
                }
                // Die Karten, die im (bereits deduplizierten) Loesungs-Pool
                // stehen, haben Vorrang - sonst zeigen die beiden Pools auf
                // verschiedene Karten desselben Spielers.
                for (const p of pool) {
                    const key = (p.assetId != null && p.assetId !== 0) ? 'a' + p.assetId : 'i' + p.id;
                    seenAsset.set(key, p);
                }
                if (seenAsset.size < poolAll.length) poolAll = Array.from(seenAsset.values());
            }
            const used = new Set();
            const usedAssets = new Set();
            const reserved = [];
            const reserveCmp = makeConsumeCmp();
            // Jede Reservierung MUSS hierueber laufen: sie fuehrt used und
            // usedAssets zusammen nach. Zwei Karten desselben Spielers im Team
            // sind HTTP 460 (LEARNINGS 6). Anker und manueller Rarity-Pick
            // liefen frueher inline an reserve() vorbei (usedAssets blieb fuer
            // sie leer) - das war folgenlos, weil die SPIELER-EINDEUTIGKEIT
            // weiter oben pool/poolAll schon vorab pro assetId dedupliziert.
            // Seit hier BEIDE Pfade ueber reserve() laufen, haengt die
            // Kollisions-Sperre nicht mehr zusaetzlich von dieser upstream-
            // Dedupe ab, falls sie ein zukuenftiger Umbau je lockert.
            function reserve(p) {
                if (p.assetId != null && p.assetId !== 0 && usedAssets.has(String(p.assetId))) {
                    // Sollte durch die SPIELER-EINDEUTIGKEIT oben strukturell
                    // unerreichbar sein - falls doch, ist das hier die einzige
                    // Stelle, die es je sichtbar macht (vorher keine Log-Spur).
                    warnings.push('Interne Warnung: ' + (p.name || p.assetId) +
                        ' wurde durch Anker/Rarity-Pick ein zweites Mal reserviert (gleicher Spieler) - bitte Diagnose schicken.');
                }
                used.add(p.id);
                if (p.assetId != null && p.assetId !== 0) usedAssets.add(String(p.assetId));
                reserved.push(p);
            }
            function freeCard(p) {
                return !used.has(p.id) &&
                    !(p.assetId != null && p.assetId !== 0 && usedAssets.has(String(p.assetId)));
            }
            // ---- Kartenkosten (Band + persönliche Scarcity, Storage-Bonus) ----
            // VOR den Reservierungen definiert: auch Vorgabe-Karten werden
            // nach KOSTEN gewählt (87er TOTW mit Kosten 2 schlägt 85er mit 5).
            // makeCostOf() ist die modul-weite SSOT-Factory (nahe parseRatingCosts) -
            // solver-test.js ruft dieselbe Funktion statt sie nachzubilden.
            const costOf = makeCostOf(pool, cfg);
            if (prof) {
                prof.poolFill = pool.length;
                prof.ratingsFill = new Set(pool.map(function (p) { return p.rating; })).size;
            }
            const isProtectedRarity = costOf.isProtectedRarity;
            // ---- Anker ----
            if (cfg.anchorId != null && cfg.anchorId !== '') {
                const anchor = pool.find(p => String(p.id) === String(cfg.anchorId));
                if (anchor) reserve(anchor);
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
                    reserve(pick);
                    forcedPickId = pick.id;
                    warnings.push('Rarity-Vorgabe: ' + pick.name + ' (' + pick.rating + ') manuell gesetzt.');
                } else {
                    warnings.push('Gewählte Rarity-Karte nicht im Pool gefunden - Automatik greift.');
                }
            }
            // cmp/NEED/windowV werden hier (statt bei ihrer fachlichen Herkunft,
            // der Rarity-Vorgaben-Reservierung) berechnet, weil sowohl die
            // Spieler-Level- als auch die Rarity-Vorgaben-Reservierung
            // (reserveWindowAware()/searchTeam(), Ticket #60/#64, LEARNINGS 41)
            // sie brauchen, BEVOR ihre jeweilige Reservierungs-Schleife läuft -
            // Spieler-Level kommt im Code vor Rarity. Beide Ausdrücke sind
            // reine Funktionen von bereits bekannten Werten (N/target), eine
            // einzige Deklaration statt zweier synchron zu haltender Kopien
            // (SSOT).
            const cmp = makeConsumeCmp();
            const NEED = target ? (N * N * target - Math.floor(N / 2)) : null;
            // windowV: reine Funktion von cfg.maxOvershoot/N, SSOT mit
            // searchTeam()s frueherer lokaler Kopie - reserveWindowAware()
            // braucht denselben Wert, um ueber ALLE Trials hinweg (nicht pro
            // Trial einzeln) das global guenstigste Ergebnis IM Fenster zu waehlen.
            const windowV = target ? Math.max(0, Math.round(
                (cfg.maxOvershoot != null ? cfg.maxOvershoot : 0.10) * N * N)) : 0;
            // Wird reserveWindowAware() bei der Spieler-Level- oder der
            // Rarity-Vorgaben-Reservierung fuendig, haelt sie hier das ueber
            // ALLE Kandidaten-Kombinationen ermittelte globale Minimum fest
            // (Schritt 5 im jeweiligen Aufruf). Der FINALE Such-Aufruf am Ende
            // dieser Funktion nutzt es als vMinFloor: die endgueltige
            // Team-Zusammenstellung darf NICHT erneut ihr EIGENES (potenziell
            // breiteres) Fenster um die fest reservierten Vorgabe-Karten herum
            // entdecken - sonst waere die Reservierungs-Entscheidung fuer ein
            // Fenster getroffen worden, das die spaetere Auffuellung gar nicht
            // mehr einhaelt (live per Fuzzing gefunden, LEARNINGS 41). Laeuft
            // danach noch eine WEITERE window-aware Reservierung (z.B. Rarity
            // nach Spieler-Level), ueberschreibt deren eigenes, mit den dann
            // schon fest reservierten Karten neu ermitteltes Minimum diesen
            // Wert - das ist erwuenscht (praeziser, weil mit mehr Kontext
            // berechnet). Bleibt null, wenn keine window-aware Reservierung
            // stattfand - der finale Aufruf verhaelt sich dann exakt wie zuvor
            // (Selbst-Entdeckung).
            let reservationVMinFloor = null;
            // ---- searchTeam(): DP-Suche, parametrisiert statt Closure -------
            // Mathematisch UNVERAENDERT gegenueber der bisherigen runSearch()
            // (bandFor/scanSt/Phase 1+2/Auswahl sind byte-identisch uebernommen,
            // siehe LEARNINGS 41 fuer den Diff-Beleg) - nur reserved/avail kommen
            // jetzt als Parameter statt als Closure ueber die (erst nach der
            // gesamten Reservierung feststehenden) Aussen-Variablen, damit
            // reserveWindowAware() dieselbe Suche fuer probeweise reservierte
            // Kandidaten-Kombinationen aufrufen kann, BEVOR die eigentliche
            // Reservierung feststeht (Schritt 4 im Lift-Plan).
            // expDims: durchgereicht an buildDp()'s "exp"-Parameter (siehe
            // dessen Docblock) - seit v4.62.0 an allen vier Call-Sites null.
            function searchTeam(reservedArr, availArr, expDims, sharedBandCache, vMinFloor,
                                availSortedAsc, halfCtx) {
                const kLocal = N - reservedArr.length;
                // Beim echten (finalen) Aufruf ist das bereits vorher geprueft
                // (":avail.length < k" weiter oben); ein Trial-Aufruf aus
                // reserveWindowAware() hat diese Pruefung nicht - eine zu
                // knappe Kombination ist dort einfach "nicht loesbar", kein Fehler.
                if (availArr.length < kLocal) return null;
                const reservedSumLocal = reservedArr.reduce((s, p) => s + p.rating, 0);
                // availSortedAsc: der Aufrufer garantiert, dass availArr schon
                // aufsteigend nach Rating sortiert ist. Dann entfallen BEIDE
                // Sortierungen. Grund (Report v4.84.0): reserveWindowAware()
                // ruft searchTeam pro Kandidaten-Kombination auf - bei 8554
                // Karten und ~19 Kombinationen waren das 38 volle Sortierungen
                // pro Runde, 6,3s. Die Zahlen sind identisch, nur der Weg
                // dorthin ist O(n) statt O(n log n).
                const sortedAscLocal = availSortedAsc
                    ? availArr : availArr.slice().sort((a, b) => a.rating - b.rating);
                let kCheapestLocal = 0;
                for (let i = 0; i < kLocal; i++) kCheapestLocal += sortedAscLocal[i].rating;
                const stLowLocal = reservedSumLocal + kCheapestLocal;
                // Die N hoechsten Ratings. Ist avail sortiert, sind das die
                // LETZTEN N - kein Sortieren von 8554 Werten noetig.
                const topAvailRatings = availSortedAsc
                    ? availArr.slice(Math.max(0, availArr.length - N)).map(p => p.rating)
                    : availArr.map(p => p.rating);
                const allDescLocal = reservedArr.map(p => p.rating)
                    .concat(topAvailRatings)
                    .sort((a, b) => b - a)
                    .slice(0, N);
                // Niedrigstes Rating, das im Team ueberhaupt vorkommen kann -
                // aus Reservierten UND Verfuegbaren. Wird fuer die Schranke
                // unten gebraucht.
                let rMinTeam = sortedAscLocal.length ? sortedAscLocal[0].rating : 0;
                for (const p of reservedArr) if (p.rating < rMinTeam) rMinTeam = p.rating;
                function quickUBLocal(st) {
                    let best = N * st; // b = 0
                    let hs = 0;
                    for (let b = 1; b <= allDescLocal.length; b++) {
                        hs += allDescLocal[b - 1];
                        // NEU (v4.89.0): die b "hohen" Karten muessen in die
                        // Team-Summe st PASSEN. Ein Team mit Summe st hat N
                        // Karten; die uebrigen N-b tragen jeweils mindestens
                        // rMinTeam bei. Also gilt fuer jede gueltige Auswahl
                        //     Summe der hohen Karten <= st - (N-b)*rMinTeam.
                        // hs ist die GROESSTE Summe fuer b Karten; v waechst
                        // monoton in hs. Passt hs nicht, ist die geklemmte
                        // Summe der beste noch moegliche Wert - deshalb wird
                        // GEKLEMMT und weitergezaehlt. Frueher abbrechen waere
                        // falsch: groessere b haben MEHR Platz (roomForHigh
                        // waechst mit b) und koennen ein hoeheres v liefern.
                        // Das Ergebnis bleibt eine OBERE Schranke fuer das
                        // erreichbare V, wird aber deutlich enger und schneidet
                        // die niedrigen st-Werte weg, fuer die vorher pro
                        // Schritt zwei DPs gebaut wurden (gemessen: Basisfall
                        // 264ms -> 117ms, minRating 0: 3700ms -> 747ms).
                        const roomForHigh = st - Math.max(0, N - b) * rMinTeam;
                        const hsEff = Math.min(hs, roomForHigh);
                        if (hsEff < 0) continue;
                        const v = N * st + N * hsEff - b * st;
                        if (v > best) best = v;
                    }
                    return best;
                }
                // windowV ist bereits vor der plList/rcList-Schleife berechnet
                // (SSOT, siehe dort) - eine einzige Deklaration statt zweier
                // synchron zu haltender Kopien.
                const bandCache = sharedBandCache || new Map();
                function bandFor(st) {
                    const rBoost = Math.floor(st / N) + 1;
                    let band = bandCache.get(rBoost);
                    if (!band) {
                        if (prof) prof.bands++;
                        const lowP = availArr.filter(p => p.rating < rBoost);
                        const highP = availArr.filter(p => p.rating >= rBoost);
                        const sMaxLow = Math.min(kLocal * Math.max(0, rBoost - 1), 1300);
                        const sMaxHigh = Math.min(kLocal * 99, 1300);
                        // HALBIERTER CACHE (v4.86.0). Ein Versuch aus
                        // reserveWindowAware() entfernt genau EINE Karte aus dem
                        // Auffuell-Pool. Die liegt in genau EINER der beiden
                        // Haelften (unter rBoost / ab rBoost) - die andere ist
                        // ueber ALLE Versuche identisch und muss nur einmal
                        // gebaut werden. Keine Approximation: dieselben
                        // Karten-Listen, dieselben DPs, nur nicht mehrfach.
                        // Gemessen (Report v4.85.0): 240 Baender pro Runde,
                        // 6,4s - die Arbeit pro Versuch war schon vorher
                        // identisch, nur 19x wiederholt.
                        let dpLow = null, dpHigh = null;
                        let lowKey = null, highKey = null;
                        if (halfCtx) {
                            const removedIsLow = halfCtx.removedRating != null &&
                                                 halfCtx.removedRating < rBoost;
                            lowKey = rBoost + (removedIsLow ? ':' + halfCtx.removedId : ':-');
                            highKey = rBoost + (removedIsLow ? ':-' : ':' + halfCtx.removedId);
                            dpLow = halfCtx.lowCache.get(lowKey) || null;
                            dpHigh = halfCtx.highCache.get(highKey) || null;
                        }
                        if (!dpLow) {
                            if (prof) {
                                prof.buildDp++;
                                prof.ratingsLow = Math.max(prof.ratingsLow,
                                    new Set(lowP.map(function (p) { return p.rating; })).size);
                                prof.sMaxLow = Math.max(prof.sMaxLow, sMaxLow);
                            }
                            dpLow = buildDp(lowP, kLocal, sMaxLow, costOf, expDims, cmp);
                            if (halfCtx) halfCtx.lowCache.set(lowKey, dpLow);
                        }
                        if (!dpHigh) {
                            if (prof) {
                                prof.buildDp++;
                                prof.ratingsHigh = Math.max(prof.ratingsHigh,
                                    new Set(highP.map(function (p) { return p.rating; })).size);
                                prof.sMaxHigh = Math.max(prof.sMaxHigh, sMaxHigh);
                            }
                            dpHigh = buildDp(highP, kLocal, sMaxHigh, costOf, expDims, cmp);
                            if (halfCtx) halfCtx.highCache.set(highKey, dpHigh);
                        }
                        band = { rBoost: rBoost, dpLow: dpLow, dpHigh: dpHigh };
                        bandCache.set(rBoost, band);
                    }
                    return band;
                }
                function scanSt(st, vCap, cb) {
                    const band = bandFor(st);
                    const S_target = st - reservedSumLocal;
                    if (S_target < 0) return;
                    let bRes = 0, HRes = 0;
                    for (const p of reservedArr) {
                        if (p.rating >= band.rBoost) { bRes++; HRes += p.rating; }
                    }
                    const budget = expDims ? expDims.budget : 0;
                    for (let bA = 0; bA <= kLocal; bA++) {
                        const b = bRes + bA;
                        const base = N * st + N * HRes - b * st;
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
                                    const cL = band.dpLow.cost(kLocal - bA, eL, sLow);
                                    if (cL === Infinity) continue;
                                    cb(V, cH + cL, { st: st, bA: bA, HA: HA, eH: eH, eL: eL, sLow: sLow });
                                    if (!expDims) break;
                                }
                                if (!expDims) break;
                            }
                        }
                    }
                }
                const stHardCapLocal = stLowLocal + 900;
                // vMinFloor (Ticket #60, LEARNINGS 41): reserveWindowAware()
                // ruft searchTeam() in einem ZWEITEN Durchlauf mit einem von
                // AUSSEN vorgegebenen Fenster-Boden (dem ueber ALLE Kombinationen
                // ermittelten globalen Minimum) statt des selbst entdeckten
                // vBound auf - eine Kombination, deren EIGENES Minimum hoeher
                // liegt als das globale, darf sonst faelschlich ihr EIGENES (zu
                // weites) Fenster ausnutzen und eine Karten-Wahl ausserhalb des
                // tatsaechlich gueltigen, globalen Fensters zurueckliefern (live
                // per Fuzzing gefunden). Der normale (finale) Aufruf unten
                // uebergibt hier weiterhin nichts und verhaelt sich exakt wie
                // zuvor (Phase 1 unveraendert).
                let vMin;
                if (vMinFloor != null) {
                    vMin = vMinFloor;
                } else {
                    let vBound = -1;
                    for (let st = stLowLocal; st <= stHardCapLocal && vBound < 0; st++) {
                        if (quickUBLocal(st) < NEED) continue;
                        let found = -1;
                        scanSt(st, Infinity, function (V) {
                            if (found < 0 || V < found) found = V;
                        });
                        if (found >= 0) vBound = found;
                    }
                    if (vBound < 0) return null;
                    vMin = vBound;
                }
                const bestByV = new Map();
                for (let st = stLowLocal; st <= stHardCapLocal; st++) {
                    if (N * st > vMin + windowV) break;
                    if (quickUBLocal(st) < NEED) continue;
                    scanSt(st, vMin + windowV, function (V, cost, ref) {
                        if (V < NEED) return;
                        const cur = bestByV.get(V);
                        if (!cur || cost < cur.cost - 1e-12) {
                            bestByV.set(V, { cost: cost, ref: ref });
                        }
                        if (V < vMin) vMin = V;
                    });
                }
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
                const low = band.dpLow.reconstruct(kLocal - chosen.ref.bA, chosen.ref.eL, chosen.ref.sLow);
                return { team: reservedArr.concat(high, low), V: chosen.V, vMin: vMin };
            }
            // ---- reserveWindowAware() (Ticket #60/#64, LEARNINGS 41) ---------
            // Generalisierte fensterbewusste Vorgaben-Reservierung: fuer eine
            // Vorgabe MIT gesetztem target (die Aufrufer entscheiden das jeweils
            // selbst) ersetzt sie die reine Kosten-Sortierung durch eine
            // fensterbewusste Auswahl - probiert - bounded durch
            // RARITY_WINDOW_TRIAL_CAP - ALLE moeglichen (Rating -> Anzahl)-
            // Aufteilungen der `stillNeed` Vorgabe-Karten unter den vom Aufrufer
            // gelieferten Kandidaten (`cands`, das Kandidaten-Praedikat lebt
            // beim jeweiligen Aufrufer - Rarity und Spieler-Level filtern
            // unterschiedliche Pools/Bedingungen) tatsaechlich durch dieselbe
            // DP-Suche (searchTeam) und reserviert die Kombination mit dem
            // kleinsten erreichten V (Tiebreak Kosten - CLAUDE.mds
            // Regel-Hierarchie "Fenster > Kosten"). `describeCard(p)` liefert
            // den warnings-Text pro reservierter Karte (Aufrufer-spezifisches
            // Format). `canShareBandCache` (Aufrufer-berechnet, siehe dort)
            // erlaubt Trials denselben Band-Cache/Avail-Pool zu teilen, wenn
            // KEINER der Kandidaten je in "avail" auftauchen koennte. Reserviert
            // NICHTS (Rueckgabe 0), wenn die Kombinatorik den Cap reisst oder
            // keine Kombination ueberhaupt ein loesbares Team ergibt - der
            // bestehende Kosten-Greedy beim Aufrufer greift dann unveraendert
            // (additiver Fallback, kein zweiter Fehlerpfad).
            function reserveWindowAware(stillNeed, cands, describeCard, canShareBandCache) {
                if (stillNeed <= 0 || !cands.length) return 0;
                // Schritt 2 (Lift-Plan): pro Rating nur die (bis zu stillNeed)
                // guenstigsten Kandidaten behalten - verlustfrei, weil der
                // V-Beitrag einer Karte ausschliesslich von ihrem Rating abhaengt
                // (squadV) und costOf bei gleichem Rating eindeutig ordnet.
                const byRating = new Map();
                for (const p of cands) {
                    if (!byRating.has(p.rating)) byRating.set(p.rating, []);
                    byRating.get(p.rating).push(p);
                }
                const profiles = Array.from(byRating.keys()).sort((a, b) => a - b).map(function (r) {
                    const list = byRating.get(r).sort((a, b) => (costOf(a) - costOf(b)) || reserveCmp(a, b));
                    return { rating: r, cards: list.slice(0, Math.min(stillNeed, list.length)) };
                });
                // Schritt 3: Kombinatorik-Schranke. Zaehlt NUR, ob die Anzahl
                // moeglicher Aufteilungen den Cap ueberschreitet - bricht dafuer
                // frueh ab (kein Materialisieren von mehr als noetig fuer die
                // Cap-Entscheidung selbst).
                function countCombos(idx, remain, budget) {
                    if (remain === 0) return 1;
                    if (idx >= profiles.length) return 0;
                    let total = 0;
                    const maxTake = Math.min(remain, profiles[idx].cards.length);
                    for (let take = 0; take <= maxTake; take++) {
                        total += countCombos(idx + 1, remain - take, budget - total);
                        if (total > budget) return total;
                    }
                    return total;
                }
                const comboCount = countCombos(0, stillNeed, RARITY_WINDOW_TRIAL_CAP);
                if (prof) prof.trials += Math.min(comboCount, RARITY_WINDOW_TRIAL_CAP);
                if (comboCount === 0) return 0;
                if (comboCount > RARITY_WINDOW_TRIAL_CAP) {
                    warnings.push('Fensterbewusste Vorgaben-Wahl uebersprungen (zu viele Kandidaten) - Kosten-Reihenfolge verwendet.');
                    return 0;
                }
                // Geteilter Band-Cache ist nur sicher, wenn KEINER der Kandidaten
                // je in "avail" landen koennte - sonst haengt avail von der
                // konkreten Kombination ab (loser Durchlauf, limitProtected===false,
                // wo ungenutzte geschuetzte Karten als Fueller bleiben duerfen).
                // Der Aufrufer berechnet diese Bedingung (kennt seine eigenen
                // Kandidaten), reserveWindowAware() selbst bleibt neutral.
                const sharedBandCache = canShareBandCache ? new Map() : null;
                const sharedAvail = canShareBandCache
                    ? pool.filter(function (p) { return !used.has(p.id) && !isProtectedRarity(p); })
                    : null;
                // BASIS FUER DIE VERSUCHE, einmal gebaut: gefiltert wie im
                // Versuch, aber OHNE die Karten der jeweiligen Kombination -
                // die kommen pro Versuch per filter() heraus, was die
                // Sortierung erhaelt. Vorher entstand dieser Pool pro Versuch
                // neu und wurde in searchTeam zweimal sortiert (Report
                // v4.84.0: 6,3s pro Runde).
                const trialBaseAsc = (canShareBandCache ? sharedAvail
                    : pool.filter(function (p) {
                        return !used.has(p.id) && (!limitProtected || !isProtectedRarity(p));
                    })).slice().sort(function (a, b) { return a.rating - b.rating; });
                function trialAvailFor(comboCards) {
                    if (!comboCards.length) return trialBaseAsc;
                    const skip = new Set(comboCards.map(function (p) { return p.id; }));
                    return trialBaseAsc.filter(function (p) { return !skip.has(p.id); });
                }
                // Ueber BEIDE Durchlaeufe geteilt: dieselben (rBoost, Karte)-
                // Paare kommen in Pass 2 erneut vor, und die unberuehrte
                // DP-Haelfte gilt fuer alle Versuche.
                const halfCaches = { lowCache: new Map(), highCache: new Map(),
                                     removedId: null, removedRating: null };
                function halfCtxFor(comboCards) {
                    // Nur bei GENAU EINER entfernten Karte ist die Aufteilung
                    // eindeutig. Bei mehreren (stillNeed > 1) wird wie bisher
                    // pro Versuch gebaut - lieber langsam als falsch.
                    if (comboCards.length !== 1) return null;
                    halfCaches.removedId = comboCards[0].id;
                    halfCaches.removedRating = comboCards[0].rating;
                    return halfCaches;
                }
                // Schritt 5 (Lift-Plan): ERST alle Trials sammeln, DANN ueber
                // ALLE hinweg das kleinste erreichte V (globalVmin) bestimmen -
                // ein einzelner Trial darf NICHT vorschnell nur gegen den bis
                // dahin kleinsten V-Wert tiebreaken, sonst gewinnt ein Trial mit
                // minimal kleinerem V eine teurere Kombination, obwohl eine
                // andere Kombination NUR wenig hoeher liegt (noch im selben
                // Fenster) aber deutlich billiger ist - CLAUDE.mds Regel-Hierarchie
                // "Fenster > Kosten, Kosten entscheiden IM Fenster" gilt fuer die
                // Reservierungs-ENTSCHEIDUNG selbst, nicht nur fuer die Auffuellung.
                // Pass 1: pro Kombination NUR das rohe (nicht fenster-
                // optimierte) Minimum vMin ermitteln (searchTeam() ohne
                // vMinFloor - Phase 1 unveraendert). searchTeam() optimiert
                // sonst intern gegen das EIGENE Fenster [vMin, vMin+windowV]
                // dieser einen Kombination - das kann eine Wahl ausserhalb des
                // TATSAECHLICHEN, ueber ALLE Kombinationen gemeinsamen Fensters
                // liefern (live per Fuzzing gefunden), darum Pass 2 unten.
                function trialRawVMin(comboCards) {
                    for (const p of comboCards) reserve(p);
                    const trialAvail = trialAvailFor(comboCards);
                    const trialResult = searchTeam(reserved, trialAvail, null,
                        canShareBandCache ? sharedBandCache : null, undefined, true,
                        halfCtxFor(comboCards));
                    for (const p of comboCards) {
                        used.delete(p.id);
                        if (p.assetId != null && p.assetId !== 0) usedAssets.delete(String(p.assetId));
                        reserved.pop();
                    }
                    return trialResult ? trialResult.vMin : null;
                }
                const combos = [];
                (function generate(idx, remain, chosen) {
                    if (remain === 0) { combos.push(chosen.slice()); return; }
                    if (idx >= profiles.length) return;
                    const maxTake = Math.min(remain, profiles[idx].cards.length);
                    for (let take = 0; take <= maxTake; take++) {
                        for (let i = 0; i < take; i++) chosen.push(profiles[idx].cards[i]);
                        generate(idx + 1, remain - take, chosen);
                        chosen.length -= take;
                    }
                })(0, stillNeed, []);
                const rawVMins = combos.map(function (c) { return { combo: c, vMin: trialRawVMin(c) }; })
                    .filter(function (t) { return t.vMin != null; });
                if (!rawVMins.length) return 0;
                let globalVmin = Infinity;
                for (const t of rawVMins) if (t.vMin < globalVmin) globalVmin = t.vMin;
                // Pass 2: nur fuer Kombinationen, deren eigenes Minimum
                // ueberhaupt innerhalb des GLOBALEN Fensters liegen kann,
                // searchTeam() ERNEUT aufrufen - diesmal mit vMinFloor =
                // globalVmin, damit die kosten-optimale Wahl INNERHALB des
                // gemeinsamen (nicht des eigenen) Fensters ermittelt wird.
                let best = null;
                for (const t of rawVMins) {
                    if (t.vMin > globalVmin + windowV) continue;
                    for (const p of t.combo) reserve(p);
                    const trialAvail = trialAvailFor(t.combo);
                    const refined = searchTeam(reserved, trialAvail, null,
                        canShareBandCache ? sharedBandCache : null, globalVmin, true,
                        halfCtxFor(t.combo));
                    for (const p of t.combo) {
                        used.delete(p.id);
                        if (p.assetId != null && p.assetId !== 0) usedAssets.delete(String(p.assetId));
                        reserved.pop();
                    }
                    if (!refined) continue;
                    let cost = 0;
                    for (const p of refined.team) cost += costOf(p);
                    if (!best || cost < best.cost - 1e-9 ||
                        (Math.abs(cost - best.cost) <= 1e-9 && refined.V < best.V)) {
                        best = { V: refined.V, cost: cost, combo: t.combo };
                    }
                }
                if (!best) return 0;
                for (const p of best.combo) {
                    reserve(p);
                    warnings.push(describeCard(p));
                }
                // Der finale Such-Aufruf (Ende dieser Funktion) muss dasselbe
                // Fenster respektieren, das diese Wahl gerade erst begruendet
                // hat - sonst entdeckt er fuer die jetzt FEST reservierten
                // Karten sein EIGENES (potenziell breiteres) Fenster erneut.
                reservationVMinFloor = globalVmin;
                return best.combo.length;
            }
            // ---- Gemischte Qualitaets-Vorgaben (Bronze + Silber) ----------
            // Pro Stufe die guenstigsten Karten reservieren, in derselben
            // Rangfolge wie ueberall ohne Ziel-Rating: Storage vor Verein, dann
            // das niedrigste Rating, dann die Kosten (LEARNINGS 17).
            if (qTiers) {
                if (qTiers.reduce((a, t) => a + t.count, 0) > N) {
                    return { ok: false, reason: 'Gemischte Vorgabe verlangt mehr Spieler (' +
                        qTiers.map(t => t.count + 'x ' + t.label).join(' + ') +
                        ') als das Team Slots hat (' + N + '). Bitte Diagnose schicken.',
                        warnings: warnings };
                }
                for (const t of qTiers) {
                    let have = reserved.filter(p => p.rating >= t.lo && p.rating <= t.hi).length;
                    const picked = [];
                    while (have < t.count) {
                        const cand = pool
                            .filter(p => freeCard(p) && p.rating >= t.lo && p.rating <= t.hi)
                            .sort(makeFillCmp(costOf, reserveCmp))[0];
                        if (!cand) {
                            return { ok: false, reason: 'Qualitaets-Vorgabe "' + t.count + 'x ' +
                                t.label + '" nicht erfuellbar - nur ' + have +
                                ' passende Karte(n) im Pool.', warnings: warnings };
                        }
                        reserve(cand);
                        picked.push(cand.rating);
                        have++;
                    }
                    if (picked.length) {
                        warnings.push(picked.length + 'x ' + t.label + ' reserviert (' +
                            picked.sort((a, b) => a - b).join(', ') + ').');
                    }
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
            // Fensterbewusste Wahl NUR mit gesetztem target (dasselbe Muster
            // wie bei der Rarity-Vorgabe weiter unten) - ohne target bleibt der
            // heutige, dafuer bereits korrekte Kosten-Sortier-Weg unveraendert
            // (kein maxOvershoot-Fenster ohne Ziel-Rating).
            function reservePlayerLevelForConstraint(pl, stillNeed) {
                const cands = pool.filter(function (p) { return freeCard(p) && p.rating >= pl.minRating; });
                return reserveWindowAware(stillNeed, cands, function (p) {
                    return 'Vorgabe ' + pl.minRating + '+: ' + p.name + ' (' + p.rating + ') reserviert.';
                }, false);
            }
            for (const pl of plList) {
                const needCount = pl.count || 1;
                let have = reserved.filter(p => p.rating >= pl.minRating).length;
                if (target && have < needCount) {
                    have += reservePlayerLevelForConstraint(pl, needCount - have);
                }
                while (have < needCount) {
                    const cand = pool
                        .filter(p => freeCard(p) && p.rating >= pl.minRating)
                        .sort((a, b) => (costOf(a) - costOf(b)) || (a.rating - b.rating) || reserveCmp(a, b))[0];
                    if (!cand) {
                        return { ok: false, reason: 'Spieler-Vorgabe "min. ' + needCount + 'x ' + pl.minRating + '+" kann mit dem aktuellen Pool nicht erfüllt werden.', warnings: warnings };
                    }
                    reserve(cand);
                    warnings.push('Vorgabe ' + pl.minRating + '+: ' + cand.name + ' (' + cand.rating + ') reserviert.');
                    have++;
                }
            }
            // ---- Rarity-Vorgaben ----
            let rcList = (cfg.applyRarity === false) ? [] : (cfg.rarityConstraints || []);
            // OHNE Team-Rating gilt eine RARE-Vorgabe (Gruppe 4) fuer ALLE
            // Slots: live zeigte eine "Rare: Min. 6 Players"-SBC mit 6 Slots
            // count 1 - EAs Count-Feld ist im Objektbaum unzuverlaessig
            // (LEARNINGS 6). Bewusst NUR fuer Gruppe 4: bei Gruppe 83
            // (TOTW/TOTS/FOF/FUTTIES) will Rasmus genau die geforderte Anzahl,
            // eine Anhebung waere dort teuer falsch.
            if (!target) {
                let boosted = false;
                rcList = rcList.map(function (rc) {
                    if (Number(rc.groupId) === 4 && (rc.count || 1) < N) {
                        boosted = true;
                        return Object.assign({}, rc, { count: N });
                    }
                    return rc;
                });
                if (boosted) {
                    warnings.push('Ohne Team-Rating: Rare-Vorgabe auf alle ' + N + ' Slots angewendet.');
                }
            }
            // Die QUALITAETS-Vorgabe gilt fuer JEDEN Spieler im Team, also auch
            // fuer die Karten, die eine Rarity-Vorgabe erfuellen. Live
            // (v4.25.0) reservierte "Rare: Min. 6 + Exactly Gold" sechs BRONZE-
            // Rare, weil die Reservierung auf dem ungefilterten poolAll lief -
            // das Qualitaets-Fenster steckte nur im Auffuell-Pool.
            const qResLo = qualityLabel ? qLo : 0;
            const qResHi = qualityLabel ? qHi : 99;
            const inQualityBand = (p) => (qualityLabel ? inQBand(p)
                    : (p.rating >= qResLo && p.rating <= qResHi)) &&
                // Bronze/Silber: keine Specials, auch nicht als Vorgabe-Karte.
                !(qualityLow && p.isSpecial);
            // cmp/NEED/windowV/reservationVMinFloor/searchTeam()/
            // reserveWindowAware() sind bereits VOR der Spieler-Level-Schleife
            // deklariert (SSOT, siehe dort) - beide Vorgaben-Arten teilen sich
            // dieselbe fensterbewusste Reservierungs-Maschinerie.
            function reserveRarityForConstraint(rc, stillNeed) {
                const cands = reservationCandidates(poolAll, rc, cfg,
                    { freeCard: freeCard, inQualityBand: inQualityBand, lo: minRating, hi: 99 });
                // Geteilter Band-Cache ist nur sicher, wenn KEINER der Kandidaten
                // je in "avail" landen koennte (siehe reserveWindowAware()) -
                // bei einer Rarity-Vorgabe trifft das zu, wenn ALLE Kandidaten
                // selbst geschuetzte Rarity sind (dann schliesst `limitProtected`
                // sie ohnehin komplett aus avail aus, unabhaengig vom Trial).
                const canShareBandCache = limitProtected && cands.every(isProtectedRarity);
                return reserveWindowAware(stillNeed, cands, function (p) {
                    return 'Vorgabe ' + (rc.label || 'Rarity') + ': ' + p.name + ' (' + p.rating +
                        (p.isSpecial ? ', Special' : '') + ') reserviert.';
                }, canShareBandCache);
            }
            for (const rc of rcList) {
                const needCount = rc.count || 1;
                let have = reserved.filter(p => matchesRarity(p, rc) ||
                    (forcedPickId != null && p.id === forcedPickId)).length;
                // Fensterbewusste Wahl NUR mit gesetztem target (Schritt 1,
                // Lift-Plan) - der !target-Zweig direkt darunter bleibt beim
                // heutigen, dafuer bereits korrekten makeFillCmp-Weg (LEARNINGS
                // 15/17: dort gilt "niedrigstes Rating zuerst", kein
                // maxOvershoot-Fenster). Erfolgreiche Reservierung hebt `have`
                // sofort auf `needCount` - die anschliessende while-Schleife
                // laeuft dann gar nicht mehr an (0 Iterationen bei Erfolg).
                if (target && have < needCount) {
                    have += reserveRarityForConstraint(rc, needCount - have);
                }
                while (have < needCount) {
                    // Quellen-Regel für Vorgaben (Rasmus):
                    //  - Storage: jede passende Karte (Special/TOTW) erlaubt
                    //  - Verein: NUR TOTW - andere Club-Specials kommen nie
                    //    in SBCs (wie Evolutions)
                    // Billigste passende Karte zuerst: 85er Club-TOTW schlägt
                    // 96er aus dem Storage.
                    // Bei einer RARE-Vorgabe (Gruppe 4) ohne Ziel-OVR gilt die
                    // Panel-Obergrenze und das NIEDRIGSTE Rating zuerst - hohe
                    // Rare bleibt fuer die Rating-SBCs (Rasmus).
                    const isRareGroup = Number(rc.groupId) === 4;
                    const rareCap = (!target && isRareGroup && cfg.maxRareRating > 0)
                        ? cfg.maxRareRating : 99;
                    const lowMin = (!target && isRareGroup) ? 0 : minRating;
                    let cands = reservationCandidates(poolAll, rc, cfg,
                        { freeCard: freeCard, inQualityBand: inQualityBand, lo: lowMin, hi: rareCap });
                    // Die Rating-Obergrenze ist eine PRAEFERENZ (Panel) und darf
                    // fallen; das Qualitaets-Fenster ist eine SBC-Vorgabe und
                    // bleibt in jedem Fall stehen.
                    if (!cands.length && rareCap < 99) {
                        warnings.push('Keine Rare-Karte bis Rating ' + rareCap +
                            ' mehr frei - Grenze wird fuer diese SBC gelockert.');
                        cands = reservationCandidates(poolAll, rc, cfg,
                            { freeCard: freeCard, inQualityBand: inQualityBand, lo: lowMin, hi: 99 });
                    }
                    const cand = cands.sort((!target && isRareGroup)
                        ? makeFillCmp(costOf, reserveCmp)
                        : ((a, b) => (costOf(a) - costOf(b)) || (a.rating - b.rating) || reserveCmp(a, b))
                    )[0];
                    if (!cand) {
                        return { ok: false, reason: 'Rarity-Vorgabe "' + (rc.label || '?') + '" kann mit dem aktuellen Pool nicht erfüllt werden.', warnings: warnings };
                    }
                    reserve(cand);
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
            // cmp ist bereits vor der rcList-Schleife berechnet (siehe dort) -
            // eine einzige Deklaration statt zweier synchron zu haltender Kopien.
            // Pool-Transparenz: woraus wurde überhaupt gewählt?
            const poolInfo = (function () {
                if (!pool.length) return null;
                let lo = 99, hi = 0;
                for (const p of pool) { if (p.rating < lo) lo = p.rating; if (p.rating > hi) hi = p.rating; }
                return { count: pool.length, min: lo, max: hi };
            })();
            function finishTeam(team) {
                // ENDKONTROLLE. Live kam ein PUT heraus, in dem dieselbe Karte
                // auf zwei Slots stand und ein Slot leer blieb -> HTTP 460, und
                // der Grund war im Report nicht zu sehen. Ein kaputtes Team wird
                // ab jetzt NICHT eingetragen, sondern gemeldet - inklusive Dump,
                // damit die Ursache im naechsten Report sichtbar ist.
                const dump = team.map(p => ({
                    id: p && p.id, assetId: p && p.assetId, rating: p && p.rating,
                    storage: !!(p && p.isStorage), rareflag: p && p.rareflag
                }));
                const ids = new Set(), assets = new Set();
                let bad = null;
                for (const p of team) {
                    if (!p || !p.id) { bad = 'Karte ohne ID im Team'; break; }
                    if (ids.has(String(p.id))) { bad = 'Karte ' + p.id + ' doppelt im Team'; break; }
                    ids.add(String(p.id));
                    if (p.assetId != null && p.assetId !== 0) {
                        if (assets.has(String(p.assetId))) {
                            bad = 'Spieler ' + (p.name || p.assetId) + ' doppelt im Team (assetId ' +
                                p.assetId + ') - EA lehnt das mit 460 ab';
                            break;
                        }
                        assets.add(String(p.assetId));
                    }
                }
                if (!bad && team.length !== N) {
                    bad = 'Team hat ' + team.length + ' statt ' + N + ' Spieler';
                }
                if (bad) {
                    return { ok: false, reason: 'Interner Fehler: ' + bad +
                        '. Nichts eingetragen - bitte Diagnose schicken.',
                        warnings: warnings, teamDump: dump, usedAssetsCount: usedAssets.size };
                }
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
                    teamDump: dump,
                    // Beobachtbarkeit fuer den reserve()-Funnel (Anker/Rarity-
                    // Pick/Vorgaben): Anzahl der ueber reserve() als distinkte
                    // Spieler (assetId) gezaehlten Karten - haette vorher (Anker
                    // und Rarity-Pick liefen inline an reserve() vorbei) keine
                    // verlaessliche Aussagekraft gehabt.
                    usedAssetsCount: usedAssets.size,
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
                // ---- GOLD-SBCs: Rare nur in der geforderten Anzahl ----------
                // Rasmus: gibt es kein Ziel-OVR, verlangen Gold-SBCs oft "min. N
                // Rare". Dann sollen GENAU N rare sein und der Rest Common -
                // Rare-Karten werden für die Rating-SBCs gebraucht. Ohne
                // Rare-Vorgabe darf gar keine Rare rein.
                // Zusätzlich zwei Obergrenzen (Panel): bis wohin darf eine Rare
                // bzw. eine Common verbraucht werden. Beispiel: Storage voll mit
                // 75-89 Rare, aber nur bis 77 hergeben - 78+ bleibt für die
                // Rating-SBCs.
                let fillPool = avail;
                if (qualityLabel === 'Gold' && !qTiers) {
                    const maxRare = cfg.maxRareRating > 0 ? cfg.maxRareRating : 99;
                    const maxCommon = cfg.maxCommonRating > 0 ? cfg.maxCommonRating : 99;
                    const needRare = ((cfg.applyRarity === false) ? [] : (cfg.rareConstraints || []))
                        .reduce((m, c) => Math.max(m, Number(c.count) || 0), 0)
                        - reserved.filter(p => p.isRare).length;
                    // Rare-Karten reservieren: niedrigste zuerst, Storage vor
                    // Verein (das steckt schon in costOf/cmp).
                    let gotRare = 0;
                    for (let need = needRare; need > 0; need--) {
                        const cand = avail
                            .filter(p => freeCard(p) && p.isRare && p.rating <= maxRare)
                            .sort(makeFillCmp(costOf, cmp))[0];
                        if (!cand) break;
                        reserve(cand);
                        gotRare++;
                    }
                    if (gotRare) {
                        warnings.push(gotRare + 'x Rare für die Vorgabe reserviert (bis Rating ' +
                            maxRare + ').');
                    }
                    if (gotRare < needRare) {
                        warnings.push('Nur ' + gotRare + ' von ' + needRare +
                            ' Rare-Karten bis Rating ' + maxRare + ' gefunden - Grenze anheben?');
                    }
                    // Auffüllen NUR mit Common (bis zur Common-Grenze). Reicht
                    // das nicht, wird gelockert statt aufzugeben.
                    const commons = avail.filter(p =>
                        freeCard(p) && p.isCommon && p.rating <= maxCommon);
                    const stillNeeded = N - reserved.length;
                    if (commons.length >= stillNeeded) fillPool = commons;
                    else {
                        warnings.push('Zu wenige Common-Karten bis Rating ' + maxCommon +
                            ' (' + commons.length + '/' + stillNeeded + ') - andere Karten werden mitbenutzt.');
                        fillPool = avail.filter(p => freeCard(p));
                    }
                }
                const k2 = N - reserved.length;
                // OHNE Ziel-Rating gilt AUSNAHMSLOS: niedrigstes Rating zuerst,
                // Kosten nur als Gleichstand-Entscheid (dort steckt Storage-
                // Vorrang und Untradeable-Rabatt drin).
                // Ueber die Kosten zu gehen waehlt sonst die HAEUFIGERE Karte:
                // 75/76/77 sind in der Kostentabelle alle Stufe "0-80: 0", also
                // entscheidet der Scarcity-Term alpha/anzahl - und von 77ern hat
                // Rasmus viele. Live (v4.25.0) kamen so sieben Vereins-77er in
                // eine SBC ohne Rating-Vorgabe, wo 75er gereicht haetten.
                // Derselbe Fehler wie bei Bronze (58 statt 48) - deshalb jetzt
                // fuer den ganzen !target-Zweig, nicht nur fuer Bronze/Silber.
                // Reihenfolge ohne Ziel-Rating (Rasmus, in dieser Rangfolge):
                //   1. Storage vor Verein - Storage ist Verbrauchsmaterial.
                //      "Wenn es 77er im Storage gibt, gehen die VOR 75ern aus
                //      dem Verein."
                //   2. dann das niedrigste Rating (ein 77er ist mehr wert als
                //      ein 75er, wo kein Rating gefordert ist).
                //   3. dann die Kosten (dort steckt der Untradeable-Rabatt).
                // Die Kosten duerfen NICHT vor dem Rating stehen: 75-77 liegen
                // alle in der Stufe "0-80: 0", also gewinnt sonst ueber
                // alpha/anzahl die HAEUFIGERE Karte.
                const fillers = fillPool.filter(freeCard).sort(makeFillCmp(costOf, cmp)).slice(0, k2);
                if (reserved.length + fillers.length < N) {
                    return { ok: false, reason: 'Zu wenige passende Karten für die Vorgabe (' + (reserved.length + fillers.length) + '/' + N + ').', warnings: warnings };
                }
                return finishTeam(reserved.concat(fillers));
            }
            // NEED ist bereits vor der rcList-Schleife berechnet (siehe dort) -
            // eine einzige Deklaration statt zweier synchron zu haltender
            // Kopien (SSOT). Für die Quick-Obergrenze: höchste Ratings
            // (reserviert + verfügbar) - separat von searchTeam()s eigener,
            // rein lokaler Kopie, weil die Suchfenster-Diagnose unten sie
            // AUSSERHALB von searchTeam() braucht, nachdem diese schon null
            // geliefert hat.
            const allDesc = reserved.map(p => p.rating)
                .concat(avail.map(p => p.rating))
                .sort((a, b) => b - a)
                .slice(0, N);
            let result = searchTeam(reserved, avail, null, null, reservationVMinFloor);
            // Verteidigungslinie (sollte laut Beweis in reserveWindowAware()
            // nie greifen, siehe LEARNINGS 41): war reservationVMinFloor gesetzt
            // und liefert die Suche DAMIT dennoch nichts, lieber ohne Floor
            // erneut suchen (mit Warnung) als eine loesbare SBC faelschlich
            // abzulehnen.
            if (!result && reservationVMinFloor != null) {
                result = searchTeam(reserved, avail, null, null, null);
                if (result) warnings.push('Internes Fenster der Vorgaben-Wahl passte nicht zur finalen Zusammenstellung - ohne Fenster-Vorgabe erneut gesucht. Bitte Diagnose schicken.');
            }
            if (!result) {
                // Unterscheidung "SBC mit diesem Pool tatsächlich unlösbar" von
                // "internes Suchfenster (stHardCap, s.o.) ausgeschöpft": squadV der
                // N bestmöglichen verfügbaren Ratings (ohne jede Kosten-/Exp-
                // Einschränkung) ist das absolute Optimum dieses Pools - erreicht
                // selbst das NEED nicht, ist der Pool unabhängig vom Suchfenster zu
                // schwach; erreicht es NEED trotzdem, hat nur das Fenster nicht
                // gereicht. Rein additiv (kein Einfluss auf reason/ok unten).
                if (squadV(allDesc) >= NEED) {
                    warnings.push('Internes Suchfenster ausgeschöpft, ohne eine Lösung zu finden - das rechnerische Optimum dieses Pools erreicht das Ziel aber. Bitte Diagnose schicken.');
                }
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
        /**
         * Batch-Planung in EINZELSCHRITTEN. Grund: 10 Runden in einem Rutsch
         * blockieren den Hauptthread (gemessen: 608ms pro Runde bei 8558
         * Karten), und der Browser meldet "Seite reagiert nicht". Der Aufrufer
         * kann zwischen den Runden an den Browser zurueckgeben.
         * planBatch() unten bleibt als Wrapper - der Solver-Block bleibt rein
         * und synchron, das Warten passiert ausserhalb.
         */
        function beginBatch(poolAll, cfg, count) {
            return {
                poolAll: poolAll,
                cfg: cfg,
                n: Math.max(1, Math.min(20, Math.floor(count) || 1)),
                rounds: [],
                usedIds: new Set(),
                stoppedReason: null,
                done: false,
                roundMs: []
            };
        }
        /** Eine Runde. Liefert das Team oder null (dann ist Schluss). */
        function batchRound(st) {
            if (st.done || st.rounds.length >= st.n) { st.done = true; return null; }
            const pool = st.poolAll.filter(p => !st.usedIds.has(String(p.id)));
            // Reicht der Pool ueberhaupt noch fuer ein Team? Dann gar nicht
            // erst rechnen - die Unmoeglichkeit zu BEWEISEN ist der teure Teil,
            // und bei 10 geplanten Teams aus einem knappen Pool passiert das
            // sonst mehrfach hintereinander.
            const slots = Math.max(1, st.cfg.slots || 11);
            if (pool.length < slots) {
                st.stoppedReason = 'Nicht mehr genug Karten im Pool (' + pool.length +
                    ' übrig, ' + slots + ' gebraucht).';
                st.done = true;
                return null;
            }
            const t0 = Date.now();
            const res = solve(pool, st.cfg);
            st.roundMs.push(Date.now() - t0);
            if (!res || !res.ok) {
                st.stoppedReason = (res && res.reason) || 'Kein Team mehr möglich.';
                st.done = true;
                return null;
            }
            for (const p of res.players) st.usedIds.add(String(p.id));
            st.rounds.push(res);
            return res;
        }
        function finishBatch(st) {
            return {
                rounds: st.rounds,
                planned: st.rounds.length,
                requested: st.n,
                stoppedReason: st.stoppedReason,
                roundMs: st.roundMs,
                // Alle verbauten IDs über alle Runden - zum Gegenprüfen, dass
                // keine Karte doppelt eingeplant wurde.
                usedIds: Array.from(st.usedIds)
            };
        }
        // Der alte Weg, unveraendert im Verhalten: alles in einem Rutsch.
        // Bleibt fuer die Tests und als einfacher Aufruf ohne UI.
        function planBatch(poolAll, cfg, count) {
            const st = beginBatch(poolAll, cfg, count);
            while (batchRound(st)) { /* bis null */ }
            return finishBatch(st);
        }
        /**
         * Panel-Anzeige "N verfügbar" neben dem Pool (Ticket #68): pro
         * erkannter Rarity-Vorgabe, wie viele Karten sie JETZT erfüllen
         * könnten - über dieselbe Eligibility wie die echte Reservierung
         * (reservationCandidates(), KEINE Zweitlogik). Max-Rating-Filter und
         * Locks laufen als derselbe Vorfilter wie am solve()-Eingang
         * (applyMaxRatingFilter/filterLockedCards), damit die Anzeige nie
         * Karten mitzählt, die eine echte Reservierung gar nicht sehen würde.
         * Reine Funktion (kein STATE-Zugriff) - direkt per SolverCore
         * testbar, ohne den Panel-DOM zu stubben.
         */
        function computeRarityAvailability(poolAll, cfg, rarityConstraints) {
            let pool = applyMaxRatingFilter(poolAll, cfg);
            pool = filterLockedCards(pool, cfg);
            function tally(cands) {
                return {
                    available: cands.length,
                    totwClub: cands.filter(function (p) { return isTotw(p) && !p.isStorage; }).length,
                    totwStorage: cands.filter(function (p) { return isTotw(p) && p.isStorage; }).length,
                    specialsStorage: cands.filter(function (p) {
                        return p.isSpecial && p.isStorage && !isTotw(p);
                    }).length
                };
            }
            const perConstraint = (rarityConstraints || []).map(function (rc) {
                const t = tally(reservationCandidates(pool, rc, cfg));
                t.constraint = rc;
                t.needed = rc.count || 1;
                return t;
            });
            // Gruppe-83-Dauerzeile (TOTW/TOTS/FOF/FUTTIES), unabhaengig von
            // einer aktiven Vorgabe - Rasmus' Ausgangsfrage ("wie viele TOTW +
            // Storage-Specials habe ich noch"). {groupId:83} ist dieselbe
            // Vorgabe-Form wie eine von EA erkannte Gruppe-83-Vorgabe -
            // reservationCandidates() braucht keine Sonderbehandlung dafuer.
            const g83 = tally(reservationCandidates(pool, { groupId: 83 }, cfg));
            return {
                perConstraint: perConstraint,
                totw: g83.totwClub + g83.totwStorage,
                specialsStorage: g83.specialsStorage
            };
        }
        return {
            solve: solve,
            planBatch: planBatch,
            lastProfiles: lastProfiles,
            beginBatch: beginBatch,
            batchRound: batchRound,
            finishBatch: finishBatch,
            squadRating: squadRating,
            squadRatingExact: squadRatingExact,
            squadV: squadV,
            parseRatingCosts: parseRatingCosts,
            DEFAULT_RATING_COST_SPEC: DEFAULT_RATING_COST_SPEC,
            makeCostOf: makeCostOf,
            reservationCandidates: reservationCandidates,
            computeRarityAvailability: computeRarityAvailability
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
        // Bewusst NICHT aus SBS_SBC_PREFIX_RE_SRC abgeleitet: dort steckt eine
        // Alternation zum MATCHEN einer URL, hier nur ein Default-STRING fuer
        // den Fall, dass noch kein Praefix beobachtet wurde - andere Semantik,
        // kein Regex-Duplikat (dasselbe gilt fuer verifySquadCount unten).
        const pfx = STATE.sbc.apiPrefix || 'sbs';
        try {
            await apiPut(pfx + '/challenge/' + STATE.sbc.challengeId + '/squad', { players: players });
        } catch (e) {
            // Kam der Verein aus dem Cache, ist eine abgelehnte Karte der Fall,
            // den die drei Sperren NICHT abdecken koennen: eine billige Karte
            // verkauft und eine billige gekauft laesst Gesamtzahl und erste
            // Seite unberuehrt. Dann ist der Cache das Erste, was verdaechtig
            // ist - weg damit, der naechste Start laedt ehrlich voll.
            if (poolCacheState) dropPoolCache('Eintragen abgelehnt: ' + (e && e.message || e));
            throw e;
        }
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
        // Live-Controller der offenen SBC-Ansicht suchen. Bewusst NICHT
        // findSbcController(): dies ist Submit-Weg 0 (LEARNINGS §5, CLAUDE.md
        // "Nicht anfassen ohne Grund", der einzige Weg ohne F5) - die Duplikation
        // der "letzter Treffer gewinnt"-Traversal ist hier gewollt, ein Umbau auf
        // den Helfer wuerde das Regressionsrisiko am kritischsten Pfad erhoehen,
        // ohne einen Fehler zu beheben (siehe
        // patterns/bad/helfer-existiert-wird-umgangen.md, Abschnitt "Pattern").
        let ctrl = null;
        for (const c of getControllerChain()) {
            const n = (c.constructor && c.constructor.name) || '';
            if (/sbc/i.test(n) && (c._squad || (c.getSquad && c.getSquad()))) { ctrl = c; }
        }
        if (!ctrl) throw new Error('Kein offener SBC-Squad-Controller gefunden (Challenge im Spiel öffnen).');
        const liveSquad = ctrl._squad || (ctrl.getSquad && ctrl.getSquad());
        if (!liveSquad || typeof liveSquad.setPlayers !== 'function')
            throw new Error('Live-Squad hat kein setPlayers().');
        // Die Challenge, an der die Ansicht hängt (PaleTools: _leftController._challenge).
        // Bewusst NICHT findLiveChallenge(): dieselbe Weg-0-Ausnahme wie oben -
        // Submit-Weg 0 bleibt unangetastet, siehe LEARNINGS §5.
        let challenge = null;
        for (const key of ['_overviewController', 'leftController', '_leftController']) {
            const oc = ctrl[key];
            if (oc && oc._challenge) { challenge = oc._challenge; break; }
        }
        challenge = challenge || ctrl._challenge || STATE.sbc.entity;
        if (!challenge) throw new Error('Keine Live-Challenge gefunden.');
        // WELCHE Challenge schreibt dieser Weg eigentlich? Die App-Entity kann
        // eine ANDERE (aeltere) sein als STATE.sbc.challengeId - ein 404 hier
        // bei gleichzeitig "IN_PROGRESS" in der Set-Liste waere damit erklaert.
        // Ohne diese Zahl war jede Deutung geraten.
        let usedId = null;
        try { usedId = challenge.id != null ? challenge.id : challenge.challengeId; } catch (e) {}
        STATE.diag.submitIds = Object.assign({}, STATE.diag.submitIds, {
            app: usedId == null ? null : String(usedId),
            state: STATE.sbc.challengeId == null ? null : String(STATE.sbc.challengeId),
            same: (usedId != null && String(usedId) === String(STATE.sbc.challengeId))
        });
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
    /**
     * Meldung nach 404/475, wenn KEINE frische Instanz eindeutig gefunden wurde.
     * candidateCount unterscheidet zwei Live-Faelle (v4.61.0-Report "84+ TOTW
     * Upgrade", Runde 9/10): 0 Kandidaten heisst EA bietet die SBC ueberhaupt
     * nicht mehr an (Limit erreicht oder Mitternachts-Ablauf) - "schliessen und
     * neu oeffnen" wuerde dort nichts bringen. null (Abruf der frischen Liste
     * ist fehlgeschlagen, Zaehler unbekannt) faellt konservativ auf denselben
     * Rat wie >=1 Kandidaten zurueck.
     */
    function staleInstanceMessage(msg, candidateCount, batchProgress, nodeState, quotaNote,
                                 throttleTxt, lookupFailed) {
        // ZUERST der Zustand UNSERER Instanz. Live (v4.72.0-Report, setId 1356)
        // war candidateCount 0 - aber nicht, weil EA die SBC nicht mehr anbot,
        // sondern weil die EINE Challenge im Set genau unsere war und noch
        // laeuft:  nodeState = {status: "IN_PROGRESS", repeatable: true,
        // timesCompleted: 609}. Die Meldung "Limit erreicht oder abgelaufen"
        // war damit schlicht falsch. Ein 404/475 auf eine Challenge, die EA
        // noch als offen fuehrt, hat eine ANDERE Ursache.
        const ns = nodeState || null;
        // Der Hinweis (Drosselung/Kontingent) gehoert in JEDE Meldung - bis
        // v4.90.0 stand er nur im ersten Zweig, und genau der griff live nicht.
        const q = (throttleTxt || quotaNote || '');
        // ABFRAGE gescheitert ist etwas anderes als NICHTS GEFUNDEN. Live
        // (Report v4.89.0): GET .../challenges -> HTTP 429, weil das Tageslimit
        // ueberschritten war. Die alte Meldung behauptete, die Instanz sei
        // veraltet - dabei konnten wir gar nicht nachsehen.
        if (lookupFailed) {
            return 'Das Eintragen wurde abgelehnt (' + msg + '), und die Abfrage der ' +
                'aktuellen SBC-Instanz hat EA ebenfalls abgewiesen (' + lookupFailed +
                '). Es ist also NICHT gesagt, dass die Instanz verbraucht ist - wir ' +
                'konnten es nur nicht pruefen.' + q +
                (batchProgress
                    ? ' — ' + batchProgress.done + ' von ' + batchProgress.total + ' geschafft.'
                    : '');
        }
        const stillOpen = ns && ns.status != null &&
            !/COMPLETE|CLOSED|EXPIRED/i.test(String(ns.status));
        if (stillOpen) {
            // KEIN Kontingent-Verdacht mehr (war v4.73.0 und ist widerlegt):
            // Rasmus konnte nach einem APP-NEUSTART sofort wieder abgeben. Ein
            // Softban durch EAs Limit sperrt mindestens eine Stunde, teils den
            // ganzen Tag - ein Neustart hebt ihn nicht auf. Es ist also
            // Zustand im Client, nicht das Kontingent.
            // Liegt eine Drosselung vor, ist SIE die Erklaerung - nicht der
            // Zustand der Challenge. Live: 9x "Failed to fetch" + 503 + 512,
            // danach 475.
            return 'EA kennt diese Challenge noch (Status ' + ns.status +
                (ns.repeatable ? ', wiederholbar' : '') + '), das Eintragen wurde aber mit ' +
                msg.replace(/^.*?((?:404|475)).*$/, '$1') + ' abgelehnt. Das ist NICHT ' +
                'die verbrauchte Instanz. Bitte die SBC im Spiel einmal schliessen und neu ' +
                'oeffnen; bleibt es dabei, Diagnose schicken (Feld staleRecover)' + q +
                (batchProgress
                    ? ' — ' + batchProgress.done + ' von ' + batchProgress.total + ' geschafft.'
                    : '.');
        }
        if (candidateCount === 0) {
            return 'Keine weitere Wiederholung verfügbar (Limit erreicht oder abgelaufen)' + q +
                (batchProgress
                    ? ' — ' + batchProgress.done + ' von ' + batchProgress.total + ' geschafft.'
                    : '.');
        }
        return 'Die SBC-Instanz ist veraltet (Status aus ' + msg + ') und ' +
            'liess sich nicht eindeutig ersetzen. Wiederholbare SBCs bekommen pro ' +
            'Durchlauf eine neue ID - bitte die SBC im Spiel einmal schliessen und ' +
            'neu öffnen, dann erneut optimieren.' + q;
    }
    // Server-Messung fuer das SBC-Kontingent - absichtlich nur an DREI Stellen:
    // "Spieler laden" (Knopf), der automatische Pool-Ladevorgang beim App-Start
    // und EINMAL am Batch-Ende. NIE pro Batch-Runde: das war der Rate-Limit-
    // Ausfall (LEARNINGS 7). Die eigenen Abgaben brauchen ohnehin keinen extra
    // Request - sie werden im Batch-Takt schon gelesen und dort abgelegt.
    async function quotaMeasureQuiet() {
        try { await quotaMeasure(); } catch (e) {}
        try {
            if (ui.quota) {
                const qt = quotaText(quotaUsage());
                ui.quota.textContent = qt || 'noch keine Messung';
            }
        } catch (e) {}
    }
    async function submitToSbc(result, _retried, batchProgress) {
        if (!result || !result.players || result.players.length === 0)
            throw new Error('Kein Ergebnis zum Eintragen.');
        const need = result.players.length;
        let lastErr = null;
        // KEIN Vor-Laden der Challenge mehr (war v4.76.0 bis v4.87.0).
        // Es war eine Vermutung: in funktionierenden Laeufen stand ein
        // GET /sbs/challenge/{id} im Log, im gescheiterten nicht. Seither ist
        // dieser GET in JEDEM Report mit "Failed to fetch" gescheitert - er hat
        // also nie getan, was er sollte, kostete aber pro Batch-Runde einen
        // Request und lieferte ein Drossel-Signal, das den Batch abgebrochen
        // hat. Die Abgaben gehen auch ohne ihn durch (Zaehler 844->845->846 im
        // Report v4.87.0). Damit ist die Vermutung widerlegt.
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
            // ERHOLUNG statt Handarbeit: die verbrauchte Instanz gegen die
            // frische desselben Sets tauschen und EINMAL neu versuchen. Der
            // Tausch passiert nur, wenn GENAU EINE Challenge zur geplanten
            // Signatur (Ziel-OVR + Slots) passt - sonst landet das Team in einer
            // fremden SBC, und das wäre schlimmer als ein Abbruch.
            if (!_retried) {
                const fresh = await resolveFreshChallengeId();
                if (fresh != null) {
                    log('SBC-Instanz war veraltet - weiter mit frischer ID ' + fresh + '.');
                    setCurrentChallenge(fresh);
                    applyFromSetChallenges();
                    return await submitToSbc(result, true, batchProgress);
                }
                // Keine andere Instanz, aber unsere laeuft laut EA noch
                // (status IN_PROGRESS)? Dann ist es genau der Fall, den ein
                // APP-NEUSTART behebt - und der Neustart erneuert vor allem die
                // Session. Also einmal die Session erneuern und nachlegen,
                // statt Rasmus die App neu starten zu lassen.
                const sr0 = (STATE.diag.staleRecover &&
                             STATE.diag.staleRecover.setId === STATE.sbc.setId)
                    ? STATE.diag.staleRecover : null;
                const ns0 = sr0 ? sr0.nodeState : null;
                if (ns0 && ns0.status != null &&
                    !/COMPLETE|CLOSED|EXPIRED/i.test(String(ns0.status))) {
                    log('Instanz laeuft laut EA noch (' + ns0.status +
                        ') - Session erneuern und einmal nachlegen.');
                    STATE.diag.staleSessionRetry = (STATE.diag.staleSessionRetry || 0) + 1;
                    await nudgeSession();
                    await refreshChallengeCache();
                    return await submitToSbc(result, true, batchProgress);
                }
            }
            // setId-Abgleich, weil resolveFreshChallengeId() bei setId==null
            // oder fehlgeschlagenem Abruf FRUEH zurueckkehrt, OHNE staleRecover
            // zu schreiben - sonst wuerde hier ein veralteter Stand einer
            // frueheren, andersartigen SBC faelschlich als "0 Kandidaten" gelesen.
            const sr = (STATE.diag.staleRecover && STATE.diag.staleRecover.setId === STATE.sbc.setId)
                ? STATE.diag.staleRecover : null;
            const candidateCount = sr ? sr.candidateCount : null;
            throw new Error(staleInstanceMessage(msg, candidateCount, batchProgress,
                sr ? sr.nodeState : null, quotaHint(), throttleNote(),
                sr ? sr.lookupFailed : null));
        }
        // 403 heisst NICHT "veraltet", sondern "EA nimmt das so nicht an" -
        // meist eine Vorgabe, die der Solver nicht abdeckt (live: reqDump mit
        // scope PLAYER und CLUB MEMBER, also "dieser Spieler"/"Vereinsmitglied").
        if (/\b403\b/.test(msg)) {
            // Kein Rateschluss auf die reqDump-Scopes mehr (v4.34.0, war
            // falsch). Stattdessen EA selbst fragen: haelt die App den Squad
            // fuer abgabefaehig? Das ist dieselbe Pruefung, die der Batch vor
            // dem Abgeben benutzt.
            let eligible = null;
            try {
                const c = findSbcController();
                const sq = c && (c._squad || (c.getSquad && c.getSquad()));
                if (sq && typeof sq.isSBCSquadEligible === 'function') eligible = sq.isSBCSquadEligible();
            } catch (e) {}
            STATE.diag.lastEligible = eligible;
            throw new Error('EA hat das Eintragen abgelehnt (403).' +
                (eligible === false
                    ? ' Die App haelt den Squad nicht fuer abgabefaehig - im Spiel steht ' +
                      'noch eine Vorgabe rot, die der Solver nicht abdeckt (nur Rating und ' +
                      'Rarity werden erfuellt).'
                    : ' Meist ist die geoeffnete Instanz nicht mehr aktuell - SBC im Spiel ' +
                      'einmal schliessen und neu oeffnen, dann erneut optimieren.'));
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
    // [CTRL-BEGIN]
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
    // [CTRL-END]
    // CONTROLLER-SCAN: läuft die View-Controller-Kette der App entlang und
    // sammelt Klassennamen, squad-bezogene Methoden und SBC-Felder des
    // aktiven Controllers - die Landkarte für gezielte UI-Refreshes.
    function controllerScan() {
        const out = [];
        try {
            // Traversal ueber getControllerChain() statt eigenem Nachbau (Q4/Q5 -
            // SSOT, siehe patterns/bad/helfer-existiert-wird-umgangen.md). Bewusste
            // Angleichung: diese Funktion begrenzte vorher auf depth<12,
            // getControllerChain() auf depth<14 - jetzt einheitlich depth<14 (zwei
            // Ebenen mehr Toleranz, kein Verlust), abgesichert durch den
            // Tiefe-13-Testfall in solver-test.js.
            const chain = getControllerChain();
            if (!chain.length) return ['getAppMain fehlt'];
            for (const c of chain) out.push(((c.constructor && c.constructor.name) || '?'));
            const cur = chain[chain.length - 1];
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
            // Traversal ueber getControllerChain() statt eigenem Nachbau (Q4/Q5 -
            // SSOT, siehe patterns/bad/helfer-existiert-wird-umgangen.md) - war
            // hier bereits depth<14 wie der Helfer, keine Divergenz zu harmonisieren.
            const controllers = getControllerChain();
            if (!controllers.length) { STATE.diag.refreshLog = ['getAppMain fehlt']; return false; }
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
    const ICON_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAAsyUlEQVR4nN29145myZUu9sUKs91v01Rl+epqb0g23dBNDwkImtGFgINzABkImJvzAoLmCaQ7Xc0T6ELAPIIAaQQIEptNcsg59HbI9tVdJivdb7aJHWaFLnZWT7GnustldTfPAgrI+vPPvSO+FSuWjRUCfwY0feWF9DB/t3ztd+Kkx3LS9Jkb4MOCfb/0WWPKZ2Iw9wJ9+Q9//3DP/du/+9jffxaY8akN4KNAf1iw7/u9H8GUT4sZn/hL7wb8vUC/10r+KHqY537SjPjEXvYgwD8s4PeiB3nfJ8WIx/6SDwN/NxAeF+D3ovsZy+NmxGN7+GcZ+A/Tp8mIx/LQe4H/WQH+w3SvcT4OJpz4A+8E/88F+A/Tx437pJlwYg/7uFX/5wL8h+nj5nBSjDiRh3zUqv9zBf7D9FFzOgkm0KM+4BMEn/3e6gfg1J30c+/1hT8B/c45nkDY5JEY8NjA59SlyDUAIKVw/CmpafmEeq9+OzX9bwDcc/LJhV1wsh/5mkX74+TjAT5FJjy0CN0N/JNa9SnEhd9d/cKcm3/bXz96lapsLMfFi/Gw+QnleqJsPIwxijQvnhZGnUVKAfvtD7BVfhNCaAAJnFxctD9Ngb06Nf72h98R3jt8lTZHZ6kwV7ixv6dR/gLuc0Hebb4Pux09lAQ8TvABQCg55aavwq3la4Ih+Orqy3HV/Rora1Lnj+JW+Z00zc9V1+xZsVu/Km+2Pxq39O1U978GgNS6P9DV5b/ABQf+k8WduLa/FtdX30cCUWmeSjGuIanEA2Bxe64nIQkPzLXHDf5t4s69Ff64f0UQLAliZOptlmJNTfg67VTfxbz4/OQgHCabngohQGlyQspmtUU17XXXM4uvOWcRxuY1VJqQq81k/YG+2X9LlOr3fivzNMo/H/brH8hp8bzQcuNBx3gSkvBAEvBJgQ8AIsFVZYWszPccxas64MUZFV/3znG5xne2D8REBvGUNtIZLZ13QaXI8+qWn5VBftFkJiRBIR12r8Rrq5ewtLviWvOtcKb4kZ+qBVu/REpBiEHijl/LKcTF/Y7xJCTh/sXuEwQfANK6v9mfNj8x0JtFUbagtLRdy0QSLgTLMarVesmrxUp5HxQR0Xq9DrH3Y2O0Wa9rsq1VycirNMl+l1vxOcyy12he/gW66HHQnnbvHP6zKMw2BCQAjjdX38N9KOQ76VGZ8MA64HGDz8vux+nm+tWiF+dFYS61W+rX6MKX8iwvBElIEmjr2tzc3Q2T0YSEAPq+R+LIVZ4rozWv1w331qIsc4jKvI8+nFKgDZrkitf2F7IPm3peXRcpKUHCIKUQ3z38kchkJtSDb0V3Y8L90n0x4DZHTzpZwq17na1/Byn5dGP1Km7V31VLl+tl+Lbw/FRxvTey9Z6MPMpNZvI8Q0pAjAHBB3I+gEhCKgVjMirLEm3bwbseWZaBlLSwfgddfDKEyLTfXZE3myeUF0/zor8ijbIpxBVfXfyMezelefW1R53TBwv0PqXgngrjxLeelFzy8YCX3ZtYu2kW6Uku5G9kH5/OVT5PSIgxOEAojpEgBDJjEGNE7zwrJXF0eIQEgVFVwoeAsiwhJcH5gPVqjbIsYLRGb3uQEgRBrKWGiz2kkiwikWNPXMkfKocLmsWFCG5DTr9OkwzI9Dbl+hIE6H4w+jh87qWUP/aXJw4+p77/w813yadnODBMnrVGKZVlmXG9A0g4o5SKnAABKCK4EBicqHcOzIxRVSLGiP39Q0wmI4zGYywXS5CUMNqgbRtACAgAJAg6Nxy8p8RA4IjJeATmhMVqyZnJVPQBJIC8KoL3HsFHBSKLkfppyqTXZ6Z/CSHU/U7xQZnw0I7HQxEJoy9tQj27/Z56avPnEii9DwgxOh88d22rnHMI3iM4j67tICCodw7eBwghsF7XMFmGqqpgsgzW9uidA8eI3vUwxmBUVZBSQhAhOE/TyYSICBwi2taChKBRURBHdiQlx4n+YZulH0opO5XpQ1T0m5SSREp4EPDvxOh+t+uPZMBJl4ekEA95bX9NpXkGRDmFVOssg9aKUmRV5DmklAghIMsMIkeACFopJGbkRmM6HkEIgaZp0fseggir5RJaSkAQSAgslwscHhxgc3OTIAClJPI8R54bKKWglUSMkVMCEpgSJzJMO7zunww+jqus3ChFdkYwctHHyt9YvIqU/KPM/eOwvKcEnNjqj8ny1cUZbvrfYbd+Iz8Kr3jvQ987cs4jhAhJElmWQSpNkiSYGSEGMlkGpTXyoiApCYkZUkg4a7G1vYWtrU0alxlVVUXT2RwkCTFGDj5AKYWu6xAjQ0oCCaDrOiilEH0g5yz3y/YK+njO9j3v7++jPlqfk5ZfLlh9UR+6b8d3Dn+CBzBPH0QK7sqAx2D1MBSNpdG23HUvYNF/Y71aO9tZCj7AOYfOdsjLHCbLYbsWKSUoJdH3jjlGSEnUti2qqqIQI1JiEEkIInLes1QKTdtylmcoigpEoJQYIUSs1isOMYA5wTqPBMB7ByklEjNIiiBIBAGipNK+F36v6yyW9XLXG/yntLLf8LvL7+MBfYQ7MfwoKbg/M/QRVn/cW78Wrh7+wL+5d114vhBDsEZJLotCSSIUeYbxqMB0MoHvHVarFYzJUBY5CQikhEHBZhk6azmEyEpJKG0ACHR1wzFGNK3lrqkBThSih/ORpZSIMcDoDMwJQgxWR5ZlEAkoyxKzzU0Yk1EMTETgFHhCQgkIcPK8KbrwRR95HVed8XvrH+I+mXC/mP0bBpzU6mfr3nXv7L+apNC0NTotQTFuZt+FSFEqRSklTKYTSkKgaToslyssl2swM7quYx8jc0rQSkIAODpcsHceTdtCKQ0hMEiBlLCdBccIqRS0lqyUgiRBiQcp4ZSQUoIQAt57WNtDKAVmRrOusTg4hO87uN5CkjIphiKl6KjK/hAL+VNwrOKi/4qQQuMh4mcfJwX3lICHWf3c+/e7P97ozKXNb6pZ9QWx7q9TpfclgyJh1zuPtmt5uVhxvVqh6zqklFAUGYAE5xz63iHPMyilkACEGBBjRGIGM8NojRACus7ChwDrHCAkQmRobdB1lkejEfng0bUtvHNIALLMIHGEtRa268DMyMsSJitAUoFj5ORTJUA5Gv+FuLIvsaE35Gb5T3JavogHYMD9YPcnJtaJWD6c+rho3ypfuvjV5OM+XVuvggLJJCpZ+y8HjktvPWKIlCghL0pwYkgSUEoPllAMIEHo2iH5FWJECINCFUKg6zpoY0CSwJGRUkJKQGAPSUSMwNY5jEcVOEYIQSApEHyAyTIYY+Ccg9YaxAly0DVgNxg7QlKjL81/QZmq4qJb+r311/TpCYSk0aPCM33lhXSnX3BXCXgky4eE0aenrwgSmb969E6o7bOo3bMsUuPm+nve9RlzZC0VjNYwmcFgbxN8CPDewfUOALCua1jbg4RAng3ScHv1J47QWgMC4JSgtQIJgbZpWGuNdV3j4GjBKQFEAkIIAAmutwgxgogQIkMqCRIEpIRqXLGUgoQRe3pr/CU5LV82lza/Xbxw5r3+7VvBvnXre+DUY8jG3ddivZdF9Mg54buQ+OBfApEgCKKIjfJUEhBKmXw0Krkaj6COQwzMw1xSArwPSCnB+4Asz8HMEEJAH39XCAEfIlzv4foekXmAQhC8DwghQGoNEgLOOYQQ0Pc9XN8PTJISAglIAzNs16HvexgtYZSh0WTKs9FsR11dvctt/0cAicrs6fKlC89RYVLz83cbf7D+MdKDW0QfBRaAf6t8H8nuj9z4q0e/oc0yU21YxoP2Sz6j38omfD3Pc07MEIIQYhi2F+ehlESmJU5PSpJaw/oIyQEgwqLrkQHQBPQJnElJ505v491bB2jrGros4V0EB4eYwMpkODpaDKueCJIG36HIzQemKJBAJGGMHnwEIggitJ3FZDzCbDal969dg9wZf9ecnX8NJApgSBT1b95qixfPPYMEBokM96EXPozr7W3ogdzs+6al/SnNi0JOipej7H+PW80Yy/7rKs9cnhnTu55jGBShUgq5Jjx1/hSd29pAphWUNmh9wCRT4MjwIWBnPgMRQWtJighlOca1W7vItMZ+3aJZLbGuaxzu71GnMzy78wQH22J/WVOmFVgQayIajXJcW3bYO1wzA8fmqYDte2ijMR5VWC4XEFKEzY15WO7X3xG8+kW6OP0CAEGFuZJd2X49LNtfq2n5ufsB/+Po5BnAyXKhzsvCXEkhHqpFv/IAl1UetNJGSgkSRBHMeWZAJPHC5bP01WefRAwRWhsUZtjPIYCqrGCyHGU1gtIaUmsoSYh9j3MXLwEJsK5H0zY42r2Jvl3jsA+4drSml7/8JbTrJbquxdG6piLPYaTgM4sjen86wi/fuYEY46AjACQGirJA13VwfU+jamTKim2o/cvc9v9CZfYcAFCZPU1llnACdVUKOGHPl0QWbq3fJyOvblH5PAf9tS7PglLatE3DbWehtT62y4EXrlygrzx9BRkCpCZM51OQHJSiUhpkcug8hzQGUsrB+gEgKoPEDIEEkWUoxhNopXF4axfTaoxAV9HHhI3tHTRNjXIyH/IEWlOpCLlaENIOv3lrQT4mllKBiLBYLAc/AwLr9RoAVJGb0F9vN8MTur7DEnoo8Jf/8PeY/u3ffWAN3T0U8Qj7fwpxwav+7NTq73R1d3r/4MBlWabaZvBYPwBNSoyLnF64eBYlMVIIKEcTqDxHDAGJJIQ20FkGozVIKUilBu1+vFzF8X+UlEgQKEYjlNUIrqnxzJUnMJvN4GMcFG9K0JLAAPRojtF4iisbJT2xPQXHCGZGjB4CGBS3cyAigJlCDKyF3KZb9c8fFpePwvREraBU21/wb2/OC4inSAp7cHAUsixTznnu+x5FkaMajaCURooOz1w4i40iQ+h7kCRIYwarRylIqUBKDyAcR0WJaHDK7jQAUwKnBIkELTWqyQRVVcA5B6nk8P0w2P99b5l9z1IA2hhUxuDJ7Smfmo+ImSEgYIyBVBKut+htDyElOEIRCZe14pW4aH98kpidqA5Iga0Y57+SQVxoWzutigJVVaHpWkg1xGUGyU2YVyWdnY8RfOAQeqrMCH3XIYUAnRnEFCGDB5XVMQgRTMdbk5TA7fAC0bCKpASlhKosobSBXA8eNrwD9xZNCJxiQCIi7z26rmFRjLEhEj15hnnV9ohJHKc7PVJK6PseUmlkRoNjUlIhmOvN13ofX5Pz8sWHyR9/mE5UAoRRG/C8pYjGAglJAHW9BgEYj8eYzmZEJMDMODUbYZwbTuxBJI9dgQTmiBgilNTQJoMQCSQEBuUtIGkYMhFBCoCEgEhp2NqkhJQKQEJuMoyrCpvzOarRCOM8J6X0BxKjpSLpLcm8wmw8IUWA7R2EGKQtzwuE4OFdDySG1hIpEVGursn97kvhxurXJ4EZnaj9n6kzmTYmBlYkJZRUpLVBnhcQELRaLDlGRlXkNMkNOAQkZkoJADNCCAjOgmMA0hDz6a1F6C165+D7HikEsPfgGJESoIWAVuoDJnjvjmc2MKpzDiIlWNty3/do2ob7rmaQZOc9grOcS4HtKiNNAkQCJsugzWDep8QIkWGkYA6BrPMdntlifWH+Vw8Kz4e94ukrL6STlQBJ46DE26QUxqMR27blU1ub1HUtQvAMIdE7ByMYlZHw3lEKHlIIkgRE1yN4N4hlSgMYx/EffXv1pzSAHQLYOfTOQcSAGDyi7aAEoBKDBGCthbcd2q6D6xqEvgUHj+AcvPcIKSHalnIJnN+eY1Zl1FkH23UIbsgXdF2Htm2xaixZ1wfD9FTcW//spDA7WSUc4iH14ckiM8E5T3mRw3nPXdvBOQeAIQUwzRSUSMglACEQOYJJQ2sNYzJETvDeo2sb2LZFV6/hnUXwPVgcx3WEQEoJ4AhvG/iuASGh9x6964G+Q9826OoVnLMstSFphoQPx4i2qcl7jygEgxkKCSNF0FIMeoXEYABAwHuHEBi27YmUtMWSvx1uLr93EpidHANScml3/dvcZCUJoqapkRcFddYCQoBIgkigyjSpLIMhiRgTWBB3rkdKCdpk0Mex/r5tEJxDDB6JgegDJEeQH+I7zrYD+L2F7R2SILRdi2AtnI9Y1w1cs4Jra6TQEzhCcETiiBgCxeBhrQVzQuLIITKPDKHQkkipYTu8HbRzHkVuMJ1OyZAw4BB4t/nSByX0j0AnKwGVySKn6DkCADIl0XX2OO1HICkxKjMYEZGOA2tKgBQSEgcIqSG0GVZ4YvRtjWa9QnR2iN/bHtY7JN9BRI++WyP4HpoE2HtETogpgXuLtmvQtTV8DLDOc2ctJ+bBwhGCOUb44woM5z3y4xQmRQ/iCG0MjNYDSFKibhrE6JkhYJ3nFELFy+6Xj4rZSZqhIu23WYKuIhAAMZQNWjskyQMDzHCCkTSgokNuFExWwDZrRGcB9oiJwDECEEg8OEjWdqC+QyQBleWgPAcJQCuFmADvHMARRBJN08LbgUFa6yFkKQW5460mxkApBGgJTkoSxwBEIHHEvMxxa9micQzbD/kCABAk4HqPXCta1zWTEo2GmjOnR46InpgEpHX/qzKZLzjnQuJEAgBDgAEM5h9jqM0JKLUEKTVkpGJANZlCCAH2DhzD4OMLghACJBIkEUZFjjIz0JKGkIQkRB+AYYWj94NVJDiCY4BUGibLoaSEFITMZKSUosjMJAAiCaUkED2itxAcEb0bigG0Rp5n8Le94SQgBGB9ZKMVxYQQJvqH4drRk8mFG4+C20lJQMJ+I6wLy8ixI0c7UhK7vkfwHloOeVmRmMZGwCiJCIEUHOxqD1k1g1IGvXMoCoXMaAQICMqQSwljDPJMHztdDCkYTBpFLhF5qHwwWiI3EqbK0AiG48FHABKyJNA6zyF4DAHqiCQEpJKQRNR0PZIQAEeMtMCytoggKK2P9QDAHFGNKqzXa6cEttPpyRLb40X/h5uZeerUO1SYy58aA1LkNrX+2cjsOKZCaIGm7VAUBWdZBtv3EIJQKIHSGIiUIMFIQoAhYbsWk7GE0Tm0JJgsQ6EzkEjQRJCShpSlVsiVREqMBHHsmAkYk8FaixAZQmqMJxmYI0JZoG5zNL1DljEpkSB8j77zQGIiIWC7DhCADwGRJMo8g1g7igxOiRGDH0IgMaJtGmit4XoHvr7cy5469Y38pfMR4uGjoifDAB8PfYwTgF2KfLp39jiz1QEYthBSGomZRQIlgGMCQIogCFoMWS+l1MAAAor8OPCW0rDlaI0s00AMEOK40gECWmsoBQAJMXjIzEAS0LkAxYPPIFOAiwLZZAQVHa7Xq6GU0UckJBAEQhIMInI8WGY+BBAShCAIQUgCWK/XKIpSAcnFo+4bsba/l6P8+UfB7kR0ABm1DZGWKfBmBLcpCZcSgzkO24YkRI5DOQgBpCRxjIOJiUFXAEOUKEJAkQD3Fhw8IoDMKCgSSMffb3sPEQMSBLzMEAWhMBpVppEpAU6DguZujb5dI7QrRFuj72q4GBFUzirLURVDuXsXGEKAmBPyLBucPQBKa6Q0jI5IQB0r5d71IIHA1xZ8xynOh6KTkYCUokgpk0oh+j6SJHP8OUQCEgRiCMikBAFDqYmQxCBURgFKQ2UFupBwY3WEuusBIuTGIJPAailRVSU2qqF+NLkWngiyMshIwEMd65gEF4HWM5aLI6xvXcNB3QAcEYXkw6bDqmlhRCKV5fAMSK1RaYHaWoAUlCQooyHCsIBIKqRjKYwxQsiEQpHyEIFsejEuu3+Ws/IvPlUGIHITM3UjWS6FILjeQhBBKmIiQSkNRVR9SIiCIKVGpiVKNcTo92xgR5Y8J+zt7/GbMVFVjVEWFWo7FCGUBFzYmvK8LGljXKAoSkjnkdIaJq+QpMaqbrBuO1zf3eU3336T3jxsed1aUkWJTAocNZZM7HGmIBS5hw/M7Hva2dyAYYaIbjA5fQA4ATTomZSGkA1pFbRRrKU2TvBvUmFqse6BWfnQ0J0IA4RRp7ILG4v4x70xK3qHfToviSAEKSElR+8hiRCZEQUhzzQoMXItcVQ3sH0kHwKzs8Qx0nrdYm/vAG1IcD6AE0Mphd8rgRdPj3Dx7HkUZYX55jZmVQ5nLZz3uHH9Gv749lu4ebTG6wc1Di0DvudSL6kwks5OKoxHOZqug+06SCTEmNB2HSQRSqN4zUBKiVJiJlJIKREpskkkT0KMnQ9wDiAltrBTJKHl+FGwU8vXfiemr7yQpn/7d1j+w99/kDJ7UEqR6ySESwKsSKqUEgtD7wjvL8YwOEXWASEOJ+KkJPiY0LuAXEq4bgWRgAoJl3LGwlksbA3bWwgkBCgIpel9WMTe4uypLaTE6NoRcq3QNyssb7yD6+9dxXt1oK7pMaNERiToJFEmjdQLhCixoQUIEYCgdSIs6xp5UUKQJIHIRIIhhmIvTilkHIGLWz9z++vNyEmhj1e00qWc5M8Lovte/nerjDgxT5iP2ppjBEkKSmvH56qfzlwIW+v28ltJBs+JYvBwKcIxQyOhsQHWBy5loix6staidgEuSejZNi5ffBokBHxvsdy/hcO9m2jqBnsCyLSEJgD9BAsQYrPErYMj1L2H4YBTBcGTQT7bwGhUoqsbXh7s0fXew2iFi/MCk0xBpggXBawPIJkYgsAJpEgxJcZMJTy9UeavZ0oEqTl7ZmsjNv0v0zuLryLwLsz9M+BudGIMEJM8l4etEQHPxAo/UdPy8+d3j7oXzk1h31/RbhvhSRASI6bEdWehECnXiigxGutx9aBG6xmnt7ehSEAjISYAUvP0/BPIqhHtX78K6zwOF0uYxKCU4LxH03bYrztwGpS8FZpnZy/Qzsacg7N0dmuL3KlNXH3vPeyvWry91+DMNBv8ChCi66HznHxKyLRmwQlPVKDtcUmfv3KWw1u73/w54efCqFNKyw3L+yzW9k21OTr9KLidGAOoNOcjBJhwyEhRCyHNqNidT0ZbpyeOvfCKEzjTmkgIaAJEIuwta7Sdw7Jp0TNhNp/heuOh7BLh5iFSdOiaDgieNnd2oIoxQlMjJmDdO2SeUZUT9Ms1mj6ijwQHgdmpbYr1Ej9643WKKkM+nuJoueJxphETgZSh/Z55ngQpo6CkHLJsUgHsMVKg2biEJw0ab7Ht31MiVy0AQAhlXjzzLhn9pUfG7W4fPkx5iiDSSWCfLs7fiDESUrLnxqOtFhqSFF3cGGOumFKMMJJQZDmxIPjAHxyWaH3AWhi8/MWX8ZM3rvGCFX5zY8WXX3qZnrh8CQfXryEKArRG6wK0FJjONjCan0IXGOuuh/M9zl2+AsSAsVb4L/+Lv8buuue6tTg82Md//G//A73yrW/QwWIFToQIgUwC40xDSkKVGWgpUcBju5AQ7MKtVauOzmy9CmakyA0AUG4ugUR+v/h8bG3o7TK5R0lHCi039UtnSEgyFEUJovENF6+/d+sQOlreEhanS0I5ygcPVhHmhcbOxgxb8wkundvB+a0Znt+s8Dff+jpeePIS3nn7Lc4R8e//+jv4b/7df42vfu4FnNqYY3M+x7gskSmD7dkMZ09tozAGIXjMxmOMNDBXwMvPP4W//MoX8Pkr59EtDvgLTz9Bqxvv4ubvf4ErGxWubFW0PRtjVJYoixyUEhAChDEoMo2L8wkmMmHvYB8xIKmN0fRR+xU9ztJEEkpugNObcmRqCMg3COEvjMaGVsiMwZ6XABF8iJQXBuPRBjaCA4ktuBhxbj6BtRY//L//D/z1556iz10+j8po/OL/+b9wsFojH08w1gXy7dPcH+7SKBcwWY6qKnF6VqEwEvNxiUlZYhkjfvvWVVzbvYW/+eJz9O2Xnsby1nW897ufIUWPi6fmuLw9RYRE54d4TxYiVtGjKhTZQ+a6b3DlySfV7/dWu8v39i6LCzMrtNw6QcxOvjRRFPqcMuMWABrvi6yscHrjLI6uvw0jBTwIUgpEoVGUI1RaQiKh7XvshX2sXA9rW5S2xsXZBlbe42C1BrIc5fwUtDZY3rxKJTF2NrcwHo9AUmE8mWFW5jharVBuBUxPX0CzOoJH4t+99Q75egHb1EgAqiLHzrTCaDyBFAJ116HxCUFECACF1lgLIgECCUILkq63wO9uPpd/8fxCKDk7Kbw+YMBJ+QOU6bO3f47Lbt+VcxxYH2a5Vk/tnMevbuxCJMD7HjF6mMkEKTEmJofRGrk2uHW0wLptcavuoaeb2Nw5hwRAi8RxcZO2TEIhJOZbO5A6g6ommM03MKtyaB3Q7L4LAeadzW0oAsJsimBncPUCuWDMpxMUWYEuBoQQkRcF6n59HPkEggCTIGqtR1otoCNLOcqvx94v7Ft7tnhm52t4hBP0dx7QeDzV0ccUkMRR14XtvKKVYwQ3ZLq6MDhfbe8RmTEdV0P5eJFjNJ7i1BmHzkeIfITgA9zxEaScLRX5BHXXYlZVyMsRpJQosgyjyRyn51Mc1B0qTeD2FlWTDOPts0OiP26BxAUY3w5JHyEQV0dIiOgjo3MBEQKRBwfMeo/3VzY8uzNR+/bwd+bJ098EgLi2v02Rm5M4LQN81DHVR+j+8ScPz3V542ChdJZTyxJvvflHEARACr33sF2LtmvhnIc6rv2UkpBnBTYnYxRaYlJmmBUGT8xLnJ2NobIS7B3yskJgRp5lyARQVhVKLZFrBaU05tMJxkai5B45O4wygkICSCE6h259APYdom1R1w065+EjswDYWUcbhcJk5xwftj1WwO2SPiHH+UsPAv696q3+hAEn3ZSUCrNzc6S+/y+rxc9np8/zuZ0ddp1FTICD4N57hN7Ct2vYpkbd9YikoY0CaYVcAplWmFQ5SGfoY4Jt11A6Q4oRmTHQJgMjYTzbwHTzFMrMwHPC0noIU0Dm5ZDVigEaEb1twKGD7y1c79G5gK73iDEixgjHIGs9Lpw9zbP5NjkIt87kkyeFyYcxvu+T8g9DlOsLaVb+5VudbZ2QdOHilZBnGay3Q+GUizhardA1ayAlSCGQBEDaoKoq6CwHSQUQIWFIwFgW0FkOTcOxpawoUeYTTGfbuPLsi9ja2EBRjRAgsHLhOPwt4b1DigFaCAQQIgg2MDofYWMECwEWgpa1hRDELglImciRMUz0UJbPQ52UPwmf4E5KPuzeurWUyxD367alJhA3LoI5UmJG3bZY1C1u7e/BBY9M0vFhiSEbJY0BSY1cCiz6AAjCKM+RpMJoMkNVTkHHPSaK0QTj2SY2ZnM8c/kJ7O3t4XC1gpaDqguuh/c9QgjwaTgAYnlYCL0L6HqHpuvR2R5RCHbe0c/W+987Pob00HQ35XubHqhbysOQ0OqUvLjxzdcOrr+5WB4q6Tu7sgGtj2idh2Ng5TxcCEh9B3Y95HE2TYmIGAKEAPZqh7Ze4dx8jGI0wmhjG8pkWK8PsDq6ifXqAIv9WxhP5zh39jyefOpZfO3LX8a1Wwc4XK0Q2jWcbdH3FokD4B1iiGitQxci+hhRR2DlEgtBHL1T/9/B3g/6Sf5XeITD2feiu4ciTlYKBACyhf7q64ujX04n43K/CWF/WaPue6ytw7pzcN6jtw3WiyM0q+VQ8eYY8BZ102JvcYSnL1/E+Sefxc75y5B5hfXyEME7qPEYzWqB5a0biNFjfvYShDboVkfougY3dm+i8w51W6PtOhytOyw7i6V1cEkgQMDHiEXr2PoYJpLV7zP657Yy33rUyX/c6r8Nzt3/8HE06ePUFTdXv7er8PkzI4NzI6NGucFWlWOSSWxPxhiPJ4AcjplCDSfnF22H3YNDnJ5UOHt6GzorsH9wiFQf4OxTz2P7mZew+9tf4Orrv4WFgpcZ3nz3XdxarJGY8ZXnnoAAjtsUWHBwaMNQ9Xx1YbG2Di4ydrsYek6KLk7+k5hWX33YaT5I06aP9ANuO2YPO4i7Eomi2Si35HKl9hvn5goolByS4ilCyhbWtlAmx2Q0RYgR1gUYk2FjXOEff/QzgAjTyRiZSNgpCYcH+6h+8zOEGPH+/iF224i9VYNF22OSGzy1szkc6uMEHyM6F2BdAENg2TpYN+QHDpuGuz5SkrSMh21vxmV3+2jqo9Ijd8w6Kb8AACjT50SOX0aG2e2Cs96jtR2c81g1LVadw6ppcdg0qK0DCYHCaOxsn8IrX/wcDAl0RwdA3+Dtpec3lj3/4ep1/OHdG3hj4bFarTGRjKfnGZ47M8epzSk4JhTVBNrkUCaDZYHGeiAlFEYOzBHkUhJE29XPzaWtrz4s+A+6W3wsA+7k3IkxQUDGM5OJosQLF6n1EavG4qDpsWx6HHQBiz6g8wGFMdja3AKZHCFGXDm7g+98+XN48olL8LpEUgZHVNI1VNjTY/RC4f1lh/dWDqsoYUYTmNEGqJyhD4xRNYLJS+isAATBRkbnItZdD4YgowBR6uphrZ6Hadp3bz/gLg94VCYIo85ujE0ohVBLGziGYVvwIYKjRzmaYTSeYTyaQJBEIgVIg1uW8X5H+OMq8uurACszMIjHVcnFeIYVC6wpw64jXHcS76wj3j6sceQZqz7AQ35QV8pEcHHoN9D4BEUENVT8Tu85gbvhdBdM7sexva9Y0IcDdY9MJEws1D+fMeprtnXsyJBEhE/ASGdDLabU2LcR9XoNH4ZS9jeu3UDTNWz7DpMyx5npiK7v7jJGJTSAZzYrnDMJazectLxxtGQfI64tG0oJOFUZVDToAscJbqg/RErMMgQiCAgpzKNM7V5Wz4fpgYNxjxotBQAksOSUj42GCBGN7VGOC+4TEGKkuvPsqMFuvU9HrUVvO1zY2uCJUWSQ0efObmGUF5iOJ3ju1IxWdY0i05iMJ7DOo+56+Bjw9s09kFI4XDe8tg7vdxqbkxEVQsL5MJy2RMIsk+SgQ/QRNqb2QafzKFbifZcmnqg+EBAMkQptsFkZTHOFGCMdH+HmmBguBDrqHAwiNjLBWfJ4/twpfOXKRexsnYbOS6xsj3LnEq689BUUpy/jVk9496jmQxe4dR4XZiPaLAxNC02jXNJB66nrPaz3zJyQGc2ZHo6hKkrECcADRjkftYP6p9W+Ps336588neVfzcAhAUoICc+MaZHxaDLFQR/p+qJGQYwzkxJnZhNopdA5zz4BeTHCdDanICSC92jWK0it0VuLpq1RNzX6roUkwqrt0FiHThZIzmIrJyaSFBPD9Q4+MjvncaN1HJ4/eyS03L6fSZxE+/qHin6eBBPMov3e8yz/yhBcBjbaaDAIOsu4zHPcWLV0VLeobQ/XNDg/H8FIgbIo2JQVlJKEfAK4jjUYkRSFyKi74VBf37VD2NlF3Fx1OHt+B54FonM4P82585EUEeq6QZ8QBEl1vbPvxGd2ztyPFXRSt2h8aleYJBeuXz6wG2eqjJijygSItIE2GlkxwrJeo+0sgqkgEsPVS8ynU/RtA/YORAoxJXjfMwsBqTXFvoe1PRQJmHLESRCtXEAxnmGcazRHB9BKwkhiHyIxM5q2QxtiiEKpXS2+ry5v/eW9xn6SV5g8Uvz/ES/xSfLtw189XZjPaUVciKRyoyBUhqwouPeejNZQRJhtbHM2mlKlJTarAhubG9iMBLdc4OrBdRzur1ARISsM3lnsoYWA0wUWTQsiBet6Ts6Sdz2cjyA1tD7oVyvs2gibyEZOud0Zv6ZOTV75qAE/juusHjkB8yhMCPvr18xu98rlWRamuVYyMQqjkVUjBicqM4OtjQ3sHx3y1pmLpIsKO9MRnnnh86iKHFVK4NAj2h5t57DqHW7svovDo0O8tXeIpuuxXhzCkIDWQxaubjv4yAjO88p62m09O8DFmHL13Ok3qTR3Tb48rrvEPt2L3FJy/Pr+9cyny2fGJpydVUpyhNQaZZFDk8R8NkXnIy8ObtHW2UuYjiqcmU9x/vmX0bQNQr3EeDxCNtvCarXCb3/4/+Lm0Qpr73F0sA+CwMZsyiIx1T5isVojxYBV6/i92oMBjiEq8cTGP6mN0TfuNszHeZHbp36VYVx3v3KvHz430oKe3R6T0gqUEo3KnDOlSUvisiiQfE+HhwcoZ1u8UeV0+tRpmGoCqQyyzCAvK7z5+1/ivavvYtFHrFbLYfuaz6G0ZucjXVs1QAyo2x7LVc0LpkDSGDpTvqp2pv/mqqs/m6sM76SHucwzre3P/RsHXyRBbnOUm7lJKHODUVGgkMAkz7ExqbBcr3H1xi0kQajyHEpJHo1nJMDw3ZBTXnU9guuxMR7a22d5xkc24J2DmrqYYH2E6y0jRtQ+ck6k6IsXjoSS8/sZ92f2Ms876UGvsxUh7j6zcKd/8dZN1lnGs9yolBI2KoMnd7a4IqZJVcFLwwUC3dzdxY215cZFuL4nkMC4KmCURKEkz4tsaPydBNh7evuwxh/3G5ZEQ7MQrdF7D+ktv3h2Q71+buMQijb+s7jO9jY9yIXOIsQb/2F66syNGzf5p+/uovYJRT401fjC5dN0aXPKlQTlRQ7BjD5E9GTY25YWdQskhpESOstYCYEYHJgTee+xaC1urTu8u7Dc2uFuGR8C4Dq8cHqCMzun6f/83/6XwzSfbNxtbB+M/zFd6PzYCrM+SGseM+Ju4YvbP8//+/8xEBEunT2NQkv67h+ugYXgJBXe2VtwrogubM4540RBaAiTYSs3JKYzbG86LNqetUgkEanuh7bH1g79qKMg+DREOgXR0GmXE86Pc0xPnQoushHO97dXy382V5p/mO6WXbvNAP3+7rv/8X/93y8hBs5SpKt7B/jH373PDIJWEtOqwPl5SS+cO8WZ1pBSUkyJJUlSiLC9g2fmEIYGHIIDtYFBRvObuwu8fWsFTgmMoZlHhYAXT09Jj8auMMr8k4zvsFGX/2Rsjxn42/RYSxPvpA9LBPCvq83+z/9TT5LQhxQowWxtzPlvngv04/eO+KhnNM7jjZuHrEjQ9qRikyIrpZCchXc9bEiQYErA0GNCKqySwsHhihrr4DhwSgnMCTIGXNyqqKxKjjEOp/O93+uBy3eO85OiT/Rld9KdjDjl8Op/dfb8t+uusSolowVRRgm7R0v842+v8tInZFpiVBbIFDARTBNNyESC9xGRI7RWiELCJYCFxG7jsWwskhiu87TWYqoSnt6oaD6dQGuN70/+NfT/SQN/mz41BtxJdzLjvys3IFKElgopWKyaFt//l/dwowusshy9cxiPxnBdSzk8GyWhlcSij0MDENAH3RljiCSJ2NsWZ0pNl7dG+PXFfz3S9WmBfid96gP4MN1NV/wPOsfbu4f89o192u0TtyFBiaH7YR8Ys1xCSYWeBWLwlFJiBpD9xZWPrPz7rNBnajAfRQ9bHvNZA/tu9P8DEPskbWmX3MQAAAAASUVORK5CYII=';
    function injectStyles() {
        // ------------------------------------------------------------------
        //  DESIGN-TOKENS
        // ------------------------------------------------------------------
        // Warum auf :root und nicht am Panel: unsere Elemente sind ueber die
        // ganze Seite verteilt - der FAB, das Fortschritts-Fenster, die Toasts
        // und der Knopf an EAs Pack-Kachel stehen NICHT im Panel. Ein
        // gemeinsamer Ort ist die einzige Variante, die fuer alle gilt. Das
        // --pt--Praefix schliesst eine Kollision mit EAs Variablen aus, und
        // Variablen wirken nur, wo sie benutzt werden - EAs Oberflaeche
        // aendert sich dadurch nicht.
        const css = `
        :root {
            /* Marke */
            --pt-accent:#00e0b8;      /* Akzent: Zahlen, Titel, Fokus */
            --pt-accent-2:#0077ff;    /* zweiter Marken-Ton, nur Verlaeufe */
            --pt-on-accent:#001018;   /* Text AUF dem Akzent */
            /* Bedeutungen */
            --pt-sel:#2b6cb0;         /* AUSGEWAEHLT (Segment, Kachel-Knopf) */
            --pt-sel-hi:#3179c4;
            --pt-plan:#6b46c1;        /* Planen (hebt sich von Diagnose ab) */
            --pt-plan-hi:#7b53d8;
            --pt-danger:#c0392b;      /* unumkehrbar: abgeben, verwerten */
            --pt-danger-hi:#d4452f;
            --pt-warn:#ffcf4d;
            --pt-warn-2:#ffb454;
            --pt-bad:#ff6b6b;
            --pt-bad-2:#ff5470;
            /* Flaechen, von dunkel nach hell */
            --pt-sunken:#0b1219;      /* Eingabefeld, Vertiefung */
            --pt-bg:#0f1620;          /* Panel */
            --pt-surface:#131e2b;     /* Kasten IM Panel */
            --pt-raised:#1c2938;      /* Knopf "ghost" */
            --pt-raised-hi:#25384c;   /* raised unter dem Finger */
            --pt-hover:#16283a;       /* Zeile/Segment unter dem Finger */
            /* Linien */
            --pt-line:#1f2b3a;        /* Trennlinie, Kasten-Rahmen */
            --pt-line-soft:#1b2735;   /* leiseste Linie: Zeilen IN einem Kasten */
            --pt-line-2:#24405f;      /* Feld-Rahmen (deutlicher) */
            --pt-line-3:#2f4a68;      /* Rahmen unter dem Finger */
            /* Text, drei Rollen statt vier zufaelliger Grautoene */
            --pt-text:#e6edf3;
            --pt-text-2:#cfe0f2;      /* Sekundaertext auf Knoepfen/Karten */
            --pt-muted:#9db2c8;       /* Beschriftungen */
            --pt-faint:#8299b0;       /* Nebeninfos (war #7d93ab: zu dunkel) */
            /* Masse */
            --pt-r-s:6px;             /* klein: Feld, Chip, Plakette */
            --pt-r-m:8px;             /* mittel: Kasten, Knopf */
            --pt-r-l:14px;            /* gross: Panel, Fenster */
            --pt-tap:40px;            /* Trefferflaeche einer Hauptaktion */
            --pt-shadow:0 8px 40px rgba(0,0,0,.6);
            --pt-font:'Segoe UI', Roboto, system-ui, sans-serif;
        }
        /* ------------------------------------------------------------------
           EINSTIEG: FAB und der Knopf in EAs Aktionsleiste
           ------------------------------------------------------------------ */
        #sbc-opt-fab {
            position: fixed; right: 22px; bottom: 22px; z-index: 999999;
            width: 56px; height: 56px; border-radius: 50%;
            background: linear-gradient(135deg,var(--pt-accent),var(--pt-accent-2));
            color: var(--pt-on-accent); font-size: 26px; border: none; cursor: grab;
            box-shadow: 0 4px 18px rgba(0,0,0,.5); display: flex;
            align-items: center; justify-content: center;
            transition: transform .15s ease; padding: 0; overflow: hidden;
            /* Ohne touch-action:none scrollt Android die Seite statt zu ziehen. */
            touch-action: none;
        }
        #sbc-opt-fab:hover { transform: scale(1.08); }
        #sbc-opt-fab:active { transform: scale(.96); }
        #sbc-opt-fab.sbc-opt-dragging { cursor: grabbing; transform: scale(1.12); opacity: .9; }
        #sbc-opt-fab img {
            width: 38px; height: 38px; border-radius: 50%;
            pointer-events: none; display: block;
        }
        #sbc-opt-fab.sbc-opt-hidden { display: none; }
        #sbc-opt-packsection.sbc-opt-hidden { display: none; }
        #sbc-opt-queuesection.sbc-opt-hidden { display: none; }
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
        #pittools-sbc-btn.pittools-active { outline: 2px solid var(--pt-accent); }
        /* ------------------------------------------------------------------
           PANEL
           ------------------------------------------------------------------ */
        #sbc-opt-panel {
            position: fixed; right: 22px; bottom: 90px; z-index: 999999;
            /* Feste 340px liefen auf schmalen Schirmen aus dem Bild. */
            width: min(340px, calc(100vw - 24px));
            max-height: 78vh; overflow-y: auto; overscroll-behavior: contain;
            background: var(--pt-bg); color: var(--pt-text);
            border: 1px solid var(--pt-line);
            border-radius: var(--pt-r-l); box-shadow: var(--pt-shadow);
            font-family: var(--pt-font); font-size: 13px;
            display: none; padding: 0;
            /* Ohne das zeichnet Android eine helle Scrollbar in ein dunkles
               Panel. */
            scrollbar-width: thin;
            scrollbar-color: var(--pt-line-2) transparent;
        }
        #sbc-opt-panel::-webkit-scrollbar { width: 10px; }
        #sbc-opt-panel::-webkit-scrollbar-track { background: transparent; }
        #sbc-opt-panel::-webkit-scrollbar-thumb {
            background: var(--pt-line-2); border-radius: 6px;
            border: 3px solid var(--pt-bg);
        }
        #sbc-opt-panel.open { display: block; animation: pt-pop .16s ease; }
        /* Dezentes Einblenden statt Aufpoppen: Deckkraft plus 6px Hub aus der
           Richtung des FABs. Unter prefers-reduced-motion abgeschaltet. */
        @keyframes pt-pop {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: none; }
        }
        .sbc-opt-header {
            background: linear-gradient(135deg,var(--pt-accent),var(--pt-accent-2));
            color:var(--pt-on-accent); font-weight:700; font-size:15px;
            padding:12px 16px; border-radius:var(--pt-r-l) var(--pt-r-l) 0 0;
            display:flex; justify-content:space-between; align-items:center;
            cursor:move; user-select:none; touch-action:none;
            /* Klebt beim Scrollen oben - der Zuklapp-Knopf und der Ziehgriff
               bleiben erreichbar, auch wenn das Panel lang geworden ist. */
            position: sticky; top: 0; z-index: 2;
        }
        .sbc-opt-header img.sbc-opt-logo {
            width:18px; height:18px; border-radius:50%;
            vertical-align:-4px; margin-right:6px;
        }
        #sbc-opt-close {
            /* Vorher ein nackter Text von ~12px. Ein Zuklapp-Knopf ist die
               Aktion, die man am Handy am haeufigsten trifft (oder verfehlt).
               34px Flaeche; der negative Rand haelt die Kopfzeile auf ihrer
               bisherigen Hoehe - nur die TREFFERflaeche waechst. */
            width:34px; height:34px; margin:-5px -7px -5px 0; border-radius:50%;
            display:flex; align-items:center; justify-content:center;
            font-size:15px; line-height:1; flex:0 0 auto;
            transition: background .12s ease;
        }
        #sbc-opt-close:hover { background: rgba(0,0,0,.18); }
        #sbc-opt-close:active { background: rgba(0,0,0,.3); }
        /* Guertel zum Hosentraeger oben: was trotzdem zu breit wird, wird
           abgeschnitten statt die ganze Seite seitlich scrollen zu lassen. */
        .sbc-opt-body { padding: 14px 16px; overflow-x: hidden; }
        #sbc-opt-advanced { margin: 4px 0 10px; }
        /* Gemeinsame Aufklapp-Optik fuer "Erweiterte Einstellungen" UND die
           Batch-Team-Details (Ticket #73) - eine Stelle statt zweier
           synchron zu haltender Kopien. */
        .sbc-opt-details-toggle summary {
            cursor: pointer; color: var(--pt-muted); font-weight: 600;
            padding: 10px 12px; background: var(--pt-surface);
            border: 1px solid var(--pt-line);
            border-radius: var(--pt-r-m); user-select: none; list-style: none;
            transition: background .12s ease, border-color .12s ease;
        }
        .sbc-opt-details-toggle summary:hover {
            background: var(--pt-hover); border-color: var(--pt-line-3);
        }
        .sbc-opt-details-toggle summary::-webkit-details-marker { display: none; }
        .sbc-opt-details-toggle summary::before { content: '▸ '; color: var(--pt-accent); }
        .sbc-opt-details-toggle[open] summary::before { content: '▾ '; }
        .sbc-opt-details-toggle[open] summary { margin-bottom: 10px; }
        .sbc-opt-info {
            background:var(--pt-surface); border:1px solid var(--pt-line);
            border-radius:var(--pt-r-m);
            padding:10px 12px; margin-bottom:12px; line-height:1.6;
        }
        .sbc-opt-info b { color:var(--pt-accent); }
        #sbc-opt-availability { font-size:12px; margin-top:4px; color:var(--pt-muted); }
        /* Gleiche Warnfarbe wie .sbc-opt-warn/Toast-Warnungen - kein neues
           Farbschema fuer "verfuegbar < gefordert". */
        #sbc-opt-availability .low { color:var(--pt-warn); font-weight:700; }
        .sbc-opt-debug { color:var(--pt-faint); font-size:11px; margin-top:4px; }
        /* Seltenheit in der Zieh-Liste: dieselbe gedaempfte Farbe wie die
           uebrigen Nebeninfos, damit Name + Rating fuehrend bleiben. */
        .sbc-opt-dim { color:var(--pt-faint); }
        /* Rollen-Klassen statt Farben im Markup: sonst waeren die Tokens
           nur die halbe Wahrheit - sieben inline-Farben standen weiter im
           HTML, drei davon in dem zu dunklen Grauton. */
        .sbc-opt-muted { color:var(--pt-muted); }
        /* ------------------------------------------------------------------
           FELDER
           ------------------------------------------------------------------ */
        .sbc-opt-row { margin-bottom:12px; }
        .sbc-opt-row label { display:block; margin-bottom:4px; color:var(--pt-muted); font-size:12px; }
        /* Feld-Optik fuer ALLE Felder im Panel. Vorher hing die Regel an
           .sbc-opt-row - das Pack-Dropdown steht in einem .sbc-opt-inline und
           blieb deshalb ein natives weisses Select (Rasmus: "ultra haesslich").
           Ein Selektor statt zweier, die synchron zu halten waeren. */
        #sbc-opt-panel input[type=number], #sbc-opt-panel input[type=text],
        #sbc-opt-panel select {
            width:100%; background:var(--pt-sunken); color:var(--pt-text);
            border:1px solid var(--pt-line-2); border-radius:var(--pt-r-s);
            padding:8px 10px; font-size:13px;
            font-family:inherit; box-sizing:border-box;
            transition: border-color .12s ease, box-shadow .12s ease;
        }
        #sbc-opt-panel input:focus, #sbc-opt-panel select:focus {
            outline:none; border-color:var(--pt-accent);
            box-shadow: 0 0 0 3px rgba(0,224,184,.16);
        }
        /* Ein <select> ist nur bis auf den Aufklapp-Pfeil stylebar - der wird
           deshalb abgeschaltet und selbst gezeichnet. color-scheme:dark
           faerbt die aufgeklappte Liste mit: ohne das zeichnet Android sie
           weiss, egal was hier steht. Backticks sind in diesem Block tabu -
           das CSS steckt selbst in einem Template-Literal. */
        #sbc-opt-panel select {
            -webkit-appearance:none; -moz-appearance:none; appearance:none;
            color-scheme: dark; cursor:pointer;
            padding-right:28px; text-overflow:ellipsis;
            background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0h10L5 6z' fill='%2300e0b8'/%3E%3C/svg%3E");
            background-repeat:no-repeat;
            background-position:right 10px center;
        }
        #sbc-opt-panel select option { background:var(--pt-sunken); color:var(--pt-text); }
        /* Die Hoch/Runter-Spinner in den Zahlenfeldern sind seit der
           Schnellwahl (v4.93.0) nur Rauschen - die Felder sind der Notausgang,
           getippt wird auf die Chips. GETRENNTE Regeln: ein unbekannter
           Selektor in einer Liste verwirft die GANZE Regel, die
           ::-webkit-Pseudos wuerden die Firefox-Regel also mit begraben. */
        #sbc-opt-panel input[type=number]::-webkit-outer-spin-button,
        #sbc-opt-panel input[type=number]::-webkit-inner-spin-button {
            -webkit-appearance:none; margin:0;
        }
        #sbc-opt-panel input[type=number] { -moz-appearance:textfield; }
        /* Anhaken: die Browser-Voreinstellung ist ~13px und am Handy zu klein. */
        #sbc-opt-panel input[type=checkbox] {
            width:18px; height:18px; flex:0 0 auto; cursor:pointer;
            accent-color: var(--pt-accent);
        }
        .sbc-opt-inline { display:flex; align-items:center; gap:8px; }
        .sbc-opt-inline input[type=number] { flex:1; }
        /* WARUM min-width:0: ein Flex-Kind hat min-width:auto und kann
           deshalb nicht unter seine INHALTS-Breite schrumpfen. Bei einem
           <select> ist das die Breite der laengsten Option - lange Pack-Namen
           machten das Panel breiter als seine 342px, und Rasmus musste
           seitlich scrollen. */
        .sbc-opt-inline > * { min-width:0; }
        /* Die beiden Nachlade-Knoepfe (↻) waren laut Live-Report 29 bzw. 31px
           breit - unter jeder Trefferflaechen-Empfehlung, und einer davon ist
           der Notausgang, wenn das automatische Laden scheitert. Das
           inline-gesetzte width:auto blockiert min-width nicht. */
        #sbc-opt-queue-refresh, #sbc-opt-pack-refresh { min-width:44px; }
        .sbc-opt-toggle { display:flex; align-items:center; gap:8px; cursor:pointer; }
        .sbc-opt-toggle input { width:auto; }
        .sbc-opt-group-title {
            color:var(--pt-accent); font-size:11px; font-weight:700; text-transform:uppercase;
            letter-spacing:.04em; margin:16px 0 8px;
        }
        .sbc-opt-group-title:first-of-type { margin-top:0; }
        .sbc-opt-compact { display:flex; align-items:center; gap:8px; }
        .sbc-opt-compact label { flex:1; margin-bottom:0; }
        .sbc-opt-compact select { width:auto; min-width:110px; }
        /* ------------------------------------------------------------------
           KNOEPFE
           ------------------------------------------------------------------ */
        .sbc-opt-btn {
            width:100%; border:none; border-radius:var(--pt-r-m);
            /* min-height statt nur padding: 40px ist die Groesse, die am Handy
               zuverlaessig zu treffen ist. Vorher waren es ~37px. */
            min-height:var(--pt-tap); padding:10px 12px;
            font-weight:700; font-size:13px; font-family:inherit;
            cursor:pointer; margin-top:8px;
            transition: filter .12s ease, transform .06s ease;
        }
        /* DRUCK-FEEDBACK. Am Handy gibt es kein :hover - ohne :active hat ein
           Tap ueberhaupt keine Rueckmeldung, und man tippt zweimal. */
        .sbc-opt-btn:hover:not(:disabled) { filter: brightness(1.1); }
        .sbc-opt-btn:active:not(:disabled) { transform: translateY(1px); filter: brightness(.94); }
        .sbc-opt-btn.primary { background:var(--pt-accent); color:var(--pt-on-accent); }
        .sbc-opt-btn.blue { background:var(--pt-accent-2); color:#fff; }
        .sbc-opt-btn.ghost {
            background:var(--pt-raised); color:var(--pt-text-2);
            box-shadow: inset 0 0 0 1px var(--pt-line);
        }
        /* "Teams planen" hebt sich von "Diagnose" ab (Rasmus): der
           Diagnose-Knopf ist ghost, beide standen vorher gleich da. */
        .sbc-opt-btn.plan { background:var(--pt-plan); color:#f2edff; }
        /* Rot: gibt SBCs endgültig ab, das ist nicht rückholbar. */
        .sbc-opt-btn.danger { background:var(--pt-danger); color:#fff; }
        .sbc-opt-btn:disabled { opacity:.5; cursor:not-allowed; }
        /* Fokus NUR bei Tastatur (:focus-visible) - ein Ring nach jedem
           Fingertipp waere Laerm. */
        #sbc-opt-panel :focus-visible, #sbc-opt-fab:focus-visible,
        .sbc-opt-tilebtn:focus-visible {
            outline: 2px solid var(--pt-accent); outline-offset: 2px;
        }
        /* ------------------------------------------------------------------
           SBC-REIHE: eine Zeile pro Challenge des Sets, zum Anhaken
           ------------------------------------------------------------------ */
        .sbc-opt-queuerow {
            display:flex; align-items:center; gap:10px; cursor:pointer;
            padding:9px 10px; margin-bottom:5px; border-radius:var(--pt-r-s);
            background:var(--pt-sunken); border:1px solid var(--pt-line);
            transition: background .12s ease, border-color .12s ease;
        }
        .sbc-opt-queuerow:hover { border-color:var(--pt-line-3); background:var(--pt-hover); }
        .sbc-opt-queuerow input { width:auto; flex:0 0 auto; margin:0; }
        /* Das Ziel-OVR ist die Zahl, nach der Rasmus die SBC sucht - sie steht
           deshalb als Plakette vorn, wie im Spiel. */
        .sbc-opt-queuerow .ovr {
            flex:0 0 auto; min-width:32px; text-align:center;
            background:var(--pt-raised); border-radius:var(--pt-r-s); padding:3px 6px;
            font-weight:700; font-size:12px; color:var(--pt-accent);
        }
        .sbc-opt-queuerow .nm {
            flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
            white-space:nowrap; font-size:12px; color:var(--pt-text);
        }
        .sbc-opt-queuerow .st { flex:0 0 auto; font-size:11px; color:var(--pt-faint); }
        /* Erledigte Challenges bleiben SICHTBAR (sonst waere unklar, warum die
           Liste kuerzer ist als im Spiel), aber gedaempft und nicht angehakt. */
        .sbc-opt-queuerow.done { opacity:.5; cursor:default; }
        .sbc-opt-queuerow.done:hover { border-color:var(--pt-line); background:var(--pt-sunken); }
        .sbc-opt-queuerow.done .ovr { color:var(--pt-faint); }
        /* ------------------------------------------------------------------
           FORTSCHRITT
           ------------------------------------------------------------------ */
        /* Mittig über allem, damit man nicht im Panel nach dem Status suchen
           muss. */
        #sbc-opt-progress {
            position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%);
            z-index: 1000000; display: none;
            background: var(--pt-bg); color: var(--pt-text);
            border: 1px solid var(--pt-line-2);
            border-radius: var(--pt-r-l); box-shadow: 0 10px 50px rgba(0,0,0,.7);
            padding: 18px 22px; min-width: 300px; max-width: calc(100vw - 32px);
            text-align: center; font-family: var(--pt-font);
        }
        #sbc-opt-progress.open { display: block; }
        #sbc-opt-progress .p-title {
            font-size: 17px; font-weight: 700; color: var(--pt-accent); margin-bottom: 2px;
        }
        #sbc-opt-progress .p-step { font-size: 13px; color: var(--pt-muted); margin-bottom: 12px; }
        #sbc-opt-progress .p-bar {
            height: 8px; background: var(--pt-raised); border-radius: 5px; overflow: hidden;
        }
        #sbc-opt-progress .p-fill {
            height: 100%; width: 0%; border-radius: 5px;
            background: linear-gradient(90deg,var(--pt-accent),var(--pt-accent-2));
            transition: width .3s ease;
        }
        #sbc-opt-progress .p-done { font-size: 12px; color: var(--pt-faint); margin-top: 10px; }
        /* ------------------------------------------------------------------
           BATCH / REIHE: Abschnitte, Vorschau, Team-Details
           ------------------------------------------------------------------ */
        .sbc-opt-batch { margin-top:14px; padding-top:12px; border-top:1px solid var(--pt-line); }
        #sbc-opt-batch-preview:empty { display:none; }
        /* Der Vorschau-Kasten ist die ganze Zeit im Markup, aber solange kein
           Plan existiert, waere er nur eine leere Trennlinie. */
        #sbc-opt-planresult.sbc-opt-hidden { display:none; }
        #sbc-opt-batch-preview, #sbc-opt-batch-detail-body {
            background:var(--pt-surface); border:1px solid var(--pt-line);
            border-radius:var(--pt-r-m);
            padding:10px 12px; margin-top:8px; font-size:12px; line-height:1.5;
            max-height:340px; overflow-y:auto; overscroll-behavior: contain;
            scrollbar-width: thin; scrollbar-color: var(--pt-line-2) transparent;
        }
        /* Chromium ignoriert scrollbar-width (Firefox-Eigenschaft) - ohne
           die webkit-Regeln zeichnet es in die Kaesten seine Standard-Leiste,
           waehrend das Panel drumherum die dunkle schmale hat. */
        #sbc-opt-batch-preview::-webkit-scrollbar,
        #sbc-opt-batch-detail-body::-webkit-scrollbar { width: 10px; }
        #sbc-opt-batch-preview::-webkit-scrollbar-track,
        #sbc-opt-batch-detail-body::-webkit-scrollbar-track { background: transparent; }
        #sbc-opt-batch-preview::-webkit-scrollbar-thumb,
        #sbc-opt-batch-detail-body::-webkit-scrollbar-thumb {
            background: var(--pt-line-2); border-radius: 6px;
            border: 3px solid var(--pt-surface);
        }
        #sbc-opt-batch-details { margin-top:8px; }
        .sbc-opt-batch-round { padding:4px 0; border-bottom:1px solid var(--pt-line-soft); }
        .sbc-opt-batch-round:last-child { border-bottom:none; }
        .sbc-opt-batch-round b { color:var(--pt-accent); }
        .sbc-opt-batch-warn { color:var(--pt-warn-2); }
        .sbc-opt-batch-bad { color:var(--pt-bad); }
        /* Knopf an EAs Pack-Kachel. Bewusst erkennbar ANDERS als EAs eigene
           Knoepfe (unsere Akzentfarbe), damit niemand ihn mit "Open"
           verwechselt - er oeffnet ALLE Packs des Typs. */
        /* Zwei Knoepfe in einer Reihe, rechtsbuendig unter EAs Open-Knopf. */
        .sbc-opt-tilebtn-row {
            display:flex; justify-content:flex-end; gap:6px;
            margin:10px 0 2px; flex-wrap:wrap;
        }
        .sbc-opt-tilebtn {
            /* EIGENE ZEILE unter EAs Open-Knopf, rechtsbuendig (margin-left:auto),
               klein und gedaempft. Rasmus: "der standardfall ist immer noch,
               dass ich einfach nur einzeln oeffnen will ... mit ein bisschen
               margin, damit man nicht aus versehen drauf klickt". Der Abstand
               ist Absicht, nicht Kosmetik: der Knopf oeffnet ALLE Packs eines
               Typs. */
            display:block; margin:0; width:auto;
            background:transparent; color:#8fc3f0;
            border:1px solid #2f5878; border-radius:var(--pt-r-s);
            padding:4px 9px; font-size:11px; font-weight:600;
            font-family:var(--pt-font); line-height:1.3;
            cursor:pointer; opacity:.75;
            transition: opacity .12s ease, background .12s ease, transform .06s ease;
        }
        .sbc-opt-tilebtn:hover:not(:disabled) {
            opacity:1; background:var(--pt-sel); color:#fff; border-color:#3d8ad6;
        }
        /* ABSTOSSEN ist unumkehrbar - der Knopf sieht anders aus als der
           harmlose daneben, damit man sie nicht verwechselt. */
        .sbc-opt-tilebtn.danger { color:#f0a19a; border-color:#7a3a33; }
        .sbc-opt-tilebtn.danger:hover:not(:disabled) {
            background:var(--pt-danger); color:#fff; border-color:#d4452f;
        }
        .sbc-opt-tilebtn:active:not(:disabled) { transform: translateY(1px); }
        .sbc-opt-tilebtn:disabled { opacity:.5; cursor:not-allowed; }
        /* ------------------------------------------------------------------
           SEGMENT-SCHALTER
           ------------------------------------------------------------------ */
        /* (Rasmus: "das kann man optisch schoener loesen".) Eine Leiste, die
           Werte teilen sich die Breite gleichmaessig, der aktive ist gefuellt.
           34px hoch - am Handy war die alte Chip-Zeile mit 24px an der Grenze;
           40 wie bei den Hauptknoepfen waere hier zu wuchtig, weil drei
           nebeneinander stehen. */
        .sbc-opt-chips {
            display:flex; gap:3px; margin:0 0 10px; align-items:stretch;
            background:var(--pt-sunken); border:1px solid var(--pt-line-2);
            border-radius:9px; padding:3px;
        }
        /* Leer (noch nicht gerendert) soll die Leiste nicht als leerer Kasten
           herumstehen. */
        .sbc-opt-chips:empty { display:none; }
        .sbc-opt-chip {
            flex:1 1 0; min-width:0; background:transparent; color:var(--pt-muted);
            border:none; border-radius:var(--pt-r-s); padding:0 6px; min-height:34px;
            font-size:13px; font-weight:600; font-family:inherit;
            cursor:pointer; line-height:34px; text-align:center;
            transition:background .12s ease, color .12s ease;
        }
        .sbc-opt-chip:hover { background:var(--pt-hover); color:var(--pt-text); }
        .sbc-opt-chip:active { transform: translateY(1px); }
        .sbc-opt-chip.on { background:var(--pt-sel); color:#fff; }
        .sbc-opt-chip.on:hover { background:var(--pt-sel-hi); }
        /* ✎ ist der Notausgang, nicht die Hauptsache: schmal und gedaempft,
           aber am Ende DERSELBEN Leiste - nicht als vierter Wert. */
        .sbc-opt-chip.edit {
            /* .65 statt .5: am Handy gibt es kein Hover, das den Knopf
               aufhellt - mit .5 war der Notausgang kaum zu finden. */
            flex:0 0 34px; opacity:.65; font-size:12px;
            border-left:1px solid var(--pt-line-soft); border-radius:0 var(--pt-r-s) var(--pt-r-s) 0;
        }
        .sbc-opt-chip.edit:hover { opacity:1; background:var(--pt-hover); }
        .sbc-opt-chipedit { display:none; gap:6px; margin:0 0 10px; }
        .sbc-opt-chipedit input { flex:1; }
        .sbc-opt-chipedit .sbc-opt-btn {
            margin:0; width:auto; flex:0 0 auto; padding:8px 14px; min-height:38px;
        }
        /* Beschriftung ueber dem Schalter: eigene Zeile, damit sie nicht
           neben einem Feld auf zwei Zeilen umbricht. */
        .sbc-opt-chiplabel {
            display:block; margin:0 0 6px; color:var(--pt-muted); font-size:12px;
        }
        /* ------------------------------------------------------------------
           KARTEN-LISTEN
           ------------------------------------------------------------------ */
        .sbc-opt-batch-cards { margin:4px 0 2px; }
        .sbc-opt-batch-card {
            font-size:11px; color:var(--pt-text-2); padding:2px 0;
            white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        }
        .sbc-opt-batch-card .r {
            display:inline-block; min-width:22px; font-weight:700; color:var(--pt-text);
        }
        .sbc-opt-batch-card .src { color:var(--pt-faint); }
        .sbc-opt-batch-card .rar { color:var(--pt-muted); }
        .sbc-opt-batch-card .untr { color:var(--pt-faint); font-style:italic; }
        .sbc-opt-batch-card.prot .rar { color:var(--pt-warn-2); font-weight:700; }
        .sbc-opt-result {
            /* surface wie die Batch-Vorschau: gleiche Rolle (Ergebnis-Kasten),
               gleiche Flaeche. sunken ist fuer EINGABEN reserviert. */
            margin-top:12px; background:var(--pt-surface); border:1px solid var(--pt-line);
            border-radius:var(--pt-r-m); padding:10px; display:none;
        }
        .sbc-opt-result.show { display:block; }
        .sbc-opt-player {
            display:flex; justify-content:space-between; align-items:center;
            padding:5px 2px; border-bottom:1px solid var(--pt-line-soft);
        }
        .sbc-opt-player:last-child { border-bottom:none; }
        .sbc-opt-badge {
            background:var(--pt-accent); color:var(--pt-on-accent); font-weight:700;
            border-radius:5px; padding:2px 8px; font-size:12px; min-width:26px; text-align:center;
        }
        .sbc-opt-badge.special { background:var(--pt-warn); }
        .sbc-opt-badge.storage { outline:2px solid var(--pt-accent-2); }
        .sbc-opt-summary { margin:10px 0 4px; font-size:14px; }
        .sbc-opt-summary b { color:var(--pt-accent); }
        .sbc-opt-warn { color:var(--pt-warn); font-size:12px; margin-top:6px; }
        /* ------------------------------------------------------------------
           RATING-KOSTEN-TABELLE
           ------------------------------------------------------------------ */
        .sbc-opt-bandhead, .sbc-opt-bandrow {
            /* Loesch-Spalte 32 statt 26px: dieselbe Klasse Befund wie die
               29px-Nachlade-Knoepfe (v5.3.0), nur hinter "Erweiterte
               Einstellungen" versteckt. */
            display:grid; grid-template-columns: 16px 1fr 1fr 1fr 32px; gap:4px;
            align-items:center; margin-bottom:4px;
        }
        .sbc-opt-bandhead span { color:var(--pt-faint); font-size:11px; }
        .sbc-opt-bandrow input {
            width:100%; background:var(--pt-sunken); color:var(--pt-text);
            border:1px solid var(--pt-line-2); border-radius:var(--pt-r-s);
            padding:6px; font-size:12px;
        }
        .sbc-opt-bandrow button {
            background:var(--pt-raised); color:var(--pt-bad-2); border:none;
            border-radius:var(--pt-r-s);
            cursor:pointer; padding:8px 0; font-size:12px; font-family:inherit;
        }
        .sbc-opt-bandrow button:hover { background:var(--pt-raised-hi); }
        .sbc-opt-bandrow .sbc-opt-draghandle {
            color:var(--pt-faint); cursor:grab; user-select:none; text-align:center;
            font-size:13px; line-height:1;
        }
        .sbc-opt-bandrow.sbc-opt-dragover { outline:2px dashed var(--pt-accent); border-radius:var(--pt-r-s); }
        .sbc-opt-bandrow.sbc-opt-bandinvalid { outline:2px solid var(--pt-bad-2); border-radius:var(--pt-r-s); }
        /* ------------------------------------------------------------------
           TOASTS
           ------------------------------------------------------------------ */
        #sbc-opt-toast-wrap {
            position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
            z-index: 1000000; display:flex; flex-direction:column; gap:8px; align-items:center;
            /* Durchklickbar: der Streifen liegt vor EAs Oberflaeche, und ein
               Toast darf keinen Tap abfangen. */
            pointer-events: none;
        }
        .sbc-opt-toast {
            background:var(--pt-surface); color:var(--pt-text); border:1px solid var(--pt-line-2);
            border-left:4px solid var(--pt-accent); padding:11px 16px; border-radius:var(--pt-r-m);
            font-family:var(--pt-font); font-size:13px; box-shadow:0 4px 20px rgba(0,0,0,.5);
            max-width:min(80vw, 460px); line-height:1.45;
        }
        .sbc-opt-toast.error { border-left-color:var(--pt-bad-2); }
        .sbc-opt-toast.warn { border-left-color:var(--pt-warn); }
        /* ------------------------------------------------------------------
           RUHE-EINSTELLUNG DES GERAETS RESPEKTIEREN
           ------------------------------------------------------------------ */
        @media (prefers-reduced-motion: reduce) {
            #sbc-opt-panel.open { animation: none; }
            #sbc-opt-fab, .sbc-opt-btn, .sbc-opt-chip, .sbc-opt-queuerow,
            .sbc-opt-tilebtn, #sbc-opt-progress .p-fill,
            #sbc-opt-panel input, #sbc-opt-panel select,
            .sbc-opt-details-toggle summary, #sbc-opt-close {
                transition: none;
            }
            #sbc-opt-fab:hover, #sbc-opt-fab:active,
            .sbc-opt-btn:active:not(:disabled), .sbc-opt-chip:active,
            .sbc-opt-tilebtn:active:not(:disabled) { transform: none; }
        }
        `;
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }
    /**
     * Wie lange steht ein Toast? Vorher: 3,8s fuer ALLES - auch fuer einen
     * Fehlertext mit 150 Zeichen Deutsch. Fehler sind aber genau die
     * Meldungen, die gelesen werden muessen (die Batch-Vorschau haelt ihren
     * Zustand ueberhaupt nur fest, WEIL der Toast so schnell weg ist).
     * Jetzt: Grunddauer nach Typ, plus Lesezeit nach Laenge (~45ms/Zeichen
     * entspricht gemuetlichen 200 Woertern/Minute), Deckel bei 15s.
     * Reine Funktion - die Zahl ist sonst nirgends nachpruefbar.
     */
    function toastDuration(msg, type) {
        const len = String(msg == null ? '' : msg).length;
        const base = (type === 'error') ? 7000 : (type === 'warn') ? 5000 : 3800;
        return Math.min(15000, Math.max(base, 1500 + len * 45));
    }
    /**
     * Wie viele der sichtbaren Toasts muessen weichen, damit ein neuer Platz
     * hat? Deckel 3: seit die Dauern nach Typ/Laenge skalieren (v5.3.0),
     * stapeln sich Toasts real - die Reihe meldet uebersprungene Challenges
     * als einzelne Warnungen, und drei lange verdecken die halbe Ansicht.
     * Der AELTESTE fliegt: er hatte am meisten Lesezeit.
     * Rein (nur die Anzahl kommt herein), damit die Regel testbar ist.
     */
    function toastOverflow(visibleCount) {
        const MAX = 3;
        const n = Number(visibleCount);
        if (!isFinite(n) || n < MAX) return 0;
        return (n - MAX) + 1;
    }
    function toast(msg, type) {
        let wrap = document.getElementById('sbc-opt-toast-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'sbc-opt-toast-wrap';
            document.body.appendChild(wrap);
        }
        try {
            let weg = toastOverflow(wrap.children.length);
            while (weg-- > 0 && wrap.firstChild) wrap.removeChild(wrap.firstChild);
        } catch (e) {}
        const t = document.createElement('div');
        t.className = 'sbc-opt-toast ' + (type || '');
        t.textContent = msg;
        wrap.appendChild(t);
        const ms = toastDuration(msg, type);
        setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, ms);
        setTimeout(() => { try { wrap.removeChild(t); } catch (e) {} }, ms + 500);
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
                    SBC-Kontingent: <b id="sbc-opt-quota">–</b><br>
                    Status: <b id="sbc-opt-status">bereit</b>
                    <div id="sbc-opt-availability"></div>
                    <div class="sbc-opt-debug" id="sbc-opt-debug">API: – · SID: – · Services: –</div>
                </div>
                <button class="sbc-opt-btn ghost" id="sbc-opt-load">Spieler laden</button>
                <div class="sbc-opt-row" style="margin-bottom:0;">
                    <label class="sbc-opt-chiplabel">Min. Rating pro Spieler</label>
                    <div class="sbc-opt-chips" id="sbc-opt-minrating-chips"></div>
                    <div class="sbc-opt-chipedit sbc-opt-inline" id="sbc-opt-minrating-edit">
                        <input type="text" id="sbc-opt-minrating-editval" placeholder="75, 85">
                        <button class="sbc-opt-btn ghost" id="sbc-opt-minrating-editok">OK</button>
                    </div>
                    <!-- Das Zahlenfeld steht ZULETZT: es ist der Notausgang und
                         normalerweise versteckt (chipFieldVisible, v4.93.0). -->
                    <input type="number" id="sbc-opt-minrating" value="75" min="1" max="99"
                           style="margin-bottom:12px;">
                </div>
                <details id="sbc-opt-advanced" class="sbc-opt-details-toggle">
                    <summary>Erweiterte Einstellungen</summary>
                <div class="sbc-opt-group-title">Kartenwahl</div>
                <div class="sbc-opt-row">
                    <label class="sbc-opt-toggle">
                        <input type="checkbox" id="sbc-opt-maxrating-en">
                        Max. Rating pro Spieler begrenzen
                    </label>
                    <div class="sbc-opt-inline" style="margin-top:6px;">
                        <input type="number" id="sbc-opt-maxrating" value="85" min="1" max="99" title="Max. Rating">
                        <span class="sbc-opt-muted">OVR</span>
                    </div>
                </div>
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
                        <input type="checkbox" id="sbc-opt-uselocks" checked>
                        Gesperrte Karten (PaleTools-Schloss) nie verbauen
                    </label>
                </div>
                <div class="sbc-opt-row">
                    <label class="sbc-opt-toggle">
                        <input type="checkbox" id="sbc-opt-poolcache" checked>
                        Verein zwischenspeichern (nach Neuladen sofort da)
                    </label>
                </div>
                <div class="sbc-opt-row">
                    <label>Gold-SBCs ohne Ziel-OVR: höchstes Rating für Rare / für Common
                        (Rare darüber bleibt für Rating-SBCs)</label>
                    <div class="sbc-opt-inline">
                        <span class="sbc-opt-dim" style="font-size:11px;">Rare bis</span>
                        <input type="number" id="sbc-opt-maxrare" value="77" min="0" max="99">
                        <span class="sbc-opt-dim" style="font-size:11px;">Common bis</span>
                        <input type="number" id="sbc-opt-maxcommon" value="77" min="0" max="99">
                    </div>
                </div>
                <div class="sbc-opt-group-title">Schonen &amp; Verbrauchen</div>
                <div class="sbc-opt-row sbc-opt-compact">
                    <label>Seltene Club-Karten schonen</label>
                    <select id="sbc-opt-scarcity">
                        <option value="0">Aus (nur Waste zählt)</option>
                        <option value="8">Leicht</option>
                        <option value="18" selected>Normal</option>
                        <option value="35">Stark</option>
                    </select>
                </div>
                <div class="sbc-opt-row">
                    <label>Max. Rating-Überschuss über Minimum (z.B. 0.10 = bis 84.10 statt
                        84.00). Steht praktisch immer auf 0 - deshalb hier unten.</label>
                    <input type="number" id="sbc-opt-maxwaste" value="0.00" min="0" max="2" step="0.01">
                </div>
                <div class="sbc-opt-row sbc-opt-compact">
                    <label>Rarity-Schutz: was ist hart geschützt?</label>
                    <select id="sbc-opt-raritymode">
                        <option value="vereinTotw" selected>Nur TOTW aus dem Verein</option>
                        <option value="gruppe83">Ganze Gruppe (TOTW/TOTS/FOF/FUTTIES)</option>
                        <option value="aus">Nichts</option>
                    </select>
                </div>
                <div class="sbc-opt-row sbc-opt-compact">
                    <label>Stärke des harten Schutzes</label>
                    <select id="sbc-opt-rarityguard">
                        <option value="0">Aus</option>
                        <option value="4">Leicht</option>
                        <option value="8" selected>Normal</option>
                        <option value="20">Stark</option>
                    </select>
                </div>
                <div class="sbc-opt-row sbc-opt-compact">
                    <label>Aufschlag für Storage-TOTW (nicht unnötig verbauen)</label>
                    <select id="sbc-opt-totwsoft">
                        <option value="0">Aus</option>
                        <option value="4">Leicht</option>
                        <option value="8" selected>Normal</option>
                        <option value="20">Stark</option>
                    </select>
                </div>
                <div class="sbc-opt-row sbc-opt-compact">
                    <label>Aufschlag für Storage-Specials (Gold zuerst)</label>
                    <select id="sbc-opt-specialsoft">
                        <option value="0">Aus (Gold und Special gleich)</option>
                        <option value="1" selected>Klein (Gold zuerst)</option>
                        <option value="4">Deutlich</option>
                    </select>
                </div>
                <div class="sbc-opt-row sbc-opt-compact">
                    <label>Storage-Karten bevorzugt verbrauchen</label>
                    <select id="sbc-opt-storagebonus">
                        <option value="0">Aus</option>
                        <option value="1">Leicht</option>
                        <option value="2" selected>Normal</option>
                        <option value="4">Stark</option>
                    </select>
                </div>
                <div class="sbc-opt-row sbc-opt-compact">
                    <label>Unverkäufliche Karten zuerst verbauen (spart Coins)</label>
                    <select id="sbc-opt-untradeable">
                        <option value="0">Aus</option>
                        <option value="1">Leicht</option>
                        <option value="3" selected>Normal</option>
                        <option value="6">Stark</option>
                    </select>
                </div>
                <div class="sbc-opt-group-title">Rating-Kosten</div>
                <div class="sbc-opt-row">
                    <label>Rating-Kosten (höher = Karten dieser Stufe mehr schonen)</label>
                    <div class="sbc-opt-bandhead"><span></span><span>von</span><span>bis</span><span>Kosten</span><span></span></div>
                    <div id="sbc-opt-bands"></div>
                    <div class="sbc-opt-inline" style="margin-top:4px;">
                        <button class="sbc-opt-btn ghost" id="sbc-opt-band-add" style="margin:0;padding:5px;">+ Stufe</button>
                        <button class="sbc-opt-btn ghost" id="sbc-opt-band-reset" style="margin:0;padding:5px;">Zurücksetzen</button>
                    </div>
                </div>
                <div class="sbc-opt-group-title">Vorgabe-Karte übersteuern</div>
                <div class="sbc-opt-row">
                    <label>Karte für Rarity-Vorgabe (z.B. TOTW/FUTTIES) - übersteuert die Automatik</label>
                    <input type="text" id="sbc-opt-raritypick-filter" placeholder="Name filtern..." style="margin-bottom:6px;">
                    <select id="sbc-opt-raritypick"><option value="">– automatisch wählen –</option></select>
                </div>
                </details>
                <button class="sbc-opt-btn primary" id="sbc-opt-run">Optimieren + Eintragen</button>
                <div class="sbc-opt-result" id="sbc-opt-result"></div>
                <!-- SBC-REIHE: verschiedene Challenges EINES Sets nacheinander.
                     Nur sichtbar, wenn das offene Set mehr als eine Challenge
                     hat (syncQueueSection()). Vorschau, Plan-Check und die
                     Freigabe sind dieselben wie beim Batch - derselbe Plan,
                     nur mode:'reihe'. -->
                <div class="sbc-opt-batch sbc-opt-hidden" id="sbc-opt-queuesection">
                    <div class="sbc-opt-inline" style="margin-bottom:7px;">
                        <!-- Modul-Titel wie "Pack-Opener (Store)" - vorher stand
                             hier ein graues Feld-Label neben einem
                             Grossbuchstaben-Akzent-Titel derselben Ebene. -->
                        <div class="sbc-opt-group-title" style="margin:0;flex:1;">SBCs in diesem Set</div>
                        <button class="sbc-opt-btn ghost" id="sbc-opt-queue-refresh"
                                title="Liste neu laden"
                                style="margin:0;padding:4px 9px;width:auto;flex:0 0 auto;">↻</button>
                    </div>
                    <div id="sbc-opt-queue-list"></div>
                    <button class="sbc-opt-btn plan" id="sbc-opt-queue-plan">Angehakte planen (Vorschau)</button>
                </div>
                <!-- BATCH: dieselbe SBC mehrfach. Zwei Schritte - erst planen und
                     ansehen, dann EINE Freigabe für den ganzen Lauf. -->
                <div class="sbc-opt-batch">
                    <label class="sbc-opt-chiplabel">SBC mehrfach abschließen</label>
                    <div class="sbc-opt-chips" id="sbc-opt-batch-chips"></div>
                    <div class="sbc-opt-chipedit sbc-opt-inline" id="sbc-opt-batch-edit">
                        <input type="text" id="sbc-opt-batch-editval" placeholder="3, 5, 10">
                        <button class="sbc-opt-btn ghost" id="sbc-opt-batch-editok">OK</button>
                    </div>
                    <!-- Zahlenfeld zuletzt und normalerweise versteckt, s.o. -->
                    <input type="number" id="sbc-opt-batch-count" value="5" min="1" max="10"
                           style="margin-bottom:10px;">
                    <button class="sbc-opt-btn plan" id="sbc-opt-batch-plan">Teams planen (Vorschau)</button>
                </div>
                <!-- VORSCHAU + FREIGABE fuer BEIDE Plan-Sorten (Batch und
                     SBC-Reihe). Steht bewusst UNTER beiden Abschnitten: die
                     Vorschau gehoert hinter den Knopf, der sie erzeugt hat.
                     Ticket #73: Zusammenfassung (Confidence + Klartext-
                     Abweichungen) zuerst, direkt darunter die Freigabe,
                     Kartendetails erst aufgeklappt. -->
                <div class="sbc-opt-batch sbc-opt-hidden" id="sbc-opt-planresult">
                    <div id="sbc-opt-batch-preview"></div>
                    <button class="sbc-opt-btn danger" id="sbc-opt-batch-run" style="display:none;">
                        Alle eintragen + abgeben
                    </button>
                    <details id="sbc-opt-batch-details" class="sbc-opt-details-toggle" style="display:none;">
                        <summary id="sbc-opt-batch-detail-summary">Teams im Detail (0)</summary>
                        <div id="sbc-opt-batch-detail-body"></div>
                    </details>
                </div>
                <!-- PACK-OPENER (Store, Ticket #69/#76): nur in der Store-Ansicht
                     sichtbar (syncPackSection()) - Pack-Oeffnen ist unumkehrbar,
                     "Alle oeffnen" stoppt deshalb beim ERSTEN Fehler jeder Art. -->
                <div class="sbc-opt-batch sbc-opt-hidden" id="sbc-opt-packsection">
                    <div class="sbc-opt-group-title" style="margin-top:0;">Pack-Opener (Store)</div>
                    <div class="sbc-opt-inline" style="margin-bottom:8px;">
                        <select id="sbc-opt-pack-type" style="flex:1;">
                            <option value="">– Aktualisieren drücken –</option>
                        </select>
                        <button class="sbc-opt-btn ghost" id="sbc-opt-pack-refresh"
                                title="Pack-Liste neu laden"
                                style="margin:0;padding:6px 10px;width:auto;flex:0 0 auto;">↻</button>
                    </div>
                    <!-- "Test: 1 Pack oeffnen" ist weg (Rasmus: "brauchen wir auch
                         nicht mehr, 'Alle oeffnen' reicht vollkommen"). Wer einen
                         Testlauf will, traegt bei Anzahl eine 1 ein. -->
                    <div class="sbc-opt-compact" style="margin-top:2px;margin-bottom:8px;">
                        <label>Anzahl (leer = alle)</label>
                        <input type="number" id="sbc-opt-pack-count" min="1"
                               style="width:72px;flex:0 0 auto;" placeholder="alle">
                    </div>
                    <!-- Was mit den Karten passiert - als Segment-Schalter, wie
                         die Schnellwahl oben. Sichtbar statt in einem zweiten
                         Knopf versteckt: "Verwerten" ist unumkehrbar. -->
                    <label class="sbc-opt-chiplabel">Nach dem Öffnen</label>
                    <div class="sbc-opt-chips" id="sbc-opt-pack-mode"></div>
                    <div id="sbc-opt-pack-modehint" class="sbc-opt-debug"></div>
                    <button class="sbc-opt-btn danger" id="sbc-opt-pack-all">Alle öffnen</button>
                    <div id="sbc-opt-pack-result"></div>
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
            quota: panel.querySelector('#sbc-opt-quota'),
            availability: panel.querySelector('#sbc-opt-availability'),
            status: panel.querySelector('#sbc-opt-status'),
            debug: panel.querySelector('#sbc-opt-debug'),
            minrating: panel.querySelector('#sbc-opt-minrating'),
            minratingChips: panel.querySelector('#sbc-opt-minrating-chips'),
            minratingEdit: panel.querySelector('#sbc-opt-minrating-edit'),
            minratingEditVal: panel.querySelector('#sbc-opt-minrating-editval'),
            minratingEditOk: panel.querySelector('#sbc-opt-minrating-editok'),
            maxwaste: panel.querySelector('#sbc-opt-maxwaste'),
            applyrarity: panel.querySelector('#sbc-opt-applyrarity'),
            specialstorage: panel.querySelector('#sbc-opt-specialstorage'),
            maxRatingEn: panel.querySelector('#sbc-opt-maxrating-en'),
            maxRatingVal: panel.querySelector('#sbc-opt-maxrating'),
            scarcity: panel.querySelector('#sbc-opt-scarcity'),
            storagebonus: panel.querySelector('#sbc-opt-storagebonus'),
            untradeable: panel.querySelector('#sbc-opt-untradeable'),
            maxRare: panel.querySelector('#sbc-opt-maxrare'),
            maxCommon: panel.querySelector('#sbc-opt-maxcommon'),
            useLocks: panel.querySelector('#sbc-opt-uselocks'),
            poolCacheBox: panel.querySelector('#sbc-opt-poolcache'),
            rarityguard: panel.querySelector('#sbc-opt-rarityguard'),
            raritymode: panel.querySelector('#sbc-opt-raritymode'),
            totwsoft: panel.querySelector('#sbc-opt-totwsoft'),
            specialsoft: panel.querySelector('#sbc-opt-specialsoft'),
            bands: panel.querySelector('#sbc-opt-bands'),
            bandAdd: panel.querySelector('#sbc-opt-band-add'),
            bandReset: panel.querySelector('#sbc-opt-band-reset'),
            rarityPickFilter: panel.querySelector('#sbc-opt-raritypick-filter'),
            rarityPick: panel.querySelector('#sbc-opt-raritypick'),
            load: panel.querySelector('#sbc-opt-load'),
            run: panel.querySelector('#sbc-opt-run'),
            result: panel.querySelector('#sbc-opt-result'),
            diagBtn: panel.querySelector('#sbc-opt-diag'),
            batchCount: panel.querySelector('#sbc-opt-batch-count'),
            batchChips: panel.querySelector('#sbc-opt-batch-chips'),
            batchEdit: panel.querySelector('#sbc-opt-batch-edit'),
            batchEditVal: panel.querySelector('#sbc-opt-batch-editval'),
            batchEditOk: panel.querySelector('#sbc-opt-batch-editok'),
            batchPlan: panel.querySelector('#sbc-opt-batch-plan'),
            batchPreview: panel.querySelector('#sbc-opt-batch-preview'),
            batchRun: panel.querySelector('#sbc-opt-batch-run'),
            batchDetails: panel.querySelector('#sbc-opt-batch-details'),
            batchDetailSummary: panel.querySelector('#sbc-opt-batch-detail-summary'),
            batchDetailBody: panel.querySelector('#sbc-opt-batch-detail-body'),
            planResult: panel.querySelector('#sbc-opt-planresult'),
            queueSection: panel.querySelector('#sbc-opt-queuesection'),
            queueList: panel.querySelector('#sbc-opt-queue-list'),
            queueRefresh: panel.querySelector('#sbc-opt-queue-refresh'),
            queuePlan: panel.querySelector('#sbc-opt-queue-plan'),
            packSection: panel.querySelector('#sbc-opt-packsection'),
            packType: panel.querySelector('#sbc-opt-pack-type'),
            packRefresh: panel.querySelector('#sbc-opt-pack-refresh'),
            packModeBox: panel.querySelector('#sbc-opt-pack-mode'),
            packModeHint: panel.querySelector('#sbc-opt-pack-modehint'),
            packCount: panel.querySelector('#sbc-opt-pack-count'),
            packAll: panel.querySelector('#sbc-opt-pack-all'),
            packResult: panel.querySelector('#sbc-opt-pack-result')
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
        ui.diagBtn.addEventListener('click', onDiagClick);
        // Schnellwahl aufbauen und mit den Feldern verbinden. Tippt Rasmus von
        // Hand einen Wert, aktualisiert sich nur die Hervorhebung - der Wert
        // wird NICHT ueberschrieben.
        renderChips('minrating', ui.minratingChips, ui.minrating, ui.minratingEdit);
        renderChips('batch', ui.batchChips, ui.batchCount, ui.batchEdit);
        ui.minrating.addEventListener('input', function () {
            renderChips('minrating', ui.minratingChips, ui.minrating, ui.minratingEdit);
        });
        ui.batchCount.addEventListener('input', function () {
            renderChips('batch', ui.batchChips, ui.batchCount, ui.batchEdit);
        });
        ui.minratingEditOk.addEventListener('click', function () {
            applyChipEdit('minrating', ui.minratingChips, ui.minrating,
                          ui.minratingEdit, ui.minratingEditVal);
        });
        ui.batchEditOk.addEventListener('click', function () {
            applyChipEdit('batch', ui.batchChips, ui.batchCount,
                          ui.batchEdit, ui.batchEditVal);
        });
        ui.batchPlan.addEventListener('click', onBatchPlanClick);
        ui.batchRun.addEventListener('click', onBatchRunClick);
        ui.queueRefresh.addEventListener('click', function () {
            queueTriedSet = null;
            queueLoadError = null;
            // VON HAND: hier hat Rasmus gefragt und erwartet eine Antwort -
            // ein Fehlschlag wird also laut gemeldet. Geholt wird das Set,
            // das er ANSIEHT, nicht das zuletzt erkannte.
            loadQueueList(true, false, detectViewedSetId());
        });
        ui.queuePlan.addEventListener('click', onQueuePlanClick);
        renderPackMode();
        ui.packRefresh.addEventListener('click', onPackRefreshClick);
        ui.packAll.addEventListener('click', onPackAllClick);
        ui.rarityPickFilter.addEventListener('input', renderRarityPickOptions);
        // Zustand der "Erweiterte Einstellungen" merken
        const adv = panel.querySelector('#sbc-opt-advanced');
        try { if (localStorage.getItem('sbcOptAdvancedOpen') === '1') adv.open = true; } catch (e) {}
        adv.addEventListener('toggle', function () {
            try { localStorage.setItem('sbcOptAdvancedOpen', adv.open ? '1' : '0'); }
            catch (e) { reportError('Erweiterte-Einstellungen-Zustand speichern fehlgeschlagen', e); }
        });
        initBandEditor();
        refreshSbcInfoUI();
        refreshDiagUI();
    }
    // ---- Rating-Kosten Band-Editor ------------------------------------------
    let ratingBands = [];
    // [BANDS-BEGIN]
    // Leitet die Reset-Bänder aus SolverCore.DEFAULT_RATING_COST_SPEC ab (SSOT,
    // siehe LEARNINGS §10) statt sie als zweites Literal zu pflegen: eine
    // Bandgrenze entsteht überall dort, wo sich der geparste Kostenwert ändert.
    function defaultBands() {
        const costOf = SolverCore.parseRatingCosts(SolverCore.DEFAULT_RATING_COST_SPEC);
        const bands = [];
        let lo = 0, cost = costOf(0);
        for (let r = 1; r <= 99; r++) {
            const c = costOf(r);
            if (c !== cost) {
                bands.push({ lo: lo, hi: r - 1, cost: cost });
                lo = r; cost = c;
            }
        }
        bands.push({ lo: lo, hi: 99, cost: cost });
        return bands;
    }
    // Kehrfunktion zu parseRatingCosts(): die Kurzformen (lo===hi bzw. hi===99)
    // sind Pflicht, damit bandsToSpec(defaultBands()) exakt den Wortlaut von
    // DEFAULT_RATING_COST_SPEC ergibt (Drift-Wächter in solver-test.js).
    function bandsToSpec(bands) {
        return bands
            .filter(b => b.lo != null && b.hi != null && b.cost != null)
            .map(function (b) {
                if (b.lo === b.hi) return b.lo + ':' + b.cost;
                if (b.hi >= 99) return b.lo + '+:' + b.cost;
                return b.lo + '-' + b.hi + ':' + b.cost;
            })
            .join(', ');
    }
    // [BANDS-END]
    function saveBands() {
        try { localStorage.setItem('sbcOptRatingBands', JSON.stringify(ratingBands)); }
        catch (e) { reportError('Rating-Bänder speichern fehlgeschlagen', e); }
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
            if (band.lo > band.hi) row.classList.add('sbc-opt-bandinvalid');
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
                // parseRatingCosts() überspringt lo>hi lautlos (die Schleife
                // läuft dann nie) - eigene Fachentscheidung, keine EA-Grenze,
                // also sichtbares Feedback statt stillem No-Op.
                const invalid = band.lo > band.hi;
                row.classList.toggle('sbc-opt-bandinvalid', invalid);
                if (invalid) {
                    warn('Rating-Kosten-Band ' + band.lo + '-' + band.hi + ' ist ungültig (lo>hi) und wirkt nicht.');
                    toast('Band ' + band.lo + '-' + band.hi + ' ist ungültig (lo>hi) und wird ignoriert.', 'warn');
                }
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
            } catch (e) { reportError('Panel-Position speichern fehlgeschlagen (' + posKey + ')', e); }
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
    let containerFallbackUsed = 0;
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
        const fallback = sbcButtonContainerByText();
        if (fallback) containerFallbackUsed++;
        return fallback;
    }
    /**
     * Fallback, falls EA `.sbc-button-container` umbenennt: sucht sichtbare
     * Buttons ueber ihren Text (dasselbe Muster wie `buttonDump` in
     * buildDiagReport(), dort nur Diagnose, kein Fallback-Versuch). Nur die
     * drei Begriffe der SBC-Aktionsleiste - ein Fehltreffer ist nicht
     * schlimmer als der heutige Status quo (Container bleibt null, FAB bleibt
     * Rueckfallweg). Matchen mehrere Buttons auf UNTERSCHIEDLICHE
     * Elternknoten, ist der Container nicht sicher bestimmbar - null statt
     * zu raten.
     */
    function sbcButtonContainerByText() {
        try {
            const btns = document.querySelectorAll('button');
            let hit = null;
            for (let i = 0; i < btns.length; i++) {
                const b = btns[i];
                if (!(b.offsetParent !== null || b.getClientRects().length)) continue;
                if (!/squad builder|clear squad|exchange/i.test((b.textContent || '').trim())) continue;
                const parent = b.parentNode;
                if (!parent) continue;
                if (hit && hit !== parent) return null;
                hit = parent;
            }
            return hit;
        } catch (e) { return null; }
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
        // Zusaetzlich zur SBC-Ansicht bleibt der Einstieg auch in der
        // Store-Ansicht sichtbar (Pack-Opener, Ticket #69) - sonst waere die
        // Pack-Sektion nie erreichbar, weil Panel/FAB sonst komplett
        // verschwinden. Der eingehaengte Button in der SBC-Aktionsleiste
        // bleibt SBC-spezifisch (dort gibt es keine .sbc-button-container).
        if (!inSbcView() && !inStoreView()) {
            if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
            ui.fab.classList.add('sbc-opt-hidden');
            if (ui.panel.classList.contains('open')) togglePanel();
            return;
        }
        ui.fab.classList.remove('sbc-opt-hidden');
        const cont = inSbcView() ? sbcButtonContainer() : null;
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
    // ======================================================================
    //  SCHNELLWAHL (Chips) fuer Min-Rating und Batch-Anzahl
    // ======================================================================
    // Rasmus nimmt fast immer dieselben Werte (75 fuer 84er-Teams, 85 fuer
    // 88+; 3/5/10 Wiederholungen) und musste jedes Mal ins Zahlenfeld tippen.
    // Die Chips setzen den Wert mit einem Tipp; das Feld bleibt frei
    // editierbar, und die Chip-Werte selbst sind ueber "✎" anpassbar (kein
    // window.prompt - das ist in der WebView nicht verlaesslich, sondern ein
    // eingebettetes Textfeld).
    const CHIP_SETS = {
        minrating: { key: 'sbcOptChipsMinrating', def: [75, 85], min: 1, max: 99 },
        batch: { key: 'sbcOptChipsBatch', def: [3, 5, 10], min: 1, max: 10 }
    };
    function chipValues(name) {
        const spec = CHIP_SETS[name];
        try {
            const raw = localStorage.getItem(spec.key);
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    const clean = arr.map(Number)
                        .filter(v => isFinite(v) && v >= spec.min && v <= spec.max)
                        .filter((v, i, a) => a.indexOf(v) === i)
                        .sort((a, b) => a - b);
                    if (clean.length) return clean;
                }
            }
        } catch (e) {}
        return spec.def.slice();
    }
    function saveChipValues(name, arr) {
        try { localStorage.setItem(CHIP_SETS[name].key, JSON.stringify(arr)); } catch (e) {}
    }
    /**
     * Soll das Zahlenfeld sichtbar sein? (Rasmus: "das eingabe feld unsichtbar,
     * solange man eh nur 75 und 85 nimmt")
     * Sichtbar nur, wenn der Bearbeiten-Knopf offen ist ODER der aktuelle Wert
     * keiner der Schnellwahl-Werte ist - ein von Hand gesetzter Wert muss
     * sichtbar bleiben, sonst ist nicht erkennbar, was gilt (dann ist auch kein
     * Chip hervorgehoben).
     */
    function chipFieldVisible(name, input, editBox) {
        const editOpen = !!(editBox && editBox.style.display === 'flex');
        if (editOpen) return true;
        const cur = parseInt(input && input.value, 10);
        if (!isFinite(cur)) return true;
        return chipValues(name).indexOf(cur) === -1;
    }
    /** Regel anwenden - das LABEL bleibt stehen, nur das Feld verschwindet. */
    function applyChipFieldVisibility(name, input, editBox) {
        if (!input) return;
        input.style.display = chipFieldVisible(name, input, editBox) ? '' : 'none';
    }
    /**
     * Baut die Chip-Reihe neu. Der aktive Chip (= aktueller Feldwert) ist
     * hervorgehoben, damit auf einen Blick klar ist, was gerade gilt.
     */
    function renderChips(name, box, input, editBox) {
        if (!box || !input) return;
        box.innerHTML = '';
        applyChipFieldVisibility(name, input, editBox);
        const cur = String(parseInt(input.value, 10));
        for (const v of chipValues(name)) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sbc-opt-chip' + (String(v) === cur ? ' on' : '');
            b.textContent = String(v);
            b.addEventListener('click', function () {
                input.value = String(v);
                // input-Event, damit alles reagiert, was am Feld haengt
                // (Verfuegbarkeits-Anzeige, gespeicherte Einstellungen).
                try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
                try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
                renderChips(name, box, input, editBox);
            });
            box.appendChild(b);
        }
        const e = document.createElement('button');
        e.type = 'button';
        e.className = 'sbc-opt-chip edit';
        e.textContent = '✎';
        e.title = 'Wert von Hand eintragen / Schnellwahl-Werte anpassen';
        e.addEventListener('click', function () {
            if (!editBox) return;
            const open = editBox.style.display === 'flex';
            editBox.style.display = open ? 'none' : 'flex';
            if (!open) {
                const f = editBox.querySelector('input');
                if (f) { f.value = chipValues(name).join(', '); }
            }
            // Neu bauen, damit das Zahlenfeld der Regel folgt: der
            // Bearbeiten-Knopf ist genau der Weg, es sichtbar zu machen.
            renderChips(name, box, input, editBox);
            if (!open && input) { try { input.focus(); } catch (err) {} }
        });
        box.appendChild(e);
    }
    /** "OK" im Bearbeiten-Feld: Werte uebernehmen, Reihe neu bauen. */
    function applyChipEdit(name, box, input, editBox, valInput) {
        const spec = CHIP_SETS[name];
        const arr = String(valInput ? valInput.value : '')
            .split(/[^0-9]+/).map(Number)
            .filter(v => isFinite(v) && v >= spec.min && v <= spec.max)
            .filter((v, i, a) => a.indexOf(v) === i)
            .sort((a, b) => a - b);
        if (!arr.length) {
            toast('Keine gültigen Werte (' + spec.min + '-' + spec.max + ') - Schnellwahl unverändert.', 'warn');
            return;
        }
        saveChipValues(name, arr);
        if (editBox) editBox.style.display = 'none';
        renderChips(name, box, input, editBox);
        toast('Schnellwahl gespeichert: ' + arr.join(', '), 'ok');
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
        if (ui.quota) {
            const qt = quotaText(quotaUsage());
            ui.quota.textContent = qt || 'noch keine Messung';
        }
        refreshAvailabilityUI();
    }
    // Vorgabe-Kandidaten-Verfügbarkeit neben dem Pool (Ticket #68): zählt
    // dieselben Kandidaten wie eine echte Reservierung
    // (SolverCore.computeRarityAvailability() -> reservationCandidates(),
    // SSOT mit solveCore). Eigener Try/Catch, additiv zu den bereits
    // etablierten Feldern in refreshSbcInfoUI(): ein Fehler hier darf
    // Ziel-OVR/Vorgaben/Pool-Anzeige nicht mitreissen.
    // Debounce (400ms, Nacht-Review 16.08.): refreshSbcInfoUI() laeuft beim
    // Club-Laden PRO SEITE (~92x) - jede Verfuegbarkeits-Berechnung macht
    // readConfig() inkl. komplettem localStorage-Scan plus 6-8 volle
    // Pool-Filterdurchlaeufe. Im Lade-Takt (LEARNINGS 7/30, CPU-Seite) ist
    // das unnoetige Mehrarbeit: waehrend eines Bursts rechnet erst der
    // letzte Aufruf, Einzel-Aufrufe verzoegern sich um unmerkliche 400ms.
    function refreshAvailabilityUI() {
        if (!ui.availability) return;
        if (STATE.availTimer) clearTimeout(STATE.availTimer);
        STATE.availTimer = setTimeout(function () {
            STATE.availTimer = null;
            renderAvailabilityNow();
        }, 400);
    }
    function renderAvailabilityNow() {
        if (!ui.availability) return;
        try {
            const cfg = readConfig();
            const avail = SolverCore.computeRarityAvailability(
                STATE.pool, cfg, STATE.sbc.rarityConstraints || []);
            if (avail.perConstraint.length) {
                ui.availability.innerHTML = avail.perConstraint.map(function (c) {
                    const breakdown = (c.totwClub || c.totwStorage || c.specialsStorage)
                        ? ' (TOTW Verein ' + c.totwClub + ' · TOTW Storage ' + c.totwStorage +
                          ' · Specials Storage ' + c.specialsStorage + ')'
                        : '';
                    const line = escapeHtml(c.constraint.label || 'Rarity') + ': ' +
                        c.available + ' verfügbar' + escapeHtml(breakdown);
                    return c.available < c.needed ? '<span class="low">' + line + '</span>' : line;
                }).join('<br>');
            } else {
                ui.availability.textContent = 'TOTW: ' + avail.totw +
                    ' · Storage-Specials: ' + avail.specialsStorage;
            }
        } catch (e) { reportError('Vorgabe-Verfügbarkeit berechnen fehlgeschlagen', e); }
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
    // [RAREHIST-BEGIN]
    // Reine Funktion (kein STATE-Zugriff ausser dem uebergebenen pool) - so per
    // Marker isoliert testbar (Verhaltensgleichheit zur vormaligen anonymen
    // IIFE in buildDiagReport() ist ein eigener Testfall in solver-test.js).
    function computeRareflagHistogram(pool) {
        const m = {};
        for (const p of pool) {
            const key = String(p.rareflag);
            m[key] = (m[key] || 0) + 1;
        }
        const out = { '0_common': m['0'] || 0, '1_rare': m['1'] || 0,
                      '3_totw': m['3'] || 0 };
        const rest = Object.keys(m).filter(k => ['0', '1', '3'].indexOf(k) < 0)
            .map(k => ({ f: k, n: m[k] }))
            .sort((a, b) => b.n - a.n);
        out.topSpecials = rest.slice(0, 5).map(x => x.f + ':' + x.n).join(' ');
        out.specialFlags = rest.length;
        out.specialTotal = rest.reduce((a, x) => a + x.n, 0);
        // Cap 30: haelt den Report auch bei einem theoretischen Pool-Ausreisser
        // kompakt - in der Praxis liegt specialFlags deutlich darunter. Anders
        // als topSpecials (nur die Top-5 nach Haeufigkeit) landen hier ALLE
        // distincten rareflag-Werte OHNE Counts, damit ein neuer, zunaechst
        // seltener rareflag (z.B. ein frisches Promo-Special mit 1 Karte) immer
        // sichtbar ist, auch wenn er die Top-5-Haeufigkeitsgrenze nicht erreicht.
        out.allSpecialFlagValues = rest.map(x => x.f).slice(0, 30).join(',');
        return out;
    }
    // [RAREHIST-END]
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
                utasSeen: STATE.diag.utasSeen,
                utasUnclassified: STATE.diag.utasUnclassified
            },
            lastUtasPaths: STATE.diag.lastUtasPaths,
            lastUnclassifiedPaths: STATE.diag.lastUnclassifiedPaths,
            lastErrors: STATE.diag.lastErrors,
            uiScan: STATE.diag.uiScan || null,
            // Gesperrte Karten: wurden PaleTools-Locks gefunden und wie viele?
            locks: STATE.diag.locks || null,
            // Aktive Rating-Kosten-Tabelle: bei "SBC kostet mehr Rare als
            // erwartet" zeigt das, welche Bänder der Solver tatsächlich
            // benutzt hat, statt dass es geraten werden muss (LEARNINGS §10).
            bands: {
                spec: bandsToSpec(ratingBands),
                count: ratingBands.length,
                isDefault: JSON.stringify(ratingBands) === JSON.stringify(defaultBands())
            },
            // Aktive Panel-Einstellungen zum Report-Zeitpunkt (Live-Fall
            // 16.08.: "0 Rarity-Kandidaten trotz 43 TOTW" war ohne Kenntnis
            // des aktiven Max-Rating-Filters nicht diagnostizierbar - der
            // Report trug bis dahin KEINE Config). Wie `bands` zur Laufzeit
            // berechnet, kein STATE.diag-Feld.
            cfgSnapshot: (function () {
                try {
                    const c = readConfig();
                    return {
                        minRating: c.minRating, maxOvershoot: c.maxOvershoot,
                        maxRatingEnabled: c.maxRatingEnabled, maxRating: c.maxRating,
                        applyRarity: c.applyRarity,
                        specialOnlyFromStorage: c.specialOnlyFromStorage,
                        lockedCount: (c.lockedIds || []).length,
                        maxRareRating: c.maxRareRating, maxCommonRating: c.maxCommonRating,
                        scarcityWeight: c.scarcityWeight, storageBonus: c.storageBonus,
                        untradeableBonus: c.untradeableBonus, rarityGuardCost: c.rarityGuardCost,
                        // Der Schutz-Modus MUSS im Report stehen: er entscheidet,
                        // welche Karten der Solver ueberhaupt anfassen darf.
                        rarityMode: c.rarityMode, totwSoftCost: c.totwSoftCost,
                        specialCost: c.specialCost,
                        rarityPickId: c.rarityPickId
                    };
                } catch (e) { return { error: String(e && e.message || e) }; }
            })(),
            // Batch: was hat der Lauf pro Runde gesehen, als er die nächste
            // Instanz öffnen wollte? (Die Abbruchmeldung verweist darauf -
            // in v4.18.0 fehlte das Feld im Report, mein Fehler.)
            batchSteps: STATE.diag.batchSteps || null,
            // Verlustfreies Gegenstueck dazu, Cap 30 statt 6er-Ring: die frueheste
            // gescheiterte Runde bleibt auch bei einem spaeten Abbruch sichtbar.
            batchFailedSteps: STATE.diag.batchFailedSteps || null,
            // Wie oft loeste der stuck-Zweig oben schon aus? Macht den
            // v4.36.0-Live-Vorfall ueber mehrere Laeufe hinweg messbar statt
            // nur aus einem einzelnen LEARNINGS-Eintrag ablesbar.
            batchStuckCount: STATE.diag.batchStuckCount || 0,
            // Wie oft hat dismissRewardPopup() seit App-Start wirklich etwas
            // geschlossen? Der letzte Snapshot (popupState in lastTap) zeigt nur
            // den Einzelfall - ein wiederkehrender Popup-Typ, der Zeit im
            // 300ms-Fenster frisst, wird erst ueber die Haeufigkeit sichtbar.
            popupDismissCount: STATE.diag.popupDismissCount || 0,
            // Pack-Opener (Ticket #69/#76): letzte Enumeration, letzter
            // Einzel-Pack-Lauf (lastRun) und letzter "Alle öffnen"-Lauf
            // (lastAllRun) - beantwortet die vier offenen Mechanik-Fragen aus
            // docs/roadmap/vision/features/pack-opener.md (LEARNINGS §46).
            packScan: STATE.diag.packScan || null,
            // EAs Antwort auf die letzte Abgabe. Ohne dieses Feld war der
            // Beweis nur zufaellig im challengeResponseSample zu sehen.
            lastAward: STATE.diag.lastAward || null,
            // SBC-Reihe: welche Challenges des Sets hat das Script gesehen,
            // mit Ziel-OVR, Slots und EA-Status. Ohne das laesst sich ein
            // Bericht "er hat die falsche genommen" nicht nachvollziehen.
            queueScan: STATE.diag.queueScan || null,
            // Welches Team hat der Solver zuletzt geliefert (id/assetId/rating/
            // storage)? Bei HTTP 460 ist hier direkt zu sehen, ob eine Karte
            // oder ein Spieler doppelt drin war.
            lastTeam: STATE.diag.lastTeam || null,
            // Wie schnell war das Laden? pageSize/gap/pages/ms/retries - daran
            // ist zu sehen, ob EA die Seitengroesse kappt und ob der Takt wegen
            // Rate-Limits hochgegangen ist.
            clubLoad: STATE.diag.clubLoad || null,
            // SBC-Kontingent: Summe der serverseitigen timesCompleted plus
            // Verbrauch im Stunden-/Tagesfenster (siehe quotaUsage).
            // Frisch rechnen, aber den von quotaMeasure() gesetzten Stand
            // bevorzugen (dort ist die Messung gerade gelaufen).
            quota: STATE.diag.quota || quotaUsage(),
            // Die letzten Kontingent-Ereignisse mit Quelle: 'local' ist eine
            // eigene, von EAs Zaehler bestaetigte Abgabe, 'server' ist der
            // Zuwachs anderer Geraete. Daran ist sofort zu sehen, OB gezaehlt
            // wird - der eigentliche Befund war "der Zaehler bewegt sich nicht".
            quotaEvents: quotaLoadSamples().slice(-12),
            // Wie oft ist der JS-Kontext neu entstanden, und WIE? Mehrere
            // Starts kurz hintereinander erklaeren einen Pool, der "jedes Mal
            // neu laedt" - und 'nav' sagt, welcher Weg dahin gefuehrt hat.
            // Pool-Cache: wurde geschrieben/gelesen, und WARUM nicht?
            poolCache: STATE.diag.poolCache || null,
            poolCacheRead: STATE.diag.poolCacheRead || null,
            scriptRuns: loadScriptRuns(),
            navigation: navigationKind(),
            // Wie oft musste nach 404/475 die Session erneuert werden?
            staleSessionRetry: STATE.diag.staleSessionRetry || 0,
            // Drosselung durch EA - erklaert 475/404 beim Eintragen.
            throttle: STATE.diag.throttle || null,
            // Welche challengeId hat welcher Weg benutzt? Weicht app von state
            // ab, schreibt die App-Entity in eine andere Instanz.
            submitIds: STATE.diag.submitIds || null,
            // Abgeben: welche Controller/Methoden kamen in Frage und welche hat
            // gegriffen? Am Handy heisst der Controller anders als am PC.
            submitCandidates: STATE.diag.submitCandidates || null,
            submitChallengeVia: STATE.diag.submitChallengeVia || null,
            // Wie oft galt eine Abgabe ohne auswertbare Promise/Observable-Response
            // trotzdem als Erfolg? (LEARNINGS §9, v4.36.0: offen gelassene Frage,
            // ob EA die Abgabe wirklich bestaetigt hat.)
            submitWithoutResponseCount: STATE.diag.submitWithoutResponseCount || 0,
            // Wurde jede Batch-Abgabe von EAs Zaehler bestaetigt?
            submitCounterChecks: STATE.diag.submitCounterChecks || null,
            quotaDisabled: STATE.diag.quotaDisabled || null,
            // Getrennt von quotaDisabled: die Bestaetigung ist eine
            // Korrektheits-Pruefung, keine Diagnose-Annehmlichkeit.
            confirmDisabled: STATE.diag.confirmDisabled || null,
            // Phasen des Planens in ms: config / rounds[] / render / total.
            // "Seite reagiert nicht" beim Planen von 10 Teams - hier steht,
            // welche Phase die Zeit frisst.
            batchPlanTiming: STATE.diag.batchPlanTiming || null,
            // Wo geht die Zeit im Solver hin? Rating-Stufen, Baender, Versuche
            // und Summen-Schranken pro Lauf - damit ist entscheidbar, WAS den
            // DP aufblaeht, statt es zu modellieren.
            solverProfile: STATE.diag.solverProfile ||
                (function () { try { return SolverCore.lastProfiles(); } catch (e) { return null; } })(),
            // Griff eine Abgabe "ohne Response" wirklich? isSquadEmpty() 400ms danach
            // erneut gelesen - reine Beobachtung (kein throw/Retry), siehe submitChallengeToEa.
            submitConfirmations: STATE.diag.submitConfirmations || null,
            // Der letzte fehlende Schritt: nach dem Abgeben landet die App im
            // SBC-HUB (mehrfach belegt), und loadChallenge() bringt die Ansicht
            // nicht zurück. Um die SBC wie von Hand anzuklicken, brauche ich die
            // Kachel-Elemente - hier ein Abzug davon, wenn wir im Hub stehen.
            hubScan: (function () {
                try {
                    const inHub = getControllerChain().some(c =>
                        /hub/i.test((c.constructor && c.constructor.name) || ''));
                    const out = { inHub: inHub, sets: [] };
                    if (!inHub) return out;
                    // NUR echte Set-Kacheln, eine Zeile pro Set. Vorher standen
                    // hier auch tileHeader/tileTitle/tileContent/Reward-Liste
                    // jedes Sets - 40 Eintraege, und der Report wurde zu lang
                    // zum Kopieren.
                    const tiles = document.querySelectorAll('.ut-sbc-set-tile-view');
                    for (let i = 0; i < tiles.length && out.sets.length < 25; i++) {
                        const e = tiles[i];
                        if (!(e.offsetParent !== null || e.getClientRects().length)) continue;
                        const t = e.querySelector('.tileTitle, .tileHeader, h1');
                        // Der Status verraet, ob das Set noch wiederholbar ist
                        // ("Repeatable: 5 …") oder fuer heute durch ist.
                        const st = e.querySelector('.sbc-status-container');
                        out.sets.push({
                            title: ((t && t.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 60),
                            status: ((st && st.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 60)
                        });
                    }
                    return out;
                } catch (e) { return { error: String(e && e.message || e) }; }
            })(),
            // Submit-Diagnose: welcher Weg hat zuletzt gegriffen und ist
            // ueberhaupt eine Challenge offen? findSbcController()/
            // findLiveChallenge() traversieren dieselbe undokumentierte
            // EA-Controller-Kette wie hubScan - analog dazu abgesichert, damit
            // ein EA-seitiger Bruch dort nicht den GESAMTEN Report mitreisst.
            submitInfo: (function () {
                try {
                    const svc = window.services && window.services.SBC;
                    const ctrl = findSbcController();
                    return {
                        saveChallengeThere: !!(svc && typeof svc.saveChallenge === "function"),
                        liveChallengeThere: !!findLiveChallenge(),
                        controllerName: (ctrl && ctrl.constructor && ctrl.constructor.name) || null
                    };
                } catch (e) { return { error: String(e && e.message || e) }; }
            })(),
            // Einstiegspunkt-Diagnose: sitzt der Menüpunkt in der EA-Leiste
            // oder fällt die App auf den FAB zurück? tabBarCount zeigt, ob
            // mehrere (auch unsichtbare) Leisten im DOM stehen. Ueberschneidet
            // sich bewusst mit STATE.diag.uiScan (panelOpen/fabVisible) - dort
            // stehen nur die billigsten Basiswerte OHNE den vollen DOM-Scan
            // hier, siehe Kommentar an der uiScan-Zuweisung in onDiagClick().
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
                    // >0 = der Text-Fallback musste einspringen, weil
                    // .sbc-button-container selbst nichts lieferte.
                    containerFallbackUsed: containerFallbackUsed,
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
                    // Die acht "✕" der Kosten-Tabelle sagen nichts und standen
                    // in jedem Report - raus, damit er kopierbar bleibt.
                    visibleButtons: buttonDump.filter(b =>
                        String(b.txt || '').trim() !== '✕').slice(0, 20),
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
            // Kein "|| null": lastEligible ist dreiwertig (true = App haelt
            // Squad fuer abgabefaehig, false = ausdruecklich NICHT abgabefaehig
            // - der fuer Rasmus wichtigste Fall, null = Pruefung nicht moeglich).
            // "false || null" wuerde zu null kollabieren und den wichtigsten
            // Fall ununterscheidbar von "nicht geprueft" machen.
            lastEligible: typeof STATE.diag.lastEligible !== 'undefined' ? STATE.diag.lastEligible : null,
            controllerScan: controllerScan(),
            // GEKUERZT: von den 23 Slots sind die meisten leer (id 0) - die
            // stehen jetzt nur als Anzahl drin. Wichtig ist, WELCHE Karte auf
            // WELCHEM Slot lag (daran war das HTTP 460 zu sehen, LEARNINGS 16).
            appSquadPutBodySample: (function () {
                const raw = STATE.diag.lastSquadPutBody;
                if (typeof raw !== 'string') return raw || null;
                try {
                    const j = JSON.parse(raw);
                    if (!j || !Array.isArray(j.players)) return raw.slice(0, 800);
                    const filled = j.players
                        .filter(p => p && p.itemData && Number(p.itemData.id))
                        .map(p => p.index + ':' + p.itemData.id);
                    return { belegt: filled.join(' '), leer: j.players.length - filled.length };
                } catch (e) { return raw.slice(0, 800); }
            })(),
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
                rareConstraints: STATE.sbc.rareConstraints || [],
                usableSlots: STATE.sbc.usableSlots || null,
                reqDump: STATE.sbc.reqDump,
                // Scopes ohne Wert, die NICHT zur Standard-Boilerplate gehoeren -
                // rein informativ (siehe applyScan: daraus folgt NICHTS).
                otherScopes: STATE.sbc.otherScopes || [],
                // ALLE erkannten Scope-Strings, ungefiltert - Gegenprobe gegen
                // die reqDump-Whitelist (bereits auf 40 gedeckelt, LEARNINGS 37).
                scopesSeenCount: (STATE.sbc.scopesSeen || []).length,
                scopesSeenSample: STATE.sbc.scopesSeen || [],
                // Wie oft griff der reqCount()-1-Fallback (kein bekannter
                // Count-Key in der Eltern-Kette)? Reine Beobachtung.
                countDefaultedTotal: [].concat(STATE.sbc.reqDump || [], STATE.sbc.rarityConstraints || [],
                    STATE.sbc.playerLevelConstraints || [], STATE.sbc.qualityConstraints || [])
                    .filter(c => c && c.countDefaulted === true).length,
                // Traversal-Metriken (visitedCount/depthCapped/budgetExhausted) je
                // Scanner - KEIN Abbruch-/Warnungskriterium (der v4.34.0-Fehlalarm
                // aus einer Strukturindiz-Warnung ist die Anti-Vorlage, LEARNINGS 37).
                scanStats: STATE.diag.scanStats || null,
                staleRecover: STATE.diag.staleRecover || null,
                entityCaptured: !!STATE.sbc.entity,
                setChallengesCached: !!STATE.lastSetChallenges
            },
            poolSize: STATE.pool.length,
            // Verteilung der rareflags im Pool - zum Verifizieren der
            // Gold/Special-Klassifizierung
            // GEKUERZT (der Report muss kopierbar bleiben): das volle Histogramm
            // waren ~80 Zeilen. Gebraucht werden Common/Rare - und von den
            // Special-Flags die haeufigsten fuenf plus Restsumme.
            rareflagHistogram: computeRareflagHistogram(STATE.pool),
            poolSpecialCount: STATE.pool.filter(p => p.isSpecial).length,
            evoExcluded: STATE.diag.evoExcluded,
            // Struktur-Samples hoher Karten: verrät uns die echten Feldnamen,
            // falls Evolutions/Specials noch falsch klassifiziert werden.
            // GEKUERZT: vorher fuenf Karten mit je bis zu 60 rawKeys - der
            // groesste Einzelposten im Report. Die Feldnamen sind bekannt
            // (LEARNINGS 2), rawKeys braucht es nur noch an EINER Probe.
            highCardSamples: STATE.pool
                .filter(p => p.rating >= 85)
                .slice(0, 3)
                .map(function (p, i) {
                    const o = {
                        id: p.id, rating: p.rating, rareflag: p.rareflag,
                        isSpecial: p.isSpecial, isStorage: p.isStorage
                    };
                    if (i === 0 && p.raw) o.rawKeys = Object.keys(p.raw).join(',');
                    return o;
                }),
            // GEKUERZT: der Report war zu lang zum Kopieren und brach live mitten
            // in diesem Feld ab. Der Rest sind ohnehin nur leere Slots (id 0) -
            // gebraucht werden der Kopf und playerRequirements.
            challengeResponseSample: (function () {
                const t = challengeSample;
                if (typeof t !== 'string') return t;
                const cut = t.indexOf('"players"');
                const head = (cut > 0 ? t.slice(0, cut) : t).slice(0, 1500);
                return head + (t.length > head.length
                    ? ' …[' + (t.length - head.length) + ' Zeichen leere Slots weggelassen]' : '');
            })()
        };
    }
    function onDiagClick() {
        // uiScan: billige, EIGENSTAENDIGE Momentaufnahme in STATE.diag - anders
        // als das launcher-Sub-Objekt (buildDiagReport() weiter unten, liest
        // dieselben Basiswerte zusaetzlich zu einem vollen DOM-Scan aller
        // Buttons/Controller) ist sie ohne den teuren Report-Aufbau lesbar und
        // bleibt erhalten, selbst wenn ein spaeteres Feld in buildDiagReport()
        // einmal einen Fehler wirft.
        STATE.diag.uiScan = {
            panelOpen: !!(ui.panel && ui.panel.classList.contains('open')),
            fabVisible: !!(ui.fab && !ui.fab.classList.contains('sbc-opt-hidden')),
            inSbcView: inSbcView(),
            btnAttached: !!document.getElementById(BTN_ID)
        };
        // Das Diagnose-Werkzeug darf bei EA-Wandel nicht selbst lautlos
        // ausfallen: ein kaputtes Report-Feld liefert sonst gar nichts statt
        // wenigstens des Fehlers selbst.
        let report;
        try {
            report = buildDiagReport();
        } catch (e) {
            reportError('Diagnose-Report fehlgeschlagen', e);
            report = { version: VERSION, url: location.href, error: String(e && e.message || e) };
        }
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
            maxRatingEnabled: ui.maxRatingEn.checked,
            maxRating: parseInt(ui.maxRatingVal.value, 10) || 0,
            scarcityWeight: parseFloat(ui.scarcity.value) || 0,
            storageBonus: parseFloat(ui.storagebonus.value) || 0,
            untradeableBonus: parseFloat(ui.untradeable.value) || 0,
            // Gesperrte Karten (PaleTools-Schloss) beim Optimieren frisch
            // einlesen - sie koennen sich zwischen zwei Laeufen aendern.
            lockedIds: ui.useLocks.checked ? Array.from(readPaletoolsLocks()) : [],
            maxRareRating: parseInt(ui.maxRare.value, 10) || 0,
            maxCommonRating: parseInt(ui.maxCommon.value, 10) || 0,
            rarityGuardCost: parseFloat(ui.rarityguard.value) || 0,
            rarityMode: ui.raritymode ? ui.raritymode.value : 'vereinTotw',
            totwSoftCost: ui.totwsoft ? (parseFloat(ui.totwsoft.value) || 0) : 8,
            specialCost: ui.specialsoft ? (parseFloat(ui.specialsoft.value) || 0) : 1,
            ratingCostSpec: bandsToSpec(ratingBands),
            anchorId: null,
            rarityPickId: ui.rarityPick.value || null,
            rarityConstraints: STATE.sbc.rarityConstraints || [],
            qualityConstraints: STATE.sbc.qualityConstraints || [],
            rareConstraints: STATE.sbc.rareConstraints || [],
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
            // Erst der Cache: nach einem Neuladen der Seite (Session weg ->
            // Login -> neues Dokument) ist der Verein Sekunden alt und ein
            // volles Laden waere 50 Requests fuer nichts.
            const cache = await tryPoolCache();
            STATE.diag.poolCacheRead = cache;
            if (cache.used) {
                setStatus('Verein aus Cache - lade Storage...');
                await loadPoolSmallLists();
                refreshSbcInfoUI();
                renderAnchorOptions();
                setStatus('Pool bereit (' + STATE.pool.length + ', Verein aus Cache)');
                toast('Verein aus dem Cache (' + STATE.pool.length + ' Karten) - ' +
                      'kein vollständiges Neuladen nötig.', '');
                quotaMeasureQuiet();
                return;
            }
            log('Pool-Cache nicht verwendet: ' + cache.reason);
            await loadPool((n, total) => {
                setStatus('lade (auto)... ' + n + (total ? ' / ' + total : ''));
                if (ui.poolcount) ui.poolcount.textContent = String(n);
            });
            refreshSbcInfoUI();
            renderAnchorOptions();
            setStatus('Pool bereit (' + STATE.pool.length + ')');
            toast('Spieler automatisch geladen: ' + STATE.pool.length + ' Karten.', '');
            // Kontingent-Basis setzen. Ohne das stand der Zaehler auf einem
            // Geraet, das nur den Auto-Load benutzt, dauerhaft still.
            quotaMeasureQuiet();
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
            // EINZIGER Messpunkt fuer das SBC-Kontingent. Bewusst hier und
            // nirgends sonst: der Request ueber ALLE Sets ist schwer, und im
            // Batch-Takt hat er live 429er ausgeloest (LEARNINGS 7). Einmal
            // pro "Spieler laden" reicht fuer "wie viele SBCs heute".
            quotaMeasureQuiet();
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
        // Waehrend eines laufenden Pool-Refreshs ist STATE.pool ein
        // Uebergangszustand (onLoadClick leert ihn beim Voll-Refresh und
        // befuellt ihn asynchron neu) - ohne diesen Guard wuerde der Solver
        // unbemerkt gegen einen unvollstaendigen Pool loesen, ohne dass die
        // uebliche loadIncomplete-Warnung greift (analog zum bestehenden
        // Re-Entrancy-Schutz in onLoadClick).
        if (STATE.loading) {
            toast('Pool lädt noch - gleich nochmal versuchen.', 'error');
            setStatus('Pool lädt noch...');
            return;
        }
        // Erkennung IMMER mit der offen sichtbaren Challenge abgleichen -
        // der Hook-Zustand kann nach Pack-Öffnen/Submit veraltet sein.
        syncSbcWithOpenChallenge();
        // Sehen die Vorgaben leer/abgeschnitten aus, die verlaesslichste
        // Quelle aktiv holen: elgReq aus den Set-Challenges (Live-Fall
        // 84+ TOTW - Entity-Scan ertrank, Set-Cache hielt ein fremdes Set).
        const constraintsEmpty = () => !STATE.sbc.targetOVR &&
            !(STATE.sbc.playerLevelConstraints || []).length &&
            !(STATE.sbc.rarityConstraints || []).length &&
            !(STATE.sbc.qualityConstraints || []).length &&
            !(STATE.sbc.rareConstraints || []).length;
        if (constraintsEmpty() || anyDeepScanTruncated()) {
            // ensureSetChallenges ruft applyFromSetChallenges selbst - KEIN
            // erneutes syncSbcWithOpenChallenge danach, sonst koennte der
            // Entity-Scan die frisch gefundenen elgReq-Vorgaben wieder
            // ueberdecken.
            await ensureSetChallenges('onRunClick');
        }
        if (!STATE.sbc.targetOVR && !(STATE.sbc.playerLevelConstraints || []).length &&
            !(STATE.sbc.rarityConstraints || []).length &&
            !(STATE.sbc.qualityConstraints || []).length) {
            // Unterscheidung nach Ursache (live: Gold-Challenge Set 1337, der
            // Scan erschoepfte sein Budget im Belohnungs-Ast und fand NICHTS):
            // abgeschnittener Scan heisst "wir wissen es nicht", nicht "es
            // gibt keine Vorgaben".
            if (anyDeepScanTruncated()) {
                toast('Vorgaben nicht erkannt: der Challenge-Scan wurde abgeschnitten. Challenge bitte neu öffnen; bleibt es dabei, Diagnose schicken.', 'error');
            } else {
                toast('Kein Ziel-OVR erkannt. Bitte SBC-Challenge im Spiel öffnen (und ggf. Diagnose-Button nutzen).', 'error');
            }
            return;
        }
        if (STATE.pool.length === 0) {
            toast('Pool leer. Bitte zuerst "Spieler laden".', 'error');
            return;
        }
        // Scan abgeschnitten, aber ETWAS erkannt: weitermachen (kein Abbruch),
        // aber sichtbar machen, dass die Vorgaben unvollstaendig sein koennten.
        if (anyDeepScanTruncated()) {
            toast('Hinweis: Der Vorgaben-Scan wurde abgeschnitten - erkannte Vorgaben könnten unvollständig sein. Ergebnis vor dem Abgeben prüfen.', 'warn');
        }
        // KEINE Vorab-Warnung aus reqDump-Scopes (war v4.34.0 und ist wieder
        // raus): "PLAYER"/"CLUB MEMBER" stehen bei JEDER SBC drin, die Warnung
        // kam also auch bei SBCs, die tadellos liefen. Ob EA das Team annimmt,
        // sagt nach dem Eintragen isSBCSquadEligible() - das ist die einzige
        // verlaessliche Quelle.
        if (STATE.loadIncomplete) {
            toast('ACHTUNG: Der Pool ist unvollständig geladen (' + STATE.pool.length +
                ' Karten) - das Ergebnis kann schlechter oder unlösbar sein. Am besten erst "Spieler laden" erneut ausführen.', 'warn');
        }
        setStatus('optimiere...');
        ui.run.disabled = true;
        try {
            let cfg, res;
            try {
                cfg = readConfig();
                res = SolverCore.solve(STATE.pool, cfg);
            } catch (e) {
                toast('Optimierungsfehler: ' + e.message, 'error');
                setStatus('Fehler');
                // reportError warnt intern selbst — kein zusaetzliches warn(e),
                // sonst steht dieselbe Exception doppelt in der Konsole.
                reportError('onRunClick: readConfig/solve fehlgeschlagen', e);
                return;
            }
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
            return;
        }
        // KEINE Karten-Liste beim Einzellauf (Rasmus): "die liste an spielern
        // brauche ich nicht fuer eine einzeln abgegebene sbc. ich sehe die
        // spieler ja auf dem feld bevor ich submit druecke." Die Zusammenfassung
        // bleibt - sie sagt, was das Feld nicht sagt (Ueberschuss, Storage,
        // Warnungen). In der BATCH-Vorschau bleibt die Liste, dort gibt es
        // kein Spielfeld zum Nachsehen.
        let html = '';
        const nStorage = res.players.filter(p => p.isStorage).length;
        const wasteTxt = (typeof res.waste === 'number')
            ? ((res.waste >= 0 ? '+' : '') + res.waste.toFixed(2)) : '–';
        html += '<div class="sbc-opt-summary">Team-OVR: <b>' + res.ovr + '</b>' +
                (res.ovrExact != null ? ' <span class="sbc-opt-muted">(' + res.ovrExact.toFixed(2) + ')</span>' : '') +
                (res.target ? ' / Ziel ' + res.target : '') +
                ' &nbsp; Überschuss: <b>' + wasteTxt + '</b>' +
                (nStorage ? ' &nbsp; Storage: <b>' + nStorage + '</b>' : '') + '</div>';
        if (res.poolInfo) {
            html += '<div class="sbc-opt-dim" style="font-size:11px;">Pool nach Filtern: ' + res.poolInfo.count +
                    ' Karten (' + res.poolInfo.min + '–' + res.poolInfo.max + ')</div>';
        }
        for (const w of (res.warnings || [])) html += '<div class="sbc-opt-warn">⚠ ' + escapeHtml(w) + '</div>';
        if (!res.ok && res.reason) html += '<div class="sbc-opt-warn">⚠ ' + escapeHtml(res.reason) + '</div>';
        ui.result.className = 'sbc-opt-result show';
        ui.result.innerHTML = html;
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
    // titlePrefix generalisiert den Balken fuer den Pack-Opener-Loop (Ticket
    // #76) mit - Default 'SBC' haelt jeden bestehenden Aufrufer unveraendert.
    function showProgress(cur, total, step, doneText, titlePrefix) {
        if (!ui.progress) return;
        ui.progress.classList.add('open');
        ui.progTitle.textContent = (titlePrefix || 'SBC') + ' ' + cur + ' von ' + total;
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
    /**
     * Liegt noch ein Dialog/Shield oben? EAs Kachel-Handler sind registriert,
     * reagieren aber nicht, solange die App einen Popup-Zustand hat - genau das
     * Bild aus dem Live-Report: Tap kommt an (touchHandled true), Kachel oeffnet
     * nicht, nach einem Neustart geht es wieder.
     * Ausgelesen wird beides: der Shield der App UND was tatsaechlich an der
     * Tap-Stelle liegt (elementFromPoint) - ein synthetisch verschickter Event
     * umgeht Hit-Testing, EA prueft die Ueberdeckung aber womoeglich selbst.
     */
    function popupState() {
        const st = { shield: null, overlays: 0, top: null };
        try {
            const sh = window.gPopupClickShield;
            if (sh) {
                st.shield = {
                    up: !!(sh.isShieldUp ? sh.isShieldUp() : (sh._shieldUp || sh.visible)),
                    hasClose: typeof sh.closeActivePopup === 'function'
                };
            }
        } catch (e) {}
        try {
            // Alles, was bildschirmfuellend obendrauf liegt.
            const sel = '.ut-click-shield,[class*="click-shield"],[class*="dialog"],' +
                        '[class*="popup"],[class*="overlay"],[class*="modal"]';
            const els = document.querySelectorAll(sel);
            const seen = [];
            for (let i = 0; i < els.length; i++) {
                const e = els[i];
                if (String(e.className || '').indexOf('sbc-opt') > -1) continue;
                const r = e.getBoundingClientRect();
                if (r.width < window.innerWidth * 0.5 || r.height < window.innerHeight * 0.3) continue;
                if (!(e.offsetParent !== null || e.getClientRects().length)) continue;
                st.overlays++;
                if (seen.length < 3) seen.push(String(e.className || '').slice(0, 50));
            }
            if (seen.length) st.overlayCls = seen.join(' | ');
        } catch (e) {}
        try {
            const chain = getControllerChain();
            st.top = (chain.length && chain[chain.length - 1].constructor &&
                      chain[chain.length - 1].constructor.name) || null;
        } catch (e) {}
        return st;
    }
    // Der Knopf, mit dem der Belohnungs-Dialog seine Belohnung abholt.
    // Rasmus: "ihm fehlt scheinbar der klick auf claim rewards dazwischen".
    // Das ist KEIN geratener Klick in einen Dialog (LEARNINGS 35): die
    // Belohnung ist zu diesem Zeitpunkt serverseitig schon zugeteilt
    // (grantedChallengeAwards), und dieser Dialog hat genau diese eine Aktion.
    // Gesucht wird nur bei EXAKTER Beschriftung.
    const REWARD_CLAIM_LABELS = [
        'claim rewards', 'claim reward',
        'belohnungen abholen', 'belohnung abholen'
    ];
    /**
     * Welcher der sichtbaren Knoepfe holt die Belohnung ab? Rein (nur
     * Beschriftungen kommen herein), damit die Auswahl ohne DOM testbar ist.
     */
    function pickClaimButton(texts) {
        const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
        for (const want of REWARD_CLAIM_LABELS) {
            for (let i = 0; i < (texts || []).length; i++) {
                if (norm(texts[i]) === want) return i;
            }
        }
        return -1;
    }
    function clickClaimRewards() {
        try {
            const els = visibleAll('button, .btn-standard');
            const texts = els.map(function (el) {
                return String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
            });
            const idx = pickClaimButton(texts);
            if (idx < 0) return false;
            return clickLike(els[idx]);
        } catch (e) { return false; }
    }
    function dismissRewardPopup() {
        let closed = false;
        // ZUERST der Knopf des Dialogs selbst - er ist der Weg, den Rasmus von
        // Hand geht, und zuverlaessiger als ein Schliessen von aussen.
        try { if (clickClaimRewards()) closed = true; } catch (e) {}
        try {
            const shield = window.gPopupClickShield;
            if (shield && typeof shield.closeActivePopup === 'function') {
                // MEHRFACH: nach dem Abgeben koennen mehrere Overlays
                // hintereinander kommen (Belohnung, dann "Set abgeschlossen").
                // Vorher wurde genau einmal geschlossen - und `closed` wurde
                // auch dann gemeldet, wenn gar nichts offen war.
                for (let k = 0; k < 3; k++) {
                    const before = popupState();
                    if (!before.overlays && !(before.shield && before.shield.up)) break;
                    shield.closeActivePopup();
                    closed = true;
                }
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
        if (closed) STATE.diag.popupDismissCount = (STATE.diag.popupDismissCount || 0) + 1;
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
        // ALLE Controller im Stack absuchen, und zwar nach submitChallenge UND
        // _submitChallenge. Grund (live am Handy, v4.27.0): in der schmalen
        // Ansicht ist der oberste Controller UTSBCSquadOverviewViewController
        // und der hat NUR _submitChallenge - am PC ist es der
        // UTSBCSquadSplitViewController mit beiden. Vorher schaute der Code nur
        // auf den EINEN gefundenen Controller und nur auf den oeffentlichen
        // Namen: "Controller hat kein submitChallenge()", Batch bei 0/7 gestoppt.
        // Reihenfolge: erst die oeffentliche Methode (die macht den regulaeren
        // Weg inkl. Ansicht-Update), dann die interne.
        const cands = [];
        const seenObj = [];
        function addCand(c, where) {
            if (!c || typeof c !== 'object' || seenObj.indexOf(c) > -1) return;
            seenObj.push(c);
            if (typeof c.submitChallenge === 'function') cands.push({ c: c, m: 'submitChallenge', w: where });
            if (typeof c._submitChallenge === 'function') cands.push({ c: c, m: '_submitChallenge', w: where });
        }
        addCand(ctrl, 'ctrl');
        try {
            for (const c of getControllerChain()) {
                addCand(c, (c.constructor && c.constructor.name) || 'chain');
                // Unter-Controller des Split-Views (am PC haengt der Submit dort).
                for (const k of ['leftController', 'rightController', '_overviewController',
                                 '_challengeDetailsController']) {
                    try { addCand(c[k], k); } catch (e) {}
                }
            }
        } catch (e) {}
        STATE.diag.submitCandidates = cands.map(x => x.w + '.' + x.m);
        for (const cand of cands) {
            try {
                const r = cand.c[cand.m]();
                let resp = null;
                if (r && (typeof r.then === 'function' || typeof r.subscribe === 'function' ||
                          typeof r.observe === 'function')) resp = await obsPromise(r);
                if (resp && !responseOk(resp)) {
                    problems.push(cand.w + '.' + cand.m + ': Status ' + resp.status);
                    continue;
                }
                // Kam gar keine auswertbare Response (r weder Promise noch
                // Observable), gilt der Aufruf trotzdem als Erfolg - aber der
                // Report soll das unterscheiden koennen: beim 4/5-Abbruch
                // blieb die App danach im Squad-View haengen, und ob EA die
                // Abgabe wirklich bestaetigt hatte, war nicht ablesbar.
                STATE.diag.submitChallengeVia = cand.w + '.' + cand.m +
                    (resp ? '' : ' (ohne Response)');
                if (!resp) {
                    STATE.diag.submitWithoutResponseCount = (STATE.diag.submitWithoutResponseCount || 0) + 1;
                    // Additive Plausibilisierung, KEIN Abbruchkriterium: solange kein
                    // zweiter Live-Beleg zeigt, dass isSquadEmpty()===false nach einer
                    // "ohne Response"-Abgabe wirklich einen Fehlschlag bedeutet, darf das
                    // NICHT zu throw/Retry fuehren (False-Positive-Risiko: Netzwerk-Race,
                    // Squad-Objekt noch nicht aktualisiert - "2 von 5 fertig" waere sonst
                    // schlechter dran als ohne diese Pruefung). Nicht lesbar -> 'unknown',
                    // dann bleibt es reine Beobachtung statt einer geratenen Aussage.
                    const tConfirm = Date.now();
                    let squadEmptyAfter = 'unknown';
                    await batchWait(400);
                    try {
                        if (liveSquad && typeof liveSquad.isSquadEmpty === 'function') {
                            squadEmptyAfter = liveSquad.isSquadEmpty();
                        }
                    } catch (e) {}
                    STATE.diag.submitConfirmations = (STATE.diag.submitConfirmations || []).concat([{
                        via: cand.w + '.' + cand.m, hadResponse: false,
                        squadEmptyAfter: squadEmptyAfter, ms: Date.now() - tConfirm
                    }]).slice(-6);
                }
                return { via: 'controller' };
            } catch (e) {
                problems.push(cand.w + '.' + cand.m + ': ' + (e && e.message || e));
            }
        }
        if (!cands.length) problems.push('Kein Controller mit submitChallenge/_submitChallenge gefunden');
        const svc = window.services && window.services.SBC;
        if (svc && typeof svc.submitChallenge === 'function') {
            // Ohne Argument ist der dokumentierte Weg (arity 0). Am Handy kam
            // dabei "Cannot read properties of undefined (reading 'squad')" -
            // der Service zieht die Challenge aus einem Zustand, der in dieser
            // Ansicht nicht gesetzt ist. Deshalb zweiter Versuch MIT der
            // Challenge-Entity aus dem Controller.
            const chal = ctrl && (ctrl._challenge || ctrl.challenge);
            const tries = chal ? [[], [chal]] : [[]];
            for (const args of tries) {
                try {
                    const resp = await obsPromise(svc.submitChallenge.apply(svc, args));
                    if (responseOk(resp)) {
                        STATE.diag.submitChallengeVia = 'service(' + args.length + ')';
                        return { via: 'service' };
                    }
                    problems.push('Service(' + args.length + '): Status ' + (resp && resp.status));
                } catch (e) {
                    problems.push('Service(' + args.length + '): ' + (e && e.message || e));
                }
            }
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
        // Bevor mehrfach auf eine Kachel getippt wird, die gar nicht mehr
        // aufgeht: sagt der Hub, dass das Set fuer heute durch ist, wird sofort
        // und mit KLARER Begruendung aufgehoert. Live lief die Silber-SBC 5/5,
        // die Gold-SBC brach nach der ersten Runde ab - drei Taps kamen an und
        // die App blieb im Hub.
        const rep0 = setLooksRepeatable(plan.setName || '');
        if (rep0.repeatable === false) {
            steps.push({ ms: 0, setState: rep0, why: 'Set laut Hub nicht mehr wiederholbar' });
            return { ok: false, exhausted: true, status: rep0.status, steps: steps };
        }
        const t0 = Date.now();
        let clicked = false;
        // Alle 300ms nachsehen statt jede Sekunde, und den Set-Klick SOFORT
        // versuchen. Aus dem Live-Log: der Controller war 4s nach dem Klick da,
        // die 4s Vorlauf und die vier Anlaeufe fuer die Challenge-Zeile waren
        // verschenkte Zeit - nach dem Kachel-Klick ist die Challenge direkt
        // offen (seen.detailsView war 1, rowView 0).
        // requestChallengesForSet ist raus: es lieferte freshId null und wird
        // nicht gebraucht, weil der Klick-Weg die frische Instanz mitbringt.
        let wentBack = false;
        for (let i = 0; i < 60; i++) {          // 60 x 300ms = max ~18s
            dismissRewardPopup();
            syncSbcWithOpenChallenge();
            const ctrl = findSbcController();
            const sq = ctrl && (ctrl._squad || (ctrl.getSquad && ctrl.getSquad()));
            let empty = null;
            try { if (sq && typeof sq.isSquadEmpty === 'function') empty = sq.isSquadEmpty(); }
            catch (e) {}
            if (ctrl && sq && isFreshMatchingInstance(plan, STATE.sbc, empty)) {
                steps.push({ ms: Date.now() - t0, done: true, clicked: clicked,
                    sameIdReuse: plan.sameIdReuse || 0 });
                return { ok: true, steps: steps };
            }
            // Die App blieb nach dem Abgeben im SQUAD-VIEW haengen (live,
            // 4/5-Abbruch): der Controller war die ganzen 18s da, der Squad
            // noch voll - und weil ALLE Zweige unten nur im Hub (!ctrl)
            // arbeiten, wurde weder etwas geloggt noch etwas unternommen.
            // Deshalb: den Zustand protokollieren und zurueck zum Hub
            // navigieren - von dort kennt der Kachel-Klick den Weg, und die
            // Erschoepfungs-Erkennung kann den Kachel-Status ueberhaupt lesen.
            if (ctrl && (i === 2 || i === 20 || i === 45)) {
                STATE.diag.batchStuckCount = (STATE.diag.batchStuckCount || 0) + 1;
                steps.push({ ms: Date.now() - t0, stuck: {
                    top: (ctrl.constructor && ctrl.constructor.name) || null,
                    challengeId: STATE.sbc.challengeId,
                    usedInstance: (plan.usedChallengeIds || [])
                        .indexOf(String(STATE.sbc.challengeId)) > -1,
                    matches: matchesPlannedSbc(plan),
                    // Verlauf des Namensdrift-Ankers: setCurrentChallenge() setzt
                    // formationSlots bei jedem Challenge-Wechsel auf den Default 11
                    // zurueck, bevor die Brick-Slot-Korrektur (parseSbcChallenge)
                    // nachliefert - "matches: false" kann in diesem Fenster
                    // transient sein statt eine echte Diskrepanz zu sein.
                    formationSlots: STATE.sbc.formationSlots,
                    planSlots: plan.slots,
                    empty: empty
                } });
            }
            if (ctrl && shouldTryBack(i)) {
                const b = clickBackButton();
                steps.push({ ms: Date.now() - t0, back: b });
                if (b.ok) { wentBack = true; await batchWait(900); continue; }
            }
            // Im Hub: Set-Kachel anklicken. Erster Versuch sofort, danach
            // gelegentlich nachfassen (die Kachelliste braucht manchmal einen
            // Moment, bis sie gerendert ist).
            if (!ctrl && (!clicked || i === 20 || i === 40)) {
                // Vor dem Tap aufraeumen: liegt noch ein Dialog oben, ignoriert
                // EA den Kachel-Tap (Live-Bild: touchHandled true, nichts
                // passiert, nach Neustart ging es wieder).
                const pop = popupState();
                if (pop.overlays || (pop.shield && pop.shield.up)) {
                    dismissRewardPopup();
                    steps.push({ ms: Date.now() - t0, popupClosed: pop });
                    await batchWait(500);
                }
                let s1 = clickSetTile(plan);
                // Nicht gefunden? Dann versteckt der Hub-Filter sie vielleicht
                // (live: "Favourites" aktiv, gesuchte SBC nicht dabei).
                if (!s1.ok && (i === 3 || i === 20)) {
                    const f = clickAllFilter();
                    steps.push({ ms: Date.now() - t0, filter: f });
                    if (f.ok) { await batchWait(900); s1 = clickSetTile(plan); }
                }
                // Kachel GEFUNDEN und getippt, aber schon zweimal ohne Wirkung?
                // Dann die Liste ueber den Filter neu aufbauen lassen und noch
                // einmal tippen - eine stale View ist die wahrscheinlichste
                // Erklaerung, wenn der Tap nachweislich ankommt.
                if (s1.ok && clicked && (i === 20 || i === 40)) {
                    const f2 = clickAllFilter();
                    steps.push({ ms: Date.now() - t0, rerender: f2 });
                    if (f2.ok) {
                        await batchWait(900);
                        const s3 = clickSetTile(plan);
                        steps.push({ ms: Date.now() - t0, setTileAfterRerender: s3 });
                    }
                }
                if (s1.ok) {
                    clicked = true;
                    steps.push({ ms: Date.now() - t0, setTile: s1 });
                    await batchWait(500);
                    continue;
                }
                if (i === 3 || i === 20) steps.push({ ms: Date.now() - t0, setTile: s1 });
            }
            // Nur falls das Set MEHRERE Challenges hat, steht eine Zeilenliste
            // offen - dann die erste anklicken. Auch nach einem Zurueck-Klick:
            // der landet u.U. in der Challenge-Liste des Sets statt im Hub.
            if (!ctrl && (clicked || wentBack) && (i === 10 || i === 25)) {
                const s2 = clickChallengeRow();
                if (s2.ok) {
                    steps.push({ ms: Date.now() - t0, chRow: s2 });
                    await batchWait(700);
                    // Derselbe zweite Schritt wie in der Reihe: bei einem Set
                    // mit mehreren Challenges waehlt die Zeile nur aus. Dem
                    // Batch ist das nie aufgefallen, weil er ueber die
                    // Set-Kachel oeffnet und dabei bei EINER Challenge direkt
                    // im Squad landet. Rein additiv: der Knopf wird nur nach
                    // einem erfolgreichen Zeilen-Klick und nur bei exakter
                    // Beschriftung gedrueckt.
                    const s2b = clickChallengeEnterButton(lastChallengeRowEl);
                    steps.push({ ms: Date.now() - t0, enter: s2b });
                    if (s2b.ok) await batchWait(700);
                }
                else if (i === 10) steps.push({ ms: Date.now() - t0, chRow: s2 });
            }
            await batchWait(300);
        }
        const repEnd = setLooksRepeatable(plan.setName || '');
        steps.push({ setState: repEnd, popup: popupState(),
                     why: 'Status der Kachel nach den Versuchen' });
        return { ok: false, exhausted: repEnd.repeatable === false,
                 status: repEnd.status, steps: steps };
    }
    /**
     * EINE bestimmte Challenge des offenen Sets aufmachen (SBC-Reihe).
     * Anders als openNextInstance() geht das NICHT ueber den Hub: das Set ist
     * schon offen, es fehlt nur die richtige Zeile. Ist gerade eine andere
     * Challenge offen, wird zuerst zurueck in die Liste navigiert.
     *
     * Erfolg heisst: die Challenge mit GENAU dieser challengeId ist offen und
     * ihr Squad ist nicht nachweislich belegt. Ein voller Squad ist kein
     * Erfolg - dann steht dort ein Team, das niemand abgegeben hat, und darauf
     * noch eines zu legen waere der schlechteste Ausgang.
     */
    async function openChallengeFromList(step) {
        const steps = [];
        // OHNE Anker gibt es nichts zu erkennen. Vorher lief die Schleife in
        // dem Fall 18 Sekunden gegen String(undefined) === String(3948) - eine
        // Bedingung, die nie wahr werden konnte. Wer auf etwas Unmoegliches
        // wartet, soll es sagen.
        if (!step || step.id == null) {
            return { ok: false, steps: [{ why: 'kein Challenge-Anker übergeben',
                                          step: step ? Object.keys(step) : null }] };
        }
        const t0 = Date.now();
        let clicked = 0, backs = 0, entered = 0, waited = 0;
        // Wann wurde zuletzt betreten? Direkt danach laedt die Ansicht, und die
        // challengeId kommt erst mit ihr. Ein Zurueck-Klick in diesem Fenster
        // wirft genau das weg, was man gerade geoeffnet hat - live dreimal
        // passiert (Back bei ms 2944, 11494).
        let enteredAt = -99;
        // Zwei Schritte, nicht einer: erst die Zeile WAEHLEN, dann die
        // Challenge BETRETEN. Der zweite fehlte bis v4.95.0 komplett.
        let phase = 'zeile';
        for (let i = 0; i < 60; i++) {          // 60 x 300ms = max ~18s
            dismissRewardPopup();
            syncSbcWithOpenChallenge();
            const ctrl = findSbcController();
            if (ctrl && String(STATE.sbc.challengeId) === String(step.id)) {
                const sq = ctrl._squad || (ctrl.getSquad && ctrl.getSquad());
                let empty = null;
                try { if (sq && typeof sq.isSquadEmpty === 'function') empty = sq.isSquadEmpty(); }
                catch (e) {}
                if (empty === false) {
                    steps.push({ ms: Date.now() - t0, why: 'richtige Challenge, aber ' +
                        'das Squad ist belegt', challengeId: STATE.sbc.challengeId });
                    return { ok: false, occupied: true, steps: steps };
                }
                steps.push({ ms: Date.now() - t0, done: true, clicked: clicked, backs: backs });
                return { ok: true, steps: steps };
            }
            if (ctrl) {
                // Eine ANDERE Challenge ist offen - zurueck in die Liste. Der
                // erste Versuch sofort (nach dem Abgeben stehen wir immer in
                // der gerade fertigen), danach im Takt von shouldTryBack.
                if ((i === 0 || shouldTryBack(i)) && (i - enteredAt) >= 6) {
                    const b = clickBackButton();
                    backs++;
                    steps.push({ ms: Date.now() - t0, back: b });
                    // Nach dem Zurueck stehen wir wieder in der Liste - also
                    // wieder mit der Zeilen-Auswahl anfangen.
                    phase = 'zeile';
                    if (b.ok) { await batchWait(900); continue; }
                }
            } else if (phase === 'zeile') {
                // In der Challenge-Liste: liegt ein Dialog oben, ignoriert EA
                // den Tap (live belegt beim Kachel-Klick) - erst aufraeumen.
                const pop = popupState();
                if (pop.overlays || (pop.shield && pop.shield.up)) {
                    dismissRewardPopup();
                    steps.push({ ms: Date.now() - t0, popupClosed: pop });
                    await batchWait(500);
                }
                const r = clickChallengeRow(step);
                steps.push({ ms: Date.now() - t0, chRow: r });
                if (r.ok) {
                    clicked++;
                    phase = 'betreten';
                    // Der Auswahl Zeit lassen: rechts baut sich der
                    // Anforderungs-Block neu auf, und der Eintritts-Knopf
                    // gehoert zu DIESER Auswahl.
                    await batchWait(700);
                    continue;
                }
                // Zeilen noch nicht da - einfach im Takt weiter versuchen.
            } else if (phase === 'betreten') {
                // ZWEITER Schritt, der bis v4.95.0 fehlte: die Zeile WAEHLT
                // nur aus, betreten wird ueber den Knopf ("Go to Challenge" /
                // "Start Challenge").
                const e = clickChallengeEnterButton(lastChallengeRowEl);
                steps.push({ ms: Date.now() - t0, enter: e });
                phase = 'warten';
                if (e.ok) { entered++; enteredAt = i; await batchWait(900); continue; }
                // Kein Knopf gefunden: am Handy navigiert der Zeilen-Tap
                // moeglicherweise direkt. Dann greift oben der Controller-Test.
            } else {
                // Gewartet und nichts passiert - nach ein paar Sekunden ein
                // neuer Anlauf, statt bis zum Zeitablauf stillzustehen.
                waited++;
                if (waited % 10 === 0) phase = 'zeile';
            }
            await batchWait(300);
        }
        // WAS ist am Ende offen? Live stand hier eine andere Challenge desselben
        // Sets - und die Meldung sagte nur "liess sich nicht oeffnen". Der
        // Unterschied zwischen "nichts ging auf" und "die falsche ging auf" ist
        // der ganze Befund.
        const openId = STATE.sbc.challengeId;
        const falsche = (openId != null && String(openId) !== String(step.id));
        steps.push({ ms: Date.now() - t0, popup: popupState(),
                     why: 'Zeitueberschreitung', openId: openId, wantId: step.id,
                     wrongChallenge: falsche,
                     phase: phase, rowClicks: clicked, enterClicks: entered });
        return { ok: false, wrongChallenge: falsche, openId: openId, steps: steps };
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
    /**
     * Einen echten Tap nachbilden. Drei Dinge, die vorher fehlten und den
     * Batch am HANDY haben scheitern lassen (live: "Set-Kachel geklickt
     * (exakt)" dreimal, und die App blieb im Hub):
     *
     *  1. TOUCH-Events. Die schmale EA-Ansicht haengt ihre Tap-Handler an
     *     touchstart/touchend - am PC (Maus) reichten pointer+mouse.
     *  2. KOORDINATEN. Die Events kamen mit clientX/clientY = 0, also aus der
     *     linken oberen Ecke. Wer per Hit-Test prueft, verwirft das.
     *  3. scrollIntoView. Die gesuchte Kachel steht im Hub weit unten (im
     *     Live-Report war "Daily Silver Upgrade" die achte von vielen); ein
     *     Tap ausserhalb des Viewports ist keiner.
     *
     * Hat ein Touch-Handler preventDefault aufgerufen, ist der Tap verarbeitet
     * und die Maus-Events entfallen - genau wie im echten Browser. Sonst
     * kaeme die Navigation womoeglich zweimal.
     */
    function clickLike(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {
            try { el.scrollIntoView(); } catch (e2) {}
        }
        const r = (el.getBoundingClientRect && el.getBoundingClientRect()) ||
                  { left: 0, top: 0, width: 0, height: 0 };
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const o = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1,
                    clientX: x, clientY: y, screenX: x, screenY: y,
                    pointerType: 'touch', isPrimary: true };
        const sent = [];
        function fire(type, Ctor, init) {
            try {
                const ok = el.dispatchEvent(new Ctor(type, init || o));
                sent.push(type);
                return ok;
            } catch (e) { return true; }
        }
        let touchHandled = false;
        try {
            if (typeof window.Touch === 'function' && typeof window.TouchEvent === 'function') {
                const mk = () => new window.Touch({
                    identifier: 1, target: el, clientX: x, clientY: y,
                    pageX: x + (window.scrollX || 0), pageY: y + (window.scrollY || 0),
                    screenX: x, screenY: y
                });
                const t = mk();
                const base = { bubbles: true, cancelable: true, view: window };
                fire('touchstart', window.TouchEvent, Object.assign({}, base,
                    { touches: [t], targetTouches: [t], changedTouches: [t] }));
                const notPrevented = fire('touchend', window.TouchEvent, Object.assign({}, base,
                    { touches: [], targetTouches: [], changedTouches: [t] }));
                touchHandled = !notPrevented;
            }
        } catch (e) {}
        if (!touchHandled) {
            if (typeof window.PointerEvent === 'function') {
                fire('pointerdown', window.PointerEvent);
                fire('pointerup', window.PointerEvent);
            }
            fire('mousedown', MouseEvent);
            fire('mouseup', MouseEvent);
            fire('click', MouseEvent);
        }
        try {
            // Was liegt an der Tap-Stelle GANZ OBEN? Ist das nicht die Kachel
            // selbst (oder ein Kind davon), deckt etwas sie ab - im Live-Report
            // kam der Tap an und die Kachel oeffnete trotzdem nicht.
            let covered = null, topCls = null;
            try {
                const top = document.elementFromPoint(x, y);
                if (top) {
                    topCls = String(top.className || top.tagName || '').slice(0, 60);
                    covered = !(top === el || el.contains(top) || top.contains(el));
                }
            } catch (e2) {}
            STATE.diag.lastTap = {
                events: sent.join(','), touchHandled: touchHandled,
                x: x, y: y,
                inViewport: (y >= 0 && y <= (window.innerHeight || 0) &&
                             x >= 0 && x <= (window.innerWidth || 0)),
                covered: covered, topAtPoint: topCls,
                popup: popupState()
            };
        } catch (e) {}
        return sent.length > 0;
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
    /**
     * Filter im Hub auf "All" stellen. Live-Fall: der Filter stand auf
     * "Favourites", und die gesuchte SBC war dort gar nicht dabei - dann ist
     * ihre Kachel nicht im DOM und kein Klick der Welt findet sie.
     */
    function clickAllFilter() {
        const items = visibleAll('.ea-filter-bar-item-view');
        for (const el of items) {
            const t = (el.textContent || '').trim().toLowerCase();
            if (t === 'all' || t === 'alle') {
                if (el.className.indexOf('selected') > -1) return { ok: true, why: 'schon auf All' };
                return { ok: clickLike(el), why: 'Filter auf All gestellt' };
            }
        }
        return { ok: false, why: 'kein All-Filter gefunden' };
    }
    /**
     * Set-Kachel im Hub anklicken. Der Name muss GENAU passen: ein reiner
     * Teilstring-Vergleich trifft sonst die falsche SBC ("Upgrade" steckt in
     * jeder zweiten Kachel) - und die Diagnose meldete "geklickt", obwohl sich
     * nichts oeffnete. Reihenfolge: exakter Titel, dann Titel-Anfang, dann
     * Teilstring - und immer wird mitprotokolliert, WAS getroffen wurde.
     */
    function clickSetTile(plan) {
        const tiles = visibleAll('.ut-sbc-set-tile-view');
        const want = String(plan.setName || '').trim().toLowerCase();
        if (!want) return { ok: false, why: 'kein Set-Name gemerkt', tiles: tiles.length };
        if (!tiles.length) return { ok: false, why: 'keine Set-Kacheln sichtbar', tiles: 0 };
        // WARUM titleSource: findet titleOf() keines der Titel-Elemente (EA baut
        // nur die INNEREN Elemente um, .ut-sbc-set-tile-view selbst bleibt
        // bestehen), faellt es auf den GESAMTEN Kachel-Text zurueck - genau der
        // Zustand, der laut LEARNINGS §9 (v4.23.0) live zum Teilstring-Fehlgriff
        // fuehrte ("Upgrade" steckt in jeder zweiten Kachel). Die Matching-Logik
        // selbst bleibt unveraendert, titleSource macht nur sichtbar, OB dieser
        // fragile Pfad gerade griff.
        function titleOf(t) {
            const h = t.querySelector('.tileTitle, .tileHeader, h1');
            const text = ((h && h.textContent) || t.textContent || '')
                .replace(/\s+/g, ' ').trim().toLowerCase();
            return { text: text, source: h ? 'element' : 'fulltext' };
        }
        let hit = null, how = null, hitSource = null;
        for (const t of tiles) {
            const ti = titleOf(t);
            if (ti.text === want) { hit = t; how = 'exakt'; hitSource = ti.source; break; }
        }
        if (!hit) {
            for (const t of tiles) {
                const ti = titleOf(t);
                if (ti.text.indexOf(want) === 0 || want.indexOf(ti.text) === 0) {
                    hit = t; how = 'Anfang'; hitSource = ti.source; break;
                }
            }
        }
        if (!hit) {
            for (const t of tiles) {
                const ti = titleOf(t);
                if (ti.text.indexOf(want) > -1) { hit = t; how = 'enthalten'; hitSource = ti.source; break; }
            }
        }
        if (!hit) {
            return { ok: false, why: 'Set nicht gefunden', want: want, tiles: tiles.length,
                     titles: tiles.slice(0, 8).map(function (t) { return titleOf(t).text; }) };
        }
        // Erst die Kachel, dann ihr Titel-Element - manche Views haengen ihren
        // Tap-Handler am Kind, nicht am Container.
        clickLike(hit);
        const tap = STATE.diag.lastTap || null;
        const inner = hit.querySelector('.tileHeader, .tileTitle, h1');
        if (inner) clickLike(inner);
        return { ok: true, why: 'Set-Kachel geklickt (' + how + ')',
                 want: want, hitTitle: titleOf(hit).text, titleSource: hitSource, tap: tap,
                 tapInner: inner ? (STATE.diag.lastTap || null) : null };
    }
    /**
     * Welche der sichtbaren Challenge-Zeilen ist die gesuchte? Reine
     * Text-Auswertung (die Zeilen-TEXTE kommen herein, nicht die Elemente),
     * damit die Zuordnung ohne DOM testbar ist - sie entscheidet, in welche
     * SBC ein Team wandert.
     * Reihenfolge der Versuche: exakter Name, Name enthalten, dann das
     * Ziel-OVR als eigenstaendige Zahl. Liefert den Index oder -1.
     */
    function pickChallengeRowIndex(texts, want) {
        if (!want) return (texts && texts.length) ? 0 : -1;
        const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const list = (texts || []).map(norm);
        const name = norm(want.name);
        // Als EIGENSTAENDIGE Zahl - sonst trifft "9" in "90-Rated Squad" und
        // "91" waere nicht mehr unterscheidbar.
        const targetRe = (want.target != null)
            ? new RegExp('(^|[^0-9])' + String(want.target) + '([^0-9]|$)') : null;
        function plausibel(txt) {
            if (name && txt.indexOf(name) > -1) return true;
            if (targetRe && targetRe.test(txt)) return true;
            return false;
        }
        // 1. DIE POSITION. Sie ist die einzige eindeutige Kennung: live hiessen
        //    SECHS Challenges eines Sets "91-Rated Squad", und der Name traf
        //    damit immer die erste davon.
        //    Nur wenn die sichtbare Liste vollstaendig ist (gleich viele Zeilen
        //    wie Challenges) und der Text an der Stelle passt.
        if (typeof want.rowIndex === 'number' && want.rowIndex >= 0 &&
            want.rowIndex < list.length &&
            (want.rowCount == null || want.rowCount === list.length) &&
            (!name && !targetRe ? true : plausibel(list[want.rowIndex]))) {
            return want.rowIndex;
        }
        // 2. Der NAME - aber nur, wenn er EINDEUTIG ist. "Nimm die erste von
        //    sechs" ist genau der Fehler, der hier behoben wird.
        if (name) {
            const exakt = [];
            for (let i = 0; i < list.length; i++) { if (list[i] === name) exakt.push(i); }
            if (exakt.length === 1) return exakt[0];
            const teil = [];
            for (let i = 0; i < list.length; i++) { if (list[i].indexOf(name) > -1) teil.push(i); }
            if (teil.length === 1) return teil[0];
            if (teil.length > 1) return -1;   // mehrdeutig: lieber abbrechen
        }
        // 3. Das Ziel-OVR, ebenfalls nur eindeutig.
        if (targetRe) {
            const hits = [];
            for (let i = 0; i < list.length; i++) { if (targetRe.test(list[i])) hits.push(i); }
            if (hits.length === 1) return hits[0];
        }
        return -1;
    }
    /**
     * Challenge-Zeile in der geoeffneten Set-Ansicht anklicken.
     * OHNE Argument: die erste Zeile - genau das Verhalten, das der Batch seit
     * v4.23.0 benutzt, unveraendert.
     * MIT `want` ({ name, target }): die passende Zeile - das braucht die
     * SBC-Reihe, die gezielt die 89er/90er/91er ansteuert.
     */
    // Die zuletzt GEWAEHLTE Zeile. Bewusst ein Modul-Merker statt eines
    // Feldes im Rueckgabe-Objekt: die Rueckgaben landen als JSON in der
    // Diagnose, ein DOM-Element darin wuerde die Serialisierung sprengen.
    let lastChallengeRowEl = null;
    function clickChallengeRow(want) {
        lastChallengeRowEl = null;
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
        if (!want) {
            // Die erste Zeile ist die noch offene Wiederholung.
            lastChallengeRowEl = rows[0];
            return { ok: clickLike(rows[0]), why: rows.length + ' Zeile(n), erste geklickt' };
        }
        const texts = rows.map(function (r) {
            return String((r && r.textContent) || '').replace(/\s+/g, ' ').trim();
        });
        const idx = pickChallengeRowIndex(texts, want);
        if (idx < 0) {
            // Mehrdeutig ODER nicht gefunden - beides unterscheiden, sonst
            // sucht man beim naechsten Report am falschen Ende.
            const nm = String(want.name || '').toLowerCase();
            const mehrfach = nm ? texts.filter(function (t) {
                return String(t).toLowerCase().indexOf(nm) > -1;
            }).length : 0;
            return { ok: false,
                     why: (mehrfach > 1)
                        ? ('Name "' + want.name + '" kommt ' + mehrfach + 'x vor und die ' +
                           'Position passt nicht (' + texts.length + ' Zeilen, erwartet ' +
                           want.rowCount + ')')
                        : 'gesuchte Challenge-Zeile nicht gefunden',
                     want: (want.name || '') + '/' + want.target +
                           ' @' + want.rowIndex + '/' + want.rowCount,
                     rows: texts.length,
                     texts: texts.slice(0, 8).map(function (t) { return t.slice(0, 50); }) };
        }
        lastChallengeRowEl = rows[idx];
        return { ok: clickLike(rows[idx]), why: 'Zeile ' + (idx + 1) + ' von ' +
                 rows.length + ' geklickt', hit: texts[idx].slice(0, 60) };
    }
    // Beschriftungen des Knopfes, der eine AUSGEWAEHLTE Challenge betritt.
    // EA wechselt sie je nach Zustand: "Start Challenge" bei einer noch nicht
    // begonnenen, "Go to Challenge" bei einer laufenden (beides live gesehen).
    // Bewusst eine kurze Liste mit EXAKTEM Vergleich - lieber "nicht gefunden"
    // als ein geratener Klick in einer Ansicht voller Knoepfe.
    const CHALLENGE_ENTER_LABELS = [
        'go to challenge', 'start challenge',
        'zur challenge', 'challenge starten', 'challenge öffnen'
    ];
    /**
     * Welcher der sichtbaren Knoepfe betritt die ausgewaehlte Challenge?
     * Rein (es kommen nur Beschriftung + "steckt in einer Zeile" herein),
     * damit die Auswahl ohne DOM testbar ist.
     * `inRow` schliesst die Knoepfe INNERHALB einer Challenge-Zeile aus: die
     * heissen genauso, sind aber nur die Auswahl - genau der Klick, der live
     * dreimal ins Leere ging.
     */
    function pickEnterButton(info) {
        const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
        for (const want of CHALLENGE_ENTER_LABELS) {
            for (let i = 0; i < (info || []).length; i++) {
                if (!info[i] || info[i].inRow) continue;
                if (norm(info[i].text) === want) return i;
            }
        }
        return -1;
    }
    /**
     * Der Eintritts-Knopf INNERHALB einer Zeile (schmale Ansicht am Handy):
     * dort gibt es keinen aeusseren "Go to Challenge" (Mikes Log: seen enthielt
     * nur unsere eigenen Panel-Knoepfe), der "Start Challenge"-Knopf steckt in
     * jeder Zeile. Rein (Text + Eltern-Text kommen herein), damit die Auswahl
     * testbar ist. Exakte Beschriftung; genommen wird die AEUSSERSTE Huelle
     * des Textes - Knopf und innerer span tragen denselben Text, und geklickt
     * werden soll der Knopf (dieselbe Regel wie beim Pack-Open-Knopf).
     */
    function pickInRowEnterIndex(infos) {
        const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
        for (const want of CHALLENGE_ENTER_LABELS) {
            for (let i = 0; i < (infos || []).length; i++) {
                if (!infos[i] || norm(infos[i].text) !== want) continue;
                // Innere Ebene? Der Eltern-Text ist dann ebenfalls exakt das
                // Label - die aeussere Huelle kommt in DOM-Reihenfolge zuerst.
                if (infos[i].parentText != null && norm(infos[i].parentText) === want) continue;
                return i;
            }
        }
        return -1;
    }
    /**
     * Den Eintritts-Knopf klicken. Zwei Ansichten, zwei Wege:
     *  - Split-View (Desktop): der Knopf steht AUSSERHALB der Zeilen rechts.
     *  - Schmale Ansicht (Handy): es gibt aussen KEINEN - der Knopf steckt in
     *    der Zeile selbst, und der Zeilen-Tap allein navigiert nicht (Mikes
     *    Log: openId blieb die alte Challenge, rowClicks 5, enterClicks 0).
     * `rowEl` ist die zuvor GEWAEHLTE Zeile - nur dort wird gesucht, nie in
     * allen. Der Fallback ist auf dem Desktop unerreichbar (aussen gewinnt).
     */
    function clickChallengeEnterButton(rowEl) {
        let rows = [];
        try {
            rows = Array.prototype.slice.call(document.querySelectorAll(
                '.ut-sbc-challenge-table-row-view, .ut-sbc-challenge-tile-view'));
        } catch (e) {}
        function inRow(el) {
            for (const r of rows) {
                try { if (r === el || r.contains(el)) return true; } catch (e) {}
            }
            return false;
        }
        const els = visibleAll('button, .btn-standard');
        const info = els.map(function (el) {
            return {
                text: String((el && el.textContent) || '').replace(/\s+/g, ' ').trim(),
                inRow: inRow(el)
            };
        });
        const idx = pickEnterButton(info);
        if (idx < 0) {
            // SCHMALE ANSICHT: in der gewaehlten Zeile nachsehen.
            if (rowEl) {
                let cand = [];
                try {
                    cand = Array.prototype.slice.call(
                        rowEl.querySelectorAll('button, .btn-standard, div, span'));
                } catch (e) {}
                const infos2 = cand.map(function (el) {
                    return {
                        text: String((el && el.textContent) || '').replace(/\s+/g, ' ').trim(),
                        parentText: (el && el.parentElement)
                            ? String(el.parentElement.textContent || '').replace(/\s+/g, ' ').trim()
                            : null
                    };
                });
                const j = pickInRowEnterIndex(infos2);
                if (j >= 0) {
                    return { ok: clickLike(cand[j]),
                             why: 'Eintritts-Knopf IN der Zeile geklickt (schmale Ansicht)',
                             label: infos2[j].text.slice(0, 40) };
                }
            }
            return { ok: false, why: 'kein Eintritts-Knopf gefunden',
                     inRowTried: !!rowEl,
                     seen: info.filter(function (x) { return !x.inRow; })
                               .slice(0, 8)
                               .map(function (x) { return x.text.slice(0, 30); }) };
        }
        return { ok: clickLike(els[idx]), why: 'Eintritts-Knopf geklickt',
                 label: info[idx].text.slice(0, 40) };
    }
    // Eigene, pur testbare Bedingung statt inline in openNextInstance - der
    // v4.36.0-Live-Vorfall (App blieb im Squad-View haengen) war bisher nur per
    // Text-Match belegt, nicht per Verhaltenstest.
    function shouldTryBack(i) { return i === 5 || i === 25; }
    /**
     * Den Zurueck-Pfeil der App-Kopfleiste klicken. Gebraucht, wenn die App
     * nach dem Abgeben im Squad-View haengen bleibt (live beim 4/5-Abbruch):
     * es gibt keinen gefundenen Weg, eine Challenge programmatisch zu OEFFNEN
     * (LEARNINGS 9), aber ZURUECK geht per DOM - .ut-navigation-button-control
     * ist der Pfeil oben links (dieselbe EA-Klasse, die auch Community-Scripte
     * fuer "Back" nutzen). Harmlos: das Team ist zu diesem Zeitpunkt bereits
     * abgegeben, der Klick verlaesst nur die Ansicht. Geklickt wird NUR, wenn
     * kein Overlay offen ist - nie blind in einen Dialog.
     */
    function clickBackButton() {
        const pop = popupState();
        if (pop.overlays || (pop.shield && pop.shield.up)) {
            return { ok: false, why: 'Overlay offen - kein Zurueck-Klick', popup: pop };
        }
        const cands = visibleAll('.ut-navigation-button-control')
            .concat(visibleAll('.ut-navigation-bar-view .btn-navigation'));
        if (!cands.length) return { ok: false, why: 'kein Zurueck-Button gefunden' };
        const el = cands[0];
        return { ok: clickLike(el), why: 'Zurueck geklickt',
                 cls: String(el.className || el.tagName || '').slice(0, 60) };
    }
    /**
     * Laesst sich das Set ueberhaupt noch wiederholen? Gelesen wird der
     * Status-Text der Kachel im Hub ("Repeatable", "Repeatable: 5 …",
     * "Complete"/"Completed"). Rueckgabe:
     *   { repeatable: true|false|null, status: '<Text>' }
     * null heisst "nicht ablesbar" - dann wird NICHT abgebrochen, sondern wie
     * bisher weiter versucht. Eine Fehldiagnose darf keinen laufenden Batch
     * abwuergen.
     */
    function setLooksRepeatable(want) {
        try {
            const tiles = visibleAll('.ut-sbc-set-tile-view');
            const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const target = norm(want);
            for (const e of tiles) {
                const t = e.querySelector('.tileTitle, .tileHeader, h1');
                const title = norm(t && t.textContent);
                if (!title || (title !== target && title.indexOf(target) < 0)) continue;
                const st = e.querySelector('.sbc-status-container');
                const raw = ((st && st.textContent) || '').trim().replace(/\s+/g, ' ');
                if (!raw) return { repeatable: null, status: '' };
                const low = raw.toLowerCase();
                // "Repeatable: 5 …" / "Repeatable …" -> geht noch.
                if (low.indexOf('repeatable') > -1) {
                    // Explizite 0 kommt vor - dann ist Schluss.
                    const m = raw.match(/Repeatable:\s*(\d+)/i);
                    if (m && Number(m[1]) === 0) return { repeatable: false, status: raw };
                    return { repeatable: true, status: raw };
                }
                // Kein "Repeatable", aber "Complete(d)" -> fuer heute durch.
                if (low.indexOf('complete') > -1) return { repeatable: false, status: raw };
                return { repeatable: null, status: raw };
            }
        } catch (e) {}
        return { repeatable: null, status: '' };
    }
    /**
     * Passt die offene SBC zu dem, wofuer geplant wurde? (Vorgaben, nicht ID)
     * `sbcState` ist optional und dient dem Test: ohne Argument gilt der echte
     * Zustand, genau wie bisher an allen bestehenden Aufrufstellen.
     */
    function matchesPlannedSbc(plan, sbcState) {
        const sbc = sbcState || STATE.sbc;
        if (String(sbc.targetOVR || '') !== String(plan.targetOVR || '')) return false;
        if (Number(sbc.formationSlots || 0) !== Number(plan.slots || 0)) return false;
        return true;
    }
    // Schutz gegen eine bereits abgegebene Instanz - mit Daily-Ausnahme.
    // "Jede Wiederholung hat eine eigene challengeId" (LEARNINGS §9) gilt NUR
    // fuer die Rating-Upgrade-Sets. Daily-SBCs (live belegt: "Daily Bronze
    // Upgrade", challengeId 3068, zwei Reports v4.56.0) setzen DIESELBE
    // challengeId einfach zurueck - die harte Sperre auf usedChallengeIds
    // blockierte dort jede zweite Runde ("Batch gestoppt nach 1/6", das Squad
    // wurde nie befuellt). Deshalb: eine benutzte challengeId gilt wieder als
    // frisch, wenn die Instanz NACHWEISLICH leer ist (squadEmpty === true,
    // strikt - null heisst "unbekannt" und bleibt gesperrt). Eine
    // fehlgeschlagene Abgabe hinterlaesst ein volles Squad und bleibt blockiert.
    function isFreshMatchingInstance(plan, sbcState, squadEmpty) {
        if (!matchesPlannedSbc(plan) || squadEmpty === false) return false;
        const used = (plan.usedChallengeIds || []).indexOf(String(sbcState.challengeId)) > -1;
        if (!used) return true;
        if (squadEmpty === true) {
            plan.sameIdReuse = (plan.sameIdReuse || 0) + 1; // Diagnose: Daily-Wiederverwendung
            return true;
        }
        return false;
    }
    async function onBatchPlanClick() {
        syncSbcWithOpenChallenge();
        if (!STATE.sbc.targetOVR && !(STATE.sbc.playerLevelConstraints || []).length &&
            !(STATE.sbc.rarityConstraints || []).length &&
            !(STATE.sbc.qualityConstraints || []).length) {
            toast('Keine SBC-Vorgaben erkannt. Bitte Challenge im Spiel öffnen.', 'error');
            return;
        }
        const tooSmallBatch = poolTooSmallReason(STATE.sbc.formationSlots || 11);
        if (tooSmallBatch) { toast(tooSmallBatch, 'error'); return; }
        // Analog zur Warnung in onRunClick (:4509): der Batch darf trotzdem
        // planen und abgeben (Rasmus entscheidet bei der einen Freigabe,
        // CLAUDE.md "Batch darf abgeben") - nur informieren, nicht blockieren.
        if (STATE.loadIncomplete) {
            toast('ACHTUNG: Der Pool war beim Planen unvollständig geladen (' + STATE.pool.length +
                ' Karten) - der Plan kann auf fehlenden Karten beruhen. Am besten erst "Spieler laden" erneut ausführen, dann neu planen.', 'warn');
        }
        if (anyDeepScanTruncated()) {
            // Wie in onRunClick: die verlaesslichste Vorgaben-Quelle (elgReq
            // aus den Set-Challenges) aktiv nachladen, bevor geplant wird.
            await ensureSetChallenges('onBatchPlanClick');
        }
        if (anyDeepScanTruncated() && !STATE.setChallengesBySet[STATE.sbc.setId]) {
            toast('Hinweis: Der Vorgaben-Scan wurde abgeschnitten - der Plan könnte auf unvollständigen Vorgaben beruhen. Vorschau prüfen.', 'warn');
        }
        const want = Math.max(1, Math.min(10, parseInt(ui.batchCount.value, 10) || 1));
        ui.batchPlan.disabled = true;
        setStatus('plane ' + want + ' Teams...');
        try {
            // PHASEN MESSEN. "Seite reagiert nicht" kam beim Planen von 10
            // Teams; gemessen ist eine Solver-Runde bei 8558 Karten ~600ms,
            // das erklaert keine zweistelligen Sekunden. Ohne diese Zahlen
            // waere die naechste Runde wieder Raten.
            const tim = { total: 0, config: 0, rounds: [], render: 0 };
            const tAll = Date.now();
            let tp = Date.now();
            const cfg = readConfig();
            tim.config = Date.now() - tp;
            // Runden EINZELN rechnen und zwischendurch an den Browser
            // zurueckgeben - sonst friert die Seite fuer die ganze Dauer ein.
            const st = SolverCore.beginBatch(STATE.pool, cfg, want);
            for (let i = 0; i < want; i++) {
                showProgress(i + 1, want, 'plane Team ' + (i + 1) + ' von ' + want + '...',
                    (st.rounds.length ? st.rounds.length + ' fertig' : ''));
                // VOR dem Rechnen warten: so kommt der Fortschritt wirklich
                // auf den Schirm. Nach dem Rechnen waere der erste Frame nie
                // gezeichnet worden.
                await sleep(0);
                const tr = Date.now();
                const r = SolverCore.batchRound(st);
                tim.rounds.push(Date.now() - tr);
                if (!r) break;
            }
            const plan = SolverCore.finishBatch(st);
            // Fuer den Plan-Check (Ticket #73) am Plan festgehalten: derselbe
            // Stand, mit dem geplant wurde - eine spaetere UI-Aenderung darf
            // die Auswertung des schon fertigen Plans nicht verfaelschen.
            plan.cfg = cfg;
            // Anker ist das SET plus die Vorgaben - die challengeId aendert
            // sich pro Wiederholung und taugt nicht als Vergleich.
            plan.setId = STATE.sbc.setId;
            // Fuer die Vorschau festgehalten (renderBatchPreview): der Toast
            // oben ist nach ein paar Sekunden weg, die Freigabe kommt aber oft
            // erst deutlich spaeter - der Zustand muss in der Vorschau stehen
            // bleiben.
            plan.poolLoadIncomplete = STATE.loadIncomplete;
            plan.targetOVR = STATE.sbc.targetOVR;
            plan.slots = STATE.sbc.formationSlots;
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
            tp = Date.now();
            renderBatchPreview(plan);
            tim.render = Date.now() - tp;
            tim.total = Date.now() - tAll;
            STATE.diag.batchPlanTiming = tim;
            try { STATE.diag.solverProfile = SolverCore.lastProfiles(); } catch (e) {}
            finishProgress(plan.planned + ' von ' + want + ' Teams geplant', true);
            setStatus(plan.planned + ' von ' + want + ' Teams geplant');
        } catch (e) {
            toast('Batch-Planung fehlgeschlagen: ' + e.message, 'error');
            reportError('Batch-Planung fehlgeschlagen', e);
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
    /**
     * Plan-Check (Ticket #73): reine Auswertung des von planBatch bereits
     * fertig geplanten Ergebnisses - kein Solver-Aufruf, keine Aenderung an
     * der Planung selbst. Rasmus scrollte vorher jedes Team von Hand durch,
     * um sowas wie 84.xx statt 84 oder doppeltes TOTW zu finden.
     *
     * Score-Konvention: bestandene / gesamte Pruefungen (gerundet). Pro
     * Runde zaehlen IMMER 4 Pruefungen (Waste, Gruppe-83-Anzahl, Min-Rating,
     * Storage-Anteil), global IMMER 2 (keine doppelte Karten-Id, Pool
     * vollstaendig geladen) - ein fester Nenner, unabhaengig davon, ob eine
     * Pruefung im Einzelfall ueberhaupt greift (z.B. Waste ohne Ziel-OVR ist
     * strukturell 0, Min-Rating bei Bronze/Silber wird auf 0 abgesenkt -
     * CLAUDE.md: "Min-Rating wird dabei komplett ignoriert"). Damit hat der
     * Score in jedem Szenario dieselbe Grundlage. "Hinweis" (Storage-Anteil)
     * zaehlt im Score mit, ist aber separat gelabelt und faerbt wie eine
     * bestehende Warnung statt wie ein Fehler - "Fehler" nur bei echten
     * Vorgaben-/Rating-Verstoessen.
     */
    function computeBatchPlanCheck(plan, cfg) {
        const lines = []; // { level: 'error'|'hint', text }
        let passed = 0, total = 0;
        function runCheck(level, ok, text) {
            total++;
            if (ok) { passed++; return; }
            lines.push({ level: level, text: text });
        }
        // Die Grenzwerte EINER Runde. Beim Batch ist es fuer alle Runden
        // dieselbe Konfiguration; in der SBC-REIHE hat jede Runde ihre eigene
        // (Ziel-OVR und Vorgaben unterscheiden sich pro Challenge) und bringt
        // sie als r.cfg mit. Ohne r.cfg bleibt alles wie vorher - der Batch
        // laeuft durch denselben Code wie bisher.
        function limitsOf(c) {
            const rcs = (c.applyRarity === false) ? [] : (c.rarityConstraints || []);
            const qcs = (c.applyRarity === false) ? [] : (c.qualityConstraints || []);
            const req83 = rcs
                .filter(rc => Number(rc.groupId) === 83 ||
                    (rc.groupId == null && Array.isArray(rc.ids) && rc.ids.map(Number).indexOf(3) > -1))
                .reduce((sum, rc) => sum + (rc.count || 1), 0);
            const low = qcs.some(q => Number(q.quality) === 1 || Number(q.quality) === 2);
            return {
                required83: req83,
                rarityMode: c.rarityMode || 'vereinTotw',
                effectiveMinRating: low ? 0 : (c.minRating || 0),
                maxOvershoot: c.maxOvershoot || 0,
                rarityPickId: c.rarityPickId
            };
        }
        const baseLimits = limitsOf(cfg);
        const rarityConstraints = (cfg.applyRarity === false) ? [] : (cfg.rarityConstraints || []);
        // Vorgaben zaehlen wie der Solver sie erfuellt (Nacht-Review 16.08.):
        // matchesRarity() bedient Gruppe 83 auch ueber den ids-Zweig
        // (rareflag 3 = TOTW) - eine ids-basierte TOTW-Vorgabe erzeugte hier
        // sonst den falschen roten Fehler "1x statt geforderter 0" auf einem
        // korrekten Plan. Karten-Identitaet ebenso doppelt (groups ODER
        // rareflag 3), SSOT mit isProtectedRarity/isTotw im Solver.
        // ids zaehlen NUR ohne groupId - dieselbe Praezedenz wie matchesRarity
        // (der ids-Zweig ist dort unerreichbar, wenn groupId greift). Sonst
        // wuerde z.B. eine PLAYER_RARITY_GROUP-3-Vorgabe (groupId 3 UND
        // ids [3]) faelschlich als TOTW-Vorgabe gezaehlt (Review-Runde 2).
        const required83 = rarityConstraints
            .filter(rc => Number(rc.groupId) === 83 ||
                (rc.groupId == null && Array.isArray(rc.ids) && rc.ids.map(Number).indexOf(3) > -1))
            .reduce((s, rc) => s + (rc.count || 1), 0);
        const is83 = p => Number(p.rareflag) === 3 ||
            !!(p.groups && p.groups.indexOf(83) > -1);
        // TOTW aus dem VEREIN - seit v4.83.0 die einzige hart geschuetzte
        // Sorte (EA hat die Gruppe entwertet, siehe CLAUDE.md "Rarity-Staffel").
        const isTotwClub = p => Number(p.rareflag) === 3 && !p.isStorage;
        const qualityConstraints = (cfg.applyRarity === false) ? [] : (cfg.qualityConstraints || []);
        // Deckt sich mit dem qualityLow-Zweig im Solver (Bronze/Silber
        // ignorieren Min-Rating komplett, Gold nicht) - hier nur, um
        // festzustellen, ob die Pruefung ueberhaupt greifen soll.
        const qualityLow = qualityConstraints.some(c => Number(c.quality) === 1 || Number(c.quality) === 2);
        const seenIds = new Set();
        let dupeCard = null;
        (plan.rounds || []).forEach(function (r, i) {
            const teamNo = i + 1;
            // Pro Runde: die eigene Konfiguration, falls sie eine hat.
            const L = r.cfg ? limitsOf(r.cfg) : baseLimits;
            const required83 = L.required83;
            const rarityMode = L.rarityMode;
            const effectiveMinRating = L.effectiveMinRating;
            const maxOvershoot = L.maxOvershoot;
            const waste = r.waste || 0;
            runCheck('error', waste <= maxOvershoot + 1e-9,
                'Team ' + teamNo + ': Rating-Überschuss ' + waste.toFixed(2) + ' über dem erlaubten Fenster ' +
                maxOvershoot.toFixed(2) + ' (exakt ' +
                (r.ovrExact != null ? r.ovrExact.toFixed(2) : '?') + ').');
            // WAS gezaehlt wird, haengt am Schutz-Modus - genau wie im Solver.
            // Bis v4.84.0 verlangte die Pruefung immer GENAU die geforderte
            // Anzahl Gruppe-83-Karten. Seit EA die Gruppe entwertet hat, sind
            // mehrere davon aus dem Storage voellig in Ordnung; teuer ist nur
            // TOTW aus dem Verein.
            const countedName = (rarityMode === 'gruppe83')
                ? 'Gruppe-83-Karte(n) (TOTW/TOTS/FOF/FUTTIES)'
                : 'TOTW aus dem Verein';
            const counted = (rarityMode === 'gruppe83') ? is83 : isTotwClub;
            const nCounted = r.players.filter(counted).length;
            // Eine MANUELL gewaehlte Karte ohne passende Vorgabe ist Rasmus'
            // explizite Entscheidung - kein roter Fehler. Aber NICHT still
            // gruen (Review-Runde 2): die Pick-Auswahl im Panel ueberlebt
            // SBC-Wechsel, ein VERALTETER Pick saehe sonst wie ein perfekter
            // Plan aus. Deshalb ein sichtbarer Hinweis - direkt in lines statt
            // ueber runCheck(), damit der feste Pruefungs-Nenner
            // (LEARNINGS 48) unveraendert bleibt.
            const pickedExtra = (required83 === 0 && L.rarityPickId != null &&
                L.rarityPickId !== '' &&
                r.players.some(p => String(p.id) === String(L.rarityPickId) && counted(p))) ? 1 : 0;
            const explainedByPick = pickedExtra > 0 && nCounted === required83 + pickedExtra;
            // 'gruppe83' verlangt GENAU die Anzahl (alte Regel). Sonst gilt
            // HOECHSTENS die geforderte Anzahl Vereins-TOTW: weniger ist immer
            // besser, mehr waere ein unnoetig verbrannter Anker. Modus 'aus'
            // schuetzt nichts - dann gibt es hier nichts zu bemaengeln.
            const rarityOk = (rarityMode === 'aus') ? true
                : (rarityMode === 'gruppe83'
                    ? (nCounted === required83 || explainedByPick)
                    : (nCounted <= required83 || explainedByPick));
            runCheck('error', rarityOk,
                'Team ' + teamNo + ': ' + nCounted + 'x ' + countedName +
                (rarityMode === 'gruppe83' ? ' statt geforderter ' : ' - erlaubt sind höchstens ') +
                required83 + '.');
            if (explainedByPick) {
                lines.push({ level: 'hint', text: 'Team ' + teamNo +
                    ': 1x ' + countedName + ' stammt aus der manuellen Karten-Wahl (keine SBC-Vorgabe)' +
                    ' - Auswahl zuruecksetzen, falls unbeabsichtigt.' });
            }
            const belowMin = r.players.filter(p => p.rating < effectiveMinRating);
            runCheck('error', belowMin.length === 0,
                'Team ' + teamNo + ': ' + belowMin.length + ' Karte(n) unter Min-Rating ' + effectiveMinRating +
                ' (' + belowMin.map(p => p.rating).join(', ') + ').');
            const nStore = r.players.filter(p => p.isStorage).length;
            runCheck('hint', nStore >= 1, 'Team ' + teamNo + ': keine Storage-Karte verbaut (nur Verein).');
            for (const p of r.players) {
                const key = String(p.id);
                if (seenIds.has(key) && !dupeCard) dupeCard = p.name || ('#' + key);
                seenIds.add(key);
            }
        });
        runCheck('error', !dupeCard, 'Karte "' + dupeCard + '" ist in mehreren Teams verbaut.');
        runCheck('hint', !plan.poolLoadIncomplete,
            'Pool war beim Planen unvollständig geladen - Plan kann auf fehlenden Karten beruhen. Vor der Freigabe ggf. "Spieler laden" erneut ausführen und neu planen.');
        const errors = lines.filter(l => l.level === 'error').length;
        const hints = lines.filter(l => l.level === 'hint').length;
        return {
            score: total ? Math.round(passed / total * 100) : 100,
            passed: passed, total: total,
            errors: errors, hints: hints,
            lines: lines
        };
    }
    /**
     * Karten-Herkunft ueber ALLE geplanten Runden. Reine Funktion, damit die
     * Zahl in der Kopfzeile testbar ist und nicht still falsch werden kann.
     * Alles, was nicht Storage ist, ist Verein - dieselbe Zweiteilung wie in
     * der Detailansicht.
     */
    function countPlanSources(plan) {
        let storage = 0, club = 0;
        for (const r of ((plan && plan.rounds) || [])) {
            for (const p of ((r && r.players) || [])) {
                if (p && p.isStorage) storage++; else club++;
            }
        }
        return { storage: storage, club: club, total: storage + club };
    }
    function renderBatchPreview(plan) {
        const box = ui.batchPreview;
        if (!box) return;
        const pc = computeBatchPlanCheck(plan, plan.cfg || {});
        const parts = [];
        if (pc.errors) parts.push(pc.errors + ' Fehler');
        if (pc.hints) parts.push(pc.hints + (pc.hints === 1 ? ' Hinweis' : ' Hinweise'));
        // Herkunft der Karten direkt in die Kopfzeile (Rasmus: "kurz und knapp
        // daneben"). Ueber ALLE geplanten Teams gezaehlt, nicht pro Team - im
        // Detail steht es ohnehin schon je Runde.
        const src = countPlanSources(plan);
        const srcInfo = src.total
            ? ' · <span class="sbc-opt-muted">Storage <b>' + src.storage +
              '</b> / Verein <b>' + src.club + '</b></span>'
            : '';
        const noun = (plan.mode === 'reihe') ? ' SBC(s) geplant' : ' Team(s) geplant';
        let html;
        if (!plan.planned) {
            // KEIN Confidence-Wert ohne Plan. Der Score ist "bestandene von
            // durchgefuehrten Pruefungen" - ohne Runde bleiben nur die zwei
            // globalen, die trivial bestehen, und das ergab live die
            // irrefuehrende Zeile "0 SBC(s) geplant · Confidence 100%".
            html = '<div class="sbc-opt-batch-round sbc-opt-batch-bad"><b>Nichts geplant</b>' +
                ' — es gibt also nichts abzugeben.</div>';
        } else {
            html = '<div class="sbc-opt-batch-round"><b>' + plan.planned + noun +
                '</b> · Confidence <b>' + pc.score + '%</b>' + srcInfo +
                (parts.length ? ' — ' + parts.join(' + ') : '') + '</div>';
        }
        for (const l of pc.lines) {
            html += '<div class="sbc-opt-batch-round ' + (l.level === 'error' ? 'sbc-opt-batch-bad' : 'sbc-opt-batch-warn') + '">' +
                (l.level === 'error' ? '✗ ' : '⚠ ') + escapeHtml(l.text) + '</div>';
        }
        // Steht in JEDER uebersprungenen Zeile derselbe Pool-Grund, gehoert die
        // Handlung EINMAL nach oben statt dreimal daneben.
        const skipped = plan.skipped || [];
        const allPool = skipped.length &&
            skipped.every(function (sk) { return /Pool/i.test(String(sk.reason)); });
        if (allPool) {
            html += '<div class="sbc-opt-batch-round sbc-opt-batch-bad">' +
                'Der Pool reicht für kein Team (' + STATE.pool.length + ' Karten). ' +
                'Oben auf <b>Spieler laden</b> drücken, dann erneut planen.</div>';
        }
        for (const sk of skipped) {
            html += '<div class="sbc-opt-batch-round sbc-opt-batch-warn">⚠ "' +
                escapeHtml((sk.step && sk.step.name) || '?') + '" übersprungen: ' +
                escapeHtml(String(sk.reason)) + '</div>';
        }
        if (plan.stoppedReason) {
            html += '<div class="sbc-opt-batch-round sbc-opt-batch-bad">Nur ' + plan.planned +
                ' von ' + plan.requested + ' möglich: ' + escapeHtml(plan.stoppedReason) + '</div>';
        }
        box.innerHTML = html;
        if (ui.planResult) ui.planResult.classList.remove('sbc-opt-hidden');
        ui.batchRun.style.display = plan.planned ? 'block' : 'none';
        ui.batchRun.disabled = false;
        ui.batchRun.textContent = 'Alle ' + plan.planned + ' eintragen + abgeben';
        if (ui.batchDetails) {
            let detailHtml = '';
            plan.rounds.forEach(function (r, i) {
                const nStore = r.players.filter(p => p.isStorage).length;
                const nUntr = r.players.filter(p => p.untradeable).length;
                const nProt = r.players.filter(p => p.groups && p.groups.indexOf(83) > -1).length;
                // In der SBC-Reihe ist jede Runde eine ANDERE SBC - dann sagt
                // ihr Name etwas, die Nummer nicht.
                const label = r.challengeName
                    ? escapeHtml(r.challengeName) : ('Team ' + (i + 1));
                detailHtml += '<div class="sbc-opt-batch-round"><b>' + label + ':</b> OVR ' +
                    r.ovr + ' (' + r.ovrExact.toFixed(2) + ')' +
                    '<br><span class="sbc-opt-muted">Storage ' + nStore +
                    ' · unverkäuflich ' + nUntr +
                    (nProt ? ' · <span class="sbc-opt-batch-warn">geschützt ' + nProt + '</span>' : '') +
                    '</span><div class="sbc-opt-batch-cards">';
                for (const p of r.players.slice().sort((a, b) => b.rating - a.rating)) {
                    const prot = !!(p.groups && p.groups.indexOf(83) > -1);
                    detailHtml += '<div class="sbc-opt-batch-card' + (prot ? ' prot' : '') + '">' +
                        '<span class="r">' + p.rating + '</span> ' + escapeHtml(displayName(p)) +
                        ' <span class="src">' + (p.isStorage ? 'Storage' : 'Verein') + '</span>' +
                        ' <span class="rar">' + escapeHtml(rarityLabel(p)) + '</span>' +
                        (p.untradeable ? ' <span class="untr">unverkäuflich</span>' : '') + '</div>';
                }
                detailHtml += '</div>';
                for (const w of (r.warnings || [])) {
                    detailHtml += '<span class="sbc-opt-batch-warn">⚠ ' + escapeHtml(w) + '</span><br>';
                }
                detailHtml += '</div>';
            });
            ui.batchDetailBody.innerHTML = detailHtml;
            ui.batchDetailSummary.textContent = 'Teams im Detail (' + plan.planned + ')';
            ui.batchDetails.style.display = plan.planned ? 'block' : 'none';
        }
    }
    // Reiner Reducer (keine DOM-/Netzwerkabhaengigkeit, isoliert testbar): pflegt
    // den bestehenden 6er-Ring diag.batchSteps unveraendert UND haelt zusaetzlich
    // jede gescheiterte Runde verlustfrei in diag.batchFailedSteps fest, Cap 30
    // statt 6 (analog lastErrors) - sonst ueberschreibt der 6er-Ring bei
    // laengeren Batches die frueheste problematische Runde, bevor ein spaeter
    // Abbruch sie ueberhaupt meldet.
    function recordBatchStep(diag, round, next) {
        diag.batchSteps = (diag.batchSteps || []).concat([{
            round: round, ok: next.ok, steps: next.steps
        }]).slice(-6);
        if (!next.ok) {
            diag.batchFailedSteps = (diag.batchFailedSteps || []).concat([{
                round: round, ok: next.ok, steps: next.steps
            }]).slice(-30);
        }
    }
    /**
     * Arbeitet den Plan ab: eintragen -> abgeben -> naechste Instanz oeffnen.
     * Bricht bei jeder Unstimmigkeit ab - "2 von 5 fertig" ist besser als eine
     * falsch abgegebene SBC.
     */
    async function onBatchRunClick() {
        // Stand von EAs timesCompleted fuer dieses Set. Wird pro Runde EINMAL
        // gelesen und dient der naechsten Runde als Basis.
        let batchCountBase = null;
        // Runden hintereinander, die EA nicht bestaetigt hat.
        let unconfirmedStreak = 0;
        // Letzter WIRKLICH gelesener Zaehlerstand - und der Stand, der vor der
        // laufenden Runde galt. Damit ueberlebt eine Bestaetigung auch eine
        // Runde, in der die Messung ausgefallen ist.
        let lastKnownCount = null;
        let lastKnownBefore = null;
        // Takt vor der Bestaetigung. Startet gross genug, dass EA nicht direkt
        // abweist, und waechst bei Ablehnung selbst.
        let confirmGap = 900;
        const plan = STATE.batch;
        if (!plan || !plan.planned) { toast('Erst "Teams planen" ausführen.', 'error'); return; }
        // Zwei Plan-Sorten, EIN Lauf: 'reihe' arbeitet verschiedene Challenges
        // eines Sets ab, alles andere (Standard) dieselbe SBC mehrfach.
        const isQueue = plan.mode === 'reihe';
        const n = plan.planned;
        // KONTINGENT VOR dem Start nennen. Live (Report v4.89.0) lief ein Batch
        // in 475/404, weil das TAGESLIMIT schon ueberschritten war (326 von
        // 300) - das stand im Zaehler, aber niemand hat gefragt. Der Batch wird
        // nicht blockiert (Rasmus hat ihn bewusst freigegeben), aber die Zahl
        // gehoert vor die Entscheidung, nicht hinter den Fehlschlag.
        let quotaWarn = '';
        try {
            const u = quotaUsage();
            const overDay = u && u.day && u.day.used >= QUOTA_DAY_LIMIT;
            const overHour = u && u.hour && u.hour.used >= QUOTA_HOUR_LIMIT;
            if (overDay || overHour) {
                // ZAHLEN, keine Vorhersage. Rasmus hat live 339 Abgaben an einem
                // Tag gemacht und danach OHNE Pause weiter abgegeben - EA setzt
                // das Tageslimit also nicht so hart durch, wie die Zahl
                // nahelegt. Die Version davor hat daraus "der Batch bricht
                // wahrscheinlich ab" gemacht; das war falsch.
                quotaWarn = '\n\nHinweis: nach UNSERER Zählung liegst du bei ' +
                    (u.hour.exact ? '' : 'mind. ') + u.hour.used + '/' + QUOTA_HOUR_LIMIT +
                    ' in dieser Stunde und ' +
                    (u.day.exact ? '' : 'mind. ') + u.day.used + '/' + QUOTA_DAY_LIMIT +
                    ' heute. Das ist eine Untergrenze aus unserer eigenen Messung, kein ' +
                    'Wert von EA - erfahrungsgemäß geht danach oft noch etwas.';
            }
        } catch (e) {}
        // In der Reihe sind es verschiedene SBCs - dann werden sie benannt.
        // "3 SBCs" sagt nichts darueber, WELCHE drei.
        const whatText = isQueue
            ? (n + ' SBC(s) dieses Sets werden nacheinander eingetragen UND endgültig ' +
               'abgegeben:\n\n' + plan.rounds.map(function (r, k) {
                   return (k + 1) + '. ' + (r.challengeName || ('Challenge ' + r.challengeId)) +
                          ' (OVR ' + r.ovr + ')';
               }).join('\n') + '\n\n')
            : (n + ' SBC(s) werden eingetragen UND endgültig abgegeben.\n\n');
        if (!window.confirm(whatText +
                'Die verbauten Karten sind danach weg. Fortfahren?' + quotaWarn)) return;
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
                // SBC-REIHE: jede Runde ist eine ANDERE Challenge desselben Sets -
                // also wird sie hier aufgemacht, auch die erste. Der Batch
                // dagegen arbeitet in der schon offenen SBC weiter und oeffnet
                // die naechste Wiederholung erst am Ende der Runde (unten).
                if (isQueue) {
                    showProgress(i + 1, n, 'öffne ' + (round.challengeName || 'SBC') + '...',
                        (doneLog.length ? doneLog.length + ' fertig' : ''));
                    setStatus(tag + ': öffne ' + (round.challengeName || 'SBC') + '...');
                    const opened = await openChallengeFromList(roundToStep(round));
                    recordBatchStep(STATE.diag, i + 1, opened);
                    if (!opened.ok) {
                        throw new Error(tag + ': "' + (round.challengeName || round.challengeId) +
                            '" liess sich nicht öffnen' +
                            (opened.occupied
                                ? ' - dort steht schon ein Team im Squad. Bitte im ' +
                                  'Spiel nachsehen und es leeren oder abgeben.'
                                : (opened.wrongChallenge
                                    ? ' - aufgegangen ist Challenge ' + opened.openId +
                                      ' statt ' + round.challengeId + '. In diesem Set gibt es ' +
                                      'mehrere Challenges mit demselben Namen; bitte die ' +
                                      'Liste mit ↻ neu laden und erneut planen.'
                                    : ' (Diagnose schicken: batchSteps).')));
                    }
                }
                showProgress(i + 1, n, 'prüfe SBC...', (doneLog.length ? doneLog.length + ' fertig' : ''));
                setStatus(tag + ': prüfe Challenge...');
                syncSbcWithOpenChallenge();
                if (!findSbcController() || !findLiveChallenge()) {
                    throw new Error(tag + ': keine offene SBC-Ansicht.');
                }
                if (!matchesPlannedRound(plan, i)) {
                    throw new Error(tag + ': die offene SBC passt nicht zum Plan ' +
                        '(Ziel ' + STATE.sbc.targetOVR + '/' + STATE.sbc.formationSlots +
                        ', Challenge ' + STATE.sbc.challengeId + ' statt ' +
                        (isQueue ? (round.target + '/' + round.slots + ', Challenge ' +
                                    round.challengeId)
                                 : (plan.targetOVR + '/' + plan.slots)) +
                        '). Nichts eingetragen.');
                }
                // Die JETZT offene Instanz merken - sie ist nach dem Abgeben
                // verbraucht und darf beim Suchen der neuen nicht wieder kommen.
                if (STATE.sbc.challengeId != null) {
                    plan.usedChallengeIds.push(String(STATE.sbc.challengeId));
                }
                showProgress(i + 1, n, 'trage Team ein (OVR ' + round.ovr + ')...',
                    (doneLog.length ? doneLog.length + ' fertig' : ''));
                setStatus(tag + ': trage ein...');
                const sub = await submitToSbc(round, false, { done: done, total: n });
                if (sub && sub.via !== 'app') { await refreshChallengeCache(); refreshOpenSbcView(); }
                removeFromPool(round.players);
                showProgress(i + 1, n, 'gebe ab...', (doneLog.length ? doneLog.length + ' fertig' : ''));
                setStatus(tag + ': gebe ab...');
                // ABGABE GEGEN EAs EIGENEN ZAEHLER PRUEFEN.
                // Der Live-Report v4.74.0 zeigte den Grund fuer die Fehlerketten:
                // Runde 1 ging ueber ctrl._submitChallenge "ohne Response" durch
                // (submitWithoutResponseCount 1, squadEmptyAfter false) - ob EA
                // die Abgabe angenommen hat, war NICHT ablesbar. Der Batch lief
                // weiter, und alles danach war Folgefehler (404/475 auf dieselbe
                // Instanz).
                // Der bisher fehlende zweite Beleg ist jetzt da: die Summe der
                // serverseitigen timesCompleted. Steigt sie nicht, wurde nicht
                // abgegeben - dann wird hier gestoppt statt eine Fehlerkette zu
                // produzieren. Antwortet EA gar nicht (null), wird NICHTS
                // behauptet und wie bisher weitergemacht.
                // Basis ist der Stand aus der VORIGEN Runde - so bleibt es bei
                // EINEM leichten Request pro Runde statt zwei schweren.
                // Wird gerade gedrosselt, hat Weitermachen keinen Sinn: das
                // naechste Schreiben laeuft in denselben 475. Sauber abbrechen
                // ist besser als eine Fehlerkette (und als eine Abgabe, die
                // niemand bestaetigen kann).
                if (throttledNow()) {
                    throw new Error('Abgebrochen nach ' + done + ' von ' + n + ' Teams.' +
                        throttleNote());
                }
                const cntBefore = (batchCountBase != null)
                    ? batchCountBase : await setTimesCompleted(STATE.sbc.setId);
                // Letzten bekannten Stand behalten: fehlt der aktuelle Wert,
                // taugt der alte weiter als Basis. Live (Report v4.85.0) lagen
                // "vor Runde 1: 2" und "nach Runde 2: 4" vor - die Bestaetigung
                // ging trotzdem verloren, weil dazwischen ein 429 lag.
                if (cntBefore != null) lastKnownCount = cntBefore;
                lastKnownBefore = lastKnownCount;
                // Zeitpunkt VOR dem Abgeben: eine Belohnungs-Antwort von
                // vorher darf diese Runde nicht bestaetigen.
                const tSubmit = Date.now();
                await submitChallengeToEa();
                // EAs EIGENE ANTWORT auf die Abgabe. Live (Report v4.99.0) war
                // sie der einzige Beleg: der Set-Zaehler stand auf 0, weil das
                // Set nicht wiederholbar ist, und der Batch hielt eine
                // erfolgreiche Abgabe fuer gescheitert.
                let awardOk = awardConfirms(STATE.lastAward, STATE.sbc.challengeId, tSubmit);
                // Luft lassen: 426/429/512 auf die Bestaetigung sind
                // Rate-Limits, und sie kamen live unmittelbar nach dem Abgeben.
                // Der Takt erhoeht sich nach jedem abgewiesenen
                // Bestaetigungs-Request selbst - wie der Club-Lade-Takt
                // (LEARNINGS 7/30), nicht wieder auf einen festen kleinen Wert
                // setzen.
                await sleep(confirmGap);
                // Die Antwort kann waehrend der Pause eingetroffen sein.
                if (!awardOk) {
                    awardOk = awardConfirms(STATE.lastAward, STATE.sbc.challengeId, tSubmit);
                }
                let cntAfter = await setTimesCompleted(STATE.sbc.setId);
                if (cntAfter == null && confirmLastFail === 'request') {
                    confirmGap = Math.min(5000, Math.round(confirmGap * 2));
                    warn('[Batch] Bestätigung abgewiesen - Takt auf ' + confirmGap + 'ms erhöht.');
                }
                // NACHLESEN, bevor "nicht bestaetigt" behauptet wird. Live
                // (Report v4.90.0): Runde 1 und 2 gingen durch (966->967->968),
                // Runde 3 las 968 - unveraendert - und der Batch brach ab. Dabei
                // gab es KEINEN einzigen HTTP-Fehler und keine Drosselung: EAs
                // Zaehler war nach 900ms nur noch nicht nachgezogen. Eine
                // einzige Lesung ist also kein Beweis. Es wird NUR erneut
                // gelesen, nie erneut abgegeben.
                const baseNow = (cntBefore != null) ? cntBefore : lastKnownBefore;
                let confirmRetries = 0;
                // NICHT nachlesen, wenn EA schon geantwortet hat - das waeren
                // zwei Requests und ~3s pro Runde fuer eine Frage, die bereits
                // beantwortet ist.
                while (!awardOk && baseNow != null && cntAfter != null && cntAfter <= baseNow &&
                       confirmRetries < 2) {
                    confirmRetries++;
                    await sleep(confirmGap * (confirmRetries + 1));
                    const again = await setTimesCompleted(STATE.sbc.setId);
                    warn('[Batch] Zähler noch unverändert (' + cntAfter + ') - ' +
                         confirmRetries + '. Nachlesen ergab ' + again + '.');
                    if (again != null) cntAfter = again;
                }
                batchCountBase = (cntAfter != null) ? cntAfter : null;
                if (cntAfter != null) lastKnownCount = cntAfter;
                // Basis notfalls aus dem letzten bekannten Stand - besser eine
                // Bestaetigung ueber zwei Runden hinweg als keine.
                const baseForCmp = (cntBefore != null) ? cntBefore
                    : (cntAfter != null ? lastKnownBefore : null);
                const counterSays = (baseForCmp != null && cntAfter != null)
                    ? (cntAfter > baseForCmp) : null;
                // Ein nicht wiederholbares Set zaehlt timesCompleted NICHT
                // hoch - dort kann der Zaehler eine Abgabe nicht widerlegen.
                // "Unveraendert" heisst dann "unbekannt", nicht
                // "fehlgeschlagen": dieselbe Unterscheidung, die es fuer den
                // Messausfall schon gibt.
                const counterKannWiderlegen = (round.repeatable !== false);
                const confirmed = awardOk ? true
                    : ((counterSays === false && !counterKannWiderlegen) ? null : counterSays);
                STATE.diag.submitCounterChecks = (STATE.diag.submitCounterChecks || []).concat([{
                    round: i + 1, before: cntBefore, after: cntAfter, confirmed: confirmed,
                    // Warum null? 'request' = Messung ausgefallen (kein
                    // Abbruchgrund), 'unreadable' = Antwort ohne Zahl.
                    nullReason: (confirmed === null
                        ? (confirmLastFail ||
                           (counterSays === false ? 'set-nicht-wiederholbar' : null))
                        : null),
                    // Woran lag die Bestaetigung? award = EAs eigene Antwort.
                    via: awardOk ? 'award' : (counterSays != null ? 'zaehler' : null),
                    award: STATE.lastAward || null,
                    repeatable: round.repeatable,
                    basis: baseForCmp,
                    // Wie oft musste nachgelesen werden, bis die Zahl stand?
                    retries: confirmRetries
                }]).slice(-6);
                // Die Zahl ist da - sie wurde fuer die Bestaetigung ohnehin
                // gelesen. Bis v4.79.0 wurde sie weggeworfen, und deshalb
                // bewegte sich der Kontingent-Zaehler bei einem Batch nicht.
                if (confirmed === true) {
                    // Die Liste sofort und OHNE Request nachtragen: wir wissen,
                    // welche Challenge durch ist.
                    if (isQueue && markQueueChallengeDone(queueItems, queueChecked,
                            round.challengeId)) {
                        try { renderQueueList(); } catch (e) {}
                    }
                    const delta = (cntAfter != null && cntBefore != null)
                        ? (cntAfter - cntBefore) : 0;
                    // Bei einem nicht wiederholbaren Set bewegt sich der
                    // Zaehler nie - die Abgabe zaehlt aber trotzdem gegen EAs
                    // Kontingent. Ohne diese 1 waere sie in der Messung
                    // unsichtbar.
                    quotaAddEvent(delta > 0 ? delta : 1, 'local');
                }
                // Keine Bestaetigung ist auch keine gute Nachricht. Live liefen
                // sechs Runden mit confirmed:null durch und endeten in 475/404 -
                // die einzige echte Wache war abgeschaltet. Eine EINZELNE
                // fehlende Bestaetigung bleibt geduldet (Schluckauf), zwei in
                // Folge brechen ab: "2 von 5 fertig" ist besser als vier
                // Abgaben, von denen niemand weiss, ob sie angekommen sind.
                if (confirmed === null) {
                    // MESSPROBLEM vs. SACHPROBLEM. Ein gescheiterter
                    // Bestaetigungs-Request (429, Failed to fetch) sagt NICHTS
                    // ueber die Abgabe - live hat genau das einen Batch nach
                    // 1/5 gestoppt, obwohl der Zaehler von 2 auf 4 ging.
                    // Deshalb zaehlt er nicht auf die Abbruch-Kette.
                    const messproblem = (confirmLastFail === 'request');
                    if (!messproblem) unconfirmedStreak++;
                    warn('[Batch] Runde ' + (i + 1) + ' ohne Bestätigung von EA (' +
                         (messproblem ? 'Messung ausgefallen: ' + confirmLastFail
                                      : unconfirmedStreak + ' in Folge') + ').');
                    if (unconfirmedStreak >= 2) {
                        throw new Error('Zwei Runden hintereinander liessen sich nicht ' +
                            'bestätigen (EAs Zähler war nicht lesbar) - ' + done + ' von ' +
                            n + ' fertig. Abgebrochen, bevor daraus eine Fehlerkette wird: ' +
                            'bitte im Spiel nachsehen, welche Teams wirklich drin sind.' +
                            throttleNote());
                    }
                } else {
                    unconfirmedStreak = 0;
                }
                if (confirmed === false) {
                    throw new Error('Abgabe von Team ' + (i + 1) + ' wurde von EA nicht ' +
                        'bestätigt (Zähler unverändert bei ' + cntAfter + ', ' +
                        (confirmRetries + 1) + 'x gelesen, und keine ' +
                        'Belohnungs-Antwort) - ' + done +
                        ' von ' + n + ' fertig. Abgebrochen, bevor daraus eine Fehlerkette ' +
                        'wird: bitte die SBC im Spiel einmal schliessen, neu öffnen und ' +
                        'nachsehen, ob das Team noch drin steht.');
                }
                done++;
                doneLog.push('Team ' + (i + 1) + ': OVR ' + round.ovr + ' abgegeben');
                log('[Batch] Team ' + (i + 1) + '/' + n + ' abgegeben (OVR ' + round.ovr + ').');
                if (i + 1 < n && !isQueue) {
                    showProgress(i + 2, n, 'öffne die nächste SBC...', (doneLog.length ? doneLog.length + ' fertig' : ''));
                    setStatus(tag + ': öffne die nächste Runde...');
                    const next = await openNextInstance(plan);
                    recordBatchStep(STATE.diag, i + 1, next);
                    if (!next.ok) {
                        if (next.exhausted) {
                            // Kein Fehler, sondern eine Auskunft: EA laesst das
                            // Set gerade nicht mehr wiederholen. Der Rest des
                            // Plans ist damit gegenstandslos.
                            throw new Error('"' + (plan.setName || 'Das Set') + '" lässt sich nicht ' +
                                'mehr wiederholen' + (next.status ? ' (' + next.status + ')' : '') +
                                ' - die bereits abgegebenen Runden sind aber durch.');
                        }
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
            if (ui.batchDetails) ui.batchDetails.style.display = 'none';
            STATE.batch = null;   // Plan verbraucht - kein zweites Abgeben
            // EINE Server-Messung am Ende: bringt die Abgaben der anderen
            // Geraete mit rein (Mike am Handy, Rasmus am Laptop) und macht die
            // Zahl damit exakt statt Untergrenze. Bewusst hier und nicht pro
            // Runde - siehe LEARNINGS 7.
            quotaMeasureQuiet();
            // Die Reihen-Liste ist waehrend des Laufs schon lokal nachgetragen
            // worden (markQueueChallengeDone) - dieses Neuladen holt nur noch,
            // was EA sonst noch geaendert hat.
            // MIT ABSTAND und LEISE: live kam es 33ms nach der letzten Abgabe
            // und direkt hinter der Kontingent-Messung, und EA antwortete mit
            // HTTP 521. Zwei Requests im selben Tick nach zwei Schreibvorgaengen
            // sind genau das Muster aus LEARNINGS 7/30.
            if (isQueue) {
                // Das Set DES PLANS neu holen - nicht das gerade angesehene:
                // waehrend der 4s kann Rasmus schon woanders sein.
                const reloadSid = plan.setId;
                setTimeout(function () {
                    queueTriedSet = null;
                    loadQueueList(true, true, reloadSid);
                }, 4000);
            }
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
            if (ui.planResult && !html) ui.planResult.classList.add('sbc-opt-hidden');
        }
    }
    // ---- Helfer, die auch die Diagnose nutzt -------------------------------
    // findLiveChallenge/findSbcController werden vom aktiven, automatischen
    // Batch-Lauf (onBatchRunClick, siehe CLAUDE.md "Batch-Modus darf abgeben")
    // UND vom Diagnose-Report genutzt, um zu pruefen, ob eine Challenge offen ist.
    // [SBCCTRL-BEGIN]
    function findLiveChallenge() {
        for (const c of getControllerChain()) {
            const n = (c.constructor && c.constructor.name) || '';
            if (!/sbc/i.test(n)) continue;
            for (const key of ['_overviewController', 'leftController', '_leftController']) {
                const oc = c[key];
                // typeof-Objekt-Guard: eine truthy, aber nicht-objekthafte
                // _challenge (z.B. eine rohe ID statt der Challenge-Entity)
                // darf die Suche nicht vorzeitig mit einem unbrauchbaren Fund
                // beenden - captureChallengeEntity() erwartet ein echtes Objekt.
                if (oc && oc._challenge && typeof oc._challenge === 'object') return oc._challenge;
            }
            if (c._challenge && typeof c._challenge === 'object') return c._challenge;
        }
        return STATE.sbc.entity || null;
    }
    /** Der SBC-Controller der offenen Ansicht (mit Squad). */
    function findSbcController() {
        // "Letzter Treffer gewinnt" ist bewusst - siehe
        // patterns/bad/helfer-existiert-wird-umgangen.md, Abschnitt "Edge-Cases":
        // beim PC-Split-View-Stack sind mehrere /sbc/i-Controller gleichzeitig
        // sichtbar, der zuletzt gefundene ist der tatsaechlich aktive.
        let found = null;
        for (const c of getControllerChain()) {
            const n = (c.constructor && c.constructor.name) || '';
            if (/sbc/i.test(n) && (c._squad || (c.getSquad && c.getSquad()))) found = c;
        }
        return found;
    }
    // [SBCCTRL-END]
    async function submitCurrentResult() {
        const res = STATE.lastResult;
        if (!res || !res.ok) {
            toast('Kein gültiges Ergebnis zum Eintragen. Erst "Optimieren" ausführen.', 'error');
            return;
        }
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
        }
    }
    // ========================================================================
    //  PACK-OPENER (Store, Ticket #69 Stufe 1 + Ticket #76 Stufe 2)
    // ------------------------------------------------------------------------
    //  Mechanik-Quelle: PaleTools-Analyse vom 16.08.2026 (dekodiertes
    //  packsOpener-Plugin, LEARNINGS §46). Pack-Oeffnen ist UNUMKEHRBAR -
    //  runPackTestOpen() oeffnet GENAU EIN Pack (Stufe 1, Einzel-Testlauf UND
    //  Baustein der Stufe-2-Schleife runPackOpenAll(), SSOT) und dient der
    //  Live-Verifikation (STATE.diag.packScan beantwortet die vier offenen
    //  Mechanik-Fragen aus docs/roadmap/vision/features/pack-opener.md). Die
    //  Stufe-1-Mechanik ist stub-getestet, aber noch NICHT live verifiziert -
    //  runPackOpenAll() stoppt deshalb bei JEDEM Fehler sofort: im schlimmsten
    //  Fall degradiert "Alle oeffnen" zu einem Einzel-Pack mit klarer
    //  Fehlermeldung, bereits geoeffnete Packs sind sicher verteilt.
    // ========================================================================
    // PaleTools verwendet fuer die Storage-Kapazitaet hartkodiert 100, ohne
    // dass ein EA-Endpunkt sie liefert - UNVERIFIZIERT. runPackTestOpen()
    // misst storageCountBefore/storageCountAfter mit; die echte Grenze zeigt
    // sich erst, sobald move() bei vollem Storage tatsaechlich ablehnt.
    const PACK_STORAGE_CAPACITY_ASSUMED = 100;
    /**
     * Sind wir in der Store-Ansicht? Analog zu inSbcView(): faellt die Kette
     * leer/werfend aus, lieber der Abschnitt einmal zu viel sichtbar als ein
     * Einstieg, der nie erscheint.
     */
    /**
     * Knoepfe, die wie EAs "Open" an einer Pack-Kachel aussehen.
     * Das ist gleichzeitig der VERLAESSLICHSTE Hinweis darauf, dass wir in der
     * Pack-Ansicht sind: der Controller-Name half nicht (siehe inStoreView).
     */
    // ======================================================================
    //  SBC-REIHE: Auswahl, Liste, Planung
    // ======================================================================
    // Zustand: die zuletzt gelesene Liste und welche Haken gesetzt sind. Die
    // Haken ueberleben ein Neu-Rendern (der Abschnitt baut sich neu auf, sooft
    // die Liste kommt) - sonst waere jedes ↻ ein Zuruecksetzen der Auswahl.
    let queueItems = [];
    let queueChecked = {};
    let queueLoadedSet = null;
    let queueLoading = false;
    // Fuer welches Set wurde das Laden schon EINMAL versucht? Ohne diesen
    // Merker wuerde ein Fehlversuch alle 500ms wiederholt - genau die Sorte
    // Dauerfeuer, die live schon einmal Rate-Limit-401er ausgeloest hat
    // (LEARNINGS 7/30). Das ↻ bleibt der Weg, es erneut zu versuchen.
    let queueTriedSet = null;
    // Letzter Fehlschlag eines LEISEN Neuladens - er steht in der Liste und in
    // der Diagnose, aber nicht in lastErrors.
    let queueLoadError = null;
    // Gebaute Challenge-Listen pro Set. buildChallengeList (deepScan pro
    // Challenge) ist zu teuer fuer den 500ms-Takt - neu gebaut wird nur, wenn
    // die Antwort im Cache eine ANDERE ist (Objekt-Identitaet).
    const queueBuiltBySet = {};
    function builtChallengeListFor(sid) {
        const json = (STATE.setChallengesBySet || {})[sid];
        if (!json) return null;
        const hit = queueBuiltBySet[sid];
        if (hit && hit.json === json) return hit.items;
        STATE.diag.scanStats = STATE.diag.scanStats || {};
        const items = buildChallengeList(json, STATE.diag.scanStats);
        queueBuiltBySet[sid] = { json: json, items: items };
        return items;
    }
    /**
     * Passen die sichtbaren Zeilen-Texte zu einer Challenge-Liste? Rein, denn
     * diese Zuordnung entscheidet, WELCHES Set die Reihe anzeigt.
     * Verlangt: gleiche Anzahl, und der Name der i-ten Challenge steckt im
     * Text der i-ten Zeile - bei mindestens 70% (EA lokalisiert manche Namen,
     * ein einzelner Ausreisser darf die Zuordnung nicht kippen; unter 70%
     * ist es ein anderes Set).
     */
    function rowsMatchItems(texts, items) {
        if (!texts || !items) return false;
        if (items.length < 2 || texts.length !== items.length) return false;
        let hits = 0;
        for (let i = 0; i < items.length; i++) {
            const nm = String(items[i].name || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (nm && String(texts[i] || '').toLowerCase().indexOf(nm) > -1) hits++;
        }
        return hits >= Math.max(2, Math.ceil(items.length * 0.7));
    }
    /** Die sichtbaren Challenge-Zeilen als Texte - dieselben Selektoren wie
     *  clickChallengeRow, eine Quelle. */
    function visibleChallengeRowTexts() {
        let rows = visibleAll('.ut-sbc-challenge-table-row-view');
        if (!rows.length) rows = visibleAll('.ut-sbc-challenge-tile-view');
        return rows.map(function (r) {
            return String((r && r.textContent) || '').replace(/\s+/g, ' ').trim();
        });
    }
    /**
     * WELCHES Set sieht Rasmus gerade an? STATE.sbc.setId reicht nicht: es
     * wird aus Netzwerk-Antworten und der offenen Challenge gespeist - rendert
     * EA eine Set-Liste aus dem eigenen Speicher (kein Request, keine offene
     * Challenge), bleibt es beim VORIGEN Set haengen. Live: Marcelo-Set auf
     * dem Schirm, queueScan zeigte das 10x-85+-Set von vorhin, die Reihe
     * blieb versteckt.
     * Erkannt wird ueber die sichtbaren Zeilen gegen die gecachten Listen -
     * NUR bei eindeutigem Treffer; sonst gilt wie bisher STATE.sbc.setId.
     */
    function detectViewedSetId() {
        try {
            const texts = visibleChallengeRowTexts();
            if (texts.length >= 2) {
                // Stabilitaet zuerst: passt das bereits geladene Set, bleibt es.
                if (queueLoadedSet != null &&
                    rowsMatchItems(texts, builtChallengeListFor(queueLoadedSet))) {
                    return queueLoadedSet;
                }
                const matches = [];
                for (const k in (STATE.setChallengesBySet || {})) {
                    if (String(k) === String(queueLoadedSet)) continue;
                    if (rowsMatchItems(texts, builtChallengeListFor(k))) matches.push(k);
                }
                if (matches.length === 1) return matches[0];
            }
        } catch (e) {}
        return STATE.sbc.setId;
    }
    /**
     * Welche Challenges sind angehakt - in der Reihenfolge der Liste?
     * Rein (Liste + Haken kommen herein), damit die Zuordnung testbar ist:
     * sie entscheidet, welche SBCs abgegeben werden.
     */
    function queueSelection(items, checked) {
        const out = [];
        for (const it of items || []) {
            if (!it || it.done) continue;                 // erledigte nie
            if (!checked[String(it.id)]) continue;
            out.push(it);
        }
        return out;
    }
    /**
     * Eine gerade abgegebene Challenge in der Liste als erledigt eintragen.
     * Rein (Liste und Haken kommen herein), damit es testbar ist.
     * WARUM lokal: wir WISSEN, welche Challenge bestaetigt wurde - EA dafuer
     * noch einmal zu fragen ist ein Request, der scheitern kann (live: HTTP 521
     * 33ms nach der letzten Abgabe, und danach standen die beiden gerade
     * fertigen Challenges weiter als "NOT_STARTED" in der Liste).
     * Der Haken wird mitentfernt: eine erledigte Challenge darf beim naechsten
     * Planen nicht wieder mitkommen.
     */
    function markQueueChallengeDone(items, checked, challengeId) {
        if (challengeId == null) return false;
        let hit = false;
        for (const it of items || []) {
            if (!it || String(it.id) !== String(challengeId)) continue;
            it.done = true;
            it.state = it.state || {};
            it.state.status = 'COMPLETED';
            if (checked) checked[String(it.id)] = false;
            hit = true;
        }
        return hit;
    }
    /** Kurzer Zustandstext einer Challenge fuer die Liste. */
    function queueRowStatus(it) {
        if (!it) return '';
        if (it.done) return 'erledigt';
        if (it.target == null) return 'kein Ziel-OVR';
        return (it.slots || 11) + ' Slots';
    }
    /**
     * Beschriftung des Plan-Knopfs aus der Anzahl der Haken. Rein, weil die
     * Beschriftung das VERSPRECHEN des Knopfs ist - dieselbe Sprache wie die
     * Kachel-Knoepfe ("Alle 18 (Verein)"): die Zahl steht VOR dem Klick da.
     */
    function queuePlanLabel(n) {
        if (!n) return 'Keine SBC angehakt';
        return n + (n === 1 ? ' SBC planen (Vorschau)' : ' SBCs planen (Vorschau)');
    }
    function syncQueuePlanButton() {
        if (!ui.queuePlan) return;
        const n = queueSelection(queueItems, queueChecked).length;
        ui.queuePlan.textContent = queuePlanLabel(n);
        ui.queuePlan.disabled = (n === 0);
    }
    function renderQueueList() {
        const box = ui.queueList;
        if (!box) return;
        // Der Knopf haengt an der Auswahl - bei jedem Neuaufbau mitziehen.
        syncQueuePlanButton();
        box.innerHTML = '';
        if (!queueItems.length) {
            box.innerHTML = '<div class="sbc-opt-debug">' +
                (queueLoading ? 'lade die SBCs dieses Sets...'
                    : (queueLoadError
                        ? 'Liste konnte nicht geladen werden (' +
                          escapeHtml(queueLoadError.slice(0, 60)) + ') - ↻ drücken.'
                        : 'keine Liste geladen - ↻ drücken.')) + '</div>';
            return;
        }
        for (const it of queueItems) {
            const row = document.createElement('label');
            row.className = 'sbc-opt-queuerow' + (it.done ? ' done' : '');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.disabled = !!it.done;
            cb.checked = !it.done && !!queueChecked[String(it.id)];
            cb.addEventListener('change', function () {
                queueChecked[String(it.id)] = cb.checked;
                syncQueuePlanButton();
            });
            const ovr = document.createElement('span');
            ovr.className = 'ovr';
            ovr.textContent = (it.target != null) ? String(it.target) : '–';
            const nm = document.createElement('span');
            nm.className = 'nm';
            nm.textContent = it.name;
            nm.title = it.name + ' (Challenge ' + it.id + ')';
            const st = document.createElement('span');
            st.className = 'st';
            st.textContent = queueRowStatus(it);
            row.appendChild(cb); row.appendChild(ovr);
            row.appendChild(nm); row.appendChild(st);
            box.appendChild(row);
        }
        if (queueLoadError) {
            // Die Liste steht (ggf. lokal nachgetragen), aber das letzte
            // Nachladen kam nicht durch - das gehoert daneben, nicht in einen
            // Fehler-Toast.
            const hint = document.createElement('div');
            hint.className = 'sbc-opt-debug';
            hint.textContent = 'Stand evtl. nicht aktuell (Nachladen kam nicht durch) - ↻';
            box.appendChild(hint);
        }
    }
    /**
     * Die Challenges des offenen Sets holen. Aus dem Cache, wenn er da ist -
     * die Antwort liegt nach dem Oeffnen einer SBC ohnehin vor. `force` (das ↻)
     * holt sie neu.
     */
    async function loadQueueList(force, quiet, sidArg) {
        // Das Set kommt vom Aufrufer (Sichtbarkeits-Takt: das ANGESEHENE Set;
        // Lauf-Ende: das Set des Plans). Ohne Angabe wie bisher der Zustand.
        const sid = (sidArg != null) ? sidArg : STATE.sbc.setId;
        if (sid == null) {
            if (!quiet) toast('Kein Set erkannt - bitte eine SBC öffnen.', 'error');
            return;
        }
        if (queueLoading) return;
        queueLoading = true;
        renderQueueList();
        try {
            let json = (STATE.setChallengesBySet || {})[sid];
            if (force || !json) {
                json = await apiGet((STATE.sbc.apiPrefix || 'sbs') + '/setId/' + sid + '/challenges');
                if (json) {
                    if (typeof cacheSetChallenges === 'function') cacheSetChallenges(sid, json);
                    else STATE.setChallengesBySet[sid] = json;
                    STATE.lastSetChallenges = json;
                }
            }
            STATE.diag.scanStats = STATE.diag.scanStats || {};
            const items = buildChallengeList(json, STATE.diag.scanStats);
            queueItems = items;
            queueLoadedSet = sid;
            queueLoadError = null;
            // Vorbelegung: alles Offene angehakt - Rasmus' Beispiel war "die
            // 89er, 90er und 91er", also der Normalfall "alle". Abwaehlen ist
            // weniger Arbeit als dreimal anwaehlen. Was der Nutzer schon von
            // Hand umgestellt hat, bleibt so.
            for (const it of items) {
                const k = String(it.id);
                if (!(k in queueChecked)) queueChecked[k] = !it.done && it.target != null;
            }
            STATE.diag.queueScan = { setId: sid, count: items.length,
                loadError: queueLoadError,
                // 30 statt 12: das Live-Set hatte ZWANZIG Challenges, und im
                // Report standen zwoelf - genau die Information fehlte
                // (mehrere gleiche Namen), um den Fehler zu sehen.
                items: items.slice(0, 30).map(function (it) {
                    return { id: it.id, name: it.name, target: it.target,
                             prio: it.priority, row: it.rowIndex,
                             rep: it.repeatable,
                             slots: it.slots, formation: it.formation,
                             done: it.done, status: it.state.status };
                }) };
            log('SBC-Reihe: ' + items.length + ' Challenge(s) in Set ' + sid);
        } catch (e) {
            const msg = String((e && e.message) || e);
            if (quiet) {
                // LEISE: ein Neuladen aus Bequemlichkeit ist kein Fehler des
                // Laufs. Es gehoert nicht in lastErrors (das ist die Liste, auf
                // die bei einem Bericht zuerst geschaut wird) und darf nach
                // einem erfolgreichen Lauf keinen roten Toast erzeugen.
                warn('SBC-Liste automatisch nachladen fehlgeschlagen:', msg);
                queueLoadError = msg;
            } else {
                reportError('SBC-Liste laden fehlgeschlagen', e);
                toast('SBC-Liste laden fehlgeschlagen: ' + msg, 'error');
            }
        } finally {
            queueLoading = false;
            renderQueueList();
            syncQueueSection();
        }
    }
    /**
     * Sichtbarkeit: der Abschnitt gehoert in die SBC-Ansicht und nur dann,
     * wenn das Set ueberhaupt mehr als eine Challenge hat - bei einer einzigen
     * ist "Optimieren + Eintragen" der richtige Knopf.
     * Beim Wechsel in ein anderes Set wird die Liste EINMAL nachgeladen (aus
     * dem Cache, ohne Request, wenn er da ist) - kein Nachladen im Takt, siehe
     * LEARNINGS 7.
     */
    function syncQueueSection() {
        if (!ui.queueSection) return;
        const sid = detectViewedSetId();
        // String-Vergleiche: die Cache-Schluessel sind Strings, EAs Ids Zahlen.
        if (sid != null && String(queueLoadedSet) !== String(sid) &&
            String(queueTriedSet) !== String(sid) &&
            !queueLoading && inSbcView() && !throttledNow()) {
            queueTriedSet = sid;
            queueItems = [];
            queueChecked = {};
            // Kein await: die Sichtbarkeits-Pruefung laeuft im Takt und darf
            // nicht darauf warten. loadQueueList() rendert selbst nach.
            // LEISE: niemand hat danach gefragt.
            loadQueueList(false, true, sid);
        }
        const show = inSbcView() && sid != null &&
            String(queueLoadedSet) === String(sid) && queueItems.length > 1;
        ui.queueSection.classList.toggle('sbc-opt-hidden', !show);
    }
    /**
     * Reicht der Pool ueberhaupt fuer EIN Team? "Pool leer" war zu eng - live
     * standen fuenf Karten drin (der automatische Ladevorgang war noch nicht
     * durch), und das Ergebnis war ein leerer Plan mit dreimal derselben
     * Warnung. Liefert einen Klartext-Grund oder null.
     */
    function poolTooSmallReason(needSlots) {
        const n = STATE.pool.length;
        const need = Math.max(1, needSlots || 11);
        if (!n) return 'Pool leer. Bitte zuerst "Spieler laden".';
        if (n < need) {
            return 'Der Pool hat nur ' + n + ' Karten - für ein Team mit ' + need +
                ' Slots zu wenig. Bitte zuerst "Spieler laden" (läuft beim Start ' +
                'automatisch, kann ein paar Sekunden dauern).';
        }
        return null;
    }
    /**
     * Die angehakten SBCs planen. Schrittweise, mit Rueckgabe an den Browser
     * zwischen den Challenges - ein Solver-Lauf pro Challenge, und die Seite
     * darf dabei nicht einfrieren.
     */
    async function onQueuePlanClick() {
        const chosen = queueSelection(queueItems, queueChecked);
        if (!chosen.length) { toast('Keine SBC angehakt.', 'error'); return; }
        const tooSmall = poolTooSmallReason(Math.max.apply(null,
            chosen.map(function (c) { return c.slots || 11; })));
        if (tooSmall) { toast(tooSmall, 'error'); return; }
        if (STATE.loadIncomplete) {
            toast('ACHTUNG: Der Pool war beim Planen unvollständig geladen (' + STATE.pool.length +
                ' Karten) - der Plan kann auf fehlenden Karten beruhen.', 'warn');
        }
        ui.queuePlan.disabled = true;
        ui.batchPlan.disabled = true;
        setStatus('plane ' + chosen.length + ' SBC(s)...');
        try {
            const tim = { total: 0, rounds: [] };
            const tAll = Date.now();
            const baseCfg = readConfig();
            const st = beginQueue(STATE.pool, baseCfg);
            for (let i = 0; i < chosen.length; i++) {
                showProgress(i + 1, chosen.length,
                    'plane ' + chosen[i].name + '...',
                    (st.rounds.length ? st.rounds.length + ' fertig' : ''));
                await sleep(0);          // VOR dem Rechnen - sonst kein Frame
                const tr = Date.now();
                queueRound(st, chosen[i]);
                tim.rounds.push(Date.now() - tr);
            }
            const plan = finishQueue(st);
            plan.mode = 'reihe';
            plan.cfg = baseCfg;
            // Das Set der LISTE: STATE.sbc.setId kann beim vorigen Set haengen
            // (kein Netzwerk-Request beim Wechsel) - geplant wurde aus
            // queueItems, also gehoert deren Set an den Plan.
            plan.setId = (queueLoadedSet != null) ? queueLoadedSet : STATE.sbc.setId;
            plan.poolLoadIncomplete = STATE.loadIncomplete;
            // In der Reihe traegt JEDE Runde ihr eigenes Ziel; die Plan-Felder
            // targetOVR/slots bleiben leer, damit niemand sie versehentlich als
            // gemeinsame Vorgabe liest.
            plan.targetOVR = null;
            plan.slots = null;
            plan.usedChallengeIds = [];
            plan.setName = (function () {
                try {
                    const c = findSbcController();
                    const se = c && (c._set || c.set);
                    return (se && (se.name || se.setName)) || null;
                } catch (e) { return null; }
            })();
            STATE.batch = plan;
            renderBatchPreview(plan);
            tim.total = Date.now() - tAll;
            STATE.diag.batchPlanTiming = tim;
            try { STATE.diag.solverProfile = SolverCore.lastProfiles(); } catch (e) {}
            // Uebersprungene benennen - sonst waere unklar, warum aus drei
            // Haken zwei Teams geworden sind.
            for (const sk of plan.skipped || []) {
                toast('"' + sk.step.name + '" übersprungen: ' + sk.reason, 'warn');
            }
            finishProgress(plan.planned + ' von ' + chosen.length + ' SBC(s) geplant', true);
            setStatus(plan.planned + ' von ' + chosen.length + ' SBC(s) geplant');
        } catch (e) {
            toast('Planung fehlgeschlagen: ' + e.message, 'error');
            reportError('SBC-Reihe planen fehlgeschlagen', e);
        } finally {
            ui.batchPlan.disabled = false;
            // Nicht pauschal wieder aktivieren: ob der Knopf geht, entscheidet
            // die AUSWAHL (nach dem Lauf sind die Haken der abgegebenen
            // Challenges weg - dann ist er zu Recht aus).
            syncQueuePlanButton();
        }
    }
    /**
     * Entscheidet fuer EIN Element, ob es der Pack-Knopf ist. Rein (nur Text
     * des Elements und Text des Elternteils), damit die Ebenen-Regel testbar
     * ist - an ihr hing der Fehler.
     *   text       Text des Elements
     *   parentText Text des Elternteils (null, wenn keins)
     * Genommen wird die AEUSSERSTE Huelle, deren Text noch genau "Open" ist:
     * bei <div><span>Open</span></div> also das div. Das innerste zu nehmen
     * wuerde unseren Knopf INNERHALB von EAs Knopf einhaengen.
     */
    function isPackOpenLabel(text, parentText) {
        const norm = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().toLowerCase();
        const t = norm(text);
        if (t !== 'open' && t !== 'öffnen') return false;
        if (parentText != null && norm(parentText) === t) return false;
        return true;
    }
    function packOpenButtons() {
        const out = [];
        try {
            // BREIT suchen. Vorher stand hier nur 'button, a, [role="button"]' -
            // und im Live-Report waren openButtons 0, waehrend drei "Open"
            // sichtbar auf dem Schirm lagen (Bild vom 25.08.). EAs
            // Pack-Kachel-Knopf ist keines dieser drei Dinge.
            const els = document.querySelectorAll(
                'button, a, [role="button"], div, span, li, p');
            for (let i = 0; i < els.length; i++) {
                const el = els[i];
                if (!isPackOpenLabel(el.textContent,
                        el.parentElement ? el.parentElement.textContent : null)) continue;
                out.push(el);
            }
        } catch (e) {}
        return out;
    }
    function inStoreView() {
        // ZUERST das DOM: liegen Pack-Kacheln mit "Open" auf dem Schirm, sind
        // wir in der Pack-Ansicht - egal wie EA den Controller nennt. Der
        // Namens-Test allein war zu eng ("My Packs" enthaelt kein "store"),
        // und dann lief weder der Auto-Refresh noch die Knopf-Injection.
        try { if (packOpenButtons().length) return true; } catch (e) {}
        try {
            const chain = getControllerChain();
            if (!chain.length) return true;
            for (const c of chain) {
                const n = (c.constructor && c.constructor.name) || '';
                if (/store|pack/i.test(n)) return true;
            }
        } catch (e) { return true; }
        return false;
    }
    // Merker fuer die FLANKE "Store betreten" - die Sichtbarkeits-Pruefung
    // laeuft alle 500ms, ein Refresh pro Tick waere sinnlos und wuerde EA
    // beschiessen.
    let packViewWasIn = false;
    let lastAutoPackRefresh = 0;
    function syncPackSection() {
        if (!ui.packSection) return;
        const inStore = inStoreView();
        ui.packSection.classList.toggle('sbc-opt-hidden', !inStore);
        if (inStore) {
            if (!packViewWasIn) {
                packViewWasIn = true;
                // Kein await: syncPackSection laeuft im Intervall und darf
                // nicht darauf warten.
                autoPackRefresh();
            }
            injectPackTileButtons();
        } else {
            packViewWasIn = false;
        }
    }
    /**
     * Pack-Liste beim Betreten des Stores selbst holen.
     * Bewusst zurueckhaltend: nicht waehrend eines laufenden Pack-Laufs, mit
     * Abklingzeit (mehrfaches Rein/Raus soll EA nicht beschiessen, LEARNINGS 7),
     * und mit kurzer Verzoegerung - die Store-Ansicht baut sich noch auf.
     */
    async function autoPackRefresh(retry) {
        if (STATE.packOpenBusy) return;
        const now = Date.now();
        // Der Nachversuch darf die Abklingzeit ueberspringen - er ist selbst
        // schon durch sie hindurchgekommen. Sonst waere er ein no-op.
        if (!retry && now - lastAutoPackRefresh < 8000) return;
        if (!retry) lastAutoPackRefresh = now;
        await sleep(retry ? 2500 : 600);
        if (!inStoreView() || STATE.packOpenBusy) return;
        // OHNE services gibt es nichts zu holen - und auf der LOGIN-SEITE
        // faellt inStoreView() bei leerer Controller-Kette auf true zurueck
        // (Mikes Log: "Pack-Enumeration: fehlende Globals" bei jedem
        // Login-Navigate). Ein Fehlversuch samt reportError pro Login ist
        // reines Rauschen in lastErrors. Leise aussteigen; das Betreten des
        // echten Stores loest ueber die Flanke einen neuen Versuch aus.
        if (!servicesAvailable()) {
            mergePackScan({ autoRefreshSkipped: 'services fehlen (Login-Seite?)' });
            return;
        }
        // Schrittweise, damit im Report steht, WO es geknallt hat. Live kam nur
        // "Cannot read properties of undefined (reading 'toLowerCase')" ohne Ort -
        // damit war nicht entscheidbar, ob der Fehler bei uns oder in EAs
        // Store-Service liegt.
        let step = 'start';
        try {
            setPackStatus('lade Packs...');
            step = 'fetchMyPacks';
            const groups = await fetchMyPacks();
            step = 'renderPackTypeOptions';
            renderPackTypeOptions();
            step = 'status';
            setPackStatus(groups.length + ' eigene Pack-Typen (automatisch geladen).');
            mergePackScan({ autoRefreshCount: ((STATE.diag.packScan || {}).autoRefreshCount || 0) + 1 });
            step = 'injectPackTileButtons';
            injectPackTileButtons();
            step = 'fertig';
        } catch (e) {
            // Nicht toasten: der Nutzer hat nichts angeklickt, ein Fehler hier
            // darf ihn nicht anspringen. Der Refresh-Knopf bleibt der Weg von
            // Hand, und der Status sagt, was war.
            mergePackScan({ autoRefreshError: step + ': ' + String(e && e.message || e),
                            autoRefreshRetried: !!retry });
            // EINEN Nachversuch. Der Wurf kommt live aus EAs getPacks() 600ms
            // nach dem Betreten des Stores - dann stehen EAs eigene Store-Daten
            // noch nicht (in unserem Code gibt es auf dem Pfad kein
            // toLowerCase: nachgesehen in fetchMyPacks, groupMyPacks,
            // packLabelOf, localizeEaKey, prettifyPackKey). Von Hand klappt es
            // danach, also ist ein zweiter Anlauf die richtige Antwort. GENAU
            // einer: eine Schleife gegen EAs Store waere schlimmer als der Knopf.
            if (!retry) {
                setPackStatus('Packs noch nicht bereit - zweiter Versuch...');
                autoPackRefresh(true);
            } else {
                setPackStatus('automatisches Laden fehlgeschlagen (' + step + '): ' +
                              (e.message || e) + ' - ↻ drücken.');
            }
        }
    }
    /**
     * Alle fuer den Pack-Opener benoetigten EA-Globalen VORAB defensiv
     * aufloesen - open() ist irreversibel, ein erst mitten im Testlauf
     * fehlendes Global (z.B. GameCurrency fuer die Misc-Item-Erkennung) waere
     * dann nicht mehr sauber abbrechbar (Abbruch-Disziplin).
     */
    function resolvePackGlobals(win) {
        win = win || window;
        const missing = [];
        let store = null, item = null, repoItem = null, ItemPile = null,
            SearchCriteria = null, GameCurrency = null;
        try {
            store = win.services && win.services.Store;
            if (!store || typeof store.getPacks !== 'function') missing.push('services.Store.getPacks');
        } catch (e) { missing.push('services.Store'); }
        try {
            item = win.services && win.services.Item;
            if (!item || typeof item.requestUnassignedItems !== 'function' ||
                typeof item.move !== 'function' || typeof item.searchStorageItems !== 'function' ||
                typeof item.redeem !== 'function') missing.push('services.Item');
        } catch (e) { missing.push('services.Item'); }
        try {
            repoItem = win.repositories && win.repositories.Item;
            if (!repoItem || typeof repoItem.numItemsInCache !== 'function' ||
                typeof repoItem.setDirty !== 'function') missing.push('repositories.Item');
        } catch (e) { missing.push('repositories.Item'); }
        try {
            ItemPile = win.ItemPile;
            if (!ItemPile || ItemPile.PURCHASED == null || ItemPile.CLUB == null || ItemPile.STORAGE == null) missing.push('ItemPile');
        } catch (e) { missing.push('ItemPile'); }
        try {
            SearchCriteria = win.UTSearchCriteriaDTO;
            if (typeof SearchCriteria !== 'function') missing.push('UTSearchCriteriaDTO');
        } catch (e) { missing.push('UTSearchCriteriaDTO'); }
        // GameCurrency ist OPTIONAL (Live-Befund 16.08., packScan: in der
        // fc26-Web-App existiert es nicht als Global). Stufe 1 braucht es
        // nicht: purchase(currency) wird nie gerufen (nur open() auf
        // besessenen Packs), und isMiscPackItem() hat den itemType-Fallback.
        // Fehlt es, wird das nur diagnostisch vermerkt, nicht blockiert.
        const optionalMissing = [];
        try {
            GameCurrency = win.GameCurrency;
            if (typeof GameCurrency !== 'function') { GameCurrency = null; optionalMissing.push('GameCurrency'); }
        } catch (e) { GameCurrency = null; optionalMissing.push('GameCurrency'); }
        // Die Verwerf-Methode ist OPTIONAL: fehlt sie, funktioniert alles
        // Bisherige weiter, nur "Verwerten" verweigert den Start. Ihr Name
        // (und im Fehlerfall die Liste aller vorhandenen Methoden) geht in die
        // Diagnose - EAs Namen sind nicht dokumentiert.
        const discard = resolveDiscardFn(item);
        if (!discard) optionalMissing.push('services.Item.discard');
        return {
            ok: missing.length === 0, missing: missing, optionalMissing: optionalMissing,
            store: store, item: item, repoItem: repoItem, ItemPile: ItemPile,
            SearchCriteria: SearchCriteria, GameCurrency: GameCurrency,
            discard: discard,
            itemMethods: discard ? null : itemServiceMethodNames(item)
        };
    }
    // response.packs statt response.items - eigene Extraktion neben
    // responseItems() statt eines Parameters daran, weil das Feld (nicht nur
    // der Aufrufkontext) ein anderes ist.
    function responsePacks(response) {
        if (!response) return [];
        const r = response.response || response.data || response;
        if (r && Array.isArray(r.packs)) return r.packs;
        return [];
    }
    /** Eigene Packs (isMyPack) nach id gruppiert - jede Instanz ein Eintrag. */
    function groupMyPacks(packs) {
        const order = [];
        const byId = new Map();
        for (const p of (packs || [])) {
            if (!p || p.isMyPack !== true) continue;
            if (!byId.has(p.id)) {
                const g = { id: p.id, packName: p.packName, tradable: !!p.tradable, count: 0 };
                byId.set(p.id, g);
                order.push(g);
            }
            byId.get(p.id).count++;
        }
        return order;
    }
    function unassignedGuardOk(count) {
        return count === 0;
    }
    // ---- Klartext-Namen (Live-Befund 16.08., LEARNINGS §50) ----------------
    // EA liefert am Pack-Objekt NUR den Lokalisierungs-Key
    // ("FUT_STORE_PACK_1082_NAME_MOBILE"); im Store-UI steht "Provisions Pack".
    // Aufloesung ueber services.Localization.localize(key, args) - belegt in
    // der PaleTools-Analyse (dort exakt auf pack.packName angewandt, sowohl
    // fuer das My-Packs-Dropdown als auch fuer data-title). Ein fuehrendes
    // '*' ist EAs Marker fuer "nicht/teilweise lokalisiert" und wird
    // abgeschnitten (macht PaleTools genauso).
    function localizeEaKey(key, win) {
        win = win || (typeof window !== 'undefined' ? window : null);
        if (!key || typeof key !== 'string' || !win) return null;
        let fn = null;
        try {
            const L = win.services && win.services.Localization;
            if (L && typeof L.localize === 'function') fn = L.localize.bind(L);
        } catch (e) {}
        if (!fn) { try { if (typeof win.localize === 'function') fn = win.localize; } catch (e) {} }
        if (!fn) return null;
        let s = null;
        try { s = fn(key, []); } catch (e) { return null; }
        if (typeof s !== 'string' || !s.length) return null;
        if (s.length > 1 && s.charAt(0) === '*') s = s.substring(1);
        return (s && s !== key) ? s : null;
    }
    // Fallback ohne Localization-Service: aus dem Key wenigstens die Pack-Id
    // lesbar machen, statt "FUT_STORE_PACK_1082_NAME_MOBILE" anzuzeigen.
    function prettifyPackKey(key, id) {
        const m = /FUT_STORE_PACK_(\d+)/i.exec(String(key || ''));
        if (m) return 'Pack ' + m[1];
        if (key && !/^[A-Z0-9_]+$/.test(String(key))) return String(key);
        return 'Pack ' + (id != null ? id : '?');
    }
    function packLabelOf(group, win) {
        if (!group) return 'Pack ?';
        return localizeEaKey(group.packName, win) || prettifyPackKey(group.packName, group.id);
    }
    // rareflag -> Klartext. Nur belegte Werte benennen (FUT-Standard 0/1,
    // TOTW 3 - dieselbe Identitaet wie isTotw()); alles andere ehrlich als
    // "Special" mit der Flag-Nummer, statt einen Namen zu erfinden.
    function rarityLabelOf(rareflag, groups) {
        if (rareflag == null || rareflag === '') return null;
        const rf = Number(rareflag);
        if (rf === 0) return 'Common';
        if (rf === 1) return 'Rare';
        if (rf === 3) return 'TOTW';
        if (Array.isArray(groups) && groups.indexOf(83) > -1) return 'Special (TOTW/TOTS/FOF/FUTTIES)';
        if (isFinite(rf)) return 'Special (' + rf + ')';
        return null;
    }
    /**
     * Name/Rating/Seltenheit einer frisch gezogenen Karte (Live-Befund 16.08.:
     * die Zieh-Liste zeigte "#920367683733" ohne Rating). Die Items aus
     * requestUnassignedItems() sind ENTITIES, keine JSON-DTOs: der Name steht
     * nicht am Item selbst, sondern in den Stammdaten
     * (getStaticData() -> _staticData -> repositories.Item.getStaticDataByDefId),
     * und der Schluessel heisst definitionId, NICHT assetId (in EAs Entity-
     * Klasse existiert assetId nicht). Alles belegt aus der PaleTools-Analyse.
     *
     * normalizePlayer() bleibt der erste Versuch (unveraendert - daran haengt
     * das Club-Laden): liefert es einen Treffer, gewinnt der. Die Entity-Kette
     * ist rein additiv fuer den Fall, dass es aussteigt (bei Pack-Items:
     * rating war NaN -> null).
     */
    function describePackItem(it, opts) {
        opts = opts || {};
        // Fehler werden GESAMMELT statt still geschluckt: eine Karte, die nur
        // ueber den Fallback lesbar ist, bleibt anzeigbar (der Lauf ist da
        // laengst durch), aber der Grund landet ueber den Aufrufer im Report.
        const errs = [];
        function trap(fn) {
            try { return fn(); } catch (e) { errs.push(String(e && e.message || e)); return null; }
        }
        const norm = opts.normalize ? trap(function () { return opts.normalize(it, false); }) : null;
        const defId = safeGet(it, 'definitionId');
        let name = norm && norm.name && !/^#/.test(norm.name) ? norm.name : null;
        let rating = norm && norm.rating != null ? norm.rating : null;
        let rareflag = norm && norm.rareflag != null ? norm.rareflag : null;
        let groups = norm && norm.groups ? norm.groups : null;
        if (rating == null) {
            const r = safeGet(it, 'rating');
            if (r != null && !isNaN(parseInt(r, 10))) rating = parseInt(r, 10);
        }
        if (rareflag == null) {
            const rf = safeGet(it, 'rareflag');
            if (rf != null && !isNaN(parseInt(rf, 10))) rareflag = parseInt(rf, 10);
        }
        if (!groups) { const g = safeGet(it, 'groups'); if (Array.isArray(g)) groups = g.map(Number); }
        // Stammdaten-Kette (nur wenn noch etwas fehlt)
        if (name == null || rating == null) {
            let sd = trap(function () {
                return (it && typeof it.getStaticData === 'function') ? it.getStaticData() : null;
            });
            if (!sd) sd = safeGet(it, '_staticData');
            if (!sd && defId != null && opts.repoItem) {
                sd = trap(function () {
                    return (typeof opts.repoItem.getStaticDataByDefId === 'function')
                        ? opts.repoItem.getStaticDataByDefId(defId) : null;
                });
            }
            if (sd) {
                if (name == null) {
                    name = safeGet(sd, 'name') ||
                        safeCall(function () { return typeof sd.getFullName === 'function' ? sd.getFullName() : null; }) ||
                        safeGet(sd, 'commonName') ||
                        ([safeGet(sd, 'firstName'), safeGet(sd, 'lastName')].filter(Boolean).join(' ') || null);
                }
                if (rating == null) {
                    const sr = safeGet(sd, 'rating');
                    if (sr != null && !isNaN(parseInt(sr, 10))) rating = parseInt(sr, 10);
                }
            }
        }
        return {
            name: name || ('#' + (defId != null ? defId : safeGet(it, 'id'))),
            rating: rating,
            rareflag: rareflag,
            // groups und untradeable werden zum Verwerten gebraucht: die
            // Seltenheits-Gruppe entscheidet ueber den Stopp, unverkaeuflich
            // entscheidet ueber Wegwerfen oder Einsortieren.
            groups: Array.isArray(groups) ? groups : null,
            untradeable: !!safeGet(it, 'untradeable'),
            itemId: safeGet(it, 'id'),
            // EAs Schnellverkaufswert - keine Schaetzung, sondern die Zahl, die
            // beim Abstossen gutgeschrieben wird. untradableDiscardValue
            // spielt keine Rolle: unverkaeufliche Karten werden nicht
            // abgestossen.
            discardValue: (function () {
                const v = safeGet(it, 'discardValue');
                const n = parseInt(v, 10);
                return isFinite(n) ? n : null;
            })(),
            rarity: rarityLabelOf(rareflag, groups),
            nameResolved: !!name,
            readError: errs.length ? errs[0] : null
        };
    }
    function safeGet(o, k) {
        try { const v = o ? o[k] : null; return v === undefined ? null : v; }
        catch (e) { return null; }
    }
    function safeCall(fn) { try { return fn(); } catch (e) { return null; } }
    /**
     * Einmalige Feld-Aufnahme fuer die Diagnose (diagnose-feld-statt-raten):
     * WIE sehen die Objekte wirklich aus? Beantwortet beim naechsten Report,
     * ob Entity oder DTO, wie die Felder heissen und ob getStaticData da ist -
     * statt weiter zu vermuten, warum ein Name fehlt.
     */
    function sampleObjectShape(o) {
        if (!o || typeof o !== 'object') return null;
        const own = safeCall(function () { return Object.keys(o).slice(0, 40); }) || [];
        let proto = [];
        try {
            const p = Object.getPrototypeOf(o);
            if (p && p !== Object.prototype) proto = Object.getOwnPropertyNames(p).slice(0, 40);
        } catch (e) {}
        return {
            ownKeys: own, protoMethods: proto,
            hasGetStaticData: typeof safeGet(o, 'getStaticData') === 'function',
            hasStaticDataField: !!safeGet(o, '_staticData'),
            definitionId: safeGet(o, 'definitionId'),
            assetId: safeGet(o, 'assetId'),
            ratingRaw: safeGet(o, 'rating'),
            rareflagRaw: safeGet(o, 'rareflag'),
            itemTypeRaw: safeGet(o, 'itemType'),
            // Traegt das Item wirklich einen Schnellverkaufswert? Ohne diese
            // Zahl waere "0 Coins" nicht von "Feld nicht gelesen" zu
            // unterscheiden.
            discardValueRaw: safeGet(o, 'discardValue')
        };
    }
    /**
     * Misc-Items (Coins etc.) muessen ueber services.Item.redeem() statt
     * move() verteilt werden. GameCurrency ist EAs eigene Klasse dafuer
     * (Fallback-Kette: fehlt sie, greift derselbe itemType-Weg, den
     * normalizePlayer() bereits fuer die Spieler-Erkennung nutzt).
     */
    function isMiscPackItem(item, GameCurrency) {
        try {
            if (GameCurrency && typeof GameCurrency === 'function' && item instanceof GameCurrency) return true;
        } catch (e) {}
        try {
            const t = item && (item.itemType || item.type);
            if (t && String(t).toLowerCase() !== 'player') return true;
        } catch (e) {}
        return false;
    }
    /**
     * Reine Verteil-Entscheidung: Nicht-Duplikate -> Verein, Duplikate ->
     * Storage bis zur Kapazitaet, Rest bleibt liegen (Stufe 1: kein
     * Quicksell/Transferliste), Misc-Items gesondert markiert.
     */
    function decidePackDistribution(items, storageCountBefore, storageCapacity, GameCurrency) {
        const toClub = [], toStorage = [], toMisc = [], leftover = [];
        let storageUsed = storageCountBefore;
        for (const it of (items || [])) {
            if (isMiscPackItem(it, GameCurrency)) { toMisc.push(it); continue; }
            let dup = false;
            try { dup = typeof it.isDuplicate === 'function' ? !!it.isDuplicate() : !!it.isDuplicate; }
            catch (e) { dup = false; }
            if (!dup) { toClub.push(it); continue; }
            if (storageUsed < storageCapacity) { toStorage.push(it); storageUsed++; }
            else { leftover.push(it); }
        }
        return { toClub: toClub, toStorage: toStorage, toMisc: toMisc, leftover: leftover, storageCountAfterPlanned: storageUsed };
    }
    // ======================================================================
    //  ABSTOSSEN (EAs Schnellverkauf): erst alles pruefen, dann handeln
    // ======================================================================
    // EAs Methodenname fuer "Karte verwerten" ist nicht dokumentiert, und
    // raten ist bei einer unumkehrbaren Aktion die schlechteste Idee. Deshalb:
    // eine Kandidatenliste PROBIEREN und das Ergebnis in die Diagnose schreiben.
    // Findet sich keine, wird der Lauf verweigert - und der naechste Report
    // enthaelt die echten Methodennamen von services.Item, womit es in einem
    // Schritt behoben ist ("erst ein Diagnose-Feld einbauen, dann fixen").
    const DISCARD_CANDIDATES = ['discard', 'discardItems', 'quickSell', 'quicksell', 'sell'];
    // Was passiert nach dem Oeffnen? In localStorage, weil die Wahl ein
    // Neuladen ueberleben MUSS: sonst stuende nach jedem Login wieder
    // "Einsortieren" da, waehrend Rasmus "Verwerten" erwartet - und
    // umgekehrt waere schlimmer.
    const PACK_MODE_KEY = 'sbcOptPackMode';
    function packMode() {
        try {
            return localStorage.getItem(PACK_MODE_KEY) === 'abstossen'
                ? 'abstossen' : 'einsortieren';
        } catch (e) { return 'einsortieren'; }
    }
    function setPackMode(m) {
        try { localStorage.setItem(PACK_MODE_KEY, m === 'abstossen' ? 'abstossen' : 'einsortieren'); }
        catch (e) { reportError('Pack-Modus speichern fehlgeschlagen', e); }
    }
    function resolveDiscardFn(itemService) {
        if (!itemService) return null;
        for (const n of DISCARD_CANDIDATES) {
            let f = null;
            try { f = itemService[n]; } catch (e) { continue; }
            if (typeof f === 'function') return { name: n, fn: f.bind(itemService) };
        }
        return null;
    }
    /** Alle aufrufbaren Namen von services.Item - fuer den Report, wenn nichts passt. */
    function itemServiceMethodNames(itemService) {
        const out = [];
        if (!itemService) return out;
        try {
            for (const k of Object.keys(itemService)) {
                if (typeof itemService[k] === 'function') out.push(k);
            }
        } catch (e) {}
        try {
            const p = Object.getPrototypeOf(itemService);
            if (p && p !== Object.prototype) {
                for (const k of Object.getOwnPropertyNames(p)) {
                    if (k === 'constructor' || out.indexOf(k) > -1) continue;
                    let v = null;
                    try { v = itemService[k]; } catch (e) { continue; }
                    if (typeof v === 'function') out.push(k);
                }
            }
        } catch (e) {}
        return out.sort().slice(0, 60);
    }
    /**
     * Was passiert mit den Karten EINES Packs? Reine Entscheidung ueber die
     * GANZE Liste - es wird nichts verworfen, solange irgendetwas darin einen
     * Stopp verlangt.
     *
     * Ergebnis:
     *   toDiscard  normale, verkaeufliche Karten -> verwerten
     *   toKeep     normale, UNVERKAEUFLICHE Karten -> einsortieren (SBC-Futter)
     *   toMisc     Coins & Co. -> einloesen
     *   stoppers   Grund(e), warum NICHTS verworfen werden darf
     */
    function decidePackDiscard(items, opts) {
        const o = opts || {};
        const describe = o.describe || function () { return {}; };
        const isMisc = o.isMisc || function () { return false; };
        const locked = o.lockedIds || {};
        const toDiscard = [], toKeep = [], toMisc = [], stoppers = [], rows = [];
        for (const it of items || []) {
            if (isMisc(it)) { toMisc.push(it); rows.push({ target: 'einlösen', misc: true }); continue; }
            let d = null;
            try { d = describe(it); } catch (e) { d = null; }
            if (!d) {
                // Unlesbar ist ein STOPP, keine Annahme. Bei einer
                // unumkehrbaren Aktion ist "wird schon normal sein" die
                // teuerste Vermutung im ganzen Script.
                stoppers.push({ why: 'nicht lesbar', name: '?' });
                continue;
            }
            const name = d.name || '?';
            const id = (d.itemId != null) ? String(d.itemId) : null;
            if (id && locked[id]) {
                stoppers.push({ why: 'per PaleTools gesperrt', name: name });
                continue;
            }
            const rfRaw = d.rareflag;
            const rf = Number(rfRaw);
            const g83 = !!(d.groups && d.groups.indexOf(83) > -1);
            // Nur eine NACHWEISLICH normale Karte darf weg. Drei Faellen wird
            // hier bewusst misstraut:
            //  - null/undefined: Number(null) ist 0, und 0 ist "Common" -
            //    eine Karte ohne lesbare rareflag waere also durchgegangen.
            //    (Der Testfall dazu hat genau das aufgedeckt.)
            //  - NaN: isNormalCard() laesst es durch (fuer den Solver richtig,
            //    "unbekannt heisst nicht besonders"); zum Wegwerfen nicht.
            //  - Gruppe 83, auch bei gewoehnlicher rareflag.
            if (rfRaw == null || !isFinite(rf) || !isNormalCard(rf) || g83) {
                stoppers.push({ why: 'Special-Karte (' + (d.rarity || ('rf' + d.rareflag)) + ')',
                                name: name, rating: d.rating });
                continue;
            }
            if (d.untradeable) {
                // Rasmus' eigene Regel: unverkaeufliche Karten sind
                // SBC-Material. Behalten, nicht wegwerfen.
                toKeep.push(it);
                rows.push({ target: 'behalten (unverkäuflich)', name: name, rating: d.rating,
                            rarity: d.rarity });
                continue;
            }
            toDiscard.push(it);
            rows.push({ target: 'abgestoßen', name: name, rating: d.rating,
                        rarity: d.rarity, coins: d.discardValue });
        }
        return { toDiscard: toDiscard, toKeep: toKeep, toMisc: toMisc,
                 stoppers: stoppers, rows: rows };
    }
    /** Klartext-Grund fuer den Stopp - er landet 1:1 in der Meldung. */
    function discardStopReason(stoppers) {
        const list = (stoppers || []).slice(0, 4).map(function (st) {
            return st.name + (st.rating != null ? ' (' + st.rating + ')' : '') + ' - ' + st.why;
        });
        const rest = Math.max(0, (stoppers || []).length - list.length);
        return 'nichts abgestoßen: ' + list.join(', ') +
            (rest ? ' und ' + rest + ' weitere' : '') +
            '. Die Karten liegen unassigned - bitte im Spiel selbst entscheiden.';
    }
    // Wholesale-Reassign statt Feld-fuer-Feld: STATE.diag.packScan startet als
    // null (solver-test.js §17 verlangt "null" statt eines Objekt-Literals in
    // der STATE.diag-Deklaration selbst, siehe clubLoad/uiScan) - Object.assign
    // ignoriert eine null-Quelle, der erste Aufruf befuellt das Feld also ohne
    // Sonderfall.
    function mergePackScan(patch) {
        STATE.diag.packScan = Object.assign({}, STATE.diag.packScan, patch);
    }
    // Takt zwischen den Verteil-Schritten: 300-700ms, wie PaleTools' "Fast"
    // (LEARNINGS §30-Logik) - kein festerer Wert, kein schnellerer.
    function packTakt() { return 300 + Math.floor(Math.random() * 401); }
    // Takt ZWISCHEN Packs (Stufe 2, Ticket #76): spuerbar laenger als
    // packTakt() (500-1400ms statt 300-700ms) - zwischen zwei ganzen
    // Pack-Zyklen ist mehr Abstand die konservativere Wahl, solange die
    // open()-Instanz-Semantik noch nicht live verifiziert ist.
    function packBetweenTakt() { return 500 + Math.floor(Math.random() * 901); }
    async function fetchMyPacks() {
        const g = resolvePackGlobals();
        if (!g.ok) {
            reportError('Pack-Enumeration: fehlende Globals', new Error(g.missing.join(', ')));
            mergePackScan({ missingGlobals: g.missing });
            throw new Error('Store-Schnittstellen fehlen (' + g.missing.join(', ') + ') - Diagnose prüfen.');
        }
        const resp = await obsPromise(g.store.getPacks());
        if (!responseOk(resp)) {
            throw new Error('Pack-Liste konnte nicht geladen werden (Status ' + (resp && resp.status) + ').');
        }
        const packs = responsePacks(resp);
        const groups = groupMyPacks(packs);
        STATE.packGroups = groups;
        const byId = new Map();
        for (const p of packs) {
            if (!p || p.isMyPack !== true) continue;
            const key = String(p.id);
            if (!byId.has(key)) byId.set(key, []);
            byId.get(key).push(p);
        }
        STATE.packEntitiesById = byId;
        mergePackScan({
            myPacks: groups.map(function (x) {
                return { id: x.id, packName: x.packName, label: packLabelOf(x),
                         tradable: x.tradable, count: x.count };
            }),
            packShape: sampleObjectShape(packs[0]),
            missingGlobals: g.optionalMissing || []
        });
        return groups;
    }
    // Beschriftungen an EINER Stelle - Schalter, Knopf und Rueckfrage muessen
    // dasselbe sagen. Zwei Texte, die auseinanderlaufen, sind bei einer
    // unumkehrbaren Aktion ein echtes Risiko.
    const PACK_MODES = [
        { id: 'einsortieren', label: 'Einsortieren',
          button: 'Alle öffnen',
          tile: 'Verein',
          hint: 'Neue Karten in den Verein, Duplikate in den Storage.' },
        { id: 'abstossen', label: 'Abstoßen',
          button: 'Alle öffnen + abstoßen',
          tile: 'abstoßen',
          hint: 'Normale Karten werden ABGESTOSSEN (unwiderruflich, gibt Coins). ' +
                'Special-Karten stoppen den Lauf, unverkäufliche werden einsortiert.' }
    ];
    function packModeSpec(id) {
        for (const m of PACK_MODES) { if (m.id === id) return m; }
        return PACK_MODES[0];
    }
    /**
     * Segment-Schalter fuer den Modus - dieselben Klassen wie die Schnellwahl,
     * damit das Panel EINE Bedien-Sprache spricht.
     */
    function renderPackMode() {
        const box = ui.packModeBox;
        if (!box) return;
        const cur = packMode();
        box.innerHTML = '';
        for (const m of PACK_MODES) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sbc-opt-chip' + (m.id === cur ? ' on' : '');
            b.textContent = m.label;
            b.title = m.hint;
            b.addEventListener('click', function () {
                if (STATE.packOpenBusy) return;      // nicht mitten im Lauf umschalten
                setPackMode(m.id);
                renderPackMode();
            });
            box.appendChild(b);
        }
        const spec = packModeSpec(cur);
        if (ui.packModeHint) ui.packModeHint.textContent = spec.hint;
        if (ui.packAll) ui.packAll.textContent = spec.button;
    }
    function renderPackTypeOptions() {
        if (!ui.packType) return;
        const prev = ui.packType.value;
        const groups = STATE.packGroups || [];
        if (!groups.length) {
            ui.packType.innerHTML = '<option value="">– keine eigenen Packs gefunden –</option>';
            return;
        }
        ui.packType.innerHTML = groups.map(function (g) {
            return '<option value="' + escapeHtml(String(g.id)) + '">' + escapeHtml(packLabelOf(g)) +
                   ' (' + g.count + ' Stück)</option>';
        }).join('');
        if (prev && groups.some(function (g) { return String(g.id) === prev; })) ui.packType.value = prev;
    }
    function setPackStatus(text) {
        if (!ui.packResult) return;
        ui.packResult.innerHTML = '<div class="sbc-opt-batch-round">' + escapeHtml(text) + '</div>';
    }
    /**
     * Bilanz eines Abstoss-Laufs. Reine Funktion: Karten rein, Zahlen raus -
     * damit die Coins-Summe testbar ist und nicht still falsch werden kann.
     * Gruppiert nach Seltenheit UND Rating, weil Rasmus genau danach gefragt
     * hat ("welche spieler mit welchen rarities und welchen ratings").
     */
    function summarizeDiscarded(drawn) {
        const rows = (drawn || []).filter(function (d) {
            return d && d.target === 'abgestoßen';
        });
        let coins = 0, unbekannt = 0;
        const byKey = {};
        for (const d of rows) {
            // Number(null) ist 0 - eine Karte OHNE lesbaren Wert waere damit
            // als "0 Coins" durchgegangen statt als unbekannt. Dieselbe Falle
            // wie bei der rareflag-Pruefung; hier zum dritten Mal, deshalb
            // ausdruecklich: erst auf null pruefen, dann rechnen.
            const c = (d.coins == null) ? NaN : Number(d.coins);
            if (isFinite(c) && c >= 0) coins += c; else unbekannt++;
            const key = (d.rarity || '?') + ' ' + (d.rating != null ? d.rating : '?');
            if (!byKey[key]) {
                byKey[key] = { rarity: d.rarity || '?', rating: (d.rating != null ? d.rating : null),
                               count: 0, coins: 0 };
            }
            byKey[key].count++;
            if (isFinite(c) && c >= 0) byKey[key].coins += c;
            // (kein else: eine Gruppe zaehlt die Karte, auch wenn ihr Wert
            //  fehlt - die Zahl oben nennt, wie viele das waren)
        }
        const groups = Object.keys(byKey).map(function (k) { return byKey[k]; });
        // Absteigend nach Rating, dann nach Anzahl - so steht oben, was wehtut.
        groups.sort(function (a, b) {
            const ra = (a.rating == null) ? -1 : a.rating;
            const rb = (b.rating == null) ? -1 : b.rating;
            if (ra !== rb) return rb - ra;
            return b.count - a.count;
        });
        return { count: rows.length, coins: coins, unknownCoins: unbekannt, groups: groups };
    }
    /** Zahlen mit Tausenderpunkt - 3480 Coins liest sich als 3.480. */
    function coinsText(n) {
        // null/leer wird NICHT zu 0: Number(null) ist 0, und "0 Coins" waere
        // eine Behauptung, wo nichts bekannt ist.
        if (n == null || n === '') return '?';
        const v = Number(n);
        if (!isFinite(v)) return '?';
        return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }
    function renderPackDrawList(drawn, headerText) {
        if (!ui.packResult) return;
        const sorted = drawn.slice().sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); });
        let html = '';
        for (const d of sorted) {
            // name/target koennen bei unlesbaren Items fehlen ({id, error}-
            // Fallback des Einsammlers) - "undefined → undefined" waere die
            // Anzeige (Nacht-Review 16.08.).
            html += '<div class="sbc-opt-batch-round">' +
                    (d.rating != null ? '<b>' + d.rating + '</b> ' : '') +
                    escapeHtml(d.name || ('Item ' + (d.id != null ? d.id : '?'))) +
                    (d.rarity ? ' <span class="sbc-opt-dim">' + escapeHtml(d.rarity) + '</span>' : '') +
                    (d.isDuplicateRaw ? ' <span class="sbc-opt-batch-warn">[Duplikat]</span>' : '') +
                    ' → ' + escapeHtml(d.target || (d.error ? 'Fehler: ' + d.error : 'unbekannt')) +
                    // Coins pro abgestoßener Karte - die Summe steht oben, hier
                    // ist nachvollziehbar, woher sie kommt.
                    (d.target === 'abgestoßen' && d.coins != null
                        ? ' <span class="sbc-opt-dim">+' + coinsText(d.coins) + '</span>' : '') +
                    '</div>';
        }
        if (!html) html = '<div class="sbc-opt-batch-round">Keine Karten gezogen.</div>';
        // Statuszeile als KOPF ueber der Liste statt per setPackStatus()
        // hinterher: beide schreiben dasselbe innerHTML, die Liste war sonst
        // fuer genau einen Frame sichtbar (Nacht-Review 16.08.) - und sie ist
        // der einzige Beleg dafuer, was ein unumkehrbarer Lauf gezogen hat.
        // BILANZ des Abstossens - Rasmus: "am ende eine uebersicht wie viele
        // coins gemacht wurden und welche spieler mit welchen rarities und
        // welchen ratings abgestossen wurde".
        const bil = summarizeDiscarded(drawn);
        if (bil.count) {
            let kopf = '<div class="sbc-opt-batch-round"><b>Abgestoßen: ' + bil.count +
                ' Karte(n) · ' + coinsText(bil.coins) + ' Coins</b>' +
                (bil.unknownCoins
                    ? ' <span class="sbc-opt-batch-warn">(' + bil.unknownCoins +
                      ' ohne lesbaren Wert)</span>' : '') + '</div>';
            for (const g of bil.groups) {
                kopf += '<div class="sbc-opt-batch-round">' +
                    (g.rating != null ? '<b>' + g.rating + '</b> ' : '') +
                    escapeHtml(g.rarity) +
                    ' <span class="sbc-opt-dim">' + g.count + 'x · ' +
                    coinsText(g.coins) + ' Coins</span></div>';
            }
            html = kopf + html;
        }
        if (headerText) {
            html = '<div class="sbc-opt-batch-round"><b>' + escapeHtml(headerText) + '</b></div>' + html;
        }
        ui.packResult.innerHTML = html;
    }
    // ======================================================================
    //  "Alle oeffnen" DIREKT an EAs Pack-Kachel
    // ======================================================================
    // Anker sind bewusst NICHT EAs Klassennamen (die kennen wir nicht und sie
    // aendern sich), sondern zwei Dinge, die im Bild stehen: ein Knopf mit dem
    // Text "Open" und der Pack-NAME in derselben Kachel. Der Name wird gegen
    // unsere geladene Pack-Liste abgeglichen - EXAKT oder als Praefix, NIE
    // unscharf: Packs oeffnen ist unumkehrbar, ein Fehltreffer waere teuer.
    const PACK_BTN_MARK = 'data-sbc-opt-openall';
    const PACK_BTN_TRIES = 'data-sbc-opt-tries';
    /**
     * Alle Texte einer Kachel, die als Pack-Name in Frage kommen.
     * Vorher wurden NUR Blatt-Knoten betrachtet - im Bild bricht der Name aber
     * ueber zwei Zeilen ("10x 85+ Rare Gold\nPlayers Pack"), steckt also
     * womoeglich in einem Element MIT Kindern. Deshalb: bevorzugt Elemente mit
     * "title"/"header" in der Klasse und Ueberschriften, danach kurze Container
     * und Blaetter - alle als Kandidaten, nicht nur einer.
     */
    function packTileTitleCandidates(container) {
        const out = [];
        function add(t) {
            const c = String(t || '').replace(/\s+/g, ' ').trim();
            if (c.length >= 3 && c.length <= 90 && out.indexOf(c) < 0) out.push(c);
        }
        try {
            const pref = container.querySelectorAll(
                '[class*="title"],[class*="Title"],[class*="header"],[class*="name"],h1,h2,h3,h4');
            for (let i = 0; i < pref.length; i++) add(pref[i].textContent);
            const nodes = container.querySelectorAll('span,div,p');
            for (let i = 0; i < nodes.length && out.length < 40; i++) add(nodes[i].textContent);
        } catch (e) {}
        return out;
    }
    // Bleibt fuer die Diagnose: der laengste Kandidat ist meist der Name.
    function packTileTitleOf(container) {
        const cands = packTileTitleCandidates(container);
        let best = '';
        for (const c of cands) if (c.length > best.length) best = c;
        return best;
    }
    /** Pack-Gruppe zu einem Kachel-Titel finden - exakt, sonst Praefix. */
    function matchPackGroupByTitle(title) {
        const t = String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!t) return null;
        const groups = STATE.packGroups || [];
        let exact = null, prefix = null;
        for (const g of groups) {
            const label = String(packLabelOf(g) || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (!label) continue;
            if (label === t) { exact = exact || g; continue; }
            if (t.indexOf(label) === 0 || label.indexOf(t) === 0) prefix = prefix || g;
        }
        return exact || prefix || null;
    }
    /**
     * Neben jeden "Open"-Knopf einen eigenen setzen. Laeuft aus dem 500ms-Takt,
     * ist also idempotent: schon markierte Knoepfe werden uebersprungen, und
     * wenn EA neu rendert, kommt der Knopf von selbst wieder.
     */
    function injectPackTileButtons() {
        const btns = packOpenButtons();
        // Die Diagnose sagt in EINEM Blick, woran es haengt - vorher war
        // "kein Knopf da" nicht von "Titel nicht gelesen" zu unterscheiden.
        const scan = {
            openButtons: btns.length,
            // Tag und Klasse der gefundenen Knoepfe. Ohne das war "zu eng
            // gesucht" nur aus dem Vergleich von Bild und Report ableitbar.
            openForm: btns.slice(0, 4).map(function (b) {
                return String(b.tagName || '?').toLowerCase() + '.' +
                       String(b.className || '').slice(0, 40);
            }),
            packGroups: (STATE.packGroups || []).length,
            titlesSeen: [],
            // Wie viele Knoepfe haben ihre fuenf Anlaeufe verbraucht? Ohne
            // diese Zahl sah der Report aus wie "40 Knoepfe, 0 uebersprungen" -
            // ein Zustand, den es nicht geben kann.
            exhausted: 0,
            // Und wie viele sind schon fertig? Das ist der NORMALFALL im
            // 500ms-Takt. Ohne diese Zahl liest sich "added 0" wie ein
            // Fehlschlag - mir selbst zweimal passiert.
            alreadyDone: 0,
            hops: null,
            added: 0, skipped: 0, reason: null
        };
        if (!btns.length) {
            scan.reason = 'keine Open-Knoepfe im DOM';
            mergePackScan({ tileScan: scan });
            return;
        }
        if (!scan.packGroups) {
            // Ohne geladene Liste gibt es nichts zum Abgleichen. Kein
            // Blindraten: Packs oeffnen ist unumkehrbar.
            scan.reason = 'Pack-Liste noch nicht geladen';
            mergePackScan({ tileScan: scan });
            return;
        }
        try {
            for (let i = 0; i < btns.length; i++) {
                const b = btns[i];
                if (b.getAttribute(PACK_BTN_MARK) === '1') { scan.alreadyDone++; continue; }
                // Fehlversuche zaehlen statt sofort aufzugeben: die Kachel kann
                // ihren Namen spaeter nachliefern. Nach 5 Anlaeufen ist Ruhe.
                const tries = parseInt(b.getAttribute(PACK_BTN_TRIES) || '0', 10);
                if (tries >= 5) {
                    // Der Deckel bleibt (kein Dauerfeuer im 500ms-Takt), aber er
                    // darf nicht die BEOBACHTUNG mitdeckeln: fuer die ersten
                    // drei erschoepften Knoepfe werden die Titel weiter
                    // gesammelt. Nur lesend, kein Klick, kein Request.
                    scan.exhausted++;
                    if (scan.exhausted <= 3) {
                        let pb = b.parentElement, ph = 0;
                        while (pb && ph++ < 8) {
                            for (const c of packTileTitleCandidates(pb)) {
                                if (scan.titlesSeen.length < 12 &&
                                    scan.titlesSeen.indexOf(c) < 0) scan.titlesSeen.push(c);
                            }
                            pb = pb.parentElement;
                        }
                    }
                    continue;
                }
                // Acht Ebenen statt sechs: die verbreiterte Knopf-Erkennung
                // (v4.96.0) findet teils tiefere Elemente (live: span.text), und
                // von dort sind es mehr Schritte bis zur Kachel.
                let box = b.parentElement, group = null, hops = 0, seen = [];
                while (box && hops++ < 8) {
                    const cands = packTileTitleCandidates(box);
                    for (const c of cands) {
                        if (seen.length < 6 && seen.indexOf(c) < 0) seen.push(c);
                        const g = matchPackGroupByTitle(c);
                        if (g) { group = g; break; }
                    }
                    if (group) break;
                    box = box.parentElement;
                }
                if (!group || !box) {
                    b.setAttribute(PACK_BTN_TRIES, String(tries + 1));
                    scan.skipped++;
                    for (const t of seen) {
                        if (scan.titlesSeen.length < 8 && scan.titlesSeen.indexOf(t) < 0) {
                            scan.titlesSeen.push(t);
                        }
                    }
                    continue;
                }
                // ZWEI Knoepfe: was passiert, steht am Pack statt in einem
                // Modus-Schalter woanders. Der Abstossen-Knopf ist rot getoent -
                // die Verwechslung der beiden waere der teuerste Fehlgriff im
                // ganzen Script.
                const own = document.createElement('div');
                own.className = 'sbc-opt-tilebtn-row';
                own.setAttribute('data-sbc-opt-pack', String(group.id));
                for (const spec of PACK_MODES) {
                    const b2 = document.createElement('button');
                    b2.type = 'button';
                    b2.className = 'sbc-opt-tilebtn' +
                        (spec.id === 'abstossen' ? ' danger' : '');
                    b2.textContent = 'Alle ' + group.count + ' (' + spec.tile + ')';
                    b2.title = spec.hint;
                    b2.addEventListener('click', function (ev) {
                        try { ev.stopPropagation(); ev.preventDefault(); } catch (e) {}
                        openAllForPack(String(group.id), null, spec.id);
                    });
                    own.appendChild(b2);
                }
                try {
                    // In die KACHEL, nicht neben den Open-Text: `box` ist das
                    // Element, dessen Titel zum Pack-Namen passt. Vorher wurde
                    // als Geschwister des Textes eingehaengt - und der steckt
                    // bei EA in einem div INNERHALB des Knopfes
                    // (live: div.pack-actions). Der Knopf lag damit ueber dem
                    // normalen Open-Knopf.
                    box.appendChild(own);
                    b.setAttribute(PACK_BTN_MARK, '1');   // NUR bei Erfolg endgueltig
                    scan.added++;
                    // Wie weit war es bis zur Kachel? Sagt beim naechsten
                    // EA-Umbau, ob der Deckel von 8 noch reicht.
                    if (scan.hops == null || hops > scan.hops) scan.hops = hops;
                } catch (e) {
                    b.setAttribute(PACK_BTN_TRIES, String(tries + 1));
                    scan.skipped++;
                }
            }
        } catch (e) {
            scan.reason = 'Fehler: ' + (e && e.message || e);
        }
        if (!scan.added && !scan.reason) {
            // Drei Faelle auseinanderhalten. "added 0" allein sagt nichts: im
            // 500ms-Takt ist "schon alles eingebaut" der Normalfall, und genau
            // den habe ich zweimal als Fehlschlag gelesen.
            scan.reason = (scan.alreadyDone && !scan.skipped && !scan.exhausted)
                ? ('nichts zu tun - alle ' + scan.alreadyDone +
                   ' Knoepfe sind bereits eingebaut')
                : (scan.exhausted
                    ? ('kein Kachel-Titel passte (' + scan.exhausted +
                       ' Knoepfe haben ihre Anlaeufe verbraucht - titlesSeen zeigt, ' +
                       'was in der Kachel steht)')
                    : 'kein Kachel-Titel passte zu einem Pack-Namen');
        }
        mergePackScan({ tileScan: scan });
    }
    async function onPackRefreshClick() {
        if (STATE.packOpenBusy) return;
        ui.packRefresh.disabled = true;
        setPackStatus('lade Packs...');
        try {
            const groups = await fetchMyPacks();
            renderPackTypeOptions();
            setPackStatus(groups.length + ' eigene Pack-Typen gefunden.');
        } catch (e) {
            reportError('Pack-Enumeration fehlgeschlagen', e);
            setPackStatus('Fehler: ' + (e.message || e));
            toast('Packs laden fehlgeschlagen: ' + (e.message || e), 'error');
        } finally {
            ui.packRefresh.disabled = false;
        }
    }
    /**
     * Testlauf: Unassigned-Guard -> open() auf EINER Instanz -> success-Check
     * -> einsammeln -> verteilen (mit Takt). JEDER Fehler/success:false bricht
     * sofort ab, KEIN Retry (Abbruch-Disziplin) - Pack-Oeffnen ist
     * unumkehrbar, ein zweiter Versuch nach einem unklaren Fehler waere ein
     * zweites unkontrolliertes Risiko.
     */
    async function runPackTestOpen(groupId, mode) {
        const g = resolvePackGlobals();
        if (!g.ok) {
            reportError('Pack-Testlauf: fehlende Globals', new Error(g.missing.join(', ')));
            mergePackScan({ missingGlobals: g.missing });
            return { ok: false, reason: 'Store-Schnittstellen fehlen (' + g.missing.join(', ') + ').' };
        }
        mergePackScan({ missingGlobals: g.optionalMissing || [], errorForm: null, lastRun: null });
        let unassignedBefore;
        try { unassignedBefore = g.repoItem.numItemsInCache(g.ItemPile.PURCHASED); }
        catch (e) {
            reportError('Pack-Testlauf: numItemsInCache fehlgeschlagen', e);
            mergePackScan({ errorForm: { step: 'unassignedGuard', message: String(e && e.message || e) } });
            return { ok: false, reason: 'Unassigned-Bestand konnte nicht geprüft werden.' };
        }
        mergePackScan({ unassignedCountBefore: unassignedBefore });
        if (!unassignedGuardOk(unassignedBefore)) {
            return { ok: false, reason: 'Erst die ungeöffneten Karten (Unassigned: ' + unassignedBefore + ') im Spiel wegräumen.' };
        }
        const entities = (STATE.packEntitiesById && STATE.packEntitiesById.get(String(groupId))) || [];
        if (!entities.length) return { ok: false, reason: 'Pack-Typ nicht (mehr) gefunden - erst aktualisieren.' };
        const entity = entities[0];
        const packCountBefore = entities.length;
        let openResp;
        try { openResp = await obsPromise(entity.open()); }
        catch (e) {
            reportError('Pack-Testlauf: open() fehlgeschlagen', e);
            mergePackScan({ errorForm: { step: 'open', message: String(e && e.message || e) } });
            return { ok: false, reason: 'Öffnen fehlgeschlagen: ' + (e.message || e) };
        }
        if (!responseOk(openResp)) {
            mergePackScan({ errorForm: { step: 'open', status: openResp && openResp.status,
                keys: openResp ? Object.keys(openResp) : [] } });
            return { ok: false, reason: 'Öffnen abgelehnt (Status ' + (openResp && openResp.status) + ').' };
        }
        // Zaehlt ab hier - open() ist die unumkehrbare Aktion, unabhaengig
        // davon, ob das Einsammeln/Verteilen danach noch scheitert (der Pack-
        // Verbrauch ist so oder so bereits passiert).
        mergePackScan({ runsCount: ((STATE.diag.packScan && STATE.diag.packScan.runsCount) || 0) + 1 });
        try { g.repoItem.setDirty(g.ItemPile.PURCHASED); }
        catch (e) { reportError('Pack-Testlauf: setDirty fehlgeschlagen', e); }
        let itemsResp;
        try { itemsResp = await obsPromise(g.item.requestUnassignedItems()); }
        catch (e) {
            reportError('Pack-Testlauf: requestUnassignedItems fehlgeschlagen', e);
            mergePackScan({ errorForm: { step: 'collect', message: String(e && e.message || e) } });
            return { ok: false, reason: 'Karten einsammeln fehlgeschlagen: ' + (e.message || e) + ' Karten bleiben unassigned.' };
        }
        // Ein AUFGELOESTES {success:false} ist kein Throw - ohne diesen Check
        // wuerde responseItems() auf dem abgelehnten Payload einfach [] liefern
        // und der Lauf faelschlich als "0 Karten gezogen" statt als Ablehnung
        // durchgehen (Validator-Fund).
        if (!responseOk(itemsResp)) {
            reportError('Pack-Testlauf: requestUnassignedItems abgelehnt', new Error('Status ' + (itemsResp && itemsResp.status)));
            mergePackScan({ errorForm: { step: 'collect', status: itemsResp && itemsResp.status,
                keys: itemsResp ? Object.keys(itemsResp) : [] } });
            return { ok: false, reason: 'Karten einsammeln abgelehnt (Status ' + (itemsResp && itemsResp.status) + '). Karten bleiben unassigned.' };
        }
        const items = responseItems(itemsResp);
        let storageBefore;
        try {
            const storageResp = await obsPromise(g.item.searchStorageItems(new g.SearchCriteria()));
            if (!responseOk(storageResp)) {
                reportError('Pack-Testlauf: searchStorageItems abgelehnt', new Error('Status ' + (storageResp && storageResp.status)));
                mergePackScan({ errorForm: { step: 'storageCount', status: storageResp && storageResp.status,
                    keys: storageResp ? Object.keys(storageResp) : [] } });
                return { ok: false, reason: 'Storage-Stand abgelehnt (Status ' + (storageResp && storageResp.status) + '). Karten bleiben unassigned.' };
            }
            storageBefore = responseItems(storageResp).length;
        } catch (e) {
            reportError('Pack-Testlauf: searchStorageItems fehlgeschlagen', e);
            mergePackScan({ errorForm: { step: 'storageCount', message: String(e && e.message || e) } });
            return { ok: false, reason: 'Storage-Stand konnte nicht geprüft werden: ' + (e.message || e) + ' Karten bleiben unassigned.' };
        }
        mergePackScan({ storageCountBefore: storageBefore });
        // ---------------------------------------------------------------
        //  ABSTOSSEN: erst die GANZE Liste beurteilen, dann handeln
        // ---------------------------------------------------------------
        const wantDiscard = (mode === 'abstossen');
        let discardPlan = null;
        if (wantDiscard) {
            if (!g.discard) {
                mergePackScan({ errorForm: { step: 'discard',
                    message: 'keine Verwerf-Methode gefunden', itemMethods: g.itemMethods } });
                return { ok: false, reason: 'EA-Methode zum Abstoßen nicht gefunden - ' +
                    'bitte Diagnose schicken (packScan.errorForm.itemMethods). Die Karten ' +
                    'dieses Packs liegen unassigned.' };
            }
            const locks = {};
            try {
                for (const id of readPaletoolsLocks()) locks[String(id)] = true;
            } catch (e) { reportError('Abstoßen: Schloss-Liste nicht lesbar', e); }
            discardPlan = decidePackDiscard(items, {
                describe: function (it) {
                    return describePackItem(it, { normalize: normalizePlayer, repoItem: g.repoItem });
                },
                isMisc: function (it) { return isMiscPackItem(it, g.GameCurrency); },
                lockedIds: locks
            });
            mergePackScan({ lastDiscard: {
                toDiscard: discardPlan.toDiscard.length,
                toKeep: discardPlan.toKeep.length,
                toMisc: discardPlan.toMisc.length,
                stoppers: discardPlan.stoppers.slice(0, 6),
                via: g.discard.name
            } });
            if (discardPlan.stoppers.length) {
                // KEINE Karte angefasst. Genau so wollte Rasmus es: "bei special
                // karten einfach stoppen, denn bei special karten moechte ich
                // selbst entscheiden, ob die weggeworfen werden oder nicht."
                return { ok: false, stopped: true, drawn: [],
                         reason: discardStopReason(discardPlan.stoppers) };
            }
        }
        // Verteilt wird nur, was NICHT verworfen wird. Beim Einsortieren ist
        // das die ganze Liste - dann ist dieser Ausdruck items selbst.
        const toDistribute = wantDiscard
            ? discardPlan.toKeep.concat(discardPlan.toMisc) : items;
        const decision = decidePackDistribution(toDistribute, storageBefore, PACK_STORAGE_CAPACITY_ASSUMED, g.GameCurrency);
        for (const it of decision.toMisc) {
            await sleep(packTakt());
            let redeemResp;
            try { redeemResp = await obsPromise(g.item.redeem(it)); }
            catch (e) {
                reportError('Pack-Testlauf: redeem() fehlgeschlagen', e);
                mergePackScan({ errorForm: { step: 'redeem', message: String(e && e.message || e) } });
                return { ok: false, reason: 'Einlösen (Misc/Währung) fehlgeschlagen: ' + (e.message || e) + ' Rest bleibt unassigned.' };
            }
            // Konsistent mit dem eigenen Versprechen "JEDER Fehler bricht ab" -
            // vorher lief die Schleife nach einer Ablehnung einfach weiter.
            if (!responseOk(redeemResp)) {
                reportError('Pack-Testlauf: redeem() abgelehnt', new Error('Status ' + (redeemResp && redeemResp.status)));
                mergePackScan({ errorForm: { step: 'redeem', status: redeemResp && redeemResp.status,
                    keys: redeemResp ? Object.keys(redeemResp) : [] } });
                return { ok: false, reason: 'Einlösen (Misc/Währung) abgelehnt (Status ' + (redeemResp && redeemResp.status) + '). Rest bleibt unassigned.' };
            }
        }
        if (decision.toClub.length) {
            await sleep(packTakt());
            let clubResp;
            try { clubResp = await obsPromise(g.item.move(decision.toClub, g.ItemPile.CLUB)); }
            catch (e) {
                reportError('Pack-Testlauf: move->CLUB fehlgeschlagen', e);
                mergePackScan({ errorForm: { step: 'moveClub', message: String(e && e.message || e) } });
                return { ok: false, reason: 'Verteilen in den Verein fehlgeschlagen: ' + (e.message || e) + ' Karten bleiben unassigned.' };
            }
            if (!responseOk(clubResp)) {
                reportError('Pack-Testlauf: move->CLUB abgelehnt', new Error('Status ' + (clubResp && clubResp.status)));
                mergePackScan({ errorForm: { step: 'moveClub', status: clubResp && clubResp.status,
                    keys: clubResp ? Object.keys(clubResp) : [] } });
                return { ok: false, reason: 'Verteilen in den Verein abgelehnt (Status ' + (clubResp && clubResp.status) + '). Karten bleiben unassigned.' };
            }
        }
        if (decision.toStorage.length) {
            await sleep(packTakt());
            let storageMoveResp;
            try { storageMoveResp = await obsPromise(g.item.move(decision.toStorage, g.ItemPile.STORAGE)); }
            catch (e) {
                reportError('Pack-Testlauf: move->STORAGE fehlgeschlagen', e);
                mergePackScan({ errorForm: { step: 'moveStorage', message: String(e && e.message || e) } });
                return { ok: false, reason: 'Verteilen in den Storage fehlgeschlagen: ' + (e.message || e) + ' Karten bleiben unassigned.' };
            }
            if (!responseOk(storageMoveResp)) {
                reportError('Pack-Testlauf: move->STORAGE abgelehnt', new Error('Status ' + (storageMoveResp && storageMoveResp.status)));
                mergePackScan({ errorForm: { step: 'moveStorage', status: storageMoveResp && storageMoveResp.status,
                    keys: storageMoveResp ? Object.keys(storageMoveResp) : [] } });
                return { ok: false, reason: 'Verteilen in den Storage abgelehnt (Status ' + (storageMoveResp && storageMoveResp.status) + '). Karten bleiben unassigned.' };
            }
        }
        // JETZT verwerten - nach dem Einsortieren der Behalten-Karten, damit ein
        // Fehlschlag beim Einsortieren nichts verworfen hat.
        let discardedCount = 0;
        if (wantDiscard && discardPlan.toDiscard.length) {
            // EINZELN, mit Takt: so steht im Fehlerfall fest, wie viele
            // wirklich weg sind. Ein Sammelaufruf, der auf halber Strecke
            // abgelehnt wird, laesst genau das offen.
            for (const it of discardPlan.toDiscard) {
                await sleep(packTakt());
                let dResp;
                try { dResp = await obsPromise(g.discard.fn([it])); }
                catch (e) {
                    reportError('Abstoßen: ' + g.discard.name + '() fehlgeschlagen', e);
                    mergePackScan({ errorForm: { step: 'discard', via: g.discard.name,
                        message: String(e && e.message || e), done: discardedCount } });
                    return { ok: false, reason: 'Abstoßen fehlgeschlagen nach ' +
                        discardedCount + ' Karte(n): ' + (e.message || e) +
                        ' Der Rest liegt unassigned.' };
                }
                if (!responseOk(dResp)) {
                    reportError('Abstoßen: ' + g.discard.name + '() abgelehnt',
                        new Error('Status ' + (dResp && dResp.status)));
                    mergePackScan({ errorForm: { step: 'discard', via: g.discard.name,
                        status: dResp && dResp.status, done: discardedCount,
                        keys: dResp ? Object.keys(dResp) : [] } });
                    return { ok: false, reason: 'Abstoßen abgelehnt (Status ' +
                        (dResp && dResp.status) + ') nach ' + discardedCount +
                        ' Karte(n). Der Rest liegt unassigned.' };
                }
                discardedCount++;
            }
            mergePackScan({ lastDiscard: Object.assign(
                {}, (STATE.diag.packScan || {}).lastDiscard, { discarded: discardedCount }) });
        }
        let storageAfter = null;
        try {
            const afterResp = await obsPromise(g.item.searchStorageItems(new g.SearchCriteria()));
            // Rein beobachtend: die Verteilung ist an dieser Stelle bereits
            // abgeschlossen, ein Abbruch wuerde einen tatsaechlich erfolgreichen
            // Lauf faelschlich als Fehlschlag melden. Trotzdem KEIN Blindflug bei
            // Ablehnung: storageAfter bleibt null statt aus einem abgelehnten
            // Payload eine falsche Zahl abzuleiten (dasselbe Validator-Argument,
            // nur ohne Abbruch der bereits erledigten Verteilung).
            if (responseOk(afterResp)) storageAfter = responseItems(afterResp).length;
            else reportError('Pack-Testlauf: Storage-Nachzählung abgelehnt', new Error('Status ' + (afterResp && afterResp.status)));
        } catch (e) { reportError('Pack-Testlauf: Storage-Nachzählung fehlgeschlagen', e); }
        mergePackScan({ storageCountAfter: storageAfter });
        // Beantwortet Mechanik-Frage (a): sinkt die Anzahl gleicher Instanzen
        // um genau 1?
        let packCountAfterSameGroup = null;
        try {
            const afterPacks = responsePacks(await obsPromise(g.store.getPacks()));
            packCountAfterSameGroup = groupMyPacks(afterPacks)
                .filter(function (x) { return String(x.id) === String(groupId); })
                .reduce(function (n, x) { return n + x.count; }, 0);
        } catch (e) { reportError('Pack-Testlauf: Pack-Nachzählung fehlgeschlagen', e); }
        const drawn = items.map(function (it) {
            // Die Verteilung (move()/redeem()) ist an dieser Stelle bereits
            // abgeschlossen - ein unlesbares Item darf die Zieh-Listen-
            // Aufbereitung nicht mehr als Throw beenden (Validator-Fund):
            // sonst wuerde runPackOpenAll() einen tatsaechlich erfolgreichen
            // Pack-Zyklus als Fehler werten und die Serie unnoetig stoppen.
            try {
                const misc = isMiscPackItem(it, g.GameCurrency);
                // Entity-Kette statt nur normalizePlayer(): bei Pack-Items
                // stand vorher "#920367683733" ohne Rating in der Liste
                // (Live-Befund 16.08.) - der Name liegt in den Stammdaten.
                const d = misc ? null : describePackItem(it,
                    { normalize: normalizePlayer, repoItem: g.repoItem });
                // Nur teilweise lesbar: die Zeile bleibt (mit ID-Fallback),
                // der Grund geht trotzdem in den Report - sonst waere ein
                // stiller Namens-Ausfall nicht mehr diagnostizierbar.
                if (d && d.readError) {
                    reportError('Pack-Testlauf: Karte nur teilweise lesbar', new Error(d.readError));
                }
                let isDupRaw = null;
                try { isDupRaw = typeof it.isDuplicate === 'function' ? it.isDuplicate() : it.isDuplicate; } catch (e) {}
                return {
                    misc: misc,
                    name: d ? d.name : 'Misc/Währung',
                    rating: d ? d.rating : null,
                    rarity: d ? d.rarity : null,
                    // EAs Schnellverkaufswert. HIER, nicht nur in
                    // decidePackDiscard().rows: die Bilanz und die Anzeige
                    // lesen DIESE Liste. Live (Report v5.2.0) waren 12 Karten
                    // abgestossen und die Bilanz nannte 0 Coins - der Wert war
                    // in der falschen Liste.
                    coins: d ? d.discardValue : null,
                    isDuplicateRaw: isDupRaw,
                    target: misc ? 'redeem'
                        : (wantDiscard && discardPlan.toDiscard.indexOf(it) > -1 ? 'abgestoßen'
                        : (decision.toStorage.indexOf(it) > -1 ? 'Storage'
                        : (decision.leftover.indexOf(it) > -1 ? 'liegen geblieben (Storage voll)'
                        : 'Verein')))
                };
            } catch (e) {
                reportError('Pack-Testlauf: Zieh-Listen-Eintrag nicht lesbar', e);
                return { id: it && (it.assetId || it.id), error: String(e && e.message || e) };
            }
        });
        mergePackScan({
            lastRun: {
                itemCount: items.length,
                items: drawn,
                // Feld-Aufnahme des ERSTEN Items: zeigt im naechsten Report,
                // ob Entity oder DTO und wie die Felder wirklich heissen -
                // die Grundlage, falls ein Name weiterhin fehlt.
                itemShape: sampleObjectShape(items[0]),
                namesResolved: drawn.filter(function (d) { return d.name && !/^#/.test(d.name); }).length,
                openResponseKeys: openResp ? Object.keys(openResp) : [],
                packCountBefore: packCountBefore,
                packCountAfterSameGroup: packCountAfterSameGroup
            }
        });
        return { ok: true, drawn: drawn, discarded: discardedCount,
                 storageBefore: storageBefore, storageAfter: storageAfter };
    }
    /**
     * "Alle öffnen" (Stufe 2, Ticket #76): ruft runPackTestOpen() wiederholt
     * für denselben Pack-Typ - EIN Stufe-1-Ablauf pro Iteration, keine zweite
     * Kopie der Abbruch-Disziplin (SSOT). Stoppt beim ERSTEN Fehlschlag jeder
     * Art - die Stufe-1-Mechanik ist stub-getestet, aber noch NICHT live
     * verifiziert; im schlimmsten Fall degradiert der Lauf so zu einem
     * Einzel-Pack-Test mit klarer Fehlermeldung, bereits geöffnete Packs sind
     * sicher verteilt. Ein liegen gebliebenes Duplikat (Storage voll) stoppt
     * proaktiv mit einer konkreten Meldung, statt den generischen
     * Unassigned-Guard des nächsten Packs die Sache melden zu lassen.
     * Zwischen erfolgreichen Packs wird die Pack-Liste per fetchMyPacks() neu
     * geladen statt eine client-seitige Entity-Referenz weiterzuzählen - die
     * open()-Instanz-Semantik bei mehreren Einträgen derselben id ist eine
     * der vier noch offenen Mechanik-Fragen (LEARNINGS §46), ein frischer
     * EA-Stand umgeht die Unsicherheit statt sie zu erraten. Ein Throw AUS
     * der Schleife (z.B. aus runPackTestOpen()) landet im selben stopWith()-
     * Pfad wie ein reguläres ok:false - opened/total/lastAllRun bleiben
     * beobachtbar, und die bereits verteilten Packs bleiben in der
     * Zieh-Liste sichtbar statt in einem unbehandelten Reject zu verschwinden.
     */
    async function runPackOpenAll(groupId, requestedCount, onProgress, mode) {
        const initialGroup = (STATE.packGroups || []).find(function (g) { return String(g.id) === String(groupId); });
        const available = initialGroup ? initialGroup.count : 0;
        const total = Math.max(0, Math.min(requestedCount == null ? available : requestedCount, available));
        const drawn = [];
        let opened = 0;
        function stopWith(reason) {
            const message = opened + ' von ' + total + ' geöffnet - gestoppt: ' + reason;
            mergePackScan({ lastAllRun: { requested: requestedCount, total: total, opened: opened, ok: false, reason: reason } });
            return { ok: false, opened: opened, total: total, reason: reason, message: message, drawn: drawn };
        }
        // currentPack lebt AUSSERHALB der Schleife, damit der Catch-Block
        // (der die Schleife selbst verlassen hat) noch weiss, an welchem
        // Pack der Throw passierte (Validator-Fund: ein Throw aus
        // runPackTestOpen() - z.B. eine kuenftig doch ungeschuetzte Stelle -
        // durfte die Serie sonst unbeobachtet verlassen: kein lastAllRun-
        // Stand, keine Zieh-Liste der bereits verteilten Packs).
        let currentPack = 0;
        try {
            for (let i = 0; i < total; i++) {
                currentPack = i + 1;
                if (onProgress) onProgress(i + 1, total, 'öffne Pack ' + (i + 1) + ' von ' + total + '...');
                const res = await runPackTestOpen(groupId, mode);
                if (!res.ok) return stopWith(res.reason);
                opened++;
                Array.prototype.push.apply(drawn, res.drawn);
                const stuck = res.drawn.some(function (d) { return /liegen geblieben/.test(d.target); });
                if (stuck) {
                    return stopWith('Storage voll — Rest-Karten liegen unassigned.');
                }
                if (i + 1 < total) {
                    await sleep(packBetweenTakt());
                    try { await fetchMyPacks(); }
                    catch (e) {
                        return stopWith('Pack-Liste nach Runde ' + opened + ' konnte nicht aktualisiert werden: ' + (e.message || e) + '.');
                    }
                    const freshGroup = (STATE.packGroups || []).find(function (g) { return String(g.id) === String(groupId); });
                    if (!freshGroup || freshGroup.count < 1) {
                        return stopWith('Keine weiteren Packs dieses Typs mehr verfügbar.');
                    }
                }
            }
        } catch (e) {
            reportError('Pack-Alle-Öffnen: Abbruch bei Pack ' + currentPack, e);
            return stopWith('Unerwarteter Fehler bei Pack ' + currentPack + ': ' + (e && e.message || e) + '.');
        }
        const message = opened + ' von ' + total + ' Pack(s) geöffnet und ' +
            (mode === 'verwerten' ? 'abgestoßen' : 'verteilt') + '.';
        mergePackScan({ lastAllRun: { requested: requestedCount, total: total, opened: opened, ok: true, reason: null } });
        return { ok: true, opened: opened, total: total, message: message, drawn: drawn };
    }
    async function onPackAllClick() {
        if (STATE.packOpenBusy) return;
        const groupId = ui.packType && ui.packType.value;
        if (!groupId) { toast('Erst einen Pack-Typ wählen (Aktualisieren drücken).', 'error'); return; }
        const raw = ui.packCount && ui.packCount.value;
        const requestedCount = (raw === '' || raw == null) ? null : parseInt(raw, 10);
        if (requestedCount != null && (!Number.isFinite(requestedCount) || requestedCount < 1)) {
            toast('Ungültige Anzahl.', 'error');
            return;
        }
        await openAllForPack(groupId, requestedCount);
    }
    /**
     * Alle (oder N) Packs eines Typs oeffnen. EINE Routine fuer den
     * Panel-Knopf UND den Knopf an EAs Kachel - zwei Pfade wuerden
     * auseinanderlaufen, und dieser hier ist unumkehrbar.
     * requestedCount == null heisst "alle vorhandenen".
     */
    async function openAllForPack(groupId, requestedCount, modeArg) {
        if (STATE.packOpenBusy) return;
        const group = (STATE.packGroups || []).find(function (g) { return String(g.id) === String(groupId); });
        const available = group ? group.count : 0;
        const plannedTotal = Math.max(0, Math.min(requestedCount == null ? available : requestedCount, available));
        if (plannedTotal < 1) { toast('Keine Packs dieses Typs zum Öffnen verfügbar.', 'error'); return; }
        const packLabel = group ? packLabelOf(group) : ('Pack ' + groupId);
        // Der Kachel-Knopf sagt seinen Modus selbst; der Panel-Knopf nimmt den
        // Schalter. So steht am Pack, was passiert, ohne dass irgendwo anders
        // eine Einstellung mitgelesen werden muss.
        const mode = modeArg || packMode();
        // Die Rueckfrage muss den MODUS nennen. Verwerten ist unumkehrbar und
        // war im Panel eine Segment-Wahl - wer sie nicht bemerkt hat, soll sie
        // hier lesen.
        const frage = (mode === 'verwerten')
            ? (packLabel + ': ' + plannedTotal + ' Pack(s) werden nacheinander geöffnet ' +
               'und die normalen Karten ABGESTOSSEN (unwiderruflich weg, gibt Coins).\n\n' +
               'Special-Karten stoppen den Lauf, BEVOR etwas abgestoßen wird - dann ' +
               'entscheidest du im Spiel selbst. Unverkäufliche Karten werden nicht ' +
               'abgestoßen, sondern einsortiert (SBC-Material).\n\nFortfahren?')
            : (packLabel + ': ' + plannedTotal + ' Pack(s) werden nacheinander geöffnet.\n\n' +
               'Stoppt beim ersten Fehler; bereits geöffnete Packs sind dann schon verteilt. Fortfahren?');
        if (!window.confirm(frage)) return;
        STATE.packOpenBusy = true;
        setPackButtonsDisabled(true);
        setPackStatus('öffne ' + plannedTotal + ' Pack(s)...');
        try {
            const res = await runPackOpenAll(groupId, requestedCount, function (cur, cnt, step) {
                showProgress(cur, cnt, step, '', 'Pack');
            }, mode);
            renderPackDrawList(res.drawn, res.message);
            if (!res.ok) {
                finishProgress(res.message, false);
                toast('Alle öffnen gestoppt: ' + res.message, 'error');
            } else {
                finishProgress(res.message, true);
                toast(res.message, 'ok');
            }
            try {
                await fetchMyPacks();
                renderPackTypeOptions();
                // Kachel-Knoepfe neu aufbauen: die Anzahl hat sich geaendert,
                // ein Knopf mit alter Zahl waere irrefuehrend.
                try {
                    const stale = document.querySelectorAll('.sbc-opt-tilebtn-row');
                    for (let k = 0; k < stale.length; k++) {
                        const b = stale[k];
                        if (b.parentElement) b.parentElement.removeChild(b);
                    }
                    const marked = document.querySelectorAll(
                        '[' + PACK_BTN_MARK + '],[' + PACK_BTN_TRIES + ']');
                    for (let k = 0; k < marked.length; k++) {
                        marked[k].removeAttribute(PACK_BTN_MARK);
                        marked[k].removeAttribute(PACK_BTN_TRIES);
                    }
                } catch (e2) {}
                injectPackTileButtons();
            } catch (e) {}
            // Die gezogenen Spieler stehen im Panel - vom Store aus ist das
            // sonst unsichtbar, und genau die wollte Rasmus sehen.
            try { if (ui.panel) ui.panel.classList.add('open'); } catch (e) {}
        } catch (e) {
            reportError('Pack-Alle-Öffnen: unerwarteter Fehler', e);
            setPackStatus('Fehler: ' + (e.message || e));
            toast('Alle öffnen fehlgeschlagen: ' + (e.message || e), 'error');
        } finally {
            STATE.packOpenBusy = false;
            setPackButtonsDisabled(false);
        }
    }
    /**
     * Panel-Knoepfe UND die Knoepfe an EAs Kacheln sperren. Wichtig beim
     * Aufruf von der Kachel: sonst koennte man daneben ein zweites Mal
     * tippen, waehrend der erste Lauf noch oeffnet.
     */
    function setPackButtonsDisabled(off) {
        for (const b of [ui.packAll, ui.packRefresh]) {
            if (b) b.disabled = !!off;
        }
        try {
            const own = document.querySelectorAll('.sbc-opt-tilebtn');
            for (let i = 0; i < own.length; i++) own[i].disabled = !!off;
        } catch (e) {}
        // Die Reihe selbst gedaempft, damit auch sichtbar ist, dass gerade
        // nichts geht.
        try {
            const rows = document.querySelectorAll('.sbc-opt-tilebtn-row');
            for (let i = 0; i < rows.length; i++) {
                rows[i].style.opacity = off ? '.5' : '';
            }
        } catch (e) {}
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
        noteScriptRun();
        injectStyles();
        buildPanel();
        installLauncherDelegation();
        // Rarity-Einstellungen aus localStorage herstellen. Sie MUESSEN ein
        // Neuladen ueberleben: die Seite entsteht bei jedem Login neu, und ein
        // Schutz-Modus, der dabei auf den Default zurueckfaellt, verbaut still
        // die falschen Karten.
        try {
            const RM = [['raritymode', 'sbcOptRarityMode'],
                        ['rarityguard', 'sbcOptRarityGuard'],
                        ['totwsoft', 'sbcOptTotwSoft'],
                        ['specialsoft', 'sbcOptSpecialSoft']];
            for (const [key, lsKey] of RM) {
                const el = ui[key];
                if (!el) continue;
                try {
                    const saved = localStorage.getItem(lsKey);
                    if (saved != null) el.value = saved;
                } catch (e) {}
                el.addEventListener('change', function () {
                    try { localStorage.setItem(lsKey, el.value); } catch (e) {}
                });
            }
        } catch (e) { reportError('Rarity-Einstellungen', e); }
        try {
            if (ui.poolCacheBox) {
                ui.poolCacheBox.checked = poolCacheEnabled();
                ui.poolCacheBox.addEventListener('change', function () {
                    // In localStorage, nicht nur im DOM: der Schalter muss ein
                    // Neuladen der Seite ueberleben - das ist der Fall, um den
                    // es beim Cache ueberhaupt geht.
                    try {
                        localStorage.setItem(POOL_CACHE_TOGGLE,
                            ui.poolCacheBox.checked ? '1' : '0');
                    } catch (e) {}
                    if (!ui.poolCacheBox.checked) dropPoolCache('im Panel abgeschaltet');
                });
            }
        } catch (e) { reportError('Pool-Cache-Schalter', e); }
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
        setInterval(function () {
            try { syncLauncher(); syncPackSection(); syncQueueSection(); } catch (e) {}
        }, 500);
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
        // Der Team-Dump gehoert in den Diagnose-Report: bei einem 460 war live
        // nicht zu sehen, WELCHE Karten der Solver geliefert hat.
        try {
            STATE.diag.lastTeam = {
                ok: !!res.ok,
                reason: res.ok ? null : res.reason,
                cards: res.teamDump || null,
                // Beobachtbarkeit fuer den reserve()-Funnel (Anker/Rarity-Pick/
                // Vorgaben): Anzahl distinkter Spieler (assetId), die ueber
                // reserve() reserviert wurden - siehe SolverCore reserve().
                usedAssetsCount: res.usedAssetsCount != null ? res.usedAssetsCount : null
            };
        } catch (e) {}
        return res;
    };
    // Debug-Zugriff für die Konsole
    try { window.__SBC_OPT = { STATE: STATE, Solver: SolverCore, diag: buildDiagReport }; } catch (e) {}
    waitForBody();
})();
