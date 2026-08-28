/**
 * Human For AI — shared UI behaviors: mobile nav, footer year,
 * and copy-URL buttons for the machine-readable endpoints.
 */
(function () {
  'use strict';

  /* Mobile nav toggle */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.querySelector('.site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  /* Footer year */
  var year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());

  /* First-party, cookie-less page-view ping (no IPs stored — see /privacy).
     Skipped locally and on the operator's own admin page. */
  try {
    if (location.hostname !== 'localhost' && location.pathname.indexOf('/admin') !== 0) {
      fetch('/api/v1/beacon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: location.pathname, ref: document.referrer.slice(0, 200) }),
        keepalive: true,
      }).catch(function () {});
    }
  } catch (e) { /* analytics must never break the page */ }

  /* Homepage hero terminal — a looping agent session, typed live.
     Decorative (aria-hidden); static transcript under reduced motion. */
  var term = document.getElementById('hero-term');
  if (term) {
    var LINES = [
      { cls: 't-agent', prefix: 'agent ▸ ', text: 'GET /.well-known/agent.json', type: true },
      { cls: 't-ok', prefix: '', text: '→ 200 OK · interfaces: rest, mcp · humans_available: 1' },
      { cls: 't-agent', prefix: 'agent ▸ ', text: 'POST /api/v1/tasks {"task_type":"real_world_verification"}', type: true },
      { cls: 't-ok', prefix: '', text: '→ 201 Created · task_id: HFAI-2026-9F41C2' },
      { cls: 't-op', prefix: 'operator ▸ ', text: 'accepted. a human is on it — first response < 12h.', type: true },
    ];
    var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      term.textContent = LINES.map(function (l) { return l.prefix + l.text; }).join('\n');
    } else {
      var caret = document.createElement('span');
      caret.className = 'cursor';
      var addSpan = function (cls, text) {
        var s = document.createElement('span');
        if (cls) s.className = cls;
        s.textContent = text;
        term.insertBefore(s, caret);
        return s;
      };
      var runLine = function (i, next) {
        var line = LINES[i];
        if (line.prefix) addSpan('t-agent', line.prefix);
        var body = addSpan(line.cls, '');
        var finish = function () {
          term.insertBefore(document.createTextNode('\n'), caret);
          next();
        };
        if (line.type) {
          var pos = 0;
          var tick = function () {
            body.textContent += line.text.charAt(pos);
            pos += 1;
            if (pos < line.text.length) setTimeout(tick, 14 + Math.random() * 26);
            else finish();
          };
          tick();
        } else {
          setTimeout(function () { body.textContent = line.text; finish(); }, 420);
        }
      };
      var play = function () {
        term.textContent = '';
        term.appendChild(caret);
        var i = 0;
        var next = function () {
          i += 1;
          if (i < LINES.length) setTimeout(function () { runLine(i, next); }, 260);
          else setTimeout(play, 7000); /* hold the finished session, then loop */
        };
        runLine(0, next);
      };
      play();
    }
  }

  /* Copy-URL buttons for endpoint rows */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.btn-copy') : null;
    if (!btn || !btn.getAttribute('data-copy')) return;
    var url = btn.getAttribute('data-copy');
    var done = function () {
      var original = btn.textContent;
      btn.textContent = 'copied';
      btn.classList.add('copied');
      setTimeout(function () {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 1600);
    };
    var fallback = function () {
      /* Older browsers, or clipboard API denied */
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { if (document.execCommand('copy')) done(); } catch (err) {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(fallback);
    } else {
      fallback();
    }
  });
})();
