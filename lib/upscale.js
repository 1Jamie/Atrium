'use strict';

/**
 * Resolve host upscaler config: CLI/env (launch) > per-program profile > defaults.
 * UI overrides always apply at runtime and are persisted per gameLabel.
 */

const DEFAULTS = {
  mode: 'off',
  sharpenRcas: false,
  sgsrEdgeThreshold: 8 / 255,
  sgsrEdgeSharpness: 2,
  sgsrUseEdgeDirection: true,
  rcasSharpnessStops: 0.2,
  anime4kMode: 'a',
  anime4kTier: 'm',
  anime4kPlusA: false,
};

const ENV_KEYS = [
  'ATRIUM_UPSCALE',
  'ATRIUM_SHARPEN',
  'ATRIUM_SGSR_THRESHOLD',
  'ATRIUM_SGSR_SHARPNESS',
  'ATRIUM_SGSR_EDGE_DIRECTION',
  'ATRIUM_RCAS_SHARPNESS',
  'ATRIUM_ANIME4K_MODE',
  'ATRIUM_ANIME4K_TIER',
  'ATRIUM_ANIME4K_PLUS_A',
];

function parseMode(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (['0', 'off', 'none', 'bilinear'].includes(s)) return 'off';
  if (['1', 'on', 'sgsr'].includes(s)) return 'sgsr';
  if (['fsr1', 'fsr', 'easu'].includes(s)) return 'fsr1';
  if (['anime4k', 'a4k'].includes(s)) return 'anime4k';
  return null;
}

function parseAnime4kMode(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (['a', 'mode_a', 'modea'].includes(s)) return 'a';
  if (['b', 'mode_b', 'modeb'].includes(s)) return 'b';
  if (['c', 'mode_c', 'codec'].includes(s)) return 'c';
  return null;
}

function parseAnime4kTier(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (['s', 'fast'].includes(s)) return 's';
  if (['m', 'balanced'].includes(s)) return 'm';
  if (['l', 'high'].includes(s)) return 'l';
  if (['vl', 'veryhigh', 'very_high'].includes(s)) return 'vl';
  if (['ul', 'ultra'].includes(s)) return 'ul';
  return null;
}

function parseThreshold(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n > 1 ? Math.min(1, n / 255) : n;
}

function parseBoolish(raw, defaultTrue) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(s)) return false;
  if (['1', 'on', 'true', 'yes'].includes(s)) return true;
  return defaultTrue;
}

function fromEnv() {
  const out = {};
  let any = false;
  const mode = parseMode(process.env.ATRIUM_UPSCALE);
  if (mode != null) {
    out.mode = mode;
    any = true;
  }
  if (process.env.ATRIUM_SHARPEN != null) {
    const s = String(process.env.ATRIUM_SHARPEN).toLowerCase();
    out.sharpenRcas = ['rcas', 'cas', '1', 'on'].includes(s);
    any = true;
  }
  const thr = parseThreshold(process.env.ATRIUM_SGSR_THRESHOLD);
  if (thr != null) {
    out.sgsrEdgeThreshold = thr;
    any = true;
  }
  if (process.env.ATRIUM_SGSR_SHARPNESS != null) {
    const n = Number(process.env.ATRIUM_SGSR_SHARPNESS);
    if (Number.isFinite(n) && n >= 0) {
      out.sgsrEdgeSharpness = n;
      any = true;
    }
  }
  if (process.env.ATRIUM_SGSR_EDGE_DIRECTION != null) {
    out.sgsrUseEdgeDirection = parseBoolish(process.env.ATRIUM_SGSR_EDGE_DIRECTION, true);
    any = true;
  }
  if (process.env.ATRIUM_RCAS_SHARPNESS != null) {
    const n = Number(process.env.ATRIUM_RCAS_SHARPNESS);
    if (Number.isFinite(n) && n >= 0) {
      out.rcasSharpnessStops = n;
      any = true;
    }
  }
  const a4kMode = parseAnime4kMode(process.env.ATRIUM_ANIME4K_MODE);
  if (a4kMode != null) {
    out.anime4kMode = a4kMode;
    any = true;
  }
  const a4kTier = parseAnime4kTier(process.env.ATRIUM_ANIME4K_TIER);
  if (a4kTier != null) {
    out.anime4kTier = a4kTier;
    any = true;
  }
  if (process.env.ATRIUM_ANIME4K_PLUS_A != null) {
    out.anime4kPlusA = parseBoolish(process.env.ATRIUM_ANIME4K_PLUS_A, false);
    any = true;
  }
  return { partial: out, any };
}

function fromCliFlags(cli) {
  if (!cli || typeof cli !== 'object') return { partial: {}, any: false };
  const out = {};
  let any = false;
  if (cli.upscale != null) {
    const m = parseMode(cli.upscale);
    if (m) {
      out.mode = m;
      any = true;
    }
  }
  if (cli.sharpen != null) {
    const s = String(cli.sharpen).toLowerCase();
    out.sharpenRcas = ['rcas', 'cas', '1', 'on', 'true'].includes(s);
    any = true;
  }
  if (cli.sgsrThreshold != null) {
    const t = parseThreshold(cli.sgsrThreshold);
    if (t != null) {
      out.sgsrEdgeThreshold = t;
      any = true;
    }
  }
  if (cli.sgsrSharpness != null) {
    const n = Number(cli.sgsrSharpness);
    if (Number.isFinite(n)) {
      out.sgsrEdgeSharpness = n;
      any = true;
    }
  }
  if (cli.sgsrEdgeDirection != null) {
    out.sgsrUseEdgeDirection = !!cli.sgsrEdgeDirection;
    any = true;
  }
  if (cli.rcasSharpness != null) {
    const n = Number(cli.rcasSharpness);
    if (Number.isFinite(n)) {
      out.rcasSharpnessStops = n;
      any = true;
    }
  }
  if (cli.anime4kMode != null) {
    const m = parseAnime4kMode(cli.anime4kMode);
    if (m) {
      out.anime4kMode = m;
      any = true;
    }
  }
  if (cli.anime4kTier != null) {
    const t = parseAnime4kTier(cli.anime4kTier);
    if (t) {
      out.anime4kTier = t;
      any = true;
    }
  }
  if (cli.anime4kPlusA != null) {
    out.anime4kPlusA = !!cli.anime4kPlusA;
    any = true;
  }
  return { partial: out, any };
}

function clampConfig(cfg) {
  const c = { ...DEFAULTS, ...cfg };
  c.mode = parseMode(c.mode) || 'off';
  c.sharpenRcas = !!c.sharpenRcas;
  let thr = Number(c.sgsrEdgeThreshold);
  if (!Number.isFinite(thr) || thr < 0) thr = DEFAULTS.sgsrEdgeThreshold;
  if (thr > 1) thr = thr / 255;
  c.sgsrEdgeThreshold = Math.min(1, Math.max(0, thr));
  let sharp = Number(c.sgsrEdgeSharpness);
  if (!Number.isFinite(sharp) || sharp < 0) sharp = DEFAULTS.sgsrEdgeSharpness;
  c.sgsrEdgeSharpness = Math.min(4, Math.max(0.5, sharp));
  c.sgsrUseEdgeDirection = c.sgsrUseEdgeDirection !== false;
  let stops = Number(c.rcasSharpnessStops);
  if (!Number.isFinite(stops) || stops < 0) stops = DEFAULTS.rcasSharpnessStops;
  c.rcasSharpnessStops = Math.min(2, Math.max(0, stops));

  c.anime4kMode = parseAnime4kMode(c.anime4kMode) || DEFAULTS.anime4kMode;
  c.anime4kTier = parseAnime4kTier(c.anime4kTier) || DEFAULTS.anime4kTier;
  c.anime4kPlusA = !!c.anime4kPlusA;

  return c;
}

function gameKey(gameLabel) {
  return String(gameLabel || 'game')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 80);
}

function readProfileGame(profile, gameLabel) {
  const key = gameKey(gameLabel);
  const games = profile && profile.games && typeof profile.games === 'object' ? profile.games : {};
  const entry = games[key];
  if (!entry || typeof entry !== 'object' || !entry.upscale) return null;
  return clampConfig(entry.upscale);
}

function writeProfileGame(profile, gameLabel, upscale) {
  const key = gameKey(gameLabel);
  if (!profile.games || typeof profile.games !== 'object') profile.games = {};
  if (!profile.games[key] || typeof profile.games[key] !== 'object') profile.games[key] = {};
  profile.games[key].upscale = clampConfig(upscale);
  return profile.games[key].upscale;
}

/**
 * @param {object} opts
 * @param {object} opts.profile
 * @param {string} opts.gameLabel
 * @param {object} [opts.cli] flags from argv
 * @returns {{ config: object, source: 'cli'|'env'|'profile'|'default', launchOverride: boolean }}
 */
function resolveUpscaleConfig({ profile, gameLabel, cli }) {
  const fromCli = fromCliFlags(cli);
  const fromE = fromEnv();
  if (fromCli.any || fromE.any) {
    const merged = clampConfig({
      ...DEFAULTS,
      ...(readProfileGame(profile, gameLabel) || {}),
      ...fromE.partial,
      ...fromCli.partial,
    });
    return {
      config: merged,
      source: fromCli.any ? 'cli' : 'env',
      launchOverride: true,
    };
  }
  const saved = readProfileGame(profile, gameLabel);
  if (saved) {
    return { config: saved, source: 'profile', launchOverride: false };
  }
  return { config: { ...DEFAULTS }, source: 'default', launchOverride: false };
}

function labelForBadge(cfg) {
  const c = clampConfig(cfg || {});
  let base = 'OFF';
  if (c.mode === 'sgsr') base = 'SGSR 1.0';
  else if (c.mode === 'fsr1') base = 'FSR 1.0';
  else if (c.mode === 'anime4k') {
    const modeUpper = c.anime4kMode.toUpperCase();
    const plusA = c.anime4kPlusA ? '+A' : '';
    const tierUpper = c.anime4kTier.toUpperCase();
    base = `A4K ${modeUpper}${plusA} (${tierUpper})`;
  }
  if (c.sharpenRcas && base !== 'OFF') return base + '+CAS';
  if (c.sharpenRcas && base === 'OFF') return 'CAS';
  return base;
}

function envOverridesPresent() {
  return ENV_KEYS.some((k) => process.env[k] != null && process.env[k] !== '');
}

module.exports = {
  DEFAULTS,
  clampConfig,
  resolveUpscaleConfig,
  writeProfileGame,
  readProfileGame,
  labelForBadge,
  envOverridesPresent,
  gameKey,
  parseMode,
  parseAnime4kMode,
  parseAnime4kTier,
  parseThreshold,
};
