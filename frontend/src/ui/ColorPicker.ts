// HSV カラーホイール + SV 正方形 + RGB/HSL/Hex 入力

type RGB = [number, number, number];

function hsvToRgb(h: number, s: number, v: number): RGB {
  h = h / 360;
  let r: number, g: number, b: number;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s, v];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100; l /= 100; h /= 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function hexToRgb(hex: string): RGB | null {
  const m = /^([0-9a-f]{6})$/i.exec(hex.replace('#', ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

export class ColorPicker {
  private H = 0;   // 0-360
  private S = 1;   // 0-1（HSV 彩度）
  private V = 1;   // 0-1（HSV 明度）

  private canvas: HTMLCanvasElement;
  private ctx2d: CanvasRenderingContext2D;
  private readonly SIZE = 220;
  private readonly RING = 22;

  private dragging: 'hue' | 'sv' | null = null;
  onChange?: (r: number, g: number, b: number) => void;

  constructor() {
    this.canvas = document.getElementById('color-wheel-canvas') as HTMLCanvasElement;
    this.ctx2d = this.canvas.getContext('2d')!;
    this.renderWheel();
    this.setupEvents();
    this.setupInputs();
    this.setupPalette();
  }

  private get outerR() { return this.SIZE / 2 - 2; }
  private get innerR() { return this.outerR - this.RING; }

  setRGB(r: number, g: number, b: number) {
    const [h, s, v] = rgbToHsv(r, g, b);
    this.H = h; this.S = s; this.V = v;
    this.renderWheel();
    this.syncInputs(r, g, b);
    this.updateSwatches(r, g, b);
  }

  getRGB(): RGB {
    return hsvToRgb(this.H, this.S, this.V);
  }

  private renderWheel() {
    const ctx = this.ctx2d;
    const sz = this.SIZE;
    const cx = sz / 2, cy = sz / 2;
    const outerR = this.outerR;
    const innerR = this.innerR;

    ctx.clearRect(0, 0, sz, sz);

    // 色相リング
    for (let i = 0; i < 360; i++) {
      const a0 = (i - 0.5) * Math.PI / 180 - Math.PI / 2;
      const a1 = (i + 1.5) * Math.PI / 180 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a0) * innerR, cy + Math.sin(a0) * innerR);
      ctx.arc(cx, cy, outerR, a0, a1);
      ctx.arc(cx, cy, innerR, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = `hsl(${i},100%,50%)`;
      ctx.fill();
    }

    // 色相インジケーター
    const ha = this.H * Math.PI / 180 - Math.PI / 2;
    const midR = (outerR + innerR) / 2;
    const hx = cx + Math.cos(ha) * midR;
    const hy = cy + Math.sin(ha) * midR;
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(hx, hy, 3, 0, Math.PI * 2);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();

    // リング内部の SV 正方形
    const sqR = innerR * 0.9;
    const sqHalf = sqR / Math.SQRT2;
    const sqX = cx - sqHalf;
    const sqY = cy - sqHalf;
    const sqW = sqHalf * 2;

    const [hr, hg, hb] = hsvToRgb(this.H, 1, 1);
    ctx.fillStyle = `rgb(${hr},${hg},${hb})`;
    ctx.fillRect(sqX, sqY, sqW, sqW);

    const wg = ctx.createLinearGradient(sqX, sqY, sqX + sqW, sqY);
    wg.addColorStop(0, 'rgba(255,255,255,1)');
    wg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = wg;
    ctx.fillRect(sqX, sqY, sqW, sqW);

    const bg = ctx.createLinearGradient(sqX, sqY, sqX, sqY + sqW);
    bg.addColorStop(0, 'rgba(0,0,0,0)');
    bg.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = bg;
    ctx.fillRect(sqX, sqY, sqW, sqW);

    // SV インジケーター
    const svX = sqX + this.S * sqW;
    const svY = sqY + (1 - this.V) * sqW;
    ctx.beginPath();
    ctx.arc(svX, svY, 5, 0, Math.PI * 2);
    ctx.strokeStyle = this.V > 0.5 ? '#000' : '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private setupEvents() {
    const onDown = (e: PointerEvent) => {
      const pos = this.canvasPos(e);
      const cx = this.SIZE / 2, cy = this.SIZE / 2;
      const dx = pos.x - cx, dy = pos.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist >= this.innerR && dist <= this.outerR) {
        this.dragging = 'hue';
      } else if (dist < this.innerR * 0.9) {
        this.dragging = 'sv';
      }
      this.canvas.setPointerCapture(e.pointerId);
      this.handleDrag(pos.x, pos.y);
    };

    const onMove = (e: PointerEvent) => {
      if (!this.dragging) return;
      const pos = this.canvasPos(e);
      this.handleDrag(pos.x, pos.y);
    };

    const onUp = () => { this.dragging = null; };

    this.canvas.addEventListener('pointerdown', onDown);
    this.canvas.addEventListener('pointermove', onMove);
    this.canvas.addEventListener('pointerup', onUp);
    this.canvas.addEventListener('pointercancel', onUp);
  }

  private handleDrag(mx: number, my: number) {
    const cx = this.SIZE / 2, cy = this.SIZE / 2;

    if (this.dragging === 'hue') {
      const angle = Math.atan2(my - cy, mx - cx) + Math.PI / 2;
      this.H = ((angle * 180 / Math.PI) + 360) % 360;
    } else if (this.dragging === 'sv') {
      const sqR = this.innerR * 0.9;
      const sqHalf = sqR / Math.SQRT2;
      const sqX = cx - sqHalf, sqY = cy - sqHalf;
      const sqW = sqHalf * 2;
      this.S = Math.max(0, Math.min(1, (mx - sqX) / sqW));
      this.V = Math.max(0, Math.min(1, 1 - (my - sqY) / sqW));
    }

    this.renderWheel();
    const [r, g, b] = this.getRGB();
    this.syncInputs(r, g, b);
    this.updateSwatches(r, g, b);
    this.onChange?.(r, g, b);
  }

  private canvasPos(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.SIZE / rect.width;
    const scaleY = this.SIZE / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  private setupInputs() {
    const get = (id: string) => document.getElementById(id) as HTMLInputElement;
    const r = get('ci-r'), g = get('ci-g'), b = get('ci-b');
    const h = get('ci-h'), s = get('ci-s'), l = get('ci-l');
    const hex = get('ci-hex');

    const fromRGB = () => {
      const rv = clamp(+r.value, 0, 255);
      const gv = clamp(+g.value, 0, 255);
      const bv = clamp(+b.value, 0, 255);
      this.setRGB(rv, gv, bv);
      this.onChange?.(rv, gv, bv);
    };
    const fromHSL = () => {
      const [rv, gv, bv] = hslToRgb(+h.value, +s.value, +l.value);
      this.setRGB(rv, gv, bv);
      this.onChange?.(rv, gv, bv);
    };
    const fromHex = () => {
      const rgb = hexToRgb(hex.value);
      if (rgb) { this.setRGB(...rgb); this.onChange?.(...rgb); }
    };

    [r, g, b].forEach(el => el.addEventListener('change', fromRGB));
    [h, s, l].forEach(el => el.addEventListener('change', fromHSL));
    hex.addEventListener('change', fromHex);
  }

  private setupPalette() {
    document.querySelectorAll('.palette-swatch').forEach(el => {
      el.addEventListener('click', () => {
        const color = (el as HTMLElement).dataset.color || '#000000';
        const rgb = hexToRgb(color.replace('#', ''));
        if (rgb) { this.setRGB(...rgb); this.onChange?.(...rgb); }
      });
    });
  }

  private syncInputs(r: number, g: number, b: number) {
    const get = (id: string) => document.getElementById(id) as HTMLInputElement;
    get('ci-r').value = String(r);
    get('ci-g').value = String(g);
    get('ci-b').value = String(b);
    const [hv, sv, lv] = rgbToHsl(r, g, b);
    get('ci-h').value = String(hv);
    get('ci-s').value = String(sv);
    get('ci-l').value = String(lv);
    get('ci-hex').value = rgbToHex(r, g, b);
  }

  private updateSwatches(r: number, g: number, b: number) {
    const css = `rgb(${r},${g},${b})`;
    (document.getElementById('primary-swatch') as HTMLElement).style.background = css;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}
