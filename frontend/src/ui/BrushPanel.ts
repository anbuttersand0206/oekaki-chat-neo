import {
  BrushType, BrushConfig, ParamId, PARAM_IDS, PARAM_NAMES, BRUSH_TYPES,
  defaultBrushConfig, defaultModifiers, isWetBrush
} from '../types';
import { CurveEditor } from './CurveEditor';
import { serializeAllConfigs, deserializeAllConfigs } from './BrushStorage';

/**
 * ブラシ設定の UI と状態を管理する。
 *
 * ブラシ種別ごとに独立した BrushConfig を保持し、
 * スライダー操作後はデバウンスして Socket.IO 経由でサーバーに保存する。
 * スライダー ↔ 数値入力の同期もここで行う。
 */
export class BrushPanel {
  private allConfigs: Map<BrushType, BrushConfig> = new Map(
    BRUSH_TYPES.map(t => [t, defaultBrushConfig(t)])
  );
  private cfg: BrushConfig = this.allConfigs.get('pen')!;
  private texture: ImageData | null = null;

  // 選択中のパラメータに対して筆圧・速度カーブを 1 本ずつ表示する
  private selectedParam: ParamId = 'size';
  private pressureEditor!: CurveEditor;
  private speedEditor!: CurveEditor;

  private saveTimer: number | null = null;

  onChange?: () => void;
  onSave?: (settings: Record<string, unknown>) => void;

  get brushConfig(): BrushConfig { return { ...this.cfg, modifiers: this.cfg.modifiers }; }
  get currentTexture(): ImageData | null { return this.texture; }

  get size()    { return this.cfg.size; }
  adjustSize(delta: number) {
    this.cfg.size = Math.max(1, Math.min(500, this.cfg.size + delta));
    this.syncSlider('bp-size', this.cfg.size);
    this.onChange?.();
    this.renderPreview();
    this.debouncedSave();
  }

  // ── room_joined 時にサーバーから受信したブラシ設定を復元する ─────────────────
  restoreAllBrushConfigs(raw: Record<string, unknown>) {
    const { activeType, configs } = deserializeAllConfigs(raw);
    this.allConfigs = configs;
    const type = (activeType && BRUSH_TYPES.includes(activeType as BrushType))
      ? activeType as BrushType
      : this.cfg.type;
    this.cfg = this.allConfigs.get(type)!;
    this.syncAllSliders();
    this.updateWetVisibility();
    this.updateCurveEditors();
    this.onChange?.();
    this.renderPreview();
  }

  // ── 初期化 ────────────────────────────────────────────────────────────────────
  init() {
    this.bindBrushTypeButtons();
    this.bindCommonSliders();
    this.bindWetSliders();
    this.bindParamSelector();
    this.bindCurveEditors();
    this.bindTexture();
    this.updateWetVisibility();
    this.syncAllSliders();
    this.updateCurveEditors();
    this.renderPreview();
  }

  // ── PostgreSQL への保存をデバウンスして Socket 経由で送信する ─────────────────
  private debouncedSave() {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.onSave?.(serializeAllConfigs(this.allConfigs, this.cfg.type));
      this.saveTimer = null;
    }, 400);
  }

  // ── ブラシ種別ボタン ──────────────────────────────────────────────────────────
  private bindBrushTypeButtons() {
    document.querySelectorAll<HTMLElement>('[data-brush-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.brushType as BrushType;
        if (t === this.cfg.type) return;
        this.allConfigs.set(this.cfg.type, this.cfg);
        document.querySelectorAll('[data-brush-type]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.cfg = this.allConfigs.get(t)!;
        this.syncAllSliders();
        this.updateWetVisibility();
        this.updateCurveEditors();
        this.onChange?.();
        this.renderPreview();
        this.debouncedSave();
      });
    });
  }

  // ── 共通スライダー ────────────────────────────────────────────────────────────
  private bindCommonSliders() {
    this.bindSlider('bp-size',     v => { this.cfg.size     = v; });
    this.bindSlider('bp-opacity',  v => { this.cfg.opacity  = v / 100; });
    this.bindSlider('bp-density',  v => { this.cfg.density  = v / 100; });
    this.bindSlider('bp-spacing',  v => { this.cfg.spacing  = v / 100; });
    this.bindSlider('bp-hardness', v => { this.cfg.hardness = v / 100; });
  }

  private bindWetSliders() {
    this.bindSlider('bp-mixing', v => { this.cfg.mixing = v / 100; });
    this.bindSlider('bp-water',  v => { this.cfg.water  = v / 100; });
    this.bindSlider('bp-spread', v => { this.cfg.spread = v / 100; });
  }

  private bindSlider(id: string, onValueChange: (newValue: number) => void) {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    const num    = document.getElementById(id + '-num') as HTMLInputElement | null;
    if (!slider) return;
    slider.addEventListener('input', () => {
      if (num) num.value = slider.value;
      onValueChange(+slider.value);
      this.onChange?.();
      this.debouncedSave();
      this.renderPreview();
    });
    num?.addEventListener('change', () => {
      slider.value = num.value;
      onValueChange(+num.value);
      this.onChange?.();
      this.debouncedSave();
    });
  }

  private syncSlider(id: string, newValue: number) {
    const slider = document.getElementById(id) as HTMLInputElement | null;
    const num    = document.getElementById(id + '-num') as HTMLInputElement | null;
    if (slider) slider.value = String(newValue);
    if (num)    num.value    = String(newValue);
  }

  private syncAllSliders() {
    this.syncSlider('bp-size',     this.cfg.size);
    this.syncSlider('bp-opacity',  Math.round(this.cfg.opacity  * 100));
    this.syncSlider('bp-density',  Math.round(this.cfg.density  * 100));
    this.syncSlider('bp-spacing',  Math.round(this.cfg.spacing  * 100));
    this.syncSlider('bp-hardness', Math.round(this.cfg.hardness * 100));
    this.syncSlider('bp-mixing',   Math.round(this.cfg.mixing   * 100));
    this.syncSlider('bp-water',    Math.round(this.cfg.water    * 100));
    this.syncSlider('bp-spread',   Math.round(this.cfg.spread   * 100));
    document.querySelectorAll('[data-brush-type]').forEach(b => {
      b.classList.toggle('active', (b as HTMLElement).dataset.brushType === this.cfg.type);
    });
  }

  private updateWetVisibility() {
    const el = document.getElementById('bp-wet-section') as HTMLElement | null;
    if (el) el.style.display = isWetBrush(this.cfg.type) ? '' : 'none';
  }

  // ── モディファイア / カーブセクション ──────────────────────────────────────────
  private bindParamSelector() {
    document.querySelectorAll<HTMLElement>('[data-mod-param]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.selectedParam = btn.dataset.modParam as ParamId;
        document.querySelectorAll('[data-mod-param]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.updateCurveEditors();
      });
    });
    const randSlider = document.getElementById('bp-random') as HTMLInputElement | null;
    randSlider?.addEventListener('input', () => {
      this.cfg.modifiers[this.selectedParam].randomAmount = +randSlider.value / 100;
      this.onChange?.();
      this.debouncedSave();
    });
  }

  private bindCurveEditors() {
    const presCanvas  = document.getElementById('curve-pressure') as HTMLCanvasElement | null;
    const speedCanvas = document.getElementById('curve-speed')    as HTMLCanvasElement | null;
    if (!presCanvas || !speedCanvas) return;

    this.pressureEditor = new CurveEditor(presCanvas,  { xLabel: '筆圧' });
    this.speedEditor    = new CurveEditor(speedCanvas, { xLabel: '速度' });

    this.pressureEditor.onChange = pts => {
      this.cfg.modifiers[this.selectedParam].pressureCurve = pts;
      this.onChange?.();
      this.debouncedSave();
    };
    this.speedEditor.onChange = pts => {
      this.cfg.modifiers[this.selectedParam].speedCurve = pts;
      this.onChange?.();
      this.debouncedSave();
    };

    document.getElementById('curve-pressure-reset')?.addEventListener('click', () => {
      const def = defaultBrushConfig(this.cfg.type).modifiers[this.selectedParam];
      this.pressureEditor.setPoints(def.pressureCurve);
      this.cfg.modifiers[this.selectedParam].pressureCurve = def.pressureCurve.map(p => ({ ...p }));
      this.onChange?.();
      this.debouncedSave();
    });
    document.getElementById('curve-speed-reset')?.addEventListener('click', () => {
      const def = defaultBrushConfig(this.cfg.type).modifiers[this.selectedParam];
      this.speedEditor.setPoints(def.speedCurve);
      this.cfg.modifiers[this.selectedParam].speedCurve = def.speedCurve.map(p => ({ ...p }));
      this.onChange?.();
      this.debouncedSave();
    });

    document.querySelectorAll<HTMLElement>('#curve-pressure-presets .curve-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => this.pressureEditor.setPreset(btn.dataset.preset!));
    });
    document.querySelectorAll<HTMLElement>('#curve-speed-presets .curve-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => this.speedEditor.setPreset(btn.dataset.preset!));
    });
  }

  private updateCurveEditors() {
    if (!this.pressureEditor || !this.speedEditor) return;
    const m = this.cfg.modifiers[this.selectedParam];
    this.pressureEditor.setPoints(m.pressureCurve);
    this.speedEditor   .setPoints(m.speedCurve);
    const randSlider = document.getElementById('bp-random') as HTMLInputElement | null;
    if (randSlider) randSlider.value = String(Math.round(m.randomAmount * 100));
    document.querySelectorAll('[data-mod-param]').forEach(b => {
      b.classList.toggle('active', (b as HTMLElement).dataset.modParam === this.selectedParam);
    });
  }

  // ── 紙テクスチャ ──────────────────────────────────────────────────────────────
  private bindTexture() {
    const input = document.getElementById('bp-texture-input') as HTMLInputElement | null;
    input?.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const cvs = document.createElement('canvas');
        cvs.width = img.width; cvs.height = img.height;
        const c = cvs.getContext('2d')!;
        c.drawImage(img, 0, 0);
        this.texture = c.getImageData(0, 0, img.width, img.height);
        URL.revokeObjectURL(url);
        this.updateTexturePreview();
        this.onChange?.();
      };
      img.src = url;
    });
    document.getElementById('bp-texture-clear')?.addEventListener('click', () => {
      this.texture = null;
      this.updateTexturePreview();
      this.onChange?.();
    });
  }

  private updateTexturePreview() {
    const preview = document.getElementById('bp-texture-preview') as HTMLCanvasElement | null;
    if (!preview) return;
    const ctx = preview.getContext('2d')!;
    ctx.clearRect(0, 0, preview.width, preview.height);
    if (this.texture) {
      const textureCanvas = document.createElement('canvas');
      textureCanvas.width = this.texture.width; textureCanvas.height = this.texture.height;
      textureCanvas.getContext('2d')!.putImageData(this.texture, 0, 0);
      ctx.drawImage(textureCanvas, 0, 0, preview.width, preview.height);
    } else {
      ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? '#d8d8e2' : '#2a2a32';
      ctx.fillRect(0, 0, preview.width, preview.height);
      ctx.fillStyle = '#666';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('テクスチャなし', preview.width/2, preview.height/2 + 4);
    }
  }

  // ── ブラシプレビュー ──────────────────────────────────────────────────────────
  renderPreview() {
    const canvas = document.getElementById('brush-preview') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const isLight = document.documentElement.dataset.theme === 'light';
    const bg = isLight ? '#d8d8e2' : '#2a2a2e';
    const fg = isLight ? '20,20,40' : '255,255,255';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = Math.min(this.cfg.size / 2, canvas.height / 2 - 4);
    const alpha = this.cfg.opacity * this.cfg.density;
    const hardness = this.cfg.hardness;
    if (hardness >= 0.99) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${fg},${alpha})`;
      ctx.fill();
    } else {
      const grad = ctx.createRadialGradient(cx, cy, r * hardness, cx, cy, r);
      grad.addColorStop(0, `rgba(${fg},${alpha})`);
      grad.addColorStop(1, `rgba(${fg},0)`);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();
    }
  }
}
