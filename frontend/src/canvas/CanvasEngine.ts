import { BrushEngine } from './BrushEngine';
import { replayStroke } from './WasmBrushEngine';
import { floodFill } from './FloodFill';
import { SelectionManager } from './Selection';
import { DrawOp, StrokeSettings, defaultBrushConfig, CANVAS_W, CANVAS_H } from '../types';

/**
 * The CanvasEngine handles all drawing operations, viewport transformations (zoom/pan),
 * and the history stack (undo/redo). It manages two canvas layers: a main layer for
 * permanent drawing and an overlay layer for transient UI elements like selection marquees.
 */
export class CanvasEngine {
  readonly mainCanvas: HTMLCanvasElement;
  readonly overlayCanvas: HTMLCanvasElement;
  readonly mainCtx: CanvasRenderingContext2D;
  readonly overlayCtx: CanvasRenderingContext2D;

  private undoStack: ImageData[] = [];
  private redoStack: ImageData[] = [];
  private MAX_UNDO = 30;

  private _zoom = 1.0;
  private _panX = 0;
  private _panY = 0;

  readonly selection: SelectionManager;
  private animId = 0;
  private dashOffset = 0;

  onColorPick?: (r: number, g: number, b: number) => void;
  onTransformUpdate?: (angle: number | null) => void;

  constructor(container: HTMLElement) {
    this.mainCanvas = document.createElement('canvas');
    this.overlayCanvas = document.createElement('canvas');

    this.mainCanvas.id = 'main-canvas';
    this.overlayCanvas.id = 'overlay-canvas';

    [this.mainCanvas, this.overlayCanvas].forEach(c => {
      c.width = CANVAS_W;
      c.height = CANVAS_H;
      c.style.position = 'absolute';
      c.style.top = '0';
      c.style.left = '0';
      c.style.transformOrigin = '0 0';
      container.appendChild(c);
    });

    // Add shadow only to the main canvas
    this.mainCanvas.style.boxShadow = '0 4px 32px rgba(0,0,0,0.5)';

    this.mainCtx = this.mainCanvas.getContext('2d', { willReadFrequently: true })!;
    this.overlayCtx = this.overlayCanvas.getContext('2d')!;

    // Initial fill
    this.mainCtx.fillStyle = '#fff';
    this.mainCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    this.selection = new SelectionManager();
    this.startAnimation();
  }

  get currentZoom() { return this._zoom; }
  get panX() { return this._panX; }
  get panY() { return this._panY; }

  setZoom(z: number, centerX?: number, centerY?: number) {
    const oldZ = this._zoom;
    this._zoom = Math.max(0.05, Math.min(20, z));
    
    if (centerX !== undefined && centerY !== undefined) {
      const ratio = this._zoom / oldZ;
      this._panX = centerX - (centerX - this._panX) * ratio;
      this._panY = centerY - (centerY - this._panY) * ratio;
    }
    this.updateViewport();
  }

  zoomBy(factor: number, cx?: number, cy?: number) {
    this.setZoom(this._zoom * factor, cx, cy);
  }

  panBy(dx: number, dy: number) {
    this._panX += dx;
    this._panY += dy;
    this.updateViewport();
  }

  pan(dx: number, dy: number) {
    this.panBy(dx, dy);
  }

  fitToScreen() {
    const rect = this.mainCanvas.parentElement!.getBoundingClientRect();
    const padding = 40;
    const availW = rect.width - padding;
    const availH = rect.height - padding;
    const z = Math.min(availW / CANVAS_W, availH / CANVAS_H, 1.0);
    this._zoom = z;
    this._panX = (rect.width - CANVAS_W * z) / 2;
    this._panY = (rect.height - CANVAS_H * z) / 2;
    this.updateViewport();
  }

  updateViewport() {
    const transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._zoom})`;
    this.mainCanvas.style.transform = transform;
    this.overlayCanvas.style.transform = transform;
    const zoomLabel = document.getElementById('sb-zoom');
    if (zoomLabel) zoomLabel.textContent = `${Math.round(this._zoom * 100)}%`;
  }

  screenToCanvas(sx: number, sy: number): [number, number] {
    const rect = this.mainCanvas.getBoundingClientRect();
    return [
      (sx - rect.left) / this._zoom,
      (sy - rect.top) / this._zoom
    ];
  }

  /**
   * Captures the current canvas state and pushes it onto the undo stack.
   * Clears the redo stack as any new action invalidates future redo states.
   */
  saveUndo() {
    this.undoStack.push(this.mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    if (this.undoStack.length > this.MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * Reverts the canvas to the previous state from the undo stack.
   */
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    this.mainCtx.putImageData(this.undoStack.pop()!, 0, 0);
  }

  /**
   * Re-applies the last undone state from the redo stack.
   */
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H));
    this.mainCtx.putImageData(this.redoStack.pop()!, 0, 0);
  }

  // ── Drawing operations ────────────────────────────────────────────────────

  /**
   * Applies a drawing operation received from either the local tool or the network.
   * This handles strokes, fills, clearing, and pasting images.
   */
  applyOp(op: DrawOp) {
    switch (op.type) {
      case 'stroke': {
        const s: StrokeSettings = {
          brushConfig: {
            ...defaultBrushConfig(op.brushType),
            size: op.size, opacity: op.opacity, density: op.density,
            spacing: op.spacing, hardness: op.hardness, mixing: op.mixing,
            water: op.water, spread: op.spread,
            modifiers: JSON.parse(op.modifiersJson)
          },
          color: op.color,
          eraser: op.tool === 'eraser'
        };
        replayStroke(this.mainCtx, op.points, s);
        break;
      }
      case 'fill':
        this.doFill(op.x, op.y, op.color, op.tolerance);
        break;
      case 'clear':
        this.saveUndo();
        this.clearCanvas();
        break;
      case 'paste':
        this.saveUndo();
        const img = new Image();
        img.onload = () => {
          this.mainCtx.drawImage(img, op.x, op.y, op.width, op.height);
        };
        img.src = op.dataUrl;
        break;
    }
  }

  clearCanvas() {
    this.mainCtx.fillStyle = '#fff';
    this.mainCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  getStateDataUrl() {
    return this.mainCanvas.toDataURL('image/webp', 0.85);
  }

  loadStateDataUrl(dataUrl: string) {
    const img = new Image();
    img.onload = () => {
      this.mainCtx.fillStyle = '#fff';
      this.mainCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      this.mainCtx.drawImage(img, 0, 0);
    };
    img.src = dataUrl;
  }

  pickColor(cx: number, cy: number): [number, number, number] {
    const data = this.mainCtx.getImageData(Math.floor(cx), Math.floor(cy), 1, 1).data;
    return [data[0], data[1], data[2]];
  }

  doFill(x: number, y: number, color: [number, number, number], tolerance: number) {
    this.saveUndo();
    const img = this.mainCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
    floodFill(img, x, y, color[0], color[1], color[2], tolerance);
    this.mainCtx.putImageData(img, 0, 0);
  }

  saveAs(format: 'png' | 'jpg') {
    const link = document.createElement('a');
    link.download = `oekaki-${Date.now()}.${format}`;
    link.href = this.mainCanvas.toDataURL(format === 'png' ? 'image/png' : 'image/jpeg', 0.95);
    link.click();
  }

  private startAnimation() {
    const tick = () => {
      this.dashOffset = (this.dashOffset + 0.5) % 12;
      this.overlayCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
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
