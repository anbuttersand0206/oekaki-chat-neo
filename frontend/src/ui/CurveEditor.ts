import { CurvePoint } from '../types';

// ── Bezier helpers ────────────────────────────────────────────────────────────

function b1(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3;
}

function findT(x: number, x0: number, x1: number, x2: number, x3: number): number {
  let lo = 0, hi = 1;
  for (let k = 0; k < 32; k++) {
    const m = (lo + hi) * 0.5;
    if (b1(m, x0, x1, x2, x3) < x) lo = m; else hi = m;
  }
  return (lo + hi) * 0.5;
}

// Catmull-Rom slope at s[i] (x-parameterized), used for auto-handles
function cmSlope(s: CurvePoint[], i: number): number {
  const n = s.length;
  if (i === 0)     return (s[1].y - s[0].y) / (s[1].x - s[0].x + 1e-9);
  if (i === n - 1) return (s[n-1].y - s[n-2].y) / (s[n-1].x - s[n-2].x + 1e-9);
  return (s[i+1].y - s[i-1].y) / (s[i+1].x - s[i-1].x + 1e-9);
}

interface Ctrl { x: number; y: number; }

// Catmull-Rom tangents → Bezier handles for segment i→i+1
function autoCtrl(s: CurvePoint[], i: number): { p1: Ctrl; p2: Ctrl } {
  const p0 = s[i], p3 = s[i + 1];
  const dx = p3.x - p0.x;
  const m0 = cmSlope(s, i)     * dx;
  const m1 = cmSlope(s, i + 1) * dx;
  return {
    p1: { x: p0.x + dx / 3, y: p0.y + m0 / 3 },
    p2: { x: p3.x - dx / 3, y: p3.y - m1 / 3 },
  };
}

// Resolved control points for segment i (explicit handles if set, else auto)
function segCtrl(s: CurvePoint[], i: number): { p1: Ctrl; p2: Ctrl } {
  const p0 = s[i], p3 = s[i + 1];
  const auto = autoCtrl(s, i);
  const p1: Ctrl = (p0.rx !== undefined)
    ? { x: Math.max(p0.x, Math.min(p3.x, p0.rx)), y: p0.ry! }
    : auto.p1;
  const p2: Ctrl = (p3.lx !== undefined)
    ? { x: Math.max(p0.x, Math.min(p3.x, p3.lx)), y: p3.ly! }
    : auto.p2;
  return { p1, p2 };
}

// ── Public curve evaluation ───────────────────────────────────────────────────

export function evalCurve(pts: CurvePoint[], x: number): number {
  if (pts.length === 0) return 1;
  const s = pts.slice().sort((a, b) => a.x - b.x);
  const n = s.length;
  if (x <= s[0].x) return s[0].y;
  if (x >= s[n - 1].x) return s[n - 1].y;

  let i = n - 2;
  for (let j = 0; j < n - 1; j++) {
    if (x <= s[j + 1].x) { i = j; break; }
  }

  const { p1, p2 } = segCtrl(s, i);
  const t = findT(x, s[i].x, p1.x, p2.x, s[i + 1].x);
  return Math.max(0, Math.min(1, b1(t, s[i].y, p1.y, p2.y, s[i + 1].y)));
}

// ── Presets ───────────────────────────────────────────────────────────────────

export const CURVE_PRESETS: Record<string, CurvePoint[]> = {
  flat:   [{ x: 0, y: 1 }, { x: 1, y: 1 }],
  linear: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
  soft:   [{ x: 0, y: 0 }, { x: 0.3, y: 0.65 }, { x: 0.7, y: 0.92 }, { x: 1, y: 1 }],
  hard:   [{ x: 0, y: 0 }, { x: 0.3, y: 0.05 }, { x: 0.7, y: 0.45 }, { x: 1, y: 1 }],
  scurve: [{ x: 0, y: 0 }, { x: 0.25, y: 0.1 }, { x: 0.75, y: 0.9 }, { x: 1, y: 1 }],
};

export interface CurveEditorOptions {
  xLabel?: string;
}

// ── Internal types ────────────────────────────────────────────────────────────

type DragKind = 'anchor' | 'handleL' | 'handleR';
interface Drag { kind: DragKind; idx: number; }
interface SortedPt extends CurvePoint { _oi: number; }

// ── CurveEditor ───────────────────────────────────────────────────────────────

export class CurveEditor {
  private pts: CurvePoint[];
  private drag: Drag | null = null;
  private W = 0;
  private readonly PAD = 28;
  private readonly xLabel: string;

  onChange?: (pts: CurvePoint[]) => void;

  constructor(private readonly canvas: HTMLCanvasElement, opts: CurveEditorOptions = {}) {
    this.xLabel = opts.xLabel ?? '入力';
    this.pts = CURVE_PRESETS.flat.map(p => ({ ...p }));
    this.setupEvents();
    this.initResize();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getPoints(): CurvePoint[] { return this.pts.map(p => ({ ...p })); }

  setPoints(pts: CurvePoint[]) {
    this.pts = pts.length >= 2
      ? pts.map(p => ({ ...p }))
      : CURVE_PRESETS.flat.map(p => ({ ...p }));
    this.render();
  }

  reset() { this.setPreset('flat'); }

  setPreset(name: string) {
    const pre = CURVE_PRESETS[name];
    if (!pre) return;
    this.pts = pre.map(p => ({ ...p }));
    this.render();
    this.onChange?.(this.getPoints());
  }

  // ── Sorted array (with original index attached) ─────────────────────────────

  private sorted(): SortedPt[] {
    return this.pts.map((p, i) => ({ ...p, _oi: i })).sort((a, b) => a.x - b.x);
  }

  // ── Computed handle (explicit or auto-Catmull-Rom) ──────────────────────────

  private computedHandle(s: SortedPt[], si: number, side: 'L' | 'R'): Ctrl {
    const pt = s[si];
    if (side === 'L') {
      if (pt.lx !== undefined) return { x: pt.lx, y: pt.ly! };
      if (si > 0) return segCtrl(s, si - 1).p2;
      return { x: pt.x, y: pt.y };
    } else {
      if (pt.rx !== undefined) return { x: pt.rx, y: pt.ry! };
      if (si < s.length - 1) return segCtrl(s, si).p1;
      return { x: pt.x, y: pt.y };
    }
  }

  // ── Coordinate helpers ──────────────────────────────────────────────────────

  private plotRect() {
    const P = this.PAD, W = this.W;
    const pw = W - 2 * P;
    return { x0: P, y0: P, x1: W - P, y1: W - P, pw, ph: pw };
  }

  private toCanvas(lx: number, ly: number): [number, number] {
    const { x0, y0, pw, ph } = this.plotRect();
    return [x0 + lx * pw, y0 + (1 - ly) * ph];
  }

  private toLogical(cx: number, cy: number): [number, number] {
    const { x0, y0, pw, ph } = this.plotRect();
    return [(cx - x0) / pw, 1 - (cy - y0) / ph];
  }

  private eventPos(e: PointerEvent | MouseEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    const sx = this.W / r.width;
    const sy = this.W / r.height;
    return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
  }

  private hw(): number { return Math.max(4, this.W / 30 | 0); }
  private hr(): number { return Math.max(3, this.W / 38 | 0); }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  private hitTest(cx: number, cy: number): { kind: DragKind; idx: number } | null {
    const s = this.sorted();
    const hr = this.hr() + 2;

    // Handles first (so they're grabbable even when near an anchor)
    for (let si = s.length - 1; si >= 0; si--) {
      if (si > 0) {
        const h = this.computedHandle(s, si, 'L');
        const [hx, hy] = this.toCanvas(h.x, h.y);
        if (Math.hypot(cx - hx, cy - hy) <= hr) return { kind: 'handleL', idx: s[si]._oi };
      }
      if (si < s.length - 1) {
        const h = this.computedHandle(s, si, 'R');
        const [hx, hy] = this.toCanvas(h.x, h.y);
        if (Math.hypot(cx - hx, cy - hy) <= hr) return { kind: 'handleR', idx: s[si]._oi };
      }
    }

    // Anchors
    const hw = this.hw() + 2;
    for (let i = this.pts.length - 1; i >= 0; i--) {
      const [hx, hy] = this.toCanvas(this.pts[i].x, this.pts[i].y);
      if (Math.abs(cx - hx) <= hw && Math.abs(cy - hy) <= hw) return { kind: 'anchor', idx: i };
    }

    return null;
  }

  private inPlot(cx: number, cy: number): boolean {
    const { x0, y0, x1, y1 } = this.plotRect();
    return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
  }

  // ── Event binding ───────────────────────────────────────────────────────────

  private setupEvents() {
    const cvs = this.canvas;
    cvs.addEventListener('contextmenu', e => e.preventDefault());

    cvs.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [cx, cy] = this.eventPos(e);

      if (e.button === 2) {
        const hit = this.hitTest(cx, cy);
        if (hit?.kind === 'anchor') {
          const s = this.sorted();
          const si = s.findIndex(p => p._oi === hit.idx);
          if (si > 0 && si < s.length - 1) {
            this.pts.splice(hit.idx, 1);
            this.render();
            this.onChange?.(this.getPoints());
          }
        }
        return;
      }
      if (e.button !== 0) return;

      const hit = this.hitTest(cx, cy);
      if (hit) {
        this.drag = hit;
        cvs.setPointerCapture(e.pointerId);
        return;
      }

      if (this.inPlot(cx, cy)) {
        const [lx, ly] = this.toLogical(cx, cy);
        const np: CurvePoint = {
          x: Math.max(0.02, Math.min(0.98, lx)),
          y: Math.max(0, Math.min(1, ly)),
        };
        this.pts.push(np);
        this.pts.sort((a, b) => a.x - b.x);
        const idx = this.pts.indexOf(np);
        this.drag = { kind: 'anchor', idx };
        cvs.setPointerCapture(e.pointerId);
        this.render();
        this.onChange?.(this.getPoints());
      }
    });

    cvs.addEventListener('dblclick', (e) => {
      const [cx, cy] = this.eventPos(e);
      const hit = this.hitTest(cx, cy);
      if (hit?.kind === 'anchor') {
        const s = this.sorted();
        const si = s.findIndex(p => p._oi === hit.idx);
        if (si > 0 && si < s.length - 1) {
          this.pts.splice(hit.idx, 1);
          this.drag = null;
          this.render();
          this.onChange?.(this.getPoints());
        }
      }
    });

    cvs.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const [cx, cy] = this.eventPos(e);
      const [lx, ly] = this.toLogical(cx, cy);
      const { kind, idx } = this.drag;
      const pt = this.pts[idx];

      if (kind === 'anchor') {
        const s = this.sorted();
        const si = s.findIndex(p => p._oi === idx);
        const newY = Math.max(0, Math.min(1, ly));
        let newX = pt.x;
        if (si > 0 && si < s.length - 1) {
          newX = Math.max(s[si - 1].x + 0.01, Math.min(s[si + 1].x - 0.01, lx));
        }
        const ddx = newX - pt.x, ddy = newY - pt.y;
        if (pt.lx !== undefined) { pt.lx += ddx; pt.ly = pt.ly! + ddy; }
        if (pt.rx !== undefined) { pt.rx += ddx; pt.ry = pt.ry! + ddy; }
        pt.x = newX;
        pt.y = newY;

      } else {
        // Handle drag — always mirror opposite handle across anchor
        const ax = pt.x, ay = pt.y;
        if (kind === 'handleR') {
          pt.rx = lx;          pt.ry = ly;
          pt.lx = 2 * ax - lx; pt.ly = 2 * ay - ly;
        } else {
          pt.lx = lx;          pt.ly = ly;
          pt.rx = 2 * ax - lx; pt.ry = 2 * ay - ly;
        }
      }

      this.render();
      this.onChange?.(this.getPoints());
    });

    cvs.addEventListener('pointerup', (e) => {
      this.drag = null;
      cvs.releasePointerCapture(e.pointerId);
    });
    cvs.addEventListener('pointercancel', () => { this.drag = null; });
  }

  // ── Sizing ──────────────────────────────────────────────────────────────────

  private initResize() {
    const sync = () => {
      const w = this.canvas.clientWidth;
      if (!w) return;
      this.canvas.width  = w;
      this.canvas.height = w;
      this.W = w;
      this.render();
    };
    new ResizeObserver(sync).observe(this.canvas);
    requestAnimationFrame(sync);
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  render() {
    const { canvas, W } = this;
    if (!W) return;
    const ctx = canvas.getContext('2d')!;
    const isLight = document.documentElement.dataset.theme === 'light';
    const { x0, y0, x1, y1, pw, ph } = this.plotRect();

    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = isLight ? '#e4e4ed' : '#16161e';
    ctx.fillRect(0, 0, W, W);

    ctx.fillStyle = isLight ? '#c8c8d6' : '#0c0c12';
    ctx.fillRect(x0, y0, pw, ph);

    // Grid
    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    for (let g = 1; g < 4; g++) {
      const gx = x0 + (g / 4) * pw;
      const gy = y0 + (g / 4) * ph;
      ctx.beginPath(); ctx.moveTo(gx, y0); ctx.lineTo(gx, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x0, gy); ctx.lineTo(x1, gy); ctx.stroke();
    }

    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, pw, ph);

    // Axis labels
    const fs = Math.max(8, W / 22 | 0);
    ctx.font = `${fs}px sans-serif`;
    const lc = isLight ? 'rgba(20,20,50,0.5)' : 'rgba(200,200,230,0.45)';
    ctx.fillStyle = lc;

    ctx.textAlign    = 'right';  ctx.textBaseline = 'top';
    ctx.fillText('0%', x0 - 2, y1);
    ctx.textAlign    = 'right';  ctx.textBaseline = 'bottom';
    ctx.fillText('100%', x0 - 2, y0);
    ctx.textAlign    = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('100%', x1, y1 + 3);
    ctx.fillText(this.xLabel, x0 + pw / 2, y1 + 3);

    ctx.save();
    ctx.translate(4, y0 + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = lc;
    ctx.font = `${fs}px sans-serif`;
    ctx.fillText('出力', 0, 0);
    ctx.restore();

    // Linear reference (dotted)
    ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.22)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    const [dlx, dly] = this.toCanvas(0, 0);
    const [drx, dry] = this.toCanvas(1, 1);
    ctx.moveTo(dlx, dly); ctx.lineTo(drx, dry);
    ctx.stroke();
    ctx.setLineDash([]);

    // ── Bezier curve ──────────────────────────────────────────────────────────
    const s = this.sorted();
    ctx.strokeStyle = '#5b8fff';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    const [s0x, s0y] = this.toCanvas(s[0].x, s[0].y);
    ctx.moveTo(s0x, s0y);
    for (let i = 0; i < s.length - 1; i++) {
      const { p1, p2 } = segCtrl(s, i);
      const [c1x, c1y] = this.toCanvas(p1.x, p1.y);
      const [c2x, c2y] = this.toCanvas(p2.x, p2.y);
      const [epx, epy] = this.toCanvas(s[i + 1].x, s[i + 1].y);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, epx, epy);
    }
    ctx.stroke();

    // ── Handles and anchors ───────────────────────────────────────────────────
    const hr = this.hr();
    const hw = this.hw();

    const drawHandle = (h: Ctrl, oi: number, kind: DragKind, ax: number, ay: number) => {
      const [hx, hy] = this.toCanvas(h.x, h.y);
      const active = this.drag?.kind === kind && this.drag.idx === oi;
      ctx.strokeStyle = 'rgba(255,180,100,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle   = active ? '#ffb060' : 'rgba(255,180,100,0.85)';
      ctx.strokeStyle = active ? '#ffd080' : 'rgba(255,200,100,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    };

    for (let si = 0; si < s.length; si++) {
      const [ax, ay] = this.toCanvas(s[si].x, s[si].y);
      const oi = s[si]._oi;
      if (si > 0)              drawHandle(this.computedHandle(s, si, 'L'), oi, 'handleL', ax, ay);
      if (si < s.length - 1)  drawHandle(this.computedHandle(s, si, 'R'), oi, 'handleR', ax, ay);

      const active = this.drag?.kind === 'anchor' && this.drag.idx === oi;
      ctx.shadowColor = active ? 'rgba(255,144,64,0.7)' : 'rgba(91,143,255,0.5)';
      ctx.shadowBlur  = active ? 8 : 4;
      ctx.fillStyle   = active ? '#ff9040' : (isLight ? '#ffffff' : '#dce0ff');
      ctx.fillRect(ax - hw, ay - hw, hw * 2, hw * 2);
      ctx.shadowBlur  = 0;
      ctx.strokeStyle = active ? '#ff9040' : '#5b8fff';
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(ax - hw, ay - hw, hw * 2, hw * 2);
    }
    ctx.shadowBlur = 0;
  }
}
