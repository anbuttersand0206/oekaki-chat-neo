import { BrushEngine } from './BrushEngine';
import { replayStroke } from './WasmBrushEngine';
import { floodFill } from './FloodFill';
import { SelectionManager } from './Selection';
import { DrawOp, StrokeSettings, defaultBrushConfig } from '../types';

export const CANVAS_W = 1600;
export const CANVAS_H = 1200;
const MAX_UNDO = 30;

export class CanvasEngine {
  readonly mainCanvas: HTMLCanvasElement;
  readonly overlayCanvas: HTMLCanvasElement;
  readonly mainCtx: CanvasRenderingContext2D;
  readonly overlayCtx: CanvasRenderingContext2D;

  readonly selection = new SelectionManager();

  private panX = 0;
  private panY = 0;
  private _zoom = 1;

  private undoStack: ImageData[] = [];
  private redoStack: ImageData[] = [];

  private dashOffset = 0;
  private animId = 0;

  // callbacks
  onStrokeEnd?: (points: { x: number; y: number; p: number }[], s: StrokeSettings) => void;
  onFill?: (x: number, y: number, color: [number, number, number], tolerance: number) => void;
  onClear?: () => void;
  onPaste?: (x: number, y: number, dataUrl: string, w: number, h: number) => void;
  onColorPick?: (r: number, g: number, b: number) => void;
  onTransformUpdate?: (angle: number | null) => void;

  constructor(wrapper: HTMLElement) {
    this.mainCanvas = document.getElementById('main-canvas') as HTMLCanvasElement;
    this.overlayCanvas = document.getElementById('overlay-canvas') as HTMLCanvasElement;
    this.mainCanvas.width = CANVAS_W;
    this.mainCanvas.height = CANVAS_H;
    this.overlayCanvas.width = CANVAS_W;
    this.overlayCanvas.height = CANVAS_H;

    this.mainCtx = this.mainCanvas.getContext('2d', { willReadFrequently: true })!;
    this.overlayCtx = this.overlayCanvas.getContext('2d')!;

    // White background
    this.mainCtx.fillStyle = '#ffffff';
    this.mainCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    this.centerCanvas(wrapper);
    this.startOverlayAnimation();
  }

  // ── Viewport ──────────────────────────────────────────────────────────────

  get currentZoom() { return this._zoom; }

  screenToCanvas(sx: number, sy: number): [number, number] {
    const container = document.getElementById('canvas-container')!;
    const rect = container.getBoundingClientRect();
    return [
      (sx - rect.left) / this._zoom,
      (sy - rect.top) / this._zoom
    ];
  }

  centerCanvas(wrapper: HTMLElement) {
    const wr = wrapper.getBoundingClientRect();
    this.panX = Math.max(0, (wr.width - CANVAS_W * this._zoom) / 2);
    this.panY = Math.max(0, (wr.height - CANVAS_H * this._zoom) / 2);
    this.applyTransform();
  }

  zoomBy(factor: number, cx?: number, cy?: number) {
    const wrapper = document.getElementById('canvas-wrapper')!;
    const wr = wrapper.getBoundingClientRect();
    cx = cx ?? wr.width / 2;
    cy = cy ?? wr.height / 2;

    const newZoom = Math.max(0.05, Math.min(20, this._zoom * factor));
    this.panX = cx - (cx - this.panX) * (newZoom / this._zoom);
    this.panY = cy - (cy - this.panY) * (newZoom / this._zoom);
    this._zoom = newZoom;
    this.applyTransform();
  }

  setZoom(z: number) {
    this._zoom = Math.max(0.05, Math.min(20, z));
    this.centerCanvas(document.getElementById('canvas-wrapper')!);
    this.applyTransform();
  }

  pan(dx: number, dy: number) {
    this.panX += dx;
    this.panY += dy;
    this.applyTransform();
  }

  fitToScreen() {
    const wrapper = document.getElementById('canvas-wrapper')!;
    const wr = wrapper.getBoundingClientRect();
    const zx = (wr.width - 40) / CANVAS_W;
    const zy = (wr.height - 40) / CANVAS_H;
    this._zoom = Math.min(zx, zy);
    this.centerCanvas(wrapper);
  }

  private applyTransform() {
    const c = document.getElementById('canvas-container') as HTMLElement;
    c.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this._zoom})`;
    c.style.transformOrigin = '0 0';
    document.getElementById('sb-zoom')!.textContent = `${Math.round(this._zoom * 100)}%`;
  }

  // ── Undo/Redo ─────────────────────────────────────────────────────────────

  saveUndo() {
    this.undoStack.push(this.mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    this.mainCtx.putImageData(this.undoStack.pop()!, 0, 0);
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    this.mainCtx.putImageData(this.redoStack.pop()!, 0, 0);
  }

  // ── Drawing operations ────────────────────────────────────────────────────

  applyOp(op: DrawOp) {
    switch (op.type) {
      case 'stroke': {
        const base = defaultBrushConfig(op.brushType);
        let modifiers = base.modifiers;
        try {
          if (op.modifiersJson) modifiers = JSON.parse(op.modifiersJson);
        } catch { /* use defaults */ }
        const s: StrokeSettings = {
          brushConfig: {
            ...base,
            size:      op.size,
            opacity:   op.opacity,
            density:   op.density,
            spacing:   op.spacing,
            hardness:  op.hardness  ?? base.hardness,
            mixing:    op.mixing,
            water:     op.water,
            spread:    op.spread,
            modifiers
          },
          color:  op.color,
          eraser: op.tool === 'eraser',
          texture: null
        };
        replayStroke(this.mainCtx, op.points, s);
        break;
      }
      case 'fill': {
        const imgData = this.mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
        floodFill(imgData, op.x, op.y, op.color[0], op.color[1], op.color[2], op.tolerance);
        this.mainCtx.putImageData(imgData, 0, 0);
        break;
      }
      case 'clear': {
        this.mainCtx.fillStyle = '#ffffff';
        this.mainCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
        break;
      }
      case 'paste': {
        const img = new Image();
        img.onload = () => this.mainCtx.drawImage(img, op.x, op.y);
        img.src = op.dataUrl;
        break;
      }
    }
  }

  clearCanvas() {
    this.saveUndo();
    this.applyOp({ type: 'clear' });
    this.onClear?.();
  }

  doFill(cx: number, cy: number, color: [number, number, number], tolerance: number) {
    this.saveUndo();
    const imgData = this.mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
    floodFill(imgData, cx, cy, color[0], color[1], color[2], tolerance);
    this.mainCtx.putImageData(imgData, 0, 0);
    this.onFill?.(cx, cy, color, tolerance);
  }

  // Canvas state sync
  getStateDataUrl(): string {
    return this.mainCanvas.toDataURL('image/png');
  }

  loadStateDataUrl(dataUrl: string) {
    const img = new Image();
    img.onload = () => {
      this.mainCtx.fillStyle = '#ffffff';
      this.mainCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      this.mainCtx.drawImage(img, 0, 0);
    };
    img.src = dataUrl;
  }

  // Export
  saveAs(format: 'png' | 'jpg' = 'png') {
    const link = document.createElement('a');
    const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';
    link.download = `oekaki-${Date.now()}.${format}`;

    if (format === 'jpg') {
      // composite on white bg for JPEG
      const tmp = document.createElement('canvas');
      tmp.width = CANVAS_W; tmp.height = CANVAS_H;
      const tc = tmp.getContext('2d')!;
      tc.fillStyle = '#ffffff';
      tc.fillRect(0, 0, CANVAS_W, CANVAS_H);
      tc.drawImage(this.mainCanvas, 0, 0);
      link.href = tmp.toDataURL(mimeType, 0.95);
    } else {
      link.href = this.mainCanvas.toDataURL(mimeType);
    }

    link.click();
  }

  // Pick color from canvas
  pickColor(cx: number, cy: number): [number, number, number] {
    const x = Math.max(0, Math.min(CANVAS_W - 1, Math.round(cx)));
    const y = Math.max(0, Math.min(CANVAS_H - 1, Math.round(cy)));
    const d = this.mainCtx.getImageData(x, y, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  // ── Overlay animation (marching ants, remote cursors) ─────────────────────

  private startOverlayAnimation() {
    const tick = () => {
      this.overlayCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      this.dashOffset = (this.dashOffset + 0.4) % 10;
      this.selection.drawOverlay(this.overlayCtx, this.dashOffset, this._zoom);
      this.onTransformUpdate?.(this.selection.transformAngle);
      this.animId = requestAnimationFrame(tick);
    };
    tick();
  }

  destroy() {
    cancelAnimationFrame(this.animId);
  }
}
