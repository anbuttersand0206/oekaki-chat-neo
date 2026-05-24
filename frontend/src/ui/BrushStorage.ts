import { BrushConfig, BrushType, BRUSH_TYPES, CurvePoint, PARAM_IDS, defaultBrushConfig } from '../types';

// ── Number precision helper ────────────────────────────────────────────────────

function r3(n: number) { return Math.round(n * 1000) / 1000; }

function compactPts(pts: CurvePoint[]) {
  return pts.map(p => {
    const o: Record<string, number> = { x: r3(p.x), y: r3(p.y) };
    if (p.lx != null) { o.lx = r3(p.lx); o.ly = r3(p.ly!); }
    if (p.rx != null) { o.rx = r3(p.rx); o.ry = r3(p.ry!); }
    return o;
  });
}

function compactConfig(cfg: BrushConfig) {
  return {
    size:     cfg.size,
    opacity:  r3(cfg.opacity),
    density:  r3(cfg.density),
    spacing:  r3(cfg.spacing),
    hardness: r3(cfg.hardness),
    mixing:   r3(cfg.mixing),
    water:    r3(cfg.water),
    spread:   r3(cfg.spread),
    modifiers: Object.fromEntries(
      PARAM_IDS.map(pid => {
        const m = cfg.modifiers[pid];
        return [pid, {
          pressureCurve: compactPts(m.pressureCurve),
          speedCurve:    compactPts(m.speedCurve),
          randomAmount:  r3(m.randomAmount),
        }];
      })
    ),
  };
}

function expandConfig(type: BrushType, s: Record<string, unknown>): BrushConfig {
  const defaults = defaultBrushConfig(type);
  const mods = { ...defaults.modifiers };
  if (s.modifiers && typeof s.modifiers === 'object') {
    const rawMods = s.modifiers as Record<string, unknown>;
    for (const pid of PARAM_IDS) {
      if (rawMods[pid]) mods[pid] = rawMods[pid] as typeof mods[typeof pid];
    }
  }
  return {
    type,
    size:     typeof s.size     === 'number' ? s.size     : defaults.size,
    opacity:  typeof s.opacity  === 'number' ? s.opacity  : defaults.opacity,
    density:  typeof s.density  === 'number' ? s.density  : defaults.density,
    spacing:  typeof s.spacing  === 'number' ? s.spacing  : defaults.spacing,
    hardness: typeof s.hardness === 'number' ? s.hardness : defaults.hardness,
    mixing:   typeof s.mixing   === 'number' ? s.mixing   : defaults.mixing,
    water:    typeof s.water    === 'number' ? s.water    : defaults.water,
    spread:   typeof s.spread   === 'number' ? s.spread   : defaults.spread,
    modifiers: mods,
  };
}

// ── Public serialization API ───────────────────────────────────────────────────

export function serializeAllConfigs(
  allConfigs: Map<BrushType, BrushConfig>,
  activeType: BrushType
): Record<string, unknown> {
  const result: Record<string, unknown> = { activeType };
  for (const [type, cfg] of allConfigs) {
    result[type] = compactConfig(cfg);
  }
  return result;
}

export function deserializeAllConfigs(raw: Record<string, unknown>): {
  activeType: BrushType | null;
  configs: Map<BrushType, BrushConfig>;
} {
  const configs = new Map<BrushType, BrushConfig>();
  const activeType = typeof raw.activeType === 'string' ? raw.activeType as BrushType : null;
  for (const type of BRUSH_TYPES) {
    const entry = raw[type];
    configs.set(
      type,
      entry && typeof entry === 'object'
        ? expandConfig(type, entry as Record<string, unknown>)
        : defaultBrushConfig(type)
    );
  }
  return { activeType, configs };
}
