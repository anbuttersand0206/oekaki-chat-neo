import { StrokeSettings, BrushConfig, ParamId } from '../types';
import { evalCurve } from '../ui/CurveEditor';

// ── Internal dab state ────────────────────────────────────────────────────────
interface State {
  prevX: number; prevY: number; prevP: number;
  distAccum: number;
  wetR: number; wetG: number; wetB: number; wetInit: boolean;
  rng: number;
  dirX: number; dirY: number;
}

function mkState(): State {
  return { prevX:0, prevY:0, prevP:0.5, distAccum:0,
           wetR:255, wetG:255, wetB:255, wetInit:false, rng:0xDEADBEEF,
           dirX:1, dirY:0 };
}

function nextRng(s: State): number {
  s.rng = Math.imul(s.rng, 1664525) + 1013904223 | 0;
  return ((s.rng >>> 1) / 0x40000000) * 2 - 1;
}

function resolveParam(s: State, pid: ParamId, base: number, pressure: number, normSpeed: number,
                      cfg: BrushConfig): number {
  const m = cfg.modifiers[pid];
  let mult = evalCurve(m.pressureCurve, pressure) * evalCurve(m.speedCurve, normSpeed);
  if (m.randomAmount > 0) mult *= (1 + m.randomAmount * nextRng(s));
  return base * mult;
}

function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function softAlpha(d: number, hardness: number): number {
  if (d >= 1) return 0;
  if (hardness >= 1 || d <= hardness) return 1;
  const t = (d - hardness) / (1 - hardness);
  return Math.exp(-4 * t * t); // Gaussian falloff
}

function paperNoise(cx: number, cy: number): number {
  let h = (Math.imul(cx, 2654435761) ^ Math.imul(cy, 2246822519)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b) >>> 0; h ^= h >>> 16;
  let h2 = (Math.imul((cx>>1), 2654435761) ^ Math.imul((cy>>1), 2246822519)) >>> 0;
  h2 ^= h2 >>> 16; h2 = Math.imul(h2, 0x45d9f3b) >>> 0; h2 ^= h2 >>> 16;
  return ((h & 0xFF) / 255 * 0.6) + ((h2 & 0xFF) / 255 * 0.4);
}

function texSample(tex: ImageData, cx: number, cy: number): number {
  const tx = ((cx % tex.width)  + tex.width)  % tex.width  | 0;
  const ty = ((cy % tex.height) + tex.height) % tex.height | 0;
  const i = (ty * tex.width + tx) * 4;
  return (tex.data[i]*0.299 + tex.data[i+1]*0.587 + tex.data[i+2]*0.114) / 255;
}

// ── BrushEngine class ─────────────────────────────────────────────────────────

export class BrushEngine {
  private state: State = mkState();

  // ── Per-stroke snapshot + per-pixel max-alpha buffer ──────────────────────────
  private preStrokeImg: ImageData | null = null;
  private strokeAlphaBuf: Float32Array | null = null;

  constructor(private ctx: CanvasRenderingContext2D) {}

  dispose() {}  // no-op — for interface parity with WasmBrushEngine

  beginStroke(x: number, y: number, pressure: number, _speed: number, s: StrokeSettings) {
    this.state = mkState();
    this.state.prevX = x; this.state.prevY = y; this.state.prevP = pressure;

    const CW = this.ctx.canvas.width, CH = this.ctx.canvas.height;
    this.preStrokeImg = this.ctx.getImageData(0, 0, CW, CH);
    const len = CW * CH;
    if (!this.strokeAlphaBuf || this.strokeAlphaBuf.length !== len) {
      this.strokeAlphaBuf = new Float32Array(len);
    } else {
      this.strokeAlphaBuf.fill(0);
    }
    this.putDab(x, y, pressure, 0, s);
  }

  strokeTo(x: number, y: number, pressure: number, speed: number, s: StrokeSettings) {
    const dx = x - this.state.prevX;
    const dy = y - this.state.prevY;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return;

    this.state.dirX = dx / dist;
    this.state.dirY = dy / dist;

    const ns  = clamp01(speed / 1000);
    const sz  = Math.max(0.01, resolveParam(this.state, 'size',    s.brushConfig.size,    pressure, ns, s.brushConfig));
    const spc = Math.max(0.01, resolveParam(this.state, 'spacing', s.brushConfig.spacing, pressure, ns, s.brushConfig));
    const spacing = Math.max(1, spc * sz);

    const steps = Math.ceil(dist / spacing);
    const leftover = spacing - (this.state.distAccum % spacing);
    const startFrac = leftover / dist;

    for (let i = 0; i < steps; i++) {
      const t = startFrac + (i / steps) * (1 - startFrac);
      if (t > 1) break;
      const cx = this.state.prevX + dx * t;
      const cy = this.state.prevY + dy * t;
      const cp = this.state.prevP + (pressure - this.state.prevP) * t;
      this.putDab(cx, cy, cp, speed, s);
    }

    this.state.distAccum += dist;
    this.state.prevX = x; this.state.prevY = y; this.state.prevP = pressure;
  }

  // ── Dab dispatch ────────────────────────────────────────────────────────────

  private putDab(cx: number, cy: number, pressure: number, speed: number, s: StrokeSettings) {
    const ns    = clamp01(speed / 1000);
    const cfg   = s.brushConfig;
    const szRaw = Math.max(0.01, resolveParam(this.state, 'size',    cfg.size,    pressure, ns, cfg));
    const opa   = clamp01(       resolveParam(this.state, 'opacity', cfg.opacity, pressure, ns, cfg));
    const den   = clamp01(       resolveParam(this.state, 'density', cfg.density, pressure, ns, cfg));
    const coverage = Math.min(1.0, szRaw);
    const rad   = Math.max(1.0, szRaw) * 0.5;
    const alpha = opa * den * coverage;

    switch (cfg.type) {
      case 'pen':        this.dabPen       (cx, cy, rad, alpha, s); break;
      case 'marker':     this.dabMarker    (cx, cy, rad, alpha, s); break;
      case 'pencil':     this.dabPencil    (cx, cy, rad, alpha, s); break;
      case 'crayon':     this.dabCrayon    (cx, cy, rad, alpha, s); break;
      case 'airbrush':   this.dabAirbrush  (cx, cy, rad, alpha, s); break;
      case 'watercolor': this.dabWatercolor(cx, cy, rad, alpha, s); break;
      case 'oil':        this.dabOil       (cx, cy, rad, alpha, s); break;
      case 'pastel':     this.dabPastel    (cx, cy, rad, alpha, s); break;
      case 'blur':       this.dabBlur      (cx, cy, rad, alpha, s); break;
    }
  }

  // ── Per-type dabs ────────────────────────────────────────────────────────────

  private patchDab(cx: number, cy: number, rad: number,
                   extra: number, s: StrokeSettings,
                   fn: (img: ImageData, ox: number, oy: number) => void) {
    const CCTX = this.ctx;
    const CW = CCTX.canvas.width, CH = CCTX.canvas.height;
    const r = Math.ceil(rad + extra + 1);
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(CW, Math.ceil(cx + r));
    const y1 = Math.min(CH, Math.ceil(cy + r));
    const pw = x1 - x0, ph = y1 - y0;
    if (pw <= 0 || ph <= 0) return;
    const img = CCTX.getImageData(x0, y0, pw, ph);
    fn(img, x0, y0);
    CCTX.putImageData(img, x0, y0);
  }

  private blendPx(d: Uint8ClampedArray, pw: number, ph: number,
                  lx: number, ly: number,
                  r: number, g: number, b: number, alpha: number, eraser: boolean) {
    if (lx < 0 || ly < 0 || lx >= pw || ly >= ph) return;
    if (alpha <= 0.003) return;
    alpha = clamp01(alpha);
    const idx = (ly * pw + lx) * 4;
    if (eraser) {
      d[idx+3] = Math.round(Math.max(0, d[idx+3] * (1 - alpha)));
      return;
    }
    const da = d[idx+3] / 255;
    const sa = alpha;
    const outA = sa + da * (1 - sa);
    if (outA < 1e-5) { d[idx+3] = 0; return; }
    const inv = 1 / outA;
    d[idx+0] = (r * sa + d[idx+0] * da * (1 - sa)) * inv;
    d[idx+1] = (g * sa + d[idx+1] * da * (1 - sa)) * inv;
    d[idx+2] = (b * sa + d[idx+2] * da * (1 - sa)) * inv;
    d[idx+3] = outA * 255;
  }

  // Max-alpha variant: only writes if new alpha exceeds the per-pixel maximum seen
  // so far this stroke; always composites against the pre-stroke snapshot.
  private blendPxBuf(d: Uint8ClampedArray, pw: number, ph: number,
                     lx: number, ly: number, ox: number, oy: number,
                     r: number, g: number, b: number, alpha: number, eraser: boolean) {
    if (lx < 0 || ly < 0 || lx >= pw || ly >= ph) return;
    if (alpha <= 0.003) return;
    alpha = clamp01(alpha);

    const pre  = this.preStrokeImg;
    const abuf = this.strokeAlphaBuf;
    if (!pre || !abuf) {
      this.blendPx(d, pw, ph, lx, ly, r, g, b, alpha, eraser);
      return;
    }

    const CW = this.ctx.canvas.width;
    const gx = lx + ox, gy = ly + oy;
    const bi = gy * CW + gx;
    if (alpha <= abuf[bi]) return; // already painted at higher alpha — skip
    abuf[bi] = alpha;

    const pi = bi * 4;
    const li = (ly * pw + lx) * 4;

    if (eraser) {
      d[li+0] = pre.data[pi+0];
      d[li+1] = pre.data[pi+1];
      d[li+2] = pre.data[pi+2];
      d[li+3] = Math.round(Math.max(0, pre.data[pi+3] * (1 - alpha)));
    } else {
      const da = pre.data[pi+3] / 255;
      const sa = alpha;
      const outA = sa + da * (1 - sa);
      if (outA < 1e-5) { d[li+3] = 0; return; }
      const inv = 1 / outA;
      d[li+0] = (r * sa + pre.data[pi+0] * da * (1-sa)) * inv;
      d[li+1] = (g * sa + pre.data[pi+1] * da * (1-sa)) * inv;
      d[li+2] = (b * sa + pre.data[pi+2] * da * (1-sa)) * inv;
      d[li+3] = outA * 255;
    }
  }

  // aa=1 for interior pixels; linearly fades 1→0 over the outer 0.5px ring (sub-pixel AA)
  private iterCircle(cx: number, cy: number, rad: number, ox: number, oy: number,
                     pw: number, ph: number,
                     fn: (lx: number, ly: number, d: number, aa: number) => void) {
    const x0 = Math.max(0, Math.floor(cx - ox - rad - 1)) | 0;
    const y0 = Math.max(0, Math.floor(cy - oy - rad - 1)) | 0;
    const x1 = Math.min(pw - 1, Math.ceil(cx - ox + rad + 1)) | 0;
    const y1 = Math.min(ph - 1, Math.ceil(cy - oy + rad + 1)) | 0;
    const r2 = rad * rad;
    const outer = rad + 0.5;
    const outerR2 = outer * outer;
    for (let ly = y0; ly <= y1; ly++) {
      for (let lx = x0; lx <= x1; lx++) {
        const dx = (lx + ox) - cx;
        const dy = (ly + oy) - cy;
        const d2 = dx*dx + dy*dy;
        if (d2 > outerR2) continue;
        const dist = Math.sqrt(d2);
        // Linear coverage: 1.0 inside radius, fades to 0 at radius+0.5
        const aa = d2 > r2 ? Math.max(0, outer - dist) * 2 : 1;
        fn(lx, ly, dist / rad, aa);
      }
    }
  }

  // N×N oversampled circle with two-zone hardness.
  // Zone 1 — inner core (d <= hardness*r): full coverage.
  // Zone 2 — outer edge (hardness*r < d < r): cubic smoothstep falloff.
  //   s = (d - innerR) / (r - innerR),  coverage = 1 - s²(3 - 2s)
  private iterCircleDab(
    cx: number, cy: number, rad: number,
    ox: number, oy: number, pw: number, ph: number,
    hardness: number,
    fn: (lx: number, ly: number, alpha: number) => void
  ): void {
    const N      = rad < 3 ? 11 : rad < 15 ? 5 : 3;
    const rr     = rad * rad;
    const isHard = hardness >= 0.999;
    const innerR = rad * hardness;
    const innerRR= innerR * innerR;
    const edgeW  = rad - innerR + 1e-6;

    const x0 = Math.max(0, Math.floor(cx - ox - rad)) | 0;
    const y0 = Math.max(0, Math.floor(cy - oy - rad)) | 0;
    const x1 = Math.min(pw - 1, Math.ceil(cx - ox + rad)) | 0;
    const y1 = Math.min(ph - 1, Math.ceil(cy - oy + rad)) | 0;

    const invN  = 1 / N;
    const invNN = 1 / (N * N);

    for (let ly = y0; ly <= y1; ly++) {
      for (let lx = x0; lx <= x1; lx++) {
        let sum = 0;
        for (let iy = 0; iy < N; iy++) {
          const py  = ly + oy + (iy + 0.5) * invN;
          const dy2 = (py - cy) * (py - cy);
          if (dy2 >= rr) continue;
          for (let ix = 0; ix < N; ix++) {
            const px = lx + ox + (ix + 0.5) * invN;
            const d2 = (px - cx) * (px - cx) + dy2;
            if (d2 >= rr) continue;
            if (isHard || d2 <= innerRR) {
              sum += 1;
            } else {
              const s = Math.min(1, (Math.sqrt(d2) - innerR) / edgeW);
              sum += 1 - s * s * (3 - 2 * s); // cubic smoothstep
            }
          }
        }
        if (sum > 0) fn(lx, ly, sum * invNN);
      }
    }
  }

  private avgColor(d: Uint8ClampedArray, pw: number, ph: number,
                   cx: number, cy: number, rad: number, ox: number, oy: number) {
    const sr = Math.max(1, rad * 0.4 | 0);
    const x0 = Math.max(0, (cx - ox - sr) | 0);
    const y0 = Math.max(0, (cy - oy - sr) | 0);
    const x1 = Math.min(pw-1, (cx - ox + sr) | 0);
    const y1 = Math.min(ph-1, (cy - oy + sr) | 0);
    let rr=0, gg=0, bb=0, cnt=0;
    for (let y=y0; y<=y1; y++) for (let x=x0; x<=x1; x++) {
      const i = (y*pw+x)*4; rr+=d[i]; gg+=d[i+1]; bb+=d[i+2]; cnt++;
    }
    return cnt ? [rr/cnt, gg/cnt, bb/cnt] : [255,255,255];
  }

  // Reads average colour from a full-canvas ImageData (global pixel coordinates)
  private avgColorGlobal(src: ImageData, cx: number, cy: number, rad: number): [number, number, number] {
    const CW = src.width, CH = src.height;
    const sr = Math.max(1, rad * 0.4 | 0);
    const x0 = Math.max(0, (cx - sr) | 0);
    const y0 = Math.max(0, (cy - sr) | 0);
    const x1 = Math.min(CW - 1, (cx + sr) | 0);
    const y1 = Math.min(CH - 1, (cy + sr) | 0);
    let r = 0, g = 0, b = 0, cnt = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * CW + x) * 4; r += src.data[i]; g += src.data[i+1]; b += src.data[i+2]; cnt++;
    }
    return cnt ? [r/cnt, g/cnt, b/cnt] : [255, 255, 255];
  }

  // ── Pen ──────────────────────────────────────────────────────────────────────
  private dabPen(cx: number, cy: number, rad: number, opa: number, s: StrokeSettings) {
    const { hardness } = s.brushConfig;
    const [r, g, b] = s.color;
    this.patchDab(cx, cy, rad, 0, s, (img, ox, oy) => {
      this.iterCircleDab(cx, cy, rad, ox, oy, img.width, img.height, hardness, (lx, ly, alpha) => {
        const a = alpha * opa;
        if (a <= 0.003) return;
        this.blendPxBuf(img.data, img.width, img.height, lx, ly, ox, oy, r, g, b, a, s.eraser);
      });
    });
  }

  // ── Marker ──────────────────────────────────────────────────────────────────
  private dabMarker(cx: number, cy: number, rad: number, opa: number, s: StrokeSettings) {
    const [r, g, b] = s.color;
    const { hardness } = s.brushConfig;
    this.patchDab(cx, cy, rad, 0, s, (img, ox, oy) => {
      this.iterCircleDab(cx, cy, rad, ox, oy, img.width, img.height, hardness, (lx, ly, alpha) => {
        this.blendPxBuf(img.data, img.width, img.height, lx, ly, ox, oy,
                        r, g, b, alpha * opa * 0.85, s.eraser);
      });
    });
  }

  // ── Pencil ──────────────────────────────────────────────────────────────────
  private dabPencil(cx: number, cy: number, rad: number, opa: number, s: StrokeSettings) {
    this.patchDab(cx, cy, rad, 0, s, (img, ox, oy) => {
      const [r,g,b] = s.color;
      const { hardness } = s.brushConfig;
      this.iterCircle(cx, cy, rad, ox, oy, img.width, img.height, (lx, ly, d, aa) => {
        const grain = s.texture
          ? texSample(s.texture, lx+ox, ly+oy)
          : paperNoise(lx+ox, ly+oy);
        const a = softAlpha(d, hardness) * (grain * 0.8 + 0.2) * opa * aa;
        this.blendPxBuf(img.data, img.width, img.height, lx, ly, ox, oy, r, g, b, a, s.eraser);
      });
    });
  }

  // ── Crayon ──────────────────────────────────────────────────────────────────
  private dabCrayon(cx: number, cy: number, rad: number, opa: number, s: StrokeSettings) {
    this.patchDab(cx, cy, rad, 0, s, (img, ox, oy) => {
      const [r,g,b] = s.color;
      const { hardness } = s.brushConfig;
      const pre = this.preStrokeImg;
      const CW  = this.ctx.canvas.width;
      this.iterCircle(cx, cy, rad, ox, oy, img.width, img.height, (lx, ly, d, aa) => {
        const grain = s.texture
          ? texSample(s.texture, lx+ox, ly+oy)
          : paperNoise(lx+ox, ly+oy);
        const a = softAlpha(d, hardness) * (grain * grain) * opa * aa;
        if (a < 0.005) return;
        // Read wax base color from pre-stroke snapshot (avoids false tinting from accumulated dabs)
        const wax = 0.3;
        let fr, fg, fb;
        if (pre) {
          const pi = ((ly + oy) * CW + (lx + ox)) * 4;
          fr = lerp(r, pre.data[pi],   wax);
          fg = lerp(g, pre.data[pi+1], wax);
          fb = lerp(b, pre.data[pi+2], wax);
        } else {
          const idx = (ly * img.width + lx) * 4;
          fr = lerp(r, img.data[idx],   wax);
          fg = lerp(g, img.data[idx+1], wax);
          fb = lerp(b, img.data[idx+2], wax);
        }
        this.blendPxBuf(img.data, img.width, img.height, lx, ly, ox, oy, fr, fg, fb, a, false);
      });
    });
  }

  // ── Airbrush ─────────────────────────────────────────────────────────────────
  // Gaussian falloff with optional core. coreRad = rad * hardness.
  private dabAirbrush(cx: number, cy: number, rad: number, opa: number, s: StrokeSettings) {
    const [r, g, b] = s.color;
    const coreRad  = rad * s.brushConfig.hardness;
    const sigma    = Math.max(1, (rad - coreRad) * 0.6);
    const totalRad = coreRad + sigma * 3;

    this.patchDab(cx, cy, totalRad, 0, s, (img, ox, oy) => {
      this.iterCircle(cx, cy, totalRad, ox, oy, img.width, img.height, (lx, ly, d, aa) => {
        const distPx = d * totalRad; 
        const alpha = (distPx <= coreRad
          ? opa
          : Math.exp(-0.5 * ((distPx - coreRad) / sigma) ** 2) * opa
        ) * aa;
        if (alpha <= 0.003) return;
        this.blendPxBuf(img.data, img.width, img.height, lx, ly, ox, oy, r, g, b, alpha, s.eraser);
      });
    });
  }

  // ── Watercolor ───────────────────────────────────────────────────────────────
  private dabWatercolor(cx: number, cy: number, rad: number, opa: number, s: StrokeSettings) {
    const water = s.brushConfig.water;
    const flow  = water * opa * 0.55;

    this.patchDab(cx, cy, rad, 0, s, (img, ox, oy) => {
      const pre = this.preStrokeImg;
      const [avgR, avgG, avgB] = pre
        ? this.avgColorGlobal(pre, cx, cy, rad * 0.6)
        : this.avgColor(img.data, img.width, img.height, cx, cy, rad, ox, oy);
      const st = this.state;
      if (!st.wetInit) { st.wetR=avgR; st.wetG=avgG; st.wetB=avgB; st.wetInit=true; }

      const sp = s.brushConfig.spread;
      const mx = s.brushConfig.mixing;
      st.wetR = lerp(avgR, st.wetR, sp * 0.5); st.wetR = lerp(st.wetR, s.color[0], mx * 0.7);
      st.wetG = lerp(avgG, st.wetG, sp * 0.5); st.wetG = lerp(st.wetG, s.color[1], mx * 0.7);
      st.wetB = lerp(avgB, st.wetB, sp * 0.5); st.wetB = lerp(st.wetB, s.color[2], mx * 0.7);

      this.iterCircle(cx, cy, rad, ox, oy, img.width, img.height, (lx, ly, normInner, aa) => {
        const g   = Math.exp(-3 * normInner * normInner);
        const rim = Math.exp(-30 * (normInner - 0.7) ** 2) * 0.35;

        // Sharper edge cutoff to remove "haze"
        const edge = clamp01((1 - normInner) * 10);
        let a = (g + rim) * flow * edge;

        if (s.texture) a *= texSample(s.texture, lx+ox, ly+oy) * 0.35 + 0.65;
        if (a > 0.003) {
          this.blendPxBuf(img.data, img.width, img.height, lx, ly, ox, oy,
                          st.wetR, st.wetG, st.wetB, a * aa, false);
        }
      });
    });
  }

  // ── Oil ── round tip, wet color mixing ────────────────────────────────────────
  private dabOil(cx: number, cy: number, rad: number, opa: number, s: StrokeSettings) {
    const cfg = s.brushConfig;
    const sp = cfg.spread, mx = cfg.mixing;

    this.patchDab(cx, cy, rad, 0, s, (img, ox, oy) => {
      const pre = this.preStrokeImg;
      const [avgR, avgG, avgB] = pre
        ? this.avgColorGlobal(pre, cx, cy, rad * 0.35)
        : this.avgColor(img.data, img.width, img.height, cx, cy, rad * 0.35, ox, oy);
      const st = this.state;
      if (!st.wetInit) { st.wetR=s.color[0]; st.wetG=s.color[1]; st.wetB=s.color[2]; st.wetInit=true; }

      st.wetR = lerp(lerp(st.wetR, avgR, sp * 0.45), s.color[0], mx * 0.55);
      st.wetG = lerp(lerp(st.wetG, avgG, sp * 0.45), s.color[1], mx * 0.55);
      st.wetB = lerp(lerp(st.wetB, avgB, sp * 0.45), s.color[2], mx * 0.55);

      const h = clamp01(cfg.hardness - cfg.water * 0.2);
      this.iterCircle(cx, cy, rad, ox, oy, img.width, img.height, (lx, ly, d, aa) => {
        const a = softAlpha(d, h) * opa * aa;
        this.blendPxBuf(img.data, img.width, img.height, lx, ly, ox, oy, st.wetR, st.wetG, st.wetB, a, false);
      });
    });
  }

  // ── Pastel ────────────────────────────────────────────────────────────────────
  private dabPastel(cx: number, cy: number, rad: number, opa: number, s: StrokeSettings) {
    this.patchDab(cx, cy, rad, 0, s, (img, ox, oy) => {
      const [r,g,b] = s.color;
      const { hardness } = s.brushConfig;
      this.iterCircle(cx, cy, rad, ox, oy, img.width, img.height, (lx, ly, d, aa) => {
        const grain = s.texture
          ? texSample(s.texture, lx+ox, ly+oy)
          : paperNoise(lx+ox, ly+oy);
        const texOpa = (1 - grain) * 0.65 + grain * 0.35;
        const a = softAlpha(d, hardness) * texOpa * opa * 0.7 * aa;
        this.blendPxBuf(img.data, img.width, img.height, lx, ly, ox, oy, r, g, b, a, false);
      });
    });
  }

  // ── Blur — max-strength per pixel prevents over-blurring in overlapping areas ─
  private dabBlur(cx: number, cy: number, rad: number, opa: number, s: StrokeSettings) {
    const pre  = this.preStrokeImg;
    const sbuf = this.strokeAlphaBuf;

    if (!pre || !sbuf) {
      // Fallback
      const blurKR = Math.max(1, rad * 0.2 | 0);
      this.patchDab(cx, cy, rad, blurKR, s, (img, ox, oy) => {
        const src = new Uint8ClampedArray(img.data);
        const pw = img.width, ph = img.height;
        this.iterCircle(cx, cy, rad, ox, oy, pw, ph, (lx, ly, d, edgeAA) => {
          const strength = softAlpha(d, 0) * opa * edgeAA;
          if (strength < 0.005) return;
          let rr=0, gg=0, bb=0, ba=0, cnt=0;
          for (let ky=ly-blurKR; ky<=ly+blurKR; ky++) {
            if (ky<0||ky>=ph) continue;
            for (let kx=lx-blurKR; kx<=lx+blurKR; kx++) {
              if (kx<0||kx>=pw) continue;
              const ki = (ky*pw+kx)*4;
              rr+=src[ki]; gg+=src[ki+1]; bb+=src[ki+2]; ba+=src[ki+3]; cnt++;
            }
          }
          if (!cnt) return;
          const i = (ly*pw+lx)*4;
          img.data[i+0] = lerp(img.data[i+0], rr/cnt, strength);
          img.data[i+1] = lerp(img.data[i+1], gg/cnt, strength);
          img.data[i+2] = lerp(img.data[i+2], bb/cnt, strength);
          img.data[i+3] = lerp(img.data[i+3], ba/cnt, strength);
        });
      });
      return;
    }

    const blurKR = Math.max(1, rad * 0.2 | 0);
    const CW = this.ctx.canvas.width, CH = this.ctx.canvas.height;

    this.patchDab(cx, cy, rad, blurKR, s, (img, ox, oy) => {
      const pw = img.width, ph = img.height;
      this.iterCircle(cx, cy, rad, ox, oy, pw, ph, (lx, ly, d, edgeAA) => {
        const strength = softAlpha(d, 0) * opa * edgeAA;
        if (strength < 0.005) return;

        const gx = lx + ox, gy = ly + oy;
        const bi = gy * CW + gx;
        if (strength <= sbuf[bi]) return; // already blurred at higher strength — skip
        sbuf[bi] = strength;

        // Box-blur using pre-stroke pixels (prevents compounding across dabs)
        let rr=0, gg=0, bb=0, ba=0, cnt=0;
        for (let ky = gy - blurKR; ky <= gy + blurKR; ky++) {
          if (ky < 0 || ky >= CH) continue;
          for (let kx = gx - blurKR; kx <= gx + blurKR; kx++) {
            if (kx < 0 || kx >= CW) continue;
            const ki = (ky * CW + kx) * 4;
            rr += pre.data[ki]; gg += pre.data[ki+1]; bb += pre.data[ki+2]; ba += pre.data[ki+3]; cnt++;
          }
        }
        if (!cnt) return;

        const pi = bi * 4;
        const li = (ly * pw + lx) * 4;
        img.data[li+0] = lerp(pre.data[pi+0], rr/cnt, strength);
        img.data[li+1] = lerp(pre.data[pi+1], gg/cnt, strength);
        img.data[li+2] = lerp(pre.data[pi+2], bb/cnt, strength);
        img.data[li+3] = lerp(pre.data[pi+3], ba/cnt, strength);
      });
    });
  }

  // ── Static replay (for remote/undo) ──────────────────────────────────────────
  static replay(ctx: CanvasRenderingContext2D,
                points: { x: number; y: number; p: number; sp?: number }[],
                s: StrokeSettings) {
    if (!points.length) return;
    const eng = new BrushEngine(ctx);
    eng.beginStroke(points[0].x, points[0].y, points[0].p, points[0].sp ?? 0, s);
    for (let i = 1; i < points.length; i++) {
      eng.strokeTo(points[i].x, points[i].y, points[i].p, points[i].sp ?? 0, s);
    }
  }
}
