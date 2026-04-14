/**
 * Git Graph Renderer — Canvas-based, touch-optimized
 */

const GitGraph = (() => {
  const ROW_H     = 62;   // px per commit row
  const COL_W     = 18;   // px per lane
  const DOT_R     = 5;    // commit dot radius
  const MAX_LANES = 5;    // cap lanes so text always has room
  const PAD_L     = 10;
  const PAD_R     = 12;
  const TEXT_GAP  = 10;

  let canvas, ctx, dpr = 1;
  let commits = [], lanes = [], edges = [], totalHeight = 0, maxLanes = 1;
  let scrollY = 0, maxScrollY = 0;
  let velocity = 0, animFrame = null;
  let touchStartY = 0, touchLastY = 0, isDragging = false;
  let mouseDown = false, mouseStartY = 0, mouseLastY = 0;
  let onCommitClick = null;

  // ── Colors ────────────────────────────────────────────────────────────────
  // Detect at draw time so hot-swapping color scheme works
  function _c() {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return {
      text:    dark ? '#e8e8f0' : '#1a1a2e',
      muted:   dark ? '#8888a8' : '#667788',
      bg:      dark ? '#0d0d1a' : '#f4f4fc',
      dotBg:   dark ? '#0d0d1a' : '#ffffff',
      row:     dark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.025)',
      sep:     dark ? 'rgba(255,255,255,0.05)'  : 'rgba(0,0,0,0.07)',
    };
  }

  const BRANCH_COLORS = [
    '#7c6ff7', '#f76f9d', '#f7a32e', '#2ed573',
    '#1e90ff', '#f76348', '#a29bfe', '#00cec9',
  ];

  // ── Init ──────────────────────────────────────────────────────────────────
  function init(canvasEl, clickCb) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    onCommitClick = clickCb;

    new ResizeObserver(_resize).observe(canvas.parentElement);
    window.addEventListener('resize', _resize);

    canvas.addEventListener('touchstart', _touchStart, { passive: true });
    canvas.addEventListener('touchmove',  _touchMove,  { passive: true });
    canvas.addEventListener('touchend',   _touchEnd,   { passive: true });
    canvas.addEventListener('mousedown',  _mouseDown);
    canvas.addEventListener('mousemove',  _mouseMove);
    canvas.addEventListener('mouseup',    _mouseUp);
    canvas.addEventListener('wheel',      _wheel, { passive: true });
    canvas.addEventListener('click',      _click);

    requestAnimationFrame(_resize);
  }

  function _resize() {
    if (!canvas) return;
    dpr = window.devicePixelRatio || 1;
    const p = canvas.parentElement.getBoundingClientRect();
    const W = p.width  || window.innerWidth;
    const H = p.height || (window.innerHeight - 60);
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    _calcMaxScroll();
    _draw();
  }

  // ── Data ──────────────────────────────────────────────────────────────────
  function setData(commitList) {
    commits = commitList;
    scrollY = 0;
    velocity = 0;
    _buildGraph();
    _calcMaxScroll();
    _draw();
  }

  function _buildGraph() {
    if (!commits.length) { lanes = []; edges = []; maxLanes = 1; totalHeight = 0; return; }

    const n = commits.length;
    const idx = new Map(commits.map((c, i) => [c.sha, i]));
    const active = [];   // active[lane] = sha we're expecting, or null
    lanes = new Array(n).fill(0);
    edges = [];

    for (let i = 0; i < n; i++) {
      const c = commits[i];

      // Find reserved lane or claim a free one
      let lane = active.indexOf(c.sha);
      if (lane === -1) {
        lane = active.indexOf(null);
        if (lane === -1) { lane = active.length; active.push(null); }
      }
      // Cap lane index
      lanes[i] = lane % MAX_LANES;
      active[lane] = null;

      c.parents.forEach((pSha, pi) => {
        const pIdx = idx.get(pSha);
        if (pIdx === undefined) return;

        let tLane;
        if (pi === 0) {
          if (active[lane] === null) {
            tLane = lane; active[lane] = pSha;
          } else {
            tLane = active.indexOf(null);
            if (tLane === -1) { tLane = active.length; active.push(null); }
            active[tLane] = pSha;
          }
        } else {
          // Merge parent: reuse existing reservation or open new
          const existing = active.indexOf(pSha);
          if (existing !== -1) {
            tLane = existing;
          } else {
            tLane = active.indexOf(null);
            if (tLane === -1) { tLane = active.length; active.push(null); }
            active[tLane] = pSha;
          }
        }

        edges.push({
          from: i,  to: pIdx,
          fl: lane % MAX_LANES, tl: tLane % MAX_LANES,
          color: c.color || BRANCH_COLORS[0]
        });
      });
    }

    maxLanes = Math.min(active.length || 1, MAX_LANES);
    totalHeight = n * ROW_H;
  }

  function _calcMaxScroll() {
    if (!canvas) return;
    const H = canvas.height / dpr;
    maxScrollY = Math.max(0, totalHeight - H);
  }

  // ── Draw ──────────────────────────────────────────────────────────────────
  function _draw() {
    if (!canvas || !ctx) return;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    if (W <= 0 || H <= 0) return;

    const c = _c();
    ctx.clearRect(0, 0, W, H);

    if (!commits.length) return;

    // Layout
    const graphW = PAD_L + maxLanes * COL_W;
    const textX  = graphW + TEXT_GAP;
    const textW  = W - textX - PAD_R;

    function ry(i)  { return i * ROW_H + ROW_H / 2 - scrollY; }
    function lx(l)  { return PAD_L + l * COL_W + COL_W / 2; }

    const first = Math.max(0, Math.floor(scrollY / ROW_H) - 1);
    const last  = Math.min(commits.length - 1, Math.ceil((scrollY + H) / ROW_H) + 1);

    // Alternating row tint
    for (let i = first; i <= last; i++) {
      if (i % 2 === 0) {
        ctx.fillStyle = c.row;
        ctx.fillRect(0, i * ROW_H - scrollY, W, ROW_H);
      }
    }

    // Row separators
    ctx.strokeStyle = c.sep;
    ctx.lineWidth = 0.5;
    for (let i = first; i <= last; i++) {
      const y = (i + 1) * ROW_H - scrollY;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Graph column separator
    ctx.strokeStyle = c.sep;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(graphW + TEXT_GAP / 2, 0);
    ctx.lineTo(graphW + TEXT_GAP / 2, H);
    ctx.stroke();

    // Edges
    ctx.lineWidth = 1.5;
    edges.forEach(e => {
      const y1 = ry(e.from), y2 = ry(e.to);
      if (y2 < -ROW_H || y1 > H + ROW_H) return;
      const x1 = lx(e.fl), x2 = lx(e.tl);
      ctx.strokeStyle = e.color;
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      if (x1 === x2) {
        ctx.lineTo(x2, y2);
      } else {
        const bend = Math.min(ROW_H * 0.7, Math.abs(y2 - y1) * 0.5);
        ctx.bezierCurveTo(x1, y1 + bend, x2, y2 - bend, x2, y2);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // Dots + text
    for (let i = first; i <= last; i++) {
      const cm = commits[i];
      const y  = ry(i);
      const x  = lx(lanes[i]);
      const col = cm.color || BRANCH_COLORS[0];

      // Glow
      ctx.beginPath();
      ctx.arc(x, y, DOT_R + 5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.12;
      ctx.fill();
      ctx.globalAlpha = 1;

      // Dot fill
      ctx.beginPath();
      ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();

      // Dot border
      ctx.beginPath();
      ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
      ctx.strokeStyle = c.dotBg;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Merge ring
      if (cm.parents && cm.parents.length > 1) {
        ctx.beginPath();
        ctx.arc(x, y, DOT_R + 3, 0, Math.PI * 2);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (textW < 40) continue; // no room for text

      // Commit message
      ctx.font = '500 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = c.text;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(_trunc(ctx, cm.message, textW), textX, y - 5);

      // Meta: hash · author · date
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = c.muted;
      const meta = `${cm.shortSha} · ${cm.author} · ${_rel(cm.date)}`;
      ctx.fillText(_trunc(ctx, meta, textW), textX, y + 12);

      // Branch badge on tip commit
      if (cm.branches && cm.branches.length) {
        const label = cm.branches[0];
        ctx.font = '500 10px -apple-system, BlinkMacSystemFont, sans-serif';
        const bw = ctx.measureText(label).width + 10;
        const bx = W - PAD_R - bw;
        if (bx > textX + 60) {
          ctx.fillStyle = col;
          ctx.globalAlpha = 0.15;
          _rrect(bx, y - 9, bw, 14, 4);
          ctx.fill();
          ctx.globalAlpha = 0.7;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          _rrect(bx, y - 9, bw, 14, 4);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = col;
          ctx.fillText(label, bx + 5, y + 1);
        }
      }
    }
  }

  function _trunc(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 3 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function _rrect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function _rel(date) {
    const s = (Date.now() - new Date(date).getTime()) / 1000;
    if (s < 60)          return 'gerade';
    if (s < 3600)        return `${Math.floor(s / 60)}m`;
    if (s < 86400)       return `${Math.floor(s / 3600)}h`;
    if (s < 86400 * 30)  return `${Math.floor(s / 86400)}d`;
    if (s < 86400 * 365) return `${Math.floor(s / 2592000)} Mon.`;
    return `${Math.floor(s / 31536000)}y`;
  }

  // ── Scroll ────────────────────────────────────────────────────────────────
  function _clamp() { scrollY = Math.max(0, Math.min(scrollY, maxScrollY)); }

  function _inertia() {
    if (Math.abs(velocity) < 0.3) { velocity = 0; return; }
    scrollY += velocity;
    velocity *= 0.92;
    _clamp(); _draw();
    animFrame = requestAnimationFrame(_inertia);
  }

  function _touchStart(e) {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    touchStartY = touchLastY = e.touches[0].clientY;
    velocity = 0; isDragging = false;
  }
  function _touchMove(e) {
    const y = e.touches[0].clientY;
    const dy = touchLastY - y;
    touchLastY = y; velocity = dy;
    if (Math.abs(y - touchStartY) > 4) isDragging = true;
    scrollY += dy; _clamp(); _draw();
  }
  function _touchEnd() {
    if (Math.abs(velocity) > 0.5) animFrame = requestAnimationFrame(_inertia);
  }

  function _mouseDown(e) {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    mouseDown = true; mouseStartY = mouseLastY = e.clientY; velocity = 0; isDragging = false;
  }
  function _mouseMove(e) {
    if (!mouseDown) return;
    const dy = mouseLastY - e.clientY; mouseLastY = e.clientY; velocity = dy;
    if (Math.abs(e.clientY - mouseStartY) > 4) isDragging = true;
    scrollY += dy; _clamp(); _draw();
  }
  function _mouseUp() {
    mouseDown = false;
    if (Math.abs(velocity) > 0.5) animFrame = requestAnimationFrame(_inertia);
  }
  function _wheel(e) { scrollY += e.deltaY; _clamp(); _draw(); }

  function _click(e) {
    if (isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const cy = e.clientY - rect.top + scrollY;
    const i = Math.floor(cy / ROW_H);
    if (i >= 0 && i < commits.length && onCommitClick) onCommitClick(commits[i]);
  }

  return { init, setData };
})();
