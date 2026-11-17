// ==UserScript==
// @name         PitTools Bridge
// @namespace    https://github.com/sbc-optimizer
// @version      1.2.0
// @description  CORS-Bruecke fuer PitTools: holt Seiten von futbin.com (SBC-Loesungen) und fut.gg (FUT Gallery). Ohne dieses Script fehlen im Browser Futbin-Loesungssuche und Galerie - in der PitTools-App uebernimmt die App selbst.
// @author       Rasmus Risse
// @copyright    2026 Rasmus Risse
// @license      PolyForm-Noncommercial-1.0.0; https://polyformproject.org/licenses/noncommercial/1.0.0
// @match        https://www.ea.com/*/ultimate-team/web-app/*
// @match        https://www.ea.com/ultimate-team/web-app/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      futbin.com
// @connect      www.futbin.com
// @connect      fut.gg
// @connect      www.fut.gg
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/Rasmus33/pittools/main/pittools-bridge.user.js
// @downloadURL  https://raw.githubusercontent.com/Rasmus33/pittools/main/pittools-bridge.user.js
// ==/UserScript==
// Warum ein ZWEITES Script: der Optimizer laeuft mit "@grant none" im echten
// Seitenkontext (er muss window.fetch/XHR der EA-App abfangen und
// window.services benutzen). Mit einem Grant wuerde Tampermonkey ihn in die
// Sandbox stecken - die Interception waere tot. Also bleibt der Optimizer wie
// er ist, und DIESES Script tut nur eines: Seiten von futbin.com holen, die
// die EA-Seite wegen CORS nicht selbst lesen darf. Verstaendigung ueber
// DOM-Events (die kreuzen die Sandbox-Grenze), Nutzdaten als JSON-String.
// In der App gibt es dasselbe Protokoll nativ (PitBridgeNative, App >= 1.11.0).
(function () {
    'use strict';
    // 1.1.0: fut.gg dazu (FUT Gallery, v5.32.0).
    const ALLOW = /^https:\/\/(www\.)?(futbin\.com|fut\.gg)\//;
    function reply(o) {
        try {
            document.dispatchEvent(new CustomEvent('pittools-bridge-done', { detail: JSON.stringify(o) }));
        } catch (e) {}
    }
    try { document.documentElement.setAttribute('data-pittools-bridge', 'tm'); } catch (e) {}
    document.addEventListener('pittools-bridge-fetch', function (ev) {
        let req = null;
        try { req = JSON.parse(ev.detail); } catch (e) { return; }
        if (!req || req.id == null) return;
        const url = String(req.url || '');
        if (!ALLOW.test(url)) { reply({ id: req.id, status: 0, error: 'Host nicht erlaubt: ' + url.slice(0, 60) }); return; }
        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: { 'Accept': 'text/html,*/*' },
                timeout: 25000,
                onload: function (r) { reply({ id: req.id, status: r.status, text: r.responseText || '' }); },
                onerror: function () { reply({ id: req.id, status: 0, error: 'Netzwerkfehler' }); },
                ontimeout: function () { reply({ id: req.id, status: 0, error: 'Zeitueberschreitung' }); }
            });
        } catch (e) {
            reply({ id: req.id, status: 0, error: 'GM_xmlhttpRequest: ' + (e && e.message || e) });
        }
    });
    // 1.2.0: KI-Verbindung (MCP). Nur wenn PitTools sie einschaltet
    // ('pittools-mcp-enable'), fragt die Bridge den lokalen PitTools-MCP-Server
    // auf 127.0.0.1 nach Auftraegen (Long-Poll), reicht sie als
    // 'pittools-mcp-call' an PitTools weiter und schickt die Antwort
    // ('pittools-mcp-result') zurueck. Kein anderer Host, kein Auftrag ohne
    // eingeschalteten Schalter.
    const mcp = { on: false, port: 47811, running: false, fails: 0 };
    function mcpStatus(state, extra) {
        try { document.dispatchEvent(new CustomEvent('pittools-mcp-status', { detail: JSON.stringify(Object.assign({ state: state, bridge: '1.2.0' }, extra || {})) })); } catch (e) {}
    }
    function mcpReq(method, path, body, timeout) {
        return new Promise(function (resolve) {
            try {
                GM_xmlhttpRequest({
                    method: method, url: 'http://127.0.0.1:' + mcp.port + path, timeout: timeout,
                    headers: { 'X-PitTools-Bridge': '1', 'Content-Type': 'application/json' },
                    data: body ? JSON.stringify(body) : undefined,
                    onload: function (r) { resolve({ status: r.status, text: r.responseText || '' }); },
                    onerror: function () { resolve({ status: 0 }); },
                    ontimeout: function () { resolve({ status: -1 }); }
                });
            } catch (e) { resolve({ status: 0 }); }
        });
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    async function mcpLoop() {
        if (mcp.running) return;
        mcp.running = true;
        while (mcp.on) {
            // Erst ein schneller Ping: die Statuszeile soll sofort "verbunden" oder
            // "kein Server" zeigen, nicht erst nach dem ersten leeren Long-Poll (25 s).
            const ping = await mcpReq('GET', '/pittools/ping', null, 5000);
            if (!mcp.on) break;
            if (ping.status !== 200) {
                mcp.fails++;
                mcpStatus('kein Server', { status: ping.status });
                await sleep(Math.min(15000, 2000 * mcp.fails));
                continue;
            }
            mcp.fails = 0;
            mcpStatus('verbunden');
            while (mcp.on) {
                const r = await mcpReq('GET', '/pittools/next', null, 30000);
                if (!mcp.on) {
                    // Auftrag kam nach dem Ausschalten: beantworten statt verwerfen (sonst wartet Claude bis zur Zeitgrenze).
                    let late = null;
                    try { late = r.status === 200 ? JSON.parse(r.text) : null; } catch (e) { late = null; }
                    if (late && late.id) mcpReq('POST', '/pittools/result', { id: late.id, ok: false, error: 'KI-Verbindung ist in PitTools ausgeschaltet.' }, 15000);
                    break;
                }
                if (r.status === 200) {
                    let job = null;
                    try { job = JSON.parse(r.text); } catch (e) { job = null; }
                    if (job && job.id && job.tool) {
                        try { document.dispatchEvent(new CustomEvent('pittools-mcp-call', { detail: JSON.stringify(job) })); } catch (e) {}
                    }
                } else if (r.status !== 204 && r.status !== -1) {
                    break; // Server weg -> wieder per Ping pruefen
                }
            }
        }
        mcp.running = false;
        mcpStatus('aus');
    }
    document.addEventListener('pittools-mcp-enable', function (ev) {
        let d = {};
        try { d = JSON.parse(ev.detail || '{}') || {}; } catch (e) { d = {}; }
        const was = mcp.on;
        mcp.on = !!d.on;
        const port = Number(d.port);
        if (port > 1024 && port < 65536) mcp.port = port;
        if (mcp.on) mcpLoop();
        else { mcpStatus('aus'); if (was) mcpReq('GET', '/pittools/bye', null, 5000); }
    });
    document.addEventListener('pittools-mcp-result', function (ev) {
        let d = null;
        try { d = JSON.parse(ev.detail); } catch (e) { return; }
        if (!d || !d.id) return;
        mcpReq('POST', '/pittools/result', d, 15000);
    });
    try { document.documentElement.setAttribute('data-pittools-bridge-mcp', '1'); } catch (e) {}
    try { console.log('[PitTools Bridge] bereit (futbin.com, fut.gg, KI-Verbindung)'); } catch (e) {}
})();
