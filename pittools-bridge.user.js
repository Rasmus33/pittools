// ==UserScript==
// @name         PitTools Bridge
// @namespace    https://github.com/sbc-optimizer
// @version      1.0.0
// @description  CORS-Bruecke fuer PitTools: holt Seiten von futbin.com (SBC-Loesungen). Ohne dieses Script fehlt im Browser die Futbin-Loesungssuche - in der PitTools-App uebernimmt die App selbst.
// @author       Rasmus Risse
// @copyright    2026 Rasmus Risse
// @license      PolyForm-Noncommercial-1.0.0; https://polyformproject.org/licenses/noncommercial/1.0.0
// @match        https://www.ea.com/*/ultimate-team/web-app/*
// @match        https://www.ea.com/ultimate-team/web-app/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      futbin.com
// @connect      www.futbin.com
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
    const ALLOW = /^https:\/\/(www\.)?futbin\.com\//;
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
    try { console.log('[PitTools Bridge] bereit (futbin.com)'); } catch (e) {}
})();
