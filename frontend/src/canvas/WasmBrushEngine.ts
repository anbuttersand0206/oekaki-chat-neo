import { StrokeSettings, PARAM_IDS } from '../types';
import { BrushEngine } from './BrushEngine';

// C++ 側の enum と対応させる（brush_engine.h と順序を一致させること）
const BRUSH_TYPE: Record<string, number> = {
  pen: 0, marker: 1, pencil: 2, crayon: 3, airbrush: 4,
  watercolor: 5, oil: 6, pastel: 7, blur: 8,
};

const PARAM_IDX: Record<string, number> = {
  size: 0, opacity: 1, density: 2, spacing: 3,
  mixing: 4, water: 5, spread: 6,
};

// ── Emscripten モジュールのインターフェース ────────────────────────────────────
interface BrushWasmModule {
  HEAPU8:  Uint8Array;
  HEAPF32: Float32Array;
  cwrap(name: string, ret: string | null, args: string[]): (...a: number[]) => number;
}

declare global {
  interface Window { BrushWasm?: () => Promise<BrushWasmModule>; }
}

// ── Wasm モジュールのシングルトン管理 ─────────────────────────────────────────
// 複数の strokeTo が並行して呼ばれてもモジュールの二重ロードを防ぐため
// Promise をキャッシュしている
let _mod: BrushWasmModule | null = null;
let _loading: Promise<boolean> | null = null;

export function initBrushWasm(): Promise<boolean> {
  if (_mod) return Promise.resolve(true);
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const factory = window.BrushWasm;
      if (!factory) {
        console.log('[BrushEngine] Wasm が見つかりません — TypeScript フォールバックを使用');
        return false;
      }
      _mod = await factory();
      console.log('[BrushEngine] Wasm の読み込みに成功しました');
      return true;
    } catch (e) {
      console.warn('[BrushEngine] Wasm の読み込みに失敗しました — TypeScript フォールバックを使用', e);
      return false;
    }
  })();
  return _loading;
}

export function isBrushWasmReady(): boolean { return _mod !== null; }

// Wasm がアボートしたときにモジュールを無効化し、TS エンジンへ恒久フォールバックする
export function invalidateWasmEngine(): void {
  if (_mod) {
    console.warn('[BrushEngine] Wasm モジュールがアボートしました — TypeScript エンジンに恒久切り替えします');
    _mod = null;
    _loading = null;
  }
}

// ── Wasm 対応のストローク再生（CanvasEngine のリモート/アンドゥに使用） ────────
export function replayStroke(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number; p: number; sp?: number }[],
  s: StrokeSettings
) {
  if (!points.length) return;
  if (_mod) {
    const eng = new WasmBrushEngine(ctx);
    try {
      eng.beginStroke(points[0].x, points[0].y, points[0].p, points[0].sp ?? 0, s);
      for (let i = 1; i < points.length; i++)
        eng.strokeTo(points[i].x, points[i].y, points[i].p, points[i].sp ?? 0, s);
      eng.dispose();
      return;
    } catch (e) {
      eng.dispose();
      invalidateWasmEngine();
    }
  }
  BrushEngine.replay(ctx, points, s);
}

// ── WasmBrushEngine ───────────────────────────────────────────────────────────
/**
 * Emscripten でコンパイルされた C++ ブラシエンジンへのブリッジ。
 *
 * パフォーマンスの肝は「ダーティ矩形フラッシュ」にある。
 * ストローク開始時に現在のキャンバスを Wasm ヒープへ一括コピーし、
 * strokeTo のたびに変化した矩形領域だけを Canvas 2D へ書き戻すことで、
 * フルキャンバスコピーによる帯域ボトルネックを避けている。
 */
export class WasmBrushEngine {
  private readonly id: number;
  private ptr = 0;
  private prevX = 0;
  private prevY = 0;

  private readonly _setType:       (id: number, t: number) => void;
  private readonly _setColor:      (id: number, r: number, g: number, b: number) => void;
  private readonly _setParam:      (id: number, p: number, v: number) => void;
  private readonly _setCurve:      (id: number, p: number, mt: number, xs: number, ys: number, n: number) => void;
  private readonly _setRandom:     (id: number, p: number, amt: number) => void;
  private readonly _setHardness:   (id: number, h: number) => void;
  private readonly _setEraser:     (id: number, e: number) => void;
  private readonly _getCanvasBuf:  (id: number, cw: number, ch: number) => number;
  private readonly _beginStroke:   (id: number, x: number, y: number, p: number, sp: number) => void;
  private readonly _strokeTo:      (id: number, x: number, y: number, p: number, sp: number) => void;
  private readonly _allocBuf:      (bytes: number) => number;
  private readonly _freeBuf:       (ptr: number) => void;
  private readonly _destroy:       (id: number) => void;

  constructor(private ctx: CanvasRenderingContext2D) {
    const m = _mod!;
    const w = (name: string, ret: string | null, args: string[]) =>
      m.cwrap(name, ret, args) as (...a: number[]) => number;

    this._setType      = w('brush_set_type',       null,     ['number','number']);
    this._setColor     = w('brush_set_color',      null,     ['number','number','number','number']);
    this._setParam     = w('brush_set_param',      null,     ['number','number','number']);
    this._setCurve     = w('brush_set_curve',      null,     ['number','number','number','number','number','number']);
    this._setRandom    = w('brush_set_random',     null,     ['number','number','number']);
    this._setHardness  = w('brush_set_hardness',   null,     ['number','number']);
    this._setEraser    = w('brush_set_eraser',     null,     ['number','number']);
    this._getCanvasBuf = w('brush_get_canvas_buf', 'number', ['number','number','number']);
    this._beginStroke  = w('brush_begin_stroke',   null,     ['number','number','number','number','number']);
    this._strokeTo     = w('brush_stroke_to',      null,     ['number','number','number','number','number']);
    this._allocBuf     = w('alloc_buf',            'number', ['number']);
    this._freeBuf      = w('free_buf',             null,     ['number']);
    this._destroy      = w('brush_destroy',        null,     ['number']);

    this.id = m.cwrap('brush_create', 'number', ['number'])(0);
  }

  dispose() {
    if (this.id) this._destroy(this.id);
  }

  private getAffectedRad(s: StrokeSettings): number {
    const cfg = s.brushConfig;
    // 筆圧/速度カーブとランダム量が最大で 2.0 倍になるので余裕を持たせる
    const maxMult = 2.5;
    const rad = Math.max(1, cfg.size) * 0.5 * maxMult;

    switch (cfg.type) {
      case 'airbrush': {
        const coreRad = rad * cfg.hardness;
        const sigma   = Math.max(1, (rad - coreRad) * 0.6);
        return coreRad + sigma * 3 + 2;
      }
      case 'watercolor': {
        return rad + 2;
      }
      case 'blur': {
        const blurKernelRadius = Math.max(1, rad * 0.2 | 0);
        return rad + blurKernelRadius + 2;
      }
      default:
        return rad + 2;
    }
  }

  beginStroke(x: number, y: number, pressure: number, speed: number, s: StrokeSettings) {
    const cfg = s.brushConfig;
    const [r, g, b] = s.color;
    const cw = this.ctx.canvas.width, ch = this.ctx.canvas.height;

    this._setType    (this.id, BRUSH_TYPE[cfg.type] ?? 0);
    this._setColor   (this.id, r, g, b);
    this._setParam   (this.id, PARAM_IDX.size,    cfg.size);
    this._setParam   (this.id, PARAM_IDX.opacity, cfg.opacity);
    this._setParam   (this.id, PARAM_IDX.density, cfg.density);
    this._setParam   (this.id, PARAM_IDX.spacing, cfg.spacing);
    this._setParam   (this.id, PARAM_IDX.mixing,  cfg.mixing);
    this._setParam   (this.id, PARAM_IDX.water,   cfg.water);
    this._setParam   (this.id, PARAM_IDX.spread,  cfg.spread);
    this._setHardness(this.id, cfg.hardness);
    this._setEraser  (this.id, s.eraser ? 1 : 0);

    for (const pid of PARAM_IDS) {
      const idx = PARAM_IDX[pid];
      const mod = cfg.modifiers[pid];
      this.pushCurve(idx, 0, mod.pressureCurve);
      this.pushCurve(idx, 1, mod.speedCurve);
      this._setRandom(this.id, idx, mod.randomAmount);
    }

    // ストローク開始時に現在のキャンバスを Wasm バッファへ一括コピーする
    this.ptr = this._getCanvasBuf(this.id, cw, ch);
    const imgData = this.ctx.getImageData(0, 0, cw, ch);
    _mod!.HEAPU8.set(imgData.data, this.ptr);

    this._beginStroke(this.id, x, y, pressure, speed);
    this.prevX = x; this.prevY = y;

    // 最初のダブ: 始点周辺だけフラッシュする
    const frad = this.getAffectedRad(s);
    this.flushRect(x - frad, y - frad, x + frad, y + frad);
  }

  strokeTo(x: number, y: number, pressure: number, speed: number, s: StrokeSettings) {
    if (!this.id || !this.ptr) return;
    const frad = this.getAffectedRad(s);

    this._strokeTo(this.id, x, y, pressure, speed);

    // 前回位置と現在位置の間のダーティ帯域だけフラッシュする
    const x0 = Math.min(this.prevX, x) - frad;
    const y0 = Math.min(this.prevY, y) - frad;
    const x1 = Math.max(this.prevX, x) + frad;
    const y1 = Math.max(this.prevY, y) + frad;
    this.flushRect(x0, y0, x1, y1);

    this.prevX = x; this.prevY = y;
  }

  // ── ヘルパー ─────────────────────────────────────────────────────────────────

  private pushCurve(paramIdx: number, modType: number, pts: { x: number; y: number }[]) {
    const n = pts.length;
    if (n === 0) return;
    const m = _mod!;
    const pxs = this._allocBuf(n * 4);
    const pys = this._allocBuf(n * 4);
    for (let i = 0; i < n; i++) {
      m.HEAPF32[(pxs >> 2) + i] = pts[i].x;
      m.HEAPF32[(pys >> 2) + i] = pts[i].y;
    }
    this._setCurve(this.id, paramIdx, modType, pxs, pys, n);
    this._freeBuf(pxs);
    this._freeBuf(pys);
  }

  // Wasm キャンバスバッファから指定矩形を切り出して 2D コンテキストに書き込む。
  // フルキャンバスではなく変更領域だけを転送することで帯域コストを抑えている。
  private flushRect(rx0: number, ry0: number, rx1: number, ry1: number) {
    const cw = this.ctx.canvas.width, ch = this.ctx.canvas.height;
    const x0 = Math.max(0, Math.floor(rx0));
    const y0 = Math.max(0, Math.floor(ry0));
    const x1 = Math.min(cw - 1, Math.ceil(rx1));
    const y1 = Math.min(ch - 1, Math.ceil(ry1));
    if (x0 > x1 || y0 > y1) return;

    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const dst = new Uint8ClampedArray(w * h * 4);
    const heap = _mod!.HEAPU8;

    // キャンバス行は連続しているが部分矩形は非連続なので行ごとにコピーする
    for (let row = 0; row < h; row++) {
      const srcOff = this.ptr + ((y0 + row) * cw + x0) * 4;
      dst.set(heap.subarray(srcOff, srcOff + w * 4), row * w * 4);
    }
    this.ctx.putImageData(new ImageData(dst, w, h), x0, y0);
  }
}
