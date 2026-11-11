// Launch and sign-in backdrop: neon rays from a central spark, drawn live so it
// is sharp at any screen size and orientation and needs no network.
(function () {
  var canvas = document.getElementById('launch-canvas');
  var ctx = canvas && canvas.getContext('2d');
  if (!ctx) return;

  var RAYS = 8, BRANCHES = 22, PULSES_PER_RAY = 2, GROW_SECONDS = 1.1;
  var still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var startedAt = performance.now();
  var width, height, cx, cy, reach, rayPaint, branches, frame = 0;

  function seeded(seed) {
    return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  }
  function point(ray, distance) {
    var angle = ray * 2 * Math.PI / RAYS;
    return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance];
  }

  function layout() {
    var scale = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth; height = canvas.clientHeight;
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    cx = width / 2; cy = height / 2; reach = Math.hypot(width, height) / 2;

    rayPaint = [];
    for (var ray = 0; ray < RAYS; ray++) {
      var end = point(ray, reach), paint = ctx.createLinearGradient(cx, cy, end[0], end[1]);
      paint.addColorStop(0, 'rgba(255,190,140,.95)');
      paint.addColorStop(.06, 'rgba(255,96,176,.85)');
      paint.addColorStop(.5, 'rgba(206,64,204,.5)');
      paint.addColorStop(1, 'rgba(150,56,224,.16)');
      rayPaint.push(paint);
    }

    // Short circuit-like stubs beside the rays; the fixed seed keeps the
    // picture the same on every launch.
    var random = seeded(7);
    branches = [];
    for (var i = 0; i < BRANCHES; i++) {
      var on = Math.floor(random() * RAYS), at = (.08 + random() * .8) * reach;
      var angle = on * 2 * Math.PI / RAYS, side = random() < .5 ? -1 : 1;
      var gap = random() < .5 ? 0 : 6 + random() * 26, out = 14 + random() * 64, along = random() < .6 ? (random() - .5) * 90 : 0;
      var nx = -Math.sin(angle) * side, ny = Math.cos(angle) * side, base = point(on, at);
      var a = [base[0] + nx * gap, base[1] + ny * gap], b = [a[0] + nx * out, a[1] + ny * out];
      branches.push({ at: at, a: a, b: b, c: [b[0] + Math.cos(angle) * along, b[1] + Math.sin(angle) * along], phase: random() * 6.28, rate: .6 + random() * 1.4 });
    }
  }

  function draw(seconds) {
    var grown = Math.min(1, seconds / GROW_SECONDS), tip = reach * (1 - Math.pow(1 - grown, 3));
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    for (var ray = 0; ray < RAYS; ray++) {
      var end = point(ray, tip);
      ctx.strokeStyle = rayPaint[ray];
      ctx.globalAlpha = .16; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(end[0], end[1]); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(end[0], end[1]); ctx.stroke();
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgb(224,84,200)';
    for (var i = 0; i < branches.length; i++) {
      var branch = branches[i];
      if (branch.at > tip) continue;
      ctx.globalAlpha = .22 + .3 * (.5 + .5 * Math.sin(seconds * branch.rate + branch.phase));
      ctx.beginPath(); ctx.moveTo(branch.a[0], branch.a[1]); ctx.lineTo(branch.b[0], branch.b[1]); ctx.lineTo(branch.c[0], branch.c[1]); ctx.stroke();
    }

    // Sparks running outward along each ray.
    for (var n = 0; n < RAYS * PULSES_PER_RAY; n++) {
      var travelled = (seconds * (.07 + (n % 5) * .012) + n * .37) % 1, distance = travelled * reach;
      if (distance > tip) continue;
      var head = point(n % RAYS, distance), tail = point(n % RAYS, Math.max(0, distance - 46));
      var fade = 1 - travelled, streak = ctx.createLinearGradient(tail[0], tail[1], head[0], head[1]);
      streak.addColorStop(0, 'rgba(255,110,190,0)');
      streak.addColorStop(1, 'rgba(255,200,170,.9)');
      ctx.globalAlpha = fade; ctx.strokeStyle = streak; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tail[0], tail[1]); ctx.lineTo(head[0], head[1]); ctx.stroke();
      ctx.fillStyle = '#FFE6D6';
      ctx.beginPath(); ctx.arc(head[0], head[1], 1.6, 0, 6.2832); ctx.fill();
    }

    var radius = (30 + 5 * Math.sin(seconds * 2.2)) * (.4 + .6 * grown), glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, 'rgba(255,244,228,1)');
    glow.addColorStop(.14, 'rgba(255,176,116,.92)');
    glow.addColorStop(.42, 'rgba(255,84,164,.32)');
    glow.addColorStop(1, 'rgba(255,84,164,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = glow;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  }

  // The backdrop only shows while launching or signed out; stop drawing otherwise.
  function shown() { var state = document.body.classList; return state.contains('launching') || state.contains('signed-out'); }
  function tick(now) { frame = 0; draw((now - startedAt) / 1000); if (shown()) frame = requestAnimationFrame(tick); }
  function wake() { if (still) draw(GROW_SECONDS); else if (!frame && shown()) frame = requestAnimationFrame(tick); }

  new MutationObserver(wake).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', function () { layout(); wake(); });
  layout();
  wake();
}());
