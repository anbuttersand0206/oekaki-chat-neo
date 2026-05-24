import { StrokeSettings, BrushConfig, ParamId } from '../types';
import { evalCurve } from '../ui/CurveEditor';

// ── Internal dab state ────────────────────────────────────────────────────────
interface State {
  prevX: number;
  prevY: number;
  prevP: number;
  dirX:  number;
  dirY:  number;
  distAccum: number;
  wetInit:   boolean;
  wetR: number;
  wetG: number;
  wetB: number;
  rng:  number;
}

function mkState(): State {
  return {
    prevX: 0, prevY: 0, prevP: 0,
    dirX: 1, dirY: 0, distAccum: 0,
    wetInit: false, wetR: 0, wetG: 0, wetB: 0,
    rng: Math.floor(Math.random() * 0xFFFFFFFF)
  };
}

function nextRng(s: State): number {
  s.rng = Math.imul(48271, s.rng) | 0;
  return (s.rng & 0x7fffffff) / 0x7fffffff * 2 - 1;
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
  let t = (d - hardness) / (1 - hardness + 1e-7);
  t = t * t * t * (t * (t * 6 - 15) + 10); // quintic smoothstep
  return 1 - t;
}

function paperNoise(x: number, y: number): number {
  const h = Math.imul(x, 2654435761) ^ Math.imul(y, 2246822519);
  const h2 = (h ^ (h >>> 16));
  const h3 = Math.imul(h2, 0x45d9f3b);
  const final = (h3 ^ (h3 >>> 16)) & 0xFF;
  return final / 255;
}

/**
 * The BrushEngine is the TypeScript fallback drawing implementation.
 * Opacity applies to the whole stroke: all dabs accumulate into strokeBuf at full
 * density, then strokeBuf is composited against preStrokeImg with opa as the
 * stroke-level alpha multiplier. Density controls per-dab alpha independently.
 */
export class BrushEngine {
  private state: State = mkState();
  private preStrokeImg: ImageData | null = null;
  private strokeBuf: Uint8ClampedArray | null = null;   // accumulated dabs, transparent bg
  private strokeAlphaBuf: Float32Array | null = null;   // for blur anti-overdraw

  constructor(private ctx: CanvasRenderingContext2D) {}

  dispose() {}

  beginStroke(x: number, y: number, pressure: number, speed: number, s: StrokeSettings) {
    this.state = mkState();
    this.state.prevX = x; this.state.prevY = y; this.state.prevP = pressure;
    const CW = this.ctx.canvas.width, CH = this.ctx.canvas.height;
    this.preStrokeImg = this.ctx.getImageData(0, 0, CW, CH);
    const len4 = CW * CH * 4;
    if (!this.strokeBuf || this.strokeBuf.length !== len4) {
      this.strokeBuf = new Uint8ClampedArray(len4);
    } else {
      this.strokeBuf.fill(0);
    }
    const len = CW * CH;
    if (!this.strokeAlphaBuf || this.strokeAlphaBuf.length !== len) {
      this.strokeAlphaBuf = new Float32Array(len);
    } else {
      this.strokeAlphaBuf.fill(0);
    }
    this.putDab(x, y, pressure, speed, s);
  }

  strokeTo(x: number, y: number, pressure: number, speed: number, s: StrokeSettings) {
    const dx = x - this.state.prevX;
    const dy = y - this.state.prevY;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return;
    this.state.dirX = dx / dist; this.state.dirY = dy / dist;
    const ns = clamp01(speed / 1000);
    const cfg = s.brushConfig;
    const szEnd = Math.max(0.01, resolveParam(this.state, 'size', cfg.size, pressure, ns, cfg));
    const spc = Math.max(0.01, resolveParam(this.state, 'spacing', cfg.spacing, pressure, ns, cfg));
    const spacing = Math.max(1, spc * szEnd);
    const steps = Math.ceil(dist / spacing);
    const leftover = spacing - (this.state.distAccum % spacing);
    const startFrac = leftover / dist;
    for (let i = 0; i < steps; i++) {
      const t = startFrac + (i / steps) * (1 - startFrac);
      if (t > 1) break;
      const cp = this.state.prevP + (pressure - this.state.prevP) * t;
      this.putDab(this.state.prevX + dx * t, this.state.prevY + dy * t, cp, speed, s);
    }
    this.state.distAccum += dist; this.state.prevX = x; this.state.prevY = y; this.state.prevP = pressure;
  }

  private putDab(cx: number, cy: number, cp: number, speed: number, s: StrokeSettings) {
    const ns = clamp01(speed / 1000);
    const cfg = s.brushConfig;
    const sz = Math.max(0.01, resolveParam(this.state, 'size', cfg.size, cp, ns, cfg));
    const opa = clamp01(resolveParam(this.state, 'opacity', cfg.opacity, cp, ns, cfg));
    const den = clamp01(resolveParam(this.state, 'density', cfg.density, cp, ns, cfg));
    const rad = Math.max(1, sz) * 0.5;
    const flow = den * (sz < 1 ? sz : 1);
    switch (cfg.type) {
      case 'pen':        this.dabPen       (cx, cy, rad, flow, opa, s); break;
      case 'marker':     this.dabMarker    (cx, cy, rad, flow, opa, s); break;
      case 'pencil':     this.dabPencil    (cx, cy, rad, flow, opa, s); break;
      case 'crayon':     this.dabCrayon    (cx, cy, rad, flow, opa, s); break;
      case 'airbrush':   this.dabAirbrush  (cx, cy, rad, flow, opa, s); break;
      case 'watercolor': this.dabWatercolor(cx, cy, rad, flow, opa, s); break;
      case 'oil':        this.dabOil       (cx, cy, rad, flow, opa, s); break;
      case 'pastel':     this.dabPastel    (cx, cy, rad, flow, opa, s); break;
      case 'blur':       this.dabBlur      (cx, cy, rad, flow * opa, s); break;
    }
  }

  // Blend (r,g,b,a) into a strokeBuf patch using Porter-Duff over. r/g/b are 0-255.
  private blendPxBuf(sb: Uint8ClampedArray, pw: number, ph: number, lx: number, ly: number,
                     r: number, g: number, b: number, a: number) {
    if (lx < 0 || ly < 0 || lx >= pw || ly >= ph) return;
    const i = (ly * pw + lx) * 4;
    const da = sb[i+3] / 255, sa = a;
    const outA = sa + da * (1 - sa);
    if (outA < 1e-5) return;
    const inv = 1 / outA;
    sb[i]   = (r * sa + sb[i]   * da * (1 - sa)) * inv;
    sb[i+1] = (g * sa + sb[i+1] * da * (1 - sa)) * inv;
    sb[i+2] = (b * sa + sb[i+2] * da * (1 - sa)) * inv;
    sb[i+3] = outA * 255;
  }

  // Direct canvas read/write patch — for eraser and blur.
  private patchDabDirect(cx: number, cy: number, rad: number, extra: number,
      fn: (img: ImageData, ox: number, oy: number) => void) {
    const CW = this.ctx.canvas.width, CH = this.ctx.canvas.height, r = Math.ceil(rad + extra + 1);
    const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(CW, Math.ceil(cx + r)), y1 = Math.min(CH, Math.ceil(cy + r));
    const pw = x1 - x0, ph = y1 - y0; if (pw <= 0 || ph <= 0) return;
    const img = this.ctx.getImageData(x0, y0, pw, ph); fn(img, x0, y0); this.ctx.putImageData(img, x0, y0);
  }

  // strokeBuf patch — accumulates dab into strokeBuf, then composites to canvas.
  // fn receives: (strokeBuf patch, pw, ph, current visible canvas patch, ox, oy)
  private patchDab(cx: number, cy: number, rad: number, extra: number, opa: number,
      fn: (sbData: Uint8ClampedArray, pw: number, ph: number, visData: Uint8ClampedArray, ox: number, oy: number) => void) {
    const CW = this.ctx.canvas.width, CH = this.ctx.canvas.height;
    const r = Math.ceil(rad + extra + 1);
    const x0 = Math.max(0, Math.floor(cx - r)), y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(CW, Math.ceil(cx + r)), y1 = Math.min(CH, Math.ceil(cy + r));
    const pw = x1 - x0, ph = y1 - y0;
    if (pw <= 0 || ph <= 0) return;

    const visImg = this.ctx.getImageData(x0, y0, pw, ph);
    const sb = this.strokeBuf!;
    const sbPatch = new Uint8ClampedArray(pw * ph * 4);
    for (let py = 0; py < ph; py++) {
      const srcOff = ((y0 + py) * CW + x0) * 4;
      sbPatch.set(sb.subarray(srcOff, srcOff + pw * 4), py * pw * 4);
    }

    fn(sbPatch, pw, ph, visImg.data, x0, y0);

    for (let py = 0; py < ph; py++) {
      sb.set(sbPatch.subarray(py * pw * 4, (py + 1) * pw * 4), ((y0 + py) * CW + x0) * 4);
    }

    const pre = this.preStrokeImg!;
    const outImg = new ImageData(pw, ph);
    for (let py = 0; py < ph; py++) for (let px = 0; px < pw; px++) {
      const li = (py * pw + px) * 4;
      const gi = ((y0 + py) * CW + x0 + px) * 4;
      const sbA = sbPatch[li + 3] / 255 * opa;
      const preA = pre.data[gi + 3] / 255;
      const outA = sbA + preA * (1 - sbA);
      if (outA < 1e-5) { outImg.data[li + 3] = 0; continue; }
      const inv = 1 / outA;
      outImg.data[li]     = (sbPatch[li]     / 255 * sbA + pre.data[gi]     / 255 * preA * (1 - sbA)) * inv * 255;
      outImg.data[li + 1] = (sbPatch[li + 1] / 255 * sbA + pre.data[gi + 1] / 255 * preA * (1 - sbA)) * inv * 255;
      outImg.data[li + 2] = (sbPatch[li + 2] / 255 * sbA + pre.data[gi + 2] / 255 * preA * (1 - sbA)) * inv * 255;
      outImg.data[li + 3] = outA * 255;
    }
    this.ctx.putImageData(outImg, x0, y0);
  }

  private iterCircleDab(cx: number, cy: number, rad: number, ox: number, oy: number, pw: number, ph: number, hardness: number, fn: (lx: number, ly: number, a: number) => void) {
    const N = rad < 3 ? 11 : rad < 15 ? 5 : 3, invN = 1 / N, invNN = 1 / (N * N), rr = rad * rad, iR = rad * hardness, iRR = iR * iR, eW = rad - iR + 1e-6;
    const x0 = Math.max(0, Math.floor(cx - ox - rad)) | 0, y0 = Math.max(0, Math.floor(cy - oy - rad)) | 0, x1 = Math.min(pw - 1, Math.ceil(cx - ox + rad)) | 0, y1 = Math.min(ph - 1, Math.ceil(cy - oy + rad)) | 0;
    for (let ly = y0; ly <= y1; ly++) for (let lx = x0; lx <= x1; lx++) {
      let sum = 0;
      for (let iy = 0; iy < N; iy++) {
        const py = ly + oy + (iy + 0.5) * invN, dy2 = (py - cy) * (py - cy); if (dy2 >= rr) continue;
        for (let ix = 0; ix < N; ix++) {
          const px = lx + ox + (ix + 0.5) * invN, d2 = (px - cx) * (px - cx) + dy2; if (d2 >= rr) continue;
          if (d2 <= iRR) sum += 1; else { const s = Math.min(1, (Math.sqrt(d2) - iR) / eW); sum += 1 - s * s * (3 - 2 * s); }
        }
      }
      if (sum > 0) fn(lx, ly, sum * invNN);
    }
  }

  private avgColor(d: Uint8ClampedArray, pw: number, ph: number, cx: number, cy: number, rad: number, ox: number, oy: number): [number, number, number] {
    const sr = Math.max(1, rad * 0.4 | 0), x0 = Math.max(0, (cx - ox - sr) | 0), y0 = Math.max(0, (cy - oy - sr) | 0), x1 = Math.min(pw - 1, (cx - ox + sr) | 0), y1 = Math.min(ph - 1, (cy - oy + sr) | 0);
    let r = 0, g = 0, b = 0, c = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * pw + x) * 4; r += d[i]; g += d[i+1]; b += d[i+2]; c++; }
    return c ? [r/c, g/c, b/c] : [255, 255, 255];
  }

  private dabPen(cx: number, cy: number, rad: number, flow: number, opa: number, s: StrokeSettings) {
    if (s.eraser) {
      this.patchDabDirect(cx, cy, rad, 0, (img, ox, oy) => {
        this.iterCircleDab(cx, cy, rad, ox, oy, img.width, img.height, s.brushConfig.hardness, (lx, ly, a) => {
          const i = (ly * img.width + lx) * 4, t = a * flow;
          img.data[i]   += (255 - img.data[i])   * t;
          img.data[i+1] += (255 - img.data[i+1]) * t;
          img.data[i+2] += (255 - img.data[i+2]) * t;
          img.data[i+3] += (255 - img.data[i+3]) * t;
        });
      });
      return;
    }
    this.patchDab(cx, cy, rad, 0, opa, (sb, pw, ph, _vis, ox, oy) => {
      this.iterCircleDab(cx, cy, rad, ox, oy, pw, ph, s.brushConfig.hardness, (lx, ly, a) => {
        this.blendPxBuf(sb, pw, ph, lx, ly, s.color[0], s.color[1], s.color[2], a * flow);
      });
    });
  }

  private dabMarker(cx: number, cy: number, rad: number, flow: number, opa: number, s: StrokeSettings) {
    if (s.eraser) {
      this.patchDabDirect(cx, cy, rad, 0, (img, ox, oy) => {
        this.iterCircleDab(cx, cy, rad, ox, oy, img.width, img.height, s.brushConfig.hardness, (lx, ly, a) => {
          const i = (ly * img.width + lx) * 4, t = a * flow * 0.85;
          img.data[i]   += (255 - img.data[i])   * t;
          img.data[i+1] += (255 - img.data[i+1]) * t;
          img.data[i+2] += (255 - img.data[i+2]) * t;
          img.data[i+3] += (255 - img.data[i+3]) * t;
        });
      });
      return;
    }
    this.patchDab(cx, cy, rad, 0, opa, (sb, pw, ph, _vis, ox, oy) => {
      this.iterCircleDab(cx, cy, rad, ox, oy, pw, ph, s.brushConfig.hardness, (lx, ly, a) => {
        this.blendPxBuf(sb, pw, ph, lx, ly, s.color[0], s.color[1], s.color[2], a * flow * 0.85);
      });
    });
  }

  private dabPencil(cx: number, cy: number, rad: number, flow: number, opa: number, s: StrokeSettings) {
    this.patchDab(cx, cy, rad, 0, opa, (sb, pw, ph, _vis, ox, oy) => {
      const rr = rad * rad;
      for (let ly = 0; ly < ph; ly++) for (let lx = 0; lx < pw; lx++) {
        const dx = (lx + ox) - cx, dy = (ly + oy) - cy, d2 = dx * dx + dy * dy; if (d2 >= rr) continue;
        const a = softAlpha(Math.sqrt(d2) / rad, s.brushConfig.hardness) * (paperNoise(lx + ox, ly + oy) * 0.8 + 0.2) * flow;
        this.blendPxBuf(sb, pw, ph, lx, ly, s.color[0], s.color[1], s.color[2], a);
      }
    });
  }

  private dabCrayon(cx: number, cy: number, rad: number, flow: number, opa: number, s: StrokeSettings) {
    this.patchDab(cx, cy, rad, 0, opa, (sb, pw, ph, vis, ox, oy) => {
      const rr = rad * rad;
      for (let ly = 0; ly < ph; ly++) for (let lx = 0; lx < pw; lx++) {
        const dx = (lx + ox) - cx, dy = (ly + oy) - cy, d2 = dx * dx + dy * dy; if (d2 >= rr) continue;
        const a = softAlpha(Math.sqrt(d2) / rad, s.brushConfig.hardness) * paperNoise(lx + ox, ly + oy) ** 2 * flow;
        if (a < 0.005) continue;
        const i = (ly * pw + lx) * 4;
        this.blendPxBuf(sb, pw, ph, lx, ly,
          lerp(s.color[0], vis[i], 0.3), lerp(s.color[1], vis[i+1], 0.3), lerp(s.color[2], vis[i+2], 0.3), a);
      }
    });
  }

  private dabAirbrush(cx: number, cy: number, rad: number, flow: number, opa: number, s: StrokeSettings) {
    const cr = rad * s.brushConfig.hardness, sig = Math.max(1, (rad - cr) * 0.6), tr = cr + sig * 3;
    this.patchDab(cx, cy, tr, 0, opa, (sb, pw, ph, _vis, ox, oy) => {
      const tr2 = tr * tr;
      for (let ly = 0; ly < ph; ly++) for (let lx = 0; lx < pw; lx++) {
        const dx = (lx + ox) - cx, dy = (ly + oy) - cy, d2 = dx * dx + dy * dy; if (d2 > tr2) continue;
        const d = Math.sqrt(d2), a = (d <= cr ? 1 : Math.exp(-0.5 * ((d - cr) / sig) ** 2)) * flow;
        if (a > 0.003) this.blendPxBuf(sb, pw, ph, lx, ly, s.color[0], s.color[1], s.color[2], a);
      }
    });
  }

  private dabWatercolor(cx: number, cy: number, rad: number, flow: number, opa: number, s: StrokeSettings) {
    this.patchDab(cx, cy, rad, 0, opa, (sb, pw, ph, vis, ox, oy) => {
      // Sample from current visible canvas (vis) for wet mixing
      const [ar, ag, ab] = this.avgColor(vis, pw, ph, cx, cy, rad * 0.6, ox, oy);
      const st = this.state; if (!st.wetInit) { st.wetR = ar; st.wetG = ag; st.wetB = ab; st.wetInit = true; }
      st.wetR = lerp(lerp(ar, st.wetR, s.brushConfig.spread * 0.5), s.color[0], s.brushConfig.mixing * 0.7);
      st.wetG = lerp(lerp(ag, st.wetG, s.brushConfig.spread * 0.5), s.color[1], s.brushConfig.mixing * 0.7);
      st.wetB = lerp(lerp(ab, st.wetB, s.brushConfig.spread * 0.5), s.color[2], s.brushConfig.mixing * 0.7);
      const rr = rad * rad, f = s.brushConfig.water * flow * 0.55;
      for (let ly = 0; ly < ph; ly++) for (let lx = 0; lx < pw; lx++) {
        const dx = (lx + ox) - cx, dy = (ly + oy) - cy, d2 = dx * dx + dy * dy; if (d2 > rr) continue;
        const ni = Math.sqrt(d2) / rad, a = (Math.exp(-3 * ni * ni) + Math.exp(-30 * (ni - 0.7) ** 2) * 0.35) * f * clamp01((1 - ni) * 10);
        if (a > 0.003) this.blendPxBuf(sb, pw, ph, lx, ly, st.wetR, st.wetG, st.wetB, a);
      }
    });
  }

  private dabOil(cx: number, cy: number, rad: number, flow: number, opa: number, s: StrokeSettings) {
    this.patchDab(cx, cy, rad, 0, opa, (sb, pw, ph, vis, ox, oy) => {
      const [ar, ag, ab] = this.avgColor(vis, pw, ph, cx, cy, rad * 0.35, ox, oy);
      const st = this.state; if (!st.wetInit) { st.wetR = s.color[0]; st.wetG = s.color[1]; st.wetB = s.color[2]; st.wetInit = true; }
      const { spread, mixing, water, hardness } = s.brushConfig;
      st.wetR = lerp(lerp(st.wetR, ar, spread * 0.30), s.color[0], mixing * 0.80);
      st.wetG = lerp(lerp(st.wetG, ag, spread * 0.30), s.color[1], mixing * 0.80);
      st.wetB = lerp(lerp(st.wetB, ab, spread * 0.30), s.color[2], mixing * 0.80);
      const ux = st.dirX, uy = st.dirY, qx = -uy, qy = ux, ra = rad * 0.55, rp = rad, h = clamp01(hardness - water * 0.2);
      for (let ly = 0; ly < ph; ly++) for (let lx = 0; lx < pw; lx++) {
        const dx = (lx + ox) - cx, dy = (ly + oy) - cy, al = dx * ux + dy * uy, pe = dx * qx + dy * qy, ed = Math.sqrt((al / ra) ** 2 + (pe / rp) ** 2);
        if (ed > 1.15) continue;
        const ef = clamp01(ed + (0.5 - (Math.sin(Math.atan2(pe, al) * 9) * 0.5 + 0.5)) * clamp01((ed - 0.6) / 0.4) * 0.25);
        this.blendPxBuf(sb, pw, ph, lx, ly, st.wetR, st.wetG, st.wetB, softAlpha(ef, h) * flow);
      }
    });
  }

  private dabPastel(cx: number, cy: number, rad: number, flow: number, opa: number, s: StrokeSettings) {
    this.patchDab(cx, cy, rad, 0, opa, (sb, pw, ph, _vis, ox, oy) => {
      const rr = rad * rad;
      for (let ly = 0; ly < ph; ly++) for (let lx = 0; lx < pw; lx++) {
        const dx = (lx + ox) - cx, dy = (ly + oy) - cy, d2 = dx * dx + dy * dy; if (d2 >= rr) continue;
        const g = paperNoise(lx + ox, ly + oy), a = softAlpha(Math.sqrt(d2) / rad, s.brushConfig.hardness) * ((1 - g) * 0.65 + g * 0.35) * flow * 0.7;
        this.blendPxBuf(sb, pw, ph, lx, ly, s.color[0], s.color[1], s.color[2], a);
      }
    });
  }

  private dabBlur(cx: number, cy: number, rad: number, flow: number, s: StrokeSettings) {
    const b = Math.max(1, rad * 0.2 | 0), rr = rad * rad;
    const CW = this.ctx.canvas.width, pre = this.preStrokeImg;
    this.patchDabDirect(cx, cy, rad, b, (img, ox, oy) => {
      const pw = img.width, ph = img.height, ab = this.strokeAlphaBuf;
      if (!pre || !ab) return;
      for (let ly = 0; ly < ph; ly++) for (let lx = 0; lx < pw; lx++) {
        const dx = (lx + ox) - cx, dy = (ly + oy) - cy, d2 = dx * dx + dy * dy; if (d2 >= rr) continue;
        const st = softAlpha(Math.sqrt(d2) / rad, 0) * flow; if (st < 0.005) continue;
        const bi = (ly + oy) * CW + (lx + ox); if (st <= ab[bi]) continue; ab[bi] = st;
        let sr = 0, sg = 0, sb = 0, sa = 0, c = 0;
        for (let ky = (ly+oy) - b; ky <= (ly+oy) + b; ky++) for (let kx = (lx+ox) - b; kx <= (lx+ox) + b; kx++) {
          if (ky >= 0 && ky < this.ctx.canvas.height && kx >= 0 && kx < CW) { const k = (ky * CW + kx) * 4; sr += pre.data[k]; sg += pre.data[k+1]; sb += pre.data[k+2]; sa += pre.data[k+3]; c++; }
        }
        if (c) { const i = (ly * pw + lx) * 4; img.data[i] = lerp(pre.data[bi*4], sr / c, st); img.data[i+1] = lerp(pre.data[bi*4+1], sg / c, st); img.data[i+2] = lerp(pre.data[bi*4+2], sb / c, st); img.data[i+3] = lerp(pre.data[bi*4+3], sa / c, st); }
      }
    });
  }

  static replay(ctx: CanvasRenderingContext2D, points: { x: number; y: number; p: number; sp?: number }[], s: StrokeSettings) {
    if (!points.length) return; const eng = new BrushEngine(ctx);
    eng.beginStroke(points[0].x, points[0].y, points[0].p, points[0].sp ?? 0, s);
    for (let i = 1; i < points.length; i++) eng.strokeTo(points[i].x, points[i].y, points[i].p, points[i].sp ?? 0, s);
  }
}
