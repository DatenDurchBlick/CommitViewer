/**
 * Git Graph Renderer — Canvas-based, touch-optimized
 * Draws a git log --graph style visualization using HTML Canvas.
 */

const GitGraph = (() => {
  // Layout constants
  const ROW_H      = 56;   // height per commit row
  const COL_W      = 20;   // width per graph lane
  const DOT_R      = 5;    // radius of commit dot
  const PAD_LEFT   = 12;   // left padding before graph
  const PAD_RIGHT  = 12;   // right padding
  const TEXT_OFF   = 16;   // gap between last lane and text
  const FONT_MSG   = '14px -apple-system, BlinkMacSystemFont, sans-serif';
  const FONT_META  = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  const FONT_HASH  = '12px "SF Mono", Menlo, monospace';

  let canvas, ctx, dpr;
  let commits = [];       // array of commit objects from API
  let branches = [];      // branch metadata
  let lanes = [];         // lane index per commit
  let edges = [];         // {from, to, fromLane, toLane, color}
  let totalHeight = 0;
  let maxLanes = 1;

  // Scroll / touch state
  let scrollY = 0;
  let maxScrollY = 0;
  let touchStartY = 0;
  let touchLastY  = 0;
  let velocity    = 0;
  let animFrame   = null;
  let isDragging  = false;

  // Click callback
  let onCommitClick = null;

  function init(canvasEl, clickCallback) {
    canvas = canvasEl;
    ctx    = canvas.getContext('2d');
    onCommitClick = clickCallback;
    dpr = window.devicePixelRatio || 1;

    _resize();
    window.addEventListener('resize', _resize);

    canvas.addEventListener('touchstart',  _onTouchStart, { passive: true });
    canvas.addEventListener('touchmove',   _onTouchMove,  { passive: true });
    canvas.addEventListener('touchend',    _onTouchEnd,   { passive: true });
    canvas.addEventListener('mousedown',   _onMouseDown);
    canvas.addEventListener('mousemove',   _onMouseMove);
    canvas.addEventListener('mouseup',     _onMouseUp);
    canvas.addEventListener('wheel',       _onWheel,      { passive: true });
    canvas.addEventListener('click',       _onClick);
  }

  function _resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    _computeMaxScroll();
    _draw();
  }

  // ── Data Processing ──────────────────────────────────────────────────────

  function setData(commitList, branchList) {
    commits  = commitList;
    branches = branchList;
    scrollY  = 0;
    velocity = 0;
    _buildGraph();
    _computeMaxScroll();
    _draw();
  }

  /**
   * Assign lanes to commits using a simple algorithm:
   * - Maintain a set of active "lanes" (each tracking its current branch tip sha)
   * - For each commit (sorted newest first):
   *   - If a lane is waiting for this sha, reuse that lane
   *   - Otherwise open a new lane
   *   - Free lanes for parents
   */
  function _buildGraph() {
    if (!commits.length) { lanes = []; edges = []; maxLanes = 1; totalHeight = 0; return; }

    const n = commits.length;
    const shaIndex = new Map(commits.map((c, i) => [c.sha, i]));

    // activeLanes[lane] = sha of the commit we're waiting for, or null
    const activeLanes = [];
    lanes = new Array(n).fill(-1);
    edges = [];

    for (let i = 0; i < n; i++) {
      const c = commits[i];

      // Find lane reserved for this commit
      let lane = activeLanes.indexOf(c.sha);

      if (lane === -1) {
        // Find an empty lane or open new one
        lane = activeLanes.indexOf(null);
        if (lane === -1) { lane = activeLanes.length; activeLanes.push(null); }
      }

      lanes[i] = lane;
      activeLanes[lane] = null;  // this lane is now free

      // Reserve lanes for parents
      c.parents.forEach((pSha, pi) => {
        const pIdx = shaIndex.get(pSha);
        if (pIdx === undefined) return; // parent outside our window

        let targetLane;
        if (pi === 0) {
          // First parent continues on same lane if free, else first available
          if (activeLanes[lane] === null) {
            targetLane = lane;
            activeLanes[lane] = pSha;
          } else {
            targetLane = activeLanes.indexOf(null);
            if (targetLane === -1) { targetLane = activeLanes.length; activeLanes.push(null); }
            activeLanes[targetLane] = pSha;
          }
        } else {
          // Merge parent: open new lane
          targetLane = activeLanes.indexOf(null);
          if (targetLane === -1) { targetLane = activeLanes.length; activeLanes.push(null); }
          // Only reserve if not already reserved
          if (!activeLanes.some((s, li) => s === pSha)) {
            activeLanes[targetLane] = pSha;
          } else {
            targetLane = activeLanes.indexOf(pSha);
          }
        }

        edges.push({
          fromIdx:  i,
          toIdx:    pIdx,
          fromLane: lane,
          toLane:   targetLane,
          color:    c.color || '#6c63ff'
        });
      });
    }

    maxLanes = activeLanes.length || 1;
    totalHeight = n * ROW_H;
  }

  function _computeMaxScroll() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    maxScrollY = Math.max(0, totalHeight - rect.height + ROW_H);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function _draw() {
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);

    if (!commits.length) return;

    const graphWidth = PAD_LEFT + maxLanes * COL_W;
    const textX      = graphWidth + TEXT_OFF;
    const isDark     = window.matchMedia('(prefers-color-scheme: dark)').matches
                       || document.documentElement.style.colorScheme === 'dark'
                       || true; // default dark

    // Colors from CSS vars (we'll just use hex directly)
    const colorText      = getComputedStyle(document.documentElement).getPropertyValue('--text').trim()       || '#e8e8f0';
    const colorTextMuted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#8888a8';
    const colorBg        = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()         || '#0d0d1a';
    const colorBg2       = getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim()        || '#151528';
    const colorBorder    = getComputedStyle(document.documentElement).getPropertyValue('--border').trim()     || '#2a2a48';

    // Visible range
    const firstRow = Math.max(0, Math.floor(scrollY / ROW_H) - 1);
    const lastRow  = Math.min(commits.length - 1, Math.ceil((scrollY + H) / ROW_H) + 1);

    function rowY(idx) { return idx * ROW_H + ROW_H / 2 - scrollY; }
    function laneX(l)  { return PAD_LEFT + l * COL_W + COL_W / 2; }

    // Draw edges first (behind dots)
    ctx.lineWidth = 2;
    edges.forEach(e => {
      const y1 = rowY(e.fromIdx);
      const y2 = rowY(e.toIdx);
      // Skip if completely off-screen
      if (y2 < -ROW_H || y1 > H + ROW_H) return;

      const x1 = laneX(e.fromLane);
      const x2 = laneX(e.toLane);

      ctx.strokeStyle = e.color;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(x1, y1);

      if (x1 === x2) {
        ctx.lineTo(x2, y2);
      } else {
        // Bezier curve for merges
        const mid = (y1 + y2) / 2;
        ctx.bezierCurveTo(x1, mid, x2, mid, x2, y2);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // Draw commit dots & text
    for (let i = firstRow; i <= lastRow; i++) {
      const c = commits[i];
      const y = rowY(i);
      const x = laneX(lanes[i]);
      const color = c.color || '#6c63ff';

      // Dot
      ctx.beginPath();
      ctx.arc(x, y, DOT_R, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = colorBg;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Merge commit: double ring
      if (c.parents.length > 1) {
        ctx.beginPath();
        ctx.arc(x, y, DOT_R + 3, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Message
      ctx.font = FONT_MSG;
      ctx.fillStyle = colorText;
      ctx.textBaseline = 'middle';

      const availW = W - textX - PAD_RIGHT;
      let msg = c.message;
      // Truncate if needed
      if (ctx.measureText(msg).width > availW) {
        while (msg.length > 5 && ctx.measureText(msg + '…').width > availW) {
          msg = msg.slice(0, -1);
        }
        msg += '…';
      }
      ctx.fillText(msg, textX, y - 8);

      // Meta line: hash + author + date
      ctx.font = FONT_META;
      ctx.fillStyle = colorTextMuted;
      const hashStr   = c.shortSha;
      const authorStr = c.author;
      const dateStr   = _relativeTime(c.date);
      const metaStr   = `${hashStr}  ${authorStr}  ${dateStr}`;
      ctx.fillText(metaStr, textX, y + 10);

      // Branch tags (only for first 2)
      if (c.branches && c.branches.length) {
        let bx = textX + ctx.measureText(metaStr).width + 10;
        c.branches.slice(0, 2).forEach(bname => {
          const bw = ctx.measureText(bname).width + 10;
          if (bx + bw > W - PAD_RIGHT) return;
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.2;
          _roundRect(ctx, bx, y + 3, bw, 16, 4);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          _roundRect(ctx, bx, y + 3, bw, 16, 4);
          ctx.stroke();
          ctx.fillStyle = color;
          ctx.fillText(bname, bx + 5, y + 11);
          bx += bw + 6;
        });
      }
    }
  }

  function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function _relativeTime(date) {
    const diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60)           return 'gerade eben';
    if (diff < 3600)         return `vor ${Math.floor(diff/60)} Min.`;
    if (diff < 86400)        return `vor ${Math.floor(diff/3600)} Std.`;
    if (diff < 86400 * 30)   return `vor ${Math.floor(diff/86400)} Tagen`;
    if (diff < 86400 * 365)  return `vor ${Math.floor(diff/2592000)} Mon.`;
    return `vor ${Math.floor(diff/31536000)} Jahren`;
  }

  // ── Scrolling ─────────────────────────────────────────────────────────────

  function _clampScroll() {
    scrollY = Math.max(0, Math.min(scrollY, maxScrollY));
  }

  function _animateInertia() {
    if (Math.abs(velocity) < 0.5) { velocity = 0; return; }
    scrollY += velocity;
    velocity *= 0.94;
    _clampScroll();
    _draw();
    animFrame = requestAnimationFrame(_animateInertia);
  }

  function _onTouchStart(e) {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    touchStartY = touchLastY = e.touches[0].clientY;
    velocity = 0;
    isDragging = false;
  }

  function _onTouchMove(e) {
    const y = e.touches[0].clientY;
    const dy = touchLastY - y;
    touchLastY = y;
    velocity = dy;
    if (Math.abs(y - touchStartY) > 5) isDragging = true;
    scrollY += dy;
    _clampScroll();
    _draw();
  }

  function _onTouchEnd(e) {
    if (Math.abs(velocity) > 1) {
      animFrame = requestAnimationFrame(_animateInertia);
    }
  }

  let mouseDown = false, mouseStartY = 0, mouseLastY = 0;
  function _onMouseDown(e) {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
    mouseDown = true; mouseStartY = mouseLastY = e.clientY; velocity = 0; isDragging = false;
  }
  function _onMouseMove(e) {
    if (!mouseDown) return;
    const dy = mouseLastY - e.clientY;
    mouseLastY = e.clientY;
    velocity = dy;
    if (Math.abs(e.clientY - mouseStartY) > 5) isDragging = true;
    scrollY += dy; _clampScroll(); _draw();
  }
  function _onMouseUp(e) { mouseDown = false; if (Math.abs(velocity) > 1) animFrame = requestAnimationFrame(_animateInertia); }
  function _onWheel(e) { scrollY += e.deltaY; _clampScroll(); _draw(); }

  // ── Click / tap ───────────────────────────────────────────────────────────

  function _onClick(e) {
    if (isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const cy = e.clientY - rect.top + scrollY;
    const idx = Math.floor(cy / ROW_H);
    if (idx >= 0 && idx < commits.length && onCommitClick) {
      onCommitClick(commits[idx]);
    }
  }

  return { init, setData };
})();
