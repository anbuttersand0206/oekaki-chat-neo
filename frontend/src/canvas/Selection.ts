export interface Rect { x: number; y: number; w: number; h: number }

export type HandleId = 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'rotate';

interface TransformState {
  cx: number; cy: number;
  w: number; h: number;
  angle: number;
  floatCanvas: HTMLCanvasElement;
  origX: number; origY: number;
  isPaste: boolean; // 貼り付けトランスフォーム: キャンセル時は破棄のみ（復元不要）
}

interface DragState {
  handle: HandleId | 'move';
  startMx: number; startMy: number;
  startCx: number; startCy: number;
  startW: number; startH: number;
  startAngle: number;
  rotStartMouseAngle: number;
}

export class SelectionManager {
  private _rect: Rect | null = null;
  private _lassoPoints: { x: number; y: number }[] = [];
  private _mode: 'rect' | 'lasso' = 'rect';
  private _mask: ImageData | null = null;
  private clipboard: { dataUrl: string; w: number; h: number } | null = null;
  private _transform: TransformState | null = null;
  private _drag: DragState | null = null;

  onSelectionChange?: () => void;

  get rect(): Rect | null { return this._rect; }
  get hasSelection(): boolean { return this._rect !== null || this._transform !== null; }
  get isTransforming(): boolean { return this._transform !== null; }
  get transformAngle(): number | null { return this._transform ? this._transform.angle : null; }

  setMode(mode: 'rect' | 'lasso') { this._mode = mode; }

  // ── 矩形選択 ──────────────────────────────────────────────────────────────────

  startRect(x: number, y: number) {
    if (this._transform) return;
    this._rect = { x, y, w: 0, h: 0 };
    this._lassoPoints = [];
  }

  updateRect(x: number, y: number, startX: number, startY: number) {
    if (this._transform) return;
    this._rect = {
      x: Math.min(x, startX),
      y: Math.min(y, startY),
      w: Math.abs(x - startX),
      h: Math.abs(y - startY)
    };
  }

  commitRect() {
    if (this._rect && (this._rect.w < 2 || this._rect.h < 2)) {
      this._rect = null;
    }
    this.onSelectionChange?.();
  }

  // ── 自由選択（ラッソ） ────────────────────────────────────────────────────────

  startLasso(x: number, y: number) {
    if (this._transform) return;
    this._lassoPoints = [{ x, y }];
    this._rect = null;
  }

  addLassoPoint(x: number, y: number) {
    this._lassoPoints.push({ x, y });
  }

  commitLasso() {
    if (this._lassoPoints.length < 3) {
      this._lassoPoints = [];
      this._rect = null;
      return;
    }
    const xs = this._lassoPoints.map(p => p.x);
    const ys = this._lassoPoints.map(p => p.y);
    this._rect = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys)
    };
    this.onSelectionChange?.();
  }

  clear() {
    this._rect = null;
    this._lassoPoints = [];
    this._mask = null;
    this._transform = null;
    this._drag = null;
    this.onSelectionChange?.();
  }

  // ── トランスフォームモード ─────────────────────────────────────────────────────

  enterTransform(mainCtx: CanvasRenderingContext2D): boolean {
    if (this._transform) return true;
    if (!this._rect) return false;
    const { x, y, w, h } = this.clampedRect(mainCtx.canvas.width, mainCtx.canvas.height);
    if (w < 2 || h < 2) return false;

    const fc = document.createElement('canvas');
    fc.width = w; fc.height = h;
    const fctx = fc.getContext('2d')!;

    // 選択範囲をキャプチャする（ラッソの場合はクリップして切り出す）
    fctx.save();
    if (this._lassoPoints.length >= 3) {
      fctx.beginPath();
      fctx.moveTo(this._lassoPoints[0].x - x, this._lassoPoints[0].y - y);
      for (const p of this._lassoPoints.slice(1)) fctx.lineTo(p.x - x, p.y - y);
      fctx.closePath();
      fctx.clip();
    }
    fctx.drawImage(mainCtx.canvas, x, y, w, h, 0, 0, w, h);
    fctx.restore();

    // メインキャンバスの選択領域を白で塗り潰す（切り取り）
    mainCtx.save();
    mainCtx.fillStyle = '#ffffff';
    if (this._lassoPoints.length >= 3) {
      mainCtx.beginPath();
      mainCtx.moveTo(this._lassoPoints[0].x, this._lassoPoints[0].y);
      for (const p of this._lassoPoints.slice(1)) mainCtx.lineTo(p.x, p.y);
      mainCtx.closePath();
      mainCtx.fill();
    } else {
      mainCtx.fillRect(x, y, w, h);
    }
    mainCtx.restore();

    this._transform = {
      cx: x + w / 2, cy: y + h / 2,
      w, h, angle: 0,
      floatCanvas: fc,
      origX: x, origY: y,
      isPaste: false
    };
    this._rect = null;
    this._lassoPoints = [];
    this.onSelectionChange?.();
    return true;
  }

  commitTransform(mainCtx: CanvasRenderingContext2D) {
    if (!this._transform) return;
    const t = this._transform;
    mainCtx.save();
    mainCtx.translate(t.cx, t.cy);
    mainCtx.rotate(t.angle);
    mainCtx.drawImage(t.floatCanvas, -t.w / 2, -t.h / 2, t.w, t.h);
    mainCtx.restore();
    this._transform = null;
    this._drag = null;
    this.onSelectionChange?.();
  }

  cancelTransform(mainCtx: CanvasRenderingContext2D) {
    if (!this._transform) return;
    const t = this._transform;
    if (!t.isPaste) {
      // enterTransform で切り取った領域を floatCanvas で復元する
      mainCtx.drawImage(t.floatCanvas, t.origX, t.origY);
    }
    this._transform = null;
    this._drag = null;
    this.onSelectionChange?.();
  }

  // クリップボードから貼り付けてトランスフォームモードに入る
  pasteAsTransform(dataUrl: string, w: number, h: number, mainCtx: CanvasRenderingContext2D): boolean {
    const canvasCx = mainCtx.canvas.width / 2;
    const canvasCy = mainCtx.canvas.height / 2;

    const fc = document.createElement('canvas');
    fc.width = w; fc.height = h;
    const fctx = fc.getContext('2d')!;

    const img = new Image();
    img.onload = () => {
      fctx.drawImage(img, 0, 0);
      this._transform = {
        cx: canvasCx, cy: canvasCy,
        w, h, angle: 0,
        floatCanvas: fc,
        origX: canvasCx - w / 2,
        origY: canvasCy - h / 2,
        isPaste: true
      };
      this._rect = null;
      this._lassoPoints = [];
      this.onSelectionChange?.();
    };
    img.src = dataUrl;
    return true;
  }

  // ── ハンドル操作 ──────────────────────────────────────────────────────────────

  private getHandlePositions(t: TransformState, hr: number): Map<HandleId, { x: number; y: number }> {
    const { cx, cy, w, h, angle } = t;
    const hw = w / 2, hh = h / 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rot = (lx: number, ly: number) => ({
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos
    });
    const m = new Map<HandleId, { x: number; y: number }>();
    m.set('nw', rot(-hw, -hh));
    m.set('n',  rot(0, -hh));
    m.set('ne', rot(hw, -hh));
    m.set('e',  rot(hw, 0));
    m.set('se', rot(hw, hh));
    m.set('s',  rot(0, hh));
    m.set('sw', rot(-hw, hh));
    m.set('w',  rot(-hw, 0));
    m.set('rotate', rot(0, -hh - hr * 4));
    return m;
  }

  getHandleAt(mx: number, my: number, zoom: number): HandleId | null {
    if (!this._transform) return null;
    const hr = Math.max(5, 8 / zoom);
    const handles = this.getHandlePositions(this._transform, hr);
    for (const [id, pos] of handles) {
      const dx = mx - pos.x, dy = my - pos.y;
      if (dx * dx + dy * dy <= hr * hr) return id;
    }
    return null;
  }

  isInsideTransform(mx: number, my: number): boolean {
    if (!this._transform) return false;
    const { cx, cy, w, h, angle } = this._transform;
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    const dx = mx - cx, dy = my - cy;
    const lx = dx * cos - dy * sin;
    const ly = dx * sin + dy * cos;
    return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
  }

  startHandleDrag(handle: HandleId | 'move', mx: number, my: number) {
    if (!this._transform) return;
    const t = this._transform;
    this._drag = {
      handle,
      startMx: mx, startMy: my,
      startCx: t.cx, startCy: t.cy,
      startW: t.w, startH: t.h,
      startAngle: t.angle,
      rotStartMouseAngle: Math.atan2(my - t.cy, mx - t.cx)
    };
  }

  updateHandleDrag(mx: number, my: number, shiftKey = false) {
    if (!this._transform || !this._drag) return;
    const t = this._transform;
    const d = this._drag;

    if (d.handle === 'move') {
      t.cx = d.startCx + (mx - d.startMx);
      t.cy = d.startCy + (my - d.startMy);
      return;
    }

    if (d.handle === 'rotate') {
      const mouseAngle = Math.atan2(my - d.startCy, mx - d.startCx);
      let newAngle = d.startAngle + (mouseAngle - d.rotStartMouseAngle);
      // Shift 押下中は 15° 単位でスナップする
      if (shiftKey) newAngle = Math.round(newAngle / (Math.PI / 12)) * (Math.PI / 12);
      t.angle = newAngle;
      return;
    }

    // リサイズ: ドラッグ開始時の中心を基準にローカル（非回転）空間で計算する
    const sa = d.startAngle;
    const cos = Math.cos(sa), sin = Math.sin(sa);
    const unrot = (wx: number, wy: number) => ({ x: wx * cos + wy * sin, y: -wx * sin + wy * cos });
    const rotv  = (lx: number, ly: number) => ({ x: lx * cos - ly * sin, y: lx * sin + ly * cos });

    const dxW = mx - d.startCx, dyW = my - d.startCy;
    const localMouse = unrot(dxW, dyW);
    const hw0 = d.startW / 2, hh0 = d.startH / 2;

    // ピン留めする対辺の位置と、どの軸が自由かを定義する
    const cfg: Record<string, { px: number; py: number; xFree: boolean; yFree: boolean }> = {
      nw: { px:  hw0, py:  hh0, xFree: true,  yFree: true  },
      ne: { px: -hw0, py:  hh0, xFree: true,  yFree: true  },
      sw: { px:  hw0, py: -hh0, xFree: true,  yFree: true  },
      se: { px: -hw0, py: -hh0, xFree: true,  yFree: true  },
      n:  { px:    0, py:  hh0, xFree: false, yFree: true  },
      s:  { px:    0, py: -hh0, xFree: false, yFree: true  },
      e:  { px: -hw0, py:    0, xFree: true,  yFree: false },
      w:  { px:  hw0, py:    0, xFree: true,  yFree: false },
    };
    const m = cfg[d.handle];
    if (!m) return;

    let newHw = hw0, newHh = hh0;
    let localNewCx = 0, localNewCy = 0;

    if (m.xFree) {
      newHw = Math.max(1, Math.abs(localMouse.x - m.px) / 2);
      localNewCx = (localMouse.x + m.px) / 2;
    }
    if (m.yFree) {
      newHh = Math.max(1, Math.abs(localMouse.y - m.py) / 2);
      localNewCy = (localMouse.y + m.py) / 2;
    }

    const worldShift = rotv(localNewCx, localNewCy);
    t.cx = d.startCx + worldShift.x;
    t.cy = d.startCy + worldShift.y;
    t.w = newHw * 2;
    t.h = newHh * 2;
    t.angle = d.startAngle;
  }

  endHandleDrag() {
    this._drag = null;
  }

  // ── コピー / カット / ペースト ────────────────────────────────────────────────

  copy(mainCtx: CanvasRenderingContext2D): boolean {
    if (!this._rect) return false;
    const { x, y, w, h } = this.clampedRect(mainCtx.canvas.width, mainCtx.canvas.height);
    if (w < 1 || h < 1) return false;

    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tc = tmp.getContext('2d')!;

    if (this._lassoPoints.length >= 3) {
      tc.beginPath();
      tc.moveTo(this._lassoPoints[0].x - x, this._lassoPoints[0].y - y);
      for (const p of this._lassoPoints.slice(1)) tc.lineTo(p.x - x, p.y - y);
      tc.closePath();
      tc.clip();
    }

    tc.drawImage(mainCtx.canvas, x, y, w, h, 0, 0, w, h);
    this.clipboard = { dataUrl: tmp.toDataURL('image/png'), w, h };
    return true;
  }

  cut(mainCtx: CanvasRenderingContext2D): boolean {
    if (!this.copy(mainCtx)) return false;
    const { x, y, w, h } = this.clampedRect(mainCtx.canvas.width, mainCtx.canvas.height);
    mainCtx.save();
    mainCtx.fillStyle = '#ffffff';
    if (this._lassoPoints.length >= 3) {
      mainCtx.beginPath();
      mainCtx.moveTo(this._lassoPoints[0].x, this._lassoPoints[0].y);
      for (const p of this._lassoPoints.slice(1)) mainCtx.lineTo(p.x, p.y);
      mainCtx.closePath();
      mainCtx.fill();
    } else {
      mainCtx.fillRect(x, y, w, h);
    }
    mainCtx.restore();
    return true;
  }

  paste(mainCtx: CanvasRenderingContext2D, onPaste?: (x: number, y: number, dataUrl: string, w: number, h: number) => void) {
    if (!this.clipboard) return;
    const { dataUrl, w, h } = this.clipboard;
    const cx = (mainCtx.canvas.width - w) / 2;
    const cy = (mainCtx.canvas.height - h) / 2;
    if (onPaste) {
      onPaste(cx, cy, dataUrl, w, h);
    } else {
      const img = new Image();
      img.onload = () => mainCtx.drawImage(img, cx, cy);
      img.src = dataUrl;
    }
  }

  setClipboard(dataUrl: string, w: number, h: number) {
    this.clipboard = { dataUrl, w, h };
  }

  hasClipboard(): boolean { return this.clipboard !== null; }

  getClipboard(): { dataUrl: string; w: number; h: number } | null { return this.clipboard; }

  // ── オーバーレイ描画 ──────────────────────────────────────────────────────────

  drawOverlay(ctx: CanvasRenderingContext2D, dashOffset: number, zoom = 1) {
    if (this._transform) {
      this.drawTransformOverlay(ctx, dashOffset, zoom);
      return;
    }

    // ラッソ: 描画中は開いたパス、確定後は閉じたパスで点線を描く
    if (this._lassoPoints.length >= 2) {
      const committed = this._rect !== null;
      ctx.save();
      ctx.lineWidth = 1.5 / zoom;
      const dash = 5 / zoom;

      ctx.beginPath();
      ctx.moveTo(this._lassoPoints[0].x, this._lassoPoints[0].y);
      for (const p of this._lassoPoints.slice(1)) ctx.lineTo(p.x, p.y);
      if (committed) ctx.closePath();

      ctx.strokeStyle = 'white';
      ctx.stroke();

      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = -dashOffset / zoom;
      ctx.strokeStyle = 'black';
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    // 矩形選択
    if (!this._rect) return;
    const { x, y, w, h } = this._rect;
    if (w < 1 || h < 1) return;

    ctx.save();
    ctx.lineWidth = 1.5 / zoom;
    const dash = 5 / zoom;

    ctx.strokeStyle = 'white';
    ctx.strokeRect(x, y, w, h);

    ctx.setLineDash([dash, dash]);
    ctx.lineDashOffset = -dashOffset / zoom;
    ctx.strokeStyle = 'black';
    ctx.strokeRect(x, y, w, h);

    ctx.setLineDash([]);
    ctx.restore();
  }

  private drawTransformOverlay(ctx: CanvasRenderingContext2D, dashOffset: number, zoom: number) {
    const t = this._transform!;
    const hr = Math.max(4, 7 / zoom);
    const lw = Math.max(0.5, 1 / zoom);
    const dash = 5 / zoom;

    // フローティング画像プレビュー
    ctx.save();
    ctx.translate(t.cx, t.cy);
    ctx.rotate(t.angle);
    ctx.drawImage(t.floatCanvas, -t.w / 2, -t.h / 2, t.w, t.h);
    ctx.restore();

    // 点線ボーダー（回転あり）
    ctx.save();
    ctx.translate(t.cx, t.cy);
    ctx.rotate(t.angle);
    ctx.lineWidth = lw * 1.5;

    ctx.strokeStyle = 'white';
    ctx.strokeRect(-t.w / 2, -t.h / 2, t.w, t.h);

    ctx.setLineDash([dash, dash]);
    ctx.lineDashOffset = -dashOffset / zoom;
    ctx.strokeStyle = 'black';
    ctx.strokeRect(-t.w / 2, -t.h / 2, t.w, t.h);

    ctx.setLineDash([]);
    ctx.restore();

    // ハンドル
    const handles = this.getHandlePositions(t, hr);
    const nPos = handles.get('n')!;
    const rPos = handles.get('rotate')!;

    // 上辺中央から回転ハンドルへの接続線
    ctx.save();
    ctx.strokeStyle = 'rgba(80,80,80,0.8)';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(nPos.x, nPos.y);
    ctx.lineTo(rPos.x, rPos.y);
    ctx.stroke();
    ctx.restore();

    for (const [id, pos] of handles) {
      ctx.save();
      ctx.fillStyle = 'white';
      ctx.strokeStyle = '#444';
      ctx.lineWidth = lw;
      if (id === 'rotate') {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, hr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#333';
        ctx.lineWidth = lw * 1.5;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, hr * 0.55, -Math.PI * 0.75, Math.PI * 0.5);
        ctx.stroke();
        const arrowAngle = Math.PI * 0.5;
        const ax = pos.x + Math.cos(arrowAngle) * hr * 0.55;
        const ay = pos.y + Math.sin(arrowAngle) * hr * 0.55;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax + Math.cos(arrowAngle + Math.PI * 0.6) * hr * 0.35, ay + Math.sin(arrowAngle + Math.PI * 0.6) * hr * 0.35);
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax + Math.cos(arrowAngle - Math.PI * 0.1) * hr * 0.35, ay + Math.sin(arrowAngle - Math.PI * 0.1) * hr * 0.35);
        ctx.stroke();
      } else {
        ctx.fillRect(pos.x - hr, pos.y - hr, hr * 2, hr * 2);
        ctx.strokeRect(pos.x - hr, pos.y - hr, hr * 2, hr * 2);
      }
      ctx.restore();
    }
  }

  private clampedRect(cw: number, ch: number): Rect {
    if (!this._rect) return { x: 0, y: 0, w: 0, h: 0 };
    const x = Math.max(0, Math.floor(this._rect.x));
    const y = Math.max(0, Math.floor(this._rect.y));
    const w = Math.min(cw - x, Math.ceil(this._rect.w));
    const h = Math.min(ch - y, Math.ceil(this._rect.h));
    return { x, y, w, h };
  }
}
