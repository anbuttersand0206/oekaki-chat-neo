import { BrushConfig, BrushType, CurvePoint, PARAM_IDS, defaultBrushConfig } from '../types';

const PRE = 'oekaki_brush_';
const EXPIRES_DAYS = 365;

// ── Cookie helpers ─────────────────────────────────────────────────────────────

function cookieSet(name: string, value: string) {
  const exp = new Date(Date.now() + EXPIRES_DAYS * 86400000).toUTCString();
  document.cookie =
    `${PRE}${name}=${encodeURIComponent(value)};expires=${exp};path=/;SameSite=Lax`;
}

function cookieGet(name: string): string | null {
  const key = PRE + name;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// ── Number precision helper ────────────────────────────────────────────────────

function r3(n: number) { return Math.round(n * 1000) / 1000; }

// ── Serialization ──────────────────────────────────────────────────────────────

function compactConfig(cfg: BrushConfig) {
  const compactPts = (pts: CurvePoint[]) =>
    pts.map(p => {
      const o: Record<string, number> = { x: r3(p.x), y: r3(p.y) };
      if (p.lx != null) { o.lx = r3(p.lx); o.ly = r3(p.ly!); }
      if (p.rx != null) { o.rx = r3(p.rx); o.ry = r3(p.ry!); }
      return o;
    });

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

// ── Public API ─────────────────────────────────────────────────────────────────

export function saveBrushCfg(cfg: BrushConfig) {
  try {
    cookieSet(cfg.type, JSON.stringify(compactConfig(cfg)));
  } catch { /* cookie too large or blocked — silently skip */ }
}

export function loadBrushCfg(type: BrushType): BrushConfig {
  const raw = cookieGet(type);
  const defaults = defaultBrushConfig(type);
  if (!raw) return defaults;

  try {
    const s = JSON.parse(raw);
    const mods = { ...defaults.modifiers };
    if (s.modifiers) {
      for (const pid of PARAM_IDS) {
        if (s.modifiers[pid]) mods[pid] = s.modifiers[pid];
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
  } catch {
    return defaults;
  }
}

export function saveActiveBrushType(type: BrushType) {
  try { cookieSet('type', type); } catch { /* ignore */ }
}

export function loadActiveBrushType(): BrushType | null {
  return cookieGet('type') as BrushType | null;
}
