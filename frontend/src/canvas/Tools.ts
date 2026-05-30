import { CanvasEngine } from './CanvasEngine';
import { BrushEngine } from './BrushEngine';
import { WasmBrushEngine, isBrushWasmReady, invalidateWasmEngine } from './WasmBrushEngine';
import { StrokeSettings, StrokePoint, ToolType } from '../types';
import { HandleId } from './Selection';

interface ToolContext {
  engine: CanvasEngine;
  getSettings: () => StrokeSettings;
  getTolerance: () => number;
  emitStroke: (points: StrokePoint[], settings: StrokeSettings, final: boolean) => void;
  emitFill: (x: number, y: number) => void;
  emitPaste: (x: number, y: number, dataUrl: string, w: number, h: number) => void;
  setCursor: (type: string) => void;
}

export class ToolManager {
  private currentTool: ToolType = 'brush';
  private ctx!: ToolContext;
  private wrapper!: HTMLElement;

  // ブラシ描画状態 — Wasm エンジン優先、失敗時は TS フォールバック
  private brushEng: BrushEngine | WasmBrushEngine | null = null;
  private strokePoints: StrokePoint[] = [];
  private strokeTimer: number | null = null;
  private strokeStartTime = 0;
  private isDrawing = false;
  // 入力平滑化 — 直近 N サンプルの加重移動平均（大きいほど滑らか、遅延も増える）
  private rawBuf: Array<{ x: number; y: number; p: number }> = [];
  private static readonly SMOOTH_WIN = 5;
  // 抜き（ストローク末端のテーパー）のために最終方向を追跡する
  private prevSmX = 0;
  private prevSmY = 0;
  private lastDirX = 0;
  private lastDirY = 0;
  // 速度追跡
  private lastPtX = 0;
  private lastPtY = 0;
  private lastPtTime = 0;
  private currentSpeed = 0; // px/s

  // パン状態
  private panStartX = 0;
  private panStartY = 0;
  private spaceDown = false;

  // 選択状態
  private selStartX = 0;
  private selStartY = 0;
  private lassoActive = false;
  private selTransformDragActive = false;

  // 貼り付けフローティング状態
  private pasteActive = false;
  private pasteX = 0;
  private pasteY = 0;
  private pasteData = '';
  private pasteW = 0;
  private pasteH = 0;

  init(ctx: ToolContext) {
    this.ctx = ctx;
    this.wrapper = document.getElementById('canvas-wrapper')!;
    this.setupEvents();
    this.setupKeyboard();
  }

  setTool(tool: ToolType) {
    this.currentTool = tool;
    this.updateCursor();
  }

  getTool(): ToolType { return this.currentTool; }

  // スペースバー押下中は一時的にパンツールに切り替える
  private get effectiveTool(): ToolType {
    return this.spaceDown ? 'pan' : this.currentTool;
  }

  private setupEvents() {
    const wrapper = this.wrapper;

    wrapper.addEventListener('pointerdown', this.onDown);
    wrapper.addEventListener('pointermove', this.onMove);
    wrapper.addEventListener('pointerup', this.onUp);
    wrapper.addEventListener('pointercancel', this.onUp);
    wrapper.addEventListener('wheel', this.onWheel, { passive: false });
    wrapper.addEventListener('contextmenu', e => e.preventDefault());
  }

  private setupKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) {
        this.spaceDown = true;
        this.updateCursor();
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.updateCursor();
      }
    });
  }

  private onDown = (e: PointerEvent) => {
    if (e.button === 1) { // ミドルクリック = パン
      this.startPan(e);
      return;
    }
    const [cx, cy] = this.ctx.engine.screenToCanvas(e.clientX, e.clientY);
    const pressure = this.getPressure(e);
    const tool = this.effectiveTool;

    this.wrapper.setPointerCapture(e.pointerId);

    switch (tool) {
      case 'brush':
      case 'eraser':
        this.startBrush(cx, cy, pressure, e);
        break;
      case 'fill':
        this.doFill(cx, cy);
        break;
      case 'pan':
        this.startPan(e);
        break;
      case 'rectSelect':
        if (this.ctx.engine.selection.isTransforming) {
          this.startTransformInteraction(cx, cy);
        } else {
          this.startRectSelect(cx, cy);
        }
        break;
      case 'lasso':
        if (this.ctx.engine.selection.isTransforming) {
          this.startTransformInteraction(cx, cy);
        } else {
          this.startLasso(cx, cy);
        }
        break;
      case 'eyedropper':
        this.pickColor(cx, cy);
        break;
    }
  };

  private onMove = (e: PointerEvent) => {
    const [cx, cy] = this.ctx.engine.screenToCanvas(e.clientX, e.clientY);
    const pressure = this.getPressure(e);
    const tool = this.effectiveTool;

    document.getElementById('sb-pos')!.textContent =
      `X: ${Math.round(cx)}  Y: ${Math.round(cy)}`;

    // 描画中でないときにトランスフォームハンドルのカーソルを更新する
    if (!this.isDrawing &&
        (tool === 'rectSelect' || tool === 'lasso') &&
        this.ctx.engine.selection.isTransforming) {
      this.updateTransformCursor(cx, cy);
    }

    if (!this.isDrawing) return;

    switch (tool) {
      case 'brush':
      case 'eraser':
        if (this.brushEng) {
          // getCoalescedEvents で pointermove イベント間のすべての中間サンプルを取得する
          const events: PointerEvent[] = e.getCoalescedEvents?.() ?? [e];
          const WIN = ToolManager.SMOOTH_WIN;
          for (const ce of events) {
            const [ecx, ecy] = this.ctx.engine.screenToCanvas(ce.clientX, ce.clientY);
            const ep = this.getPressure(ce);
            // 加重移動平均: 重み [1,2,...,WIN]、最新が最高重み
            this.rawBuf.push({ x: ecx, y: ecy, p: ep });
            if (this.rawBuf.length > WIN) this.rawBuf.shift();
            let wx = 0, wy = 0, wp = 0, wsum = 0;
            for (let i = 0; i < this.rawBuf.length; i++) {
              const w = i + 1;
              wx += this.rawBuf[i].x * w;
              wy += this.rawBuf[i].y * w;
              wp += this.rawBuf[i].p * w;
              wsum += w;
            }
            const sx = wx / wsum, sy = wy / wsum, sp = wp / wsum;
            // 平滑化後の位置からストローク方向を更新する
            const ddx = sx - this.prevSmX, ddy = sy - this.prevSmY;
            const dd = Math.hypot(ddx, ddy);
            if (dd > 0.3) {
              this.lastDirX = ddx / dd;
              this.lastDirY = ddy / dd;
              this.prevSmX = sx; this.prevSmY = sy;
            }
            this.continueBrush(sx, sy, sp);
          }
        }
        break;
      case 'pan':
        this.doPan(e);
        break;
      case 'rectSelect':
        if (this.selTransformDragActive) {
          this.ctx.engine.selection.updateHandleDrag(cx, cy, e.shiftKey);
        } else {
          this.ctx.engine.selection.updateRect(cx, cy, this.selStartX, this.selStartY);
        }
        break;
      case 'lasso':
        if (this.selTransformDragActive) {
          this.ctx.engine.selection.updateHandleDrag(cx, cy, e.shiftKey);
        } else if (this.lassoActive) {
          this.ctx.engine.selection.addLassoPoint(cx, cy);
        }
        break;
    }
  };

  private onUp = (e: PointerEvent) => {
    const [cx, cy] = this.ctx.engine.screenToCanvas(e.clientX, e.clientY);
    const pressure = this.getPressure(e);
    const tool = this.effectiveTool;

    this.isDrawing = false;

    switch (tool) {
      case 'brush':
      case 'eraser':
        this.endBrush(cx, cy, pressure);
        break;
      case 'pan':
        this.updateCursor();
        break;
      case 'rectSelect':
        if (this.selTransformDragActive) {
          this.ctx.engine.selection.endHandleDrag();
          this.selTransformDragActive = false;
        } else {
          this.ctx.engine.selection.commitRect();
          this.selStartX = 0; this.selStartY = 0;
        }
        break;
      case 'lasso':
        if (this.selTransformDragActive) {
          this.ctx.engine.selection.endHandleDrag();
          this.selTransformDragActive = false;
        } else {
          this.ctx.engine.selection.commitLasso();
          this.lassoActive = false;
        }
        break;
    }

    this.wrapper.releasePointerCapture(e.pointerId);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      // 水平スクロール（トラックパッドの2本指左右）→ パン
      this.ctx.engine.panBy(-e.deltaX, 0);
    } else {
      // 垂直スクロール → カーソル中心ズーム
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      this.ctx.engine.zoomBy(factor, e.clientX, e.clientY);
    }
  };

  // ── ブラシ ────────────────────────────────────────────────────────────────────

  private calcSpeed(cx: number, cy: number): number {
    const now = performance.now();
    const dt = now - this.lastPtTime;
    if (dt > 0 && dt < 200) {
      const dx = cx - this.lastPtX, dy = cy - this.lastPtY;
      this.currentSpeed = Math.hypot(dx, dy) / (dt / 1000);
    }
    this.lastPtX = cx; this.lastPtY = cy; this.lastPtTime = now;
    return this.currentSpeed;
  }

  private startBrush(cx: number, cy: number, pressure: number, e: PointerEvent) {
    const s = this.ctx.getSettings();
    this.brushEng?.dispose();
    this.ctx.engine.saveUndo();
    this.currentSpeed = 0;
    this.lastPtX = cx; this.lastPtY = cy; this.lastPtTime = performance.now();
    this.rawBuf = []; this.prevSmX = cx; this.prevSmY = cy;
    this.lastDirX = 0; this.lastDirY = 0;
    this.strokePoints = [{ x: cx, y: cy, p: pressure, sp: 0 }];
    this.strokeStartTime = performance.now();
    this.isDrawing = true;

    // Alt+クリック → スポイトとして機能させる
    if (e.altKey) {
      this.pickColor(cx, cy);
      this.brushEng = null;
      this.isDrawing = false;
      return;
    }

    if (isBrushWasmReady()) {
      const wasmEng = new WasmBrushEngine(this.ctx.engine.mainCtx);
      try {
        wasmEng.beginStroke(cx, cy, pressure, 0, s);
        this.brushEng = wasmEng;
      } catch (err) {
        // Wasm が失敗したら破棄して TS エンジンにフォールバックする
        wasmEng.dispose();
        invalidateWasmEngine();
        const sbEng = document.getElementById('sb-engine'); if (sbEng) sbEng.textContent = 'JS Engine';
        this.brushEng = new BrushEngine(this.ctx.engine.mainCtx);
        this.brushEng.beginStroke(cx, cy, pressure, 0, s);
      }
    } else {
      this.brushEng = new BrushEngine(this.ctx.engine.mainCtx);
      this.brushEng.beginStroke(cx, cy, pressure, 0, s);
    }

    this.schedulePartialSend(s);
  }

  private continueBrush(cx: number, cy: number, pressure: number) {
    if (!this.brushEng) return;
    const s = this.ctx.getSettings();
    const speed = this.calcSpeed(cx, cy);
    try {
      this.brushEng.strokeTo(cx, cy, pressure, speed, s);
    } catch {
      if (this.brushEng instanceof WasmBrushEngine) {
        this.brushEng.dispose();
        invalidateWasmEngine();
        const sbEng = document.getElementById('sb-engine'); if (sbEng) sbEng.textContent = 'JS Engine';
      }
      this.brushEng = null;
      return;
    }
    this.strokePoints.push({ x: cx, y: cy, p: pressure, sp: speed });
  }

  private endBrush(cx: number, cy: number, pressure: number) {
    if (!this.brushEng) return;
    const s = this.ctx.getSettings();
    const speed = this.calcSpeed(cx, cy);
    try {
      this.brushEng.strokeTo(cx, cy, pressure, speed, s);
    } catch {
      if (this.brushEng instanceof WasmBrushEngine) {
        this.brushEng.dispose();
        invalidateWasmEngine();
        const sbEng = document.getElementById('sb-engine'); if (sbEng) sbEng.textContent = 'JS Engine';
      }
      this.brushEng = null;
      this.ctx.emitStroke([...this.strokePoints], s, true);
      this.strokePoints = [];
      return;
    }
    this.strokePoints.push({ x: cx, y: cy, p: pressure, sp: speed });

    // 抜き: ストローク終端を最終方向に延長しながら筆圧を 0 に向けてテーパーさせる。
    // 長さは「最終筆圧 × ブラシサイズ」に比例させることで自然な抜けを再現する。
    const hasDir = Math.hypot(this.lastDirX, this.lastDirY) > 0.5;
    if (hasDir && pressure > 0.02) {
      const nukiLen = pressure * s.brushConfig.size * 1.2;
      const STEPS = 6;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        const nx = cx + this.lastDirX * nukiLen * t;
        const ny = cy + this.lastDirY * nukiLen * t;
        const np = pressure * (1 - t) * (1 - t); // 二次関数で 0 に収束
        this.brushEng.strokeTo(nx, ny, np, speed * (1 - t), s);
        this.strokePoints.push({ x: nx, y: ny, p: np, sp: speed * (1 - t) });
      }
    }

    if (this.strokeTimer !== null) {
      clearTimeout(this.strokeTimer);
      this.strokeTimer = null;
    }

    this.ctx.emitStroke([...this.strokePoints], s, true);
    this.strokePoints = [];
    this.brushEng = null;
  }

  private schedulePartialSend(s: StrokeSettings) {
    this.strokeTimer = window.setTimeout(() => {
      if (this.strokePoints.length > 1) {
        this.ctx.emitStroke([...this.strokePoints], s, false);
      }
      if (this.isDrawing) this.schedulePartialSend(s);
    }, 80);
  }

  // ── 塗りつぶし ────────────────────────────────────────────────────────────────

  private doFill(cx: number, cy: number) {
    const s = this.ctx.getSettings();
    this.ctx.engine.doFill(cx, cy, s.color, this.ctx.getTolerance());
    this.ctx.emitFill(cx, cy);
  }

  // ── パン ──────────────────────────────────────────────────────────────────────

  private startPan(e: PointerEvent) {
    this.isDrawing = true;
    this.panStartX = e.clientX;
    this.panStartY = e.clientY;
    this.ctx.setCursor('grabbing');
  }

  private doPan(e: PointerEvent) {
    const dx = e.clientX - this.panStartX;
    const dy = e.clientY - this.panStartY;
    this.panStartX = e.clientX;
    this.panStartY = e.clientY;
    this.ctx.engine.panBy(dx, dy);
  }

  // ── 選択 ──────────────────────────────────────────────────────────────────────

  private startRectSelect(cx: number, cy: number) {
    this.selStartX = cx;
    this.selStartY = cy;
    this.ctx.engine.selection.setMode('rect');
    this.ctx.engine.selection.startRect(cx, cy);
    this.isDrawing = true;
  }

  private startLasso(cx: number, cy: number) {
    this.ctx.engine.selection.setMode('lasso');
    this.ctx.engine.selection.startLasso(cx, cy);
    this.lassoActive = true;
    this.isDrawing = true;
  }

  // ── トランスフォーム操作 ───────────────────────────────────────────────────────

  private startTransformInteraction(cx: number, cy: number) {
    const sel = this.ctx.engine.selection;
    const zoom = this.ctx.engine.currentZoom;
    const handle = sel.getHandleAt(cx, cy, zoom);
    if (handle) {
      sel.startHandleDrag(handle, cx, cy);
      this.selTransformDragActive = true;
      this.isDrawing = true;
    } else if (sel.isInsideTransform(cx, cy)) {
      sel.startHandleDrag('move', cx, cy);
      this.selTransformDragActive = true;
      this.isDrawing = true;
    } else {
      // 枠外クリック → コミットして新しい選択を開始する
      this.ctx.engine.saveUndo();
      sel.commitTransform(this.ctx.engine.mainCtx);
      this.startRectSelect(cx, cy);
    }
  }

  private updateTransformCursor(cx: number, cy: number) {
    const sel = this.ctx.engine.selection;
    const zoom = this.ctx.engine.currentZoom;
    const handle = sel.getHandleAt(cx, cy, zoom);
    if (handle) {
      const cursorMap: Partial<Record<HandleId, string>> = {
        nw: 'nwse-resize', se: 'nwse-resize',
        ne: 'nesw-resize', sw: 'nesw-resize',
        n: 'ns-resize', s: 'ns-resize',
        e: 'ew-resize', w: 'ew-resize',
        rotate: 'grab',
      };
      this.ctx.setCursor(cursorMap[handle] ?? 'pointer');
    } else if (sel.isInsideTransform(cx, cy)) {
      this.ctx.setCursor('move');
    } else {
      this.ctx.setCursor('crosshair');
    }
  }

  // ── スポイト ──────────────────────────────────────────────────────────────────

  private pickColor(cx: number, cy: number) {
    const [r, g, b] = this.ctx.engine.pickColor(cx, cy);
    this.ctx.engine.onColorPick?.(r, g, b);
  }

  // ── 貼り付けフローティング ────────────────────────────────────────────────────

  startPaste(dataUrl: string, w: number, h: number) {
    const cw = document.getElementById('main-canvas')!.getBoundingClientRect();
    this.pasteX = (cw.width - w) / 2;
    this.pasteY = (cw.height - h) / 2;
    this.pasteData = dataUrl;
    this.pasteW = w;
    this.pasteH = h;
    this.pasteActive = true;
  }

  commitPaste() {
    if (!this.pasteActive) return;
    this.ctx.engine.saveUndo();
    const img = new Image();
    img.onload = () => this.ctx.engine.mainCtx.drawImage(img, this.pasteX, this.pasteY);
    img.src = this.pasteData;
    this.ctx.emitPaste(this.pasteX, this.pasteY, this.pasteData, this.pasteW, this.pasteH);
    this.pasteActive = false;
  }

  private getPressure(e: PointerEvent): number {
    if (e.pointerType === 'pen') return e.pressure;
    if (e.pointerType === 'touch') return e.pressure || 0.7;
    return 1.0; // マウスは常に最大圧
  }

  private updateCursor() {
    const tool = this.effectiveTool;
    const cursors: Record<ToolType, string> = {
      brush: 'crosshair',
      eraser: 'cell',
      fill: 'crosshair',
      pan: 'grab',
      rectSelect: 'crosshair',
      lasso: 'crosshair',
      eyedropper: 'crosshair'
    };
    this.ctx.setCursor(cursors[tool] || 'default');
  }
}
