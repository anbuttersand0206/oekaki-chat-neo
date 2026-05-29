export const CANVAS_W = 1600;
export const CANVAS_H = 1200;

// ── ブラシ種別 ─────────────────────────────────────────────────────────────────
export type BrushType =
  | 'pen' | 'marker' | 'pencil' | 'crayon' | 'airbrush'
  | 'watercolor' | 'oil' | 'pastel' | 'blur';

export const BRUSH_TYPES: BrushType[] = [
  'pen', 'marker', 'pencil', 'crayon', 'airbrush',
  'watercolor', 'oil', 'pastel', 'blur'
];

export const BRUSH_TYPE_NAMES: Record<BrushType, string> = {
  pen: 'ペン', marker: 'マーカー', pencil: '鉛筆', crayon: 'クレヨン',
  airbrush: 'エアブラシ', watercolor: '水彩', oil: '油彩',
  pastel: 'パステル', blur: 'ぼかし'
};

// ── パラメータ ID ──────────────────────────────────────────────────────────────
export type ParamId =
  | 'size' | 'opacity' | 'density' | 'spacing'
  | 'mixing' | 'water' | 'spread';

export const PARAM_IDS: ParamId[] = [
  'size', 'opacity', 'density', 'spacing', 'mixing', 'water', 'spread'
];

export const PARAM_NAMES: Record<ParamId, string> = {
  size: 'サイズ', opacity: '不透明度', density: '濃度', spacing: '間隔',
  mixing: '混色', water: '水分量', spread: '色伸び'
};

// ── モディファイアカーブ（区分線形補間） ───────────────────────────────────────
export interface CurvePoint {
  x: number;   // アンカー X  0–1（入力値）
  y: number;   // アンカー Y  0–1（出力乗数）
  lx?: number; // 左ハンドル X（絶対座標）
  ly?: number; // 左ハンドル Y（絶対座標）
  rx?: number; // 右ハンドル X（絶対座標）
  ry?: number; // 右ハンドル Y（絶対座標）
}

export const DEFAULT_CURVE: CurvePoint[] = [
  { x: 0, y: 1 }, { x: 1, y: 1 }
];

export interface ParamModifiers {
  pressureCurve: CurvePoint[]; // 入力=筆圧(0-1)、出力=乗数(0-2)
  speedCurve:    CurvePoint[]; // 入力=正規化速度(0-1)、出力=乗数(0-2)
  randomAmount:  number;       // ±ランダム量（0-1）。ダブごとに適用
}

export function defaultModifiers(): ParamModifiers {
  return {
    pressureCurve: DEFAULT_CURVE.map(p => ({ ...p })),
    speedCurve:    DEFAULT_CURVE.map(p => ({ ...p })),
    randomAmount:  0
  };
}

// ── ブラシ設定 ─────────────────────────────────────────────────────────────────
export interface BrushConfig {
  type:      BrushType;
  size:      number;  // 1-500 px
  opacity:   number;  // 0-1
  density:   number;  // 0-1（ダブごとの寄与率）
  spacing:   number;  // 0.01-2.0（サイズに対する割合）
  hardness:  number;  // 0-1（0=完全ソフト、1=ハード円）
  mixing:    number;  // 0-1 ウェットブラシ
  water:     number;  // 0-1 ウェットブラシ
  spread:    number;  // 0-1 ウェットブラシ
  modifiers: Record<ParamId, ParamModifiers>;
}

export function defaultBrushConfig(type: BrushType = 'pen'): BrushConfig {
  const mods = {} as Record<ParamId, ParamModifiers>;
  for (const pid of PARAM_IDS) mods[pid] = defaultModifiers();

  // ブラシ種別ごとに筆圧カーブのデフォルトを上書きする
  if (type === 'pen') {
    // サイズ: 筆圧 0→100% 線形（筆圧がそのままサイズに反映）
    mods['size'].pressureCurve = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  }
  if (type === 'marker') {
    // 不透明度: 筆圧 0→100% 線形
    mods['opacity'].pressureCurve = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  }
  if (type === 'pencil') {
    mods['size'].pressureCurve    = [{ x: 0, y: 0.5 }, { x: 1, y: 1 }];
    mods['density'].pressureCurve = [{ x: 0, y: 0   }, { x: 1, y: 1 }];
  }
  if (type === 'watercolor') {
    // 不透明度: 筆圧 50→100% 線形
    mods['opacity'].pressureCurve = [{ x: 0, y: 0.5 }, { x: 1, y: 1 }];
    // 濃度: 筆圧 0→100% 線形
    mods['density'].pressureCurve = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  }

  const presets: Partial<Record<BrushType, Partial<BrushConfig>>> = {
    pen:        { size: 3,  opacity: 1.0,  density: 1.0,  spacing: 0.05, hardness: 0.95 },
    marker:     { size: 15, opacity: 0.85, density: 0.9,  spacing: 0.05, hardness: 0.85 },
    pencil:     { size: 5,  opacity: 0.8,  density: 0.7,  spacing: 0.06, hardness: 0.5  },
    crayon:     { size: 10, opacity: 0.9,  density: 0.8,  spacing: 0.08, hardness: 0.7  },
    airbrush:   { size: 40, opacity: 0.5,  density: 0.4,  spacing: 0.08, hardness: 0.0  },
    watercolor: { size: 30, opacity: 1.0,  density: 0.8,  spacing: 0.05, hardness: 0.8,  mixing: 0.6, water: 0.8, spread: 0.4 },
    oil:        { size: 20, opacity: 1.0, density: 1.0,  spacing: 0.10, hardness: 0.65, mixing: 0.50, water: 0.35, spread: 0.30 },
    pastel:     { size: 20, opacity: 0.7,  density: 0.6,  spacing: 0.1,  hardness: 0.6  },
    blur:       { size: 50, opacity: 0.6,  density: 0.6,  spacing: 0.2,  hardness: 0.0  },
  };
  const p = presets[type] ?? {};
  return {
    type,
    size:      p.size      ?? 16,
    opacity:   p.opacity   ?? 1.0,
    density:   p.density   ?? 1.0,
    spacing:   p.spacing   ?? 0.1,
    hardness:  p.hardness  ?? 0.8,
    mixing:    p.mixing    ?? 0.5,
    water:     p.water     ?? 0.5,
    spread:    p.spread    ?? 0.3,
    modifiers: mods
  };
}

// ── ウェットブラシ判定 ────────────────────────────────────────────────────────
export function isWetBrush(t: BrushType): boolean {
  return t === 'watercolor' || t === 'oil';
}

// ── ストローク設定（実行時） ───────────────────────────────────────────────────
export interface StrokeSettings {
  brushConfig: BrushConfig;
  color: [number, number, number]; // RGB 0-255
  eraser: boolean;
  texture?: ImageData | null;
}

// ── ネットワーク用ストロークポイント ──────────────────────────────────────────
export interface StrokePoint {
  x: number;
  y: number;
  p: number;   // 筆圧 0-1
  sp?: number; // 速度 px/s
}

// ── 描画操作の型定義 ──────────────────────────────────────────────────────────
export interface DrawOpStroke {
  type:   'stroke';
  tool:   'brush' | 'eraser';
  color:  [number, number, number];
  brushType: BrushType;
  size:      number;
  opacity:   number;
  density:   number;
  spacing:   number;
  hardness:  number;
  mixing:    number;
  water:     number;
  spread:    number;
  modifiersJson: string; // JSON.stringify(Record<ParamId,ParamModifiers>)
  points: StrokePoint[];
  final?: boolean;
}

export interface DrawOpFill {
  type: 'fill';
  x: number; y: number;
  color: [number, number, number];
  tolerance: number;
}

export interface DrawOpClear { type: 'clear'; }

export interface DrawOpPaste {
  type: 'paste';
  x: number; y: number;
  dataUrl: string;
  width: number; height: number;
}

export type DrawOp = DrawOpStroke | DrawOpFill | DrawOpClear | DrawOpPaste;

export type ToolType =
  | 'brush' | 'eraser' | 'fill' | 'pan'
  | 'rectSelect' | 'lasso' | 'eyedropper';

// ── ユーザー / 部屋 ────────────────────────────────────────────────────────────
export interface User { id: string; name: string; }

export const USER_COLORS = [
  '#5b8fff', '#ff6b9d', '#6bcb77', '#ffd93d',
  '#ff9f43', '#e056fd', '#48dbfb', '#ff6b6b'
];
