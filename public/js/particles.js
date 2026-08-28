/* Homepage particle backdrop — Midnight Ledger.
   A fixed full-viewport canvas behind the page content: a cloud of dust
   rests as a soft clustered being in the hero, then condenses into the
   full entity — core, orbital rings, halo — as the visitor scrolls,
   holds, and loosens back into the cluster again.
   Purely decorative: aria-hidden, pointer-events none, no DOM content —
   invisible to agents, crawlers, and screen readers by construction. */
(function () {
  'use strict';

  var testCanvas = document.createElement('canvas');
  if (!window.requestAnimationFrame || !testCanvas.getContext || !testCanvas.getContext('2d')) return;

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- canvas ---------- */

  var canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText =
    'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:-1;pointer-events:none;';
  document.body.insertBefore(canvas, document.body.firstChild);
  var ctx = canvas.getContext('2d');

  /* colors come from the design tokens so a theme change carries over */
  var rootStyle = getComputedStyle(document.documentElement);
  function token(name, fallback) {
    var v = rootStyle.getPropertyValue(name).trim();
    return v || fallback;
  }
  var COLORS = [
    { color: token('--accent', '#4dd6ff'), share: 0.62, alpha: 0.55 }, /* signal cyan */
    { color: token('--dim', '#5a6b82'),    share: 0.30, alpha: 0.50 }, /* faint ledger gray */
    { color: token('--ok', '#34e08c'),     share: 0.08, alpha: 0.60 }  /* human green */
  ];

  var DPR_CAP = 1.5;
  var width = 0, height = 0, dpr = 1;

  var particles = [];
  var morph = 0;        /* 0 = ambient drift, 1 = assembled entity */
  var morphTarget = 0;
  var fade = 1;         /* global opacity, eased */
  var fadeTarget = 1;
  var running = false;
  var frameHandle = 0;
  var time = 0;

  /* ---------- the entity ----------
     The morph target is an abstract, non-physical being: a dense luminous
     core cloud, two tilted orbital rings crossing it, and a diffuse outer
     halo. All targets are generated procedurally — no bitmap sampling. */

  /* Box–Muller gaussian, clamped so no target lands absurdly far out */
  function gauss() {
    var u = 1 - Math.random(), v = Math.random();
    var n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.max(-2.3, Math.min(2.3, n));
  }

  /* ---------- particles ---------- */

  function buildParticles() {
    var count = Math.min(3600, Math.max(900, Math.round(width * height / 320)));
    particles = [];
    var colorIdx = 0, colorBudget = COLORS[0].share * count;
    for (var i = 0; i < count; i++) {
      if (i > colorBudget && colorIdx < COLORS.length - 1) {
        colorIdx++;
        colorBudget += COLORS[colorIdx].share * count;
      }
      particles.push({
        x: 0, y: 0,
        vx: 0, vy: 0,
        tx: 0, ty: 0,
        hx: 0, hy: 0,   /* hero-cluster anchor */
        orbit: null,
        /* dust-sized: ~0.8–2.2 css px drawn */
        r: 0.4 + Math.random() * 0.7,
        c: colorIdx,
        jitter: Math.random() * Math.PI * 2,
        /* per-particle wander: own amplitude and frequency so the
           cloud never sits still */
        amp: 4 + Math.random() * 8,
        wf: 0.008 + Math.random() * 0.012
      });
    }
    assignTargets();
    /* spawn on the cluster so the first painted frame is already the being */
    for (var s = 0; s < particles.length; s++) {
      particles[s].x = particles[s].hx + (Math.random() - 0.5) * 30;
      particles[s].y = particles[s].hy + (Math.random() - 0.5) * 30;
    }
  }

  var entityCx = 0, entityCy = 0;

  function assignTargets() {
    /* entity sits right-of-center on wide screens, centered on small */
    var cx = entityCx = width > 760 ? width * 0.6 : width * 0.5;
    var cy = entityCy = height * 0.48;
    var size = Math.min(height * 0.72, width * 0.85);

    var tiltA = -0.45, tiltB = 0.6; /* radians — the two orbit planes */
    /* ring particles get a live orbit (angular velocity) rather than a
       fixed point: the two rings circulate in opposite directions */
    function makeOrbit(rx, ry, tilt, band, dir) {
      return {
        rx: rx + (Math.random() - 0.5) * band,
        ry: ry + (Math.random() - 0.5) * band * 0.5,
        ct: Math.cos(tilt), st: Math.sin(tilt),
        a0: Math.random() * Math.PI * 2,
        w: dir * (0.0009 + Math.random() * 0.0009)
      };
    }

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i], pt;
      p.orbit = null;
      if (p.c === 2) {
        /* green: the brighter of the two orbital rings */
        p.orbit = makeOrbit(size * 0.68, size * 0.23, tiltA, size * 0.14, 1);
        pt = [cx, cy];
      } else if (p.c === 1) {
        /* gray: diffuse shell between core and rings — kept off the ring
           radii so the orbits stay legible */
        var ang = Math.random() * Math.PI * 2;
        var rad = size * (0.17 + Math.random() * 0.10);
        pt = [cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad * 0.85];
      } else if (i % 4 === 0) {
        /* a quarter of the cyan: the second, wider orbit */
        p.orbit = makeOrbit(size * 0.84, size * 0.30, tiltB, size * 0.16, -1);
        pt = [cx, cy];
      } else {
        /* the rest of the cyan: soft gaussian core — loose on purpose */
        pt = [cx + gauss() * size * 0.13, cy + gauss() * size * 0.12];
      }
      p.tx = pt[0];
      p.ty = pt[1];

      /* hero-cluster anchor: the resting shape on page load — one soft
         spreading core, no rings, no orbits. Each color spreads at its
         own radius: bright cyan heart, green mid, dusty gray fringe */
      var spread = p.c === 0 ? 0.195 : (p.c === 2 ? 0.26 : 0.34);
      p.hx = cx + gauss() * size * spread;
      p.hy = cy + gauss() * size * spread * 0.9;
    }
  }

  /* ---------- scroll → state ---------- */

  function readScroll() {
    var vh = window.innerHeight || 1;
    var p = (window.scrollY || window.pageYOffset || 0) / vh;
    var t;
    if (p < 0.2) t = 0;                       /* hero: pure drift */
    else if (p < 1.05) t = (p - 0.2) / 0.85;  /* swirl into the entity */
    else if (p < 2.4) t = 1;                  /* hold the entity */
    else if (p < 3.2) t = 1 - (p - 2.4) / 0.8; /* dissolve */
    else t = 0;
    morphTarget = t * t * (3 - 2 * t);        /* smoothstep */
    fadeTarget = p > 3.2 ? 0.45 : 1;          /* quieter behind dense sections */
  }

  /* ---------- simulation ---------- */

  function step() {
    time += 1;
    morph += (morphTarget - morph) * 0.13; /* quick to follow the scroll */
    fade += (fadeTarget - fade) * 0.05;

    /* the flow field runs full strength in the resting cluster and keeps
       a fifth of it once assembled, so nothing ever sits still */
    var flowAmt = (1 - morph * 0.8) * 0.016;
    var swirl = morph * (1 - morph) * 0.09;   /* tangential kick, peaks mid-morph */
    /* soft pull at rest and at hold, with a mid-morph boost so the
       cloud answers the scroll without losing its hover */
    var spring = 0.006 + 0.003 * morph + 0.012 * morph * (1 - morph);
    var friction = 0.955 - morph * 0.03;

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];

      /* layered-sine flow field: slow, organic drift */
      var a = Math.sin(p.x * 0.0016 + time * 0.0022 + p.jitter) +
              Math.cos(p.y * 0.0013 - time * 0.0017);
      p.vx += Math.cos(a * Math.PI) * flowAmt;
      p.vy += Math.sin(a * Math.PI) * flowAmt;

      /* entity-side target; ring particles follow a moving orbit point */
      var etx = p.tx, ety = p.ty;
      if (p.orbit && morph > 0.01) {
        var o = p.orbit;
        var ang = o.a0 + time * o.w;
        var ex = Math.cos(ang) * o.rx, ey = Math.sin(ang) * o.ry;
        etx = entityCx + ex * o.ct - ey * o.st;
        ety = entityCy + ex * o.st + ey * o.ct;
      }
      /* anchor blends hero cluster → entity as the visitor scrolls, and
         every particle wanders around it at its own pace — the cloud
         stays blurry-edged and in constant motion in both states */
      var tx = p.hx + (etx - p.hx) * morph;
      var ty = p.hy + (ety - p.hy) * morph;
      var dx = tx + Math.sin(time * p.wf + p.jitter) * p.amp - p.x;
      var dy = ty + Math.cos(time * p.wf * 1.3 + p.jitter * 1.7) * p.amp - p.y;
      p.vx += dx * spring - dy * swirl * 0.05;
      p.vy += dy * spring + dx * swirl * 0.05;

      p.vx *= friction;
      p.vy *= friction;
      p.x += p.vx;
      p.y += p.vy;
    }
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    /* the resting cluster runs a touch quieter than the assembled entity */
    var presence = 0.75 + 0.25 * morph;
    for (var c = 0; c < COLORS.length; c++) {
      ctx.fillStyle = COLORS[c].color;
      ctx.globalAlpha = COLORS[c].alpha * fade * presence;
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        if (p.c !== c) continue;
        ctx.fillRect(p.x, p.y, p.r * 2, p.r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    step();
    draw();
    frameHandle = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reducedMotion.matches) return;
    running = true;
    frameHandle = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(frameHandle);
  }

  /* ---------- sizing ---------- */

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!particles.length) buildParticles();
    else assignTargets();
    if (!running) { readScroll(); morph = morphTarget; step(); draw(); }
  }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  window.addEventListener('scroll', readScroll, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start();
  });

  var onReducedChange = function () {
    if (reducedMotion.matches) { stop(); readScroll(); morph = morphTarget; step(); draw(); }
    else start();
  };
  if (reducedMotion.addEventListener) reducedMotion.addEventListener('change', onReducedChange);

  /* localhost-only test hook: lets an automated check step the simulation
     deterministically even when the tab is backgrounded */
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    window.__hfaiParticles = {
      tick: function (n) { for (var i = 0; i < n; i++) step(); draw(); },
      state: function () { return { morph: morph, target: morphTarget, count: particles.length }; }
    };
  }

  /* ---------- go ---------- */

  resize();
  readScroll();
  if (reducedMotion.matches) {
    /* static frame only: particles scattered, no animation */
    morph = morphTarget;
    draw();
  } else {
    start();
  }
})();
