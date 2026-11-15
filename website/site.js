// The landing page's motion: nav border, scroll reveals, marquees, the text ribbons in the
// hero, the sticky "how it works" chapters, typing and count-ups. No dependencies.
(function () {
  var calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // Nav hairline once the page has scrolled.
  var nav = document.getElementById("nav");
  function onScroll() { nav.classList.toggle("scrolled", window.scrollY > 8); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // The Studio (the signed-in product) is a separate app. Set its address here once.
  var STUDIO_URL = "/dashboard";
  $$("[data-studio]").forEach(function (a) { a.setAttribute("href", STUDIO_URL); });

  // The waveform inside the hero's pill, and the word above it.
  var bars = document.getElementById("bars");
  if (bars) {
    for (var n = 0; n < 17; n++) {
      var r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      var h = 14 + ((n * 37) % 34);
      r.setAttribute("x", String(650 + n * 8.6)); r.setAttribute("y", String(720 - h / 2));
      r.setAttribute("width", "4"); r.setAttribute("height", String(h)); r.setAttribute("rx", "2");
      r.style.animationDelay = ((n * 0.13) % 1.1).toFixed(2) + "s";
      bars.appendChild(r);
    }
  }
  var status = document.getElementById("status");
  if (status && !calm) {
    var words = ["listening", "understanding", "noting it down", "replying"], wi = 0;
    setInterval(function () { wi = (wi + 1) % words.length; status.textContent = words[wi]; }, 2200);
  }

  // Marquees: one copy in the HTML, a second added here so the loop has no seam.
  $$("[data-clone]").forEach(function (track) {
    var copy = track.firstElementChild.cloneNode(true);
    copy.setAttribute("aria-hidden", "true");
    track.appendChild(copy);
  });

  // Reveal on scroll, staggered among siblings.
  function watch(els, cb, opts) {
    if (!("IntersectionObserver" in window)) { els.forEach(function (el) { cb(el, true); }); return null; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { cb(e.target, e.isIntersecting, io); });
    }, opts || { threshold: 0.15 });
    els.forEach(function (el) { io.observe(el); });
    return io;
  }
  $$(".rv").forEach(function (el) {
    var sibs = $$(":scope > .rv", el.parentElement);
    el.style.transitionDelay = Math.max(0, sibs.indexOf(el)) * 80 + "ms";
  });
  watch($$(".rv, [data-inview]"), function (el, seen, io) {
    if (!seen) return;
    el.classList.add("in");
    if (io) io.unobserve(el);
  });

  // Count up to a number the first time it is seen.
  watch($$("[data-count]"), function (el, seen, io) {
    if (!seen) return;
    if (io) io.unobserve(el);
    var to = Number(el.getAttribute("data-count"));
    if (calm || !to) { el.textContent = String(to); return; }
    var t0 = performance.now(), dur = 900;
    (function tick(now) {
      var p = Math.min(1, (now - t0) / dur);
      el.textContent = String(Math.max(p < 1 ? 0 : to, Math.round(to * (1 - Math.pow(1 - p, 3)))));
      if (p < 1) requestAnimationFrame(tick);
    })(t0);
  }, { threshold: 0.6 });

  // Text ribbons: a phrase repeated along an SVG path, sliding forward for ever.
  var ribbons = $$("[data-ribbon]").map(function (tp) {
    var unit = tp.getAttribute("data-unit");
    var text = tp.parentNode;
    var path = document.querySelector(tp.getAttribute("href"));
    tp.textContent = unit;
    var len = text.getComputedTextLength() || 600;
    var total = path && path.getTotalLength ? path.getTotalLength() : 1600;
    var copies = Math.ceil(total / len) + 2;
    tp.textContent = new Array(copies + 1).join(unit);
    tp.setAttribute("startOffset", String(-len));
    return { tp: tp, len: len, speed: Number(tp.getAttribute("data-ribbon")) || 40 };
  });
  if (ribbons.length && !calm) {
    var start = performance.now();
    (function slide(now) {
      var t = (now - start) / 1000;
      for (var i = 0; i < ribbons.length; i++) {
        var r = ribbons[i];
        r.tp.setAttribute("startOffset", String(-r.len + ((t * r.speed) % r.len)));
      }
      requestAnimationFrame(slide);
    })(start);
  }

  // Typing, replayed each time its scene is shown.
  function type(el) {
    var full = el.getAttribute("data-type");
    if (calm) { el.textContent = full; return; }
    clearInterval(el._timer);
    var i = 0;
    el.textContent = "";
    el._timer = setInterval(function () {
      i += 1;
      el.textContent = full.slice(0, i);
      if (i >= full.length) clearInterval(el._timer);
    }, 32);
  }

  // Sticky chapters: the step nearest the middle of the screen picks the scene.
  var vis = document.getElementById("chapVis");
  var steps = $$(".cstep");
  var scenes = vis ? $$(".scene", vis) : [];
  var current = -1;
  function show(n) {
    if (n === current) return;
    current = n;
    vis.setAttribute("data-on", String(n));
    scenes.forEach(function (s, i) { s.classList.toggle("on", i === n); });
    steps.forEach(function (s, i) { s.classList.toggle("on", i === n); });
    $$("[data-type]", scenes[n]).forEach(type);
  }
  if (vis && steps.length) {
    scenes.forEach(function (s) { s.classList.remove("on"); });
    watch(steps, function (el, seen) {
      if (seen) show(Number(el.getAttribute("data-step")));
    }, { rootMargin: "-45% 0px -45% 0px", threshold: 0 });
    watch([vis], function (el, seen, io) {
      if (!seen) return;
      if (io) io.unobserve(el);
      if (current < 0) show(0);
    }, { threshold: 0.3 });
  }
})();
