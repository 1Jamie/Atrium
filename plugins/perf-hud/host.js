'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Aggregate CPU times across every logical CPU.
 * Prefer /proc/stat (all fields, all cores) so iowait/softirq/steal are not dropped.
 */
function readProcStat() {
  let text;
  try {
    text = fs.readFileSync('/proc/stat', 'utf8');
  } catch (_) {
    return null;
  }
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

function cpuTimesFallback() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function sampleCpu(prev) {
  const next = readProcStat() || cpuTimesFallback();
  const idleDelta = next.idle - prev.idle;
  const totalDelta = next.total - prev.total;
  const cpuPct =
    totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0;
  return { cpuPct, next };
}

function readMeminfo() {
  let text;
  try {
    text = fs.readFileSync('/proc/meminfo', 'utf8');
  } catch (_) {
    return null;
  }
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s+kB/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
}

function findAmdgpuMem() {
  const drm = '/sys/class/drm';
  let dirs;
  try {
    dirs = fs.readdirSync(drm);
  } catch (_) {
    return null;
  }
  let best = null;
  for (const name of dirs) {
    if (!/^card\d+$/.test(name)) continue;
    const base = path.join(drm, name, 'device');
    const readU64 = (file) => {
      try {
        return Number(fs.readFileSync(path.join(base, file), 'utf8').trim());
      } catch (_) {
        return null;
      }
    };
    const vramTotal = readU64('mem_info_vram_total');
    if (vramTotal == null || !(vramTotal > 0)) continue;
    const cand = {
      vram_total: vramTotal,
      vram_used: readU64('mem_info_vram_used') || 0,
      gtt_total: readU64('mem_info_gtt_total') || 0,
      gtt_used: readU64('mem_info_gtt_used') || 0,
    };
    if (!best || cand.vram_total > best.vram_total) best = cand;
  }
  return best;
}

function bytesToMb(n) {
  return n / (1024 * 1024);
}

function readCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch (_) {
    return '';
  }
}

function readChildren(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    if (!text) return [];
    return text.split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  } catch (_) {
    return [];
  }
}

function readProcMemKb(pid) {
  // PSS is the fair share (shared libs split across users). Prefer smaps_rollup.
  try {
    const text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const pss = /^Pss:\s+(\d+)/m.exec(text);
    const rss = /^Rss:\s+(\d+)/m.exec(text);
    if (pss || rss) {
      return {
        pssKb: pss ? Number(pss[1]) : 0,
        rssKb: rss ? Number(rss[1]) : 0,
      };
    }
  } catch (_) {}
  try {
    const text = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = /^VmRSS:\s+(\d+)/m.exec(text);
    const anon = /^RssAnon:\s+(\d+)/m.exec(text);
    const rssKb = rss ? Number(rss[1]) : 0;
    // Without PSS, RssAnon is closer to "unique" than full VmRSS.
    return { pssKb: anon ? Number(anon[1]) : rssKb, rssKb };
  } catch (_) {
    return { pssKb: 0, rssKb: 0 };
  }
}

/**
 * Nested Proton/Wine/game trees are children of the Atrium node process.
 * Exclude them so "self" is Lotus+plugins only (Ghostty/Discordo stay in).
 *
 * Important: the worker `node main.js -- … proton run game.exe` keeps the game
 * argv on its own cmdline — that must NOT count as the game process.
 */
function looksLikeGameProcess(cmdline) {
  const c = String(cmdline || '').toLowerCase();
  if (!c) return false;
  // Host / plugin sidecars — never treat as the nested game.
  if (
    c.includes('ghostty') ||
    c.includes('discordo') ||
    c.includes('apprun') ||
    /(^|\/)node(\s|$)/.test(c) ||
    c.includes('main.js') ||
    c.includes('xwayland')
  ) {
    return false;
  }
  return (
    c.includes('proton') ||
    c.includes('wineserver') ||
    c.includes('wine64') ||
    c.includes('wine-preloader') ||
    /(^|\/)wine(\s|$)/.test(c) ||
    c.includes('steamapps/common') ||
    c.includes('steamapps/compatdata') ||
    c.includes('pressure-vessel') ||
    c.includes('pv-bwrap') ||
    c.includes('reaper') ||
    /\.exe(\s|$)/.test(c)
  );
}

/** Prefer the lotus worker child when the launcher forked a second node. */
function atriumRootPid() {
  const selfPid = process.pid;
  for (const child of readChildren(selfPid)) {
    const cmd = readCmdline(child);
    if (/(^|\/)node(\s|$)/.test(cmd) && cmd.includes('main.js')) {
      return child;
    }
  }
  return selfPid;
}

/**
 * Atrium host footprint: this node process (JS + lotus .node) plus plugin
 * sidecars it spawned — never the nested game/Proton tree.
 *
 * `atrium_mb` is Σ PSS (or RssAnon fallback). `atrium_rss_mb` is Σ VmRSS
 * (overcounts shared pages; useful as an upper bound).
 */
function sampleAtriumSelfMemory() {
  const launcher = process.pid;
  const root = atriumRootPid();
  const hostPids = [];
  const stack = [root];
  const seen = new Set();

  // Include the tiny launcher node when it forked the worker.
  if (launcher !== root) hostPids.push(launcher);

  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);

    const cmd = readCmdline(pid);
    if (pid !== root && pid !== launcher && looksLikeGameProcess(cmd)) {
      continue; // drop this subtree
    }

    if (!hostPids.includes(pid)) hostPids.push(pid);
    for (const child of readChildren(pid)) {
      if (!seen.has(child)) stack.push(child);
    }
  }

  let pssKb = 0;
  let rssKb = 0;
  let nodePssKb = 0;
  let pluginPssKb = 0;
  let ghosttyPssKb = 0;
  let discordoPssKb = 0;
  const parts = [];

  for (const pid of hostPids) {
    const { pssKb: p, rssKb: r } = readProcMemKb(pid);
    const cmd = readCmdline(pid);
    pssKb += p;
    rssKb += r;
    const isNode = pid === root || pid === launcher || (/(^|\/)node(\s|$)/.test(cmd) && cmd.includes('main.js'));
    if (isNode) nodePssKb += p;
    else pluginPssKb += p;
    if (cmd.includes('ghostty') || cmd.includes('AppRun')) ghosttyPssKb += p;
    if (cmd.includes('discordo')) discordoPssKb += p;
    if (
      (process.env.ATRIUM_MEM_DIAG === '1' || process.env.ATRIUM_PACING_DIAG === '1') &&
      p > 0
    ) {
      parts.push({ pid, pssMb: p / 1024, rssMb: r / 1024, cmd: cmd.slice(0, 80) });
    }
  }

  return {
    atrium_mb: bytesToMb(pssKb * 1024),
    atrium_rss_mb: bytesToMb(rssKb * 1024),
    atrium_node_mb: bytesToMb(nodePssKb * 1024),
    atrium_plugins_mb: bytesToMb(pluginPssKb * 1024),
    atrium_ghostty_mb: bytesToMb(ghosttyPssKb * 1024),
    atrium_discordo_mb: bytesToMb(discordoPssKb * 1024),
    atrium_procs: hostPids.length,
    _atrium_parts: parts,
  };
}

function sampleMemory() {
  const mi = readMeminfo();
  const gpu = findAmdgpuMem();

  if (!mi || !mi.MemTotal) {
    const totalMb = bytesToMb(os.totalmem());
    const freeMb = bytesToMb(os.freemem());
    return {
      ram_used_mb: totalMb - freeMb,
      ram_total_mb: totalMb,
      ram_pool_mb: totalMb,
      ram_sys_mb: totalMb - freeMb,
      ram_gpu_mb: 0,
      ram_uma: false,
    };
  }

  const memTotal = mi.MemTotal;
  const memAvail = mi.MemAvailable != null ? mi.MemAvailable : mi.MemFree || 0;
  const memUsed = Math.max(0, memTotal - memAvail);

  if (!gpu) {
    return {
      ram_used_mb: bytesToMb(memUsed),
      ram_total_mb: bytesToMb(memTotal),
      ram_pool_mb: bytesToMb(memTotal),
      ram_sys_mb: bytesToMb(memUsed),
      ram_gpu_mb: 0,
      ram_uma: false,
    };
  }

  const pool = memTotal + gpu.vram_total;
  const gttUsed = Math.min(gpu.gtt_used, memUsed);
  const sysExcl = Math.max(0, memUsed - gttUsed);
  const gpuUsed = gpu.vram_used + gttUsed;
  const poolUsed = sysExcl + gpuUsed;

  return {
    ram_used_mb: bytesToMb(poolUsed),
    ram_total_mb: bytesToMb(pool),
    ram_pool_mb: bytesToMb(pool),
    ram_sys_mb: bytesToMb(sysExcl),
    ram_gpu_mb: bytesToMb(gpuUsed),
    ram_vram_used_mb: bytesToMb(gpu.vram_used),
    ram_vram_total_mb: bytesToMb(gpu.vram_total),
    ram_gtt_used_mb: bytesToMb(gttUsed),
    ram_gtt_total_mb: bytesToMb(gpu.gtt_total),
    ram_uma: true,
  };
}

const DEFAULT_OVERLAY_FIELDS = {
  fps: true,
  frametime: true,
  lows: true,
  cpu: true,
  ram: true,
  pool: true,
  surf: true,
  graph: false,
  hint: true,
  /** Atrium host PSS (node + plugins, game tree excluded). */
  self: true,
  /** In-game pill glass alpha (0–1). Persisted with overlay field toggles. */
  opacity: 0.42,
};

function clampPillOpacity(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_OVERLAY_FIELDS.opacity;
  return Math.max(0.15, Math.min(0.9, n));
}

function normalizeOverlayFields(cfg) {
  const next = Object.assign({}, DEFAULT_OVERLAY_FIELDS, cfg || {});
  next.opacity = clampPillOpacity(next.opacity);
  return next;
}

const PILL_W = 300;

function pillHeightFor(fields) {
  let h = 16; // padding
  if (fields.fps || fields.frametime) h += 36;
  const grid =
    fields.lows ||
    fields.cpu ||
    fields.ram ||
    fields.self ||
    fields.pool ||
    fields.surf;
  if (grid) h += 78;
  if (fields.self) h += 16;
  if (fields.pool) h += 16;
  if (fields.hint && fields.lows) h += 14;
  if (fields.graph) h += 40;
  return Math.max(72, Math.min(280, h));
}

async function activate(ctx) {
  let prevCpu = readProcStat() || cpuTimesFallback();

  let lastMemDiagAt = 0;

  let cachedSelf = null;
  let lastSelfSampleAt = 0;

  function sampleHost(need) {
    const out = {};

    if (need.cpu) {
      const { cpuPct, next } = sampleCpu(prevCpu);
      prevCpu = next;
      out.cpu_pct = cpuPct;
    }

    if (need.ram || need.pool) {
      const mem = sampleMemory();
      out.ram_used_mb = mem.ram_used_mb;
      out.ram_total_mb = mem.ram_total_mb;
      if (need.pool) {
        out.ram_sys_mb = mem.ram_sys_mb;
        out.ram_gpu_mb = mem.ram_gpu_mb;
        out.ram_uma = !!mem.ram_uma;
      }
    }

    if (need.self) {
      // smaps_rollup walks are not free — refresh Self at 1 Hz, not nest-stats Hz.
      const now = Date.now();
      if (!cachedSelf || now - lastSelfSampleAt >= 1000) {
        lastSelfSampleAt = now;
        cachedSelf = sampleAtriumSelfMemory();
      }
      const self = cachedSelf;
      out.atrium_mb = self.atrium_mb;
      out.atrium_node_mb = self.atrium_node_mb;
      out.atrium_ghostty_mb = self.atrium_ghostty_mb;
      out.atrium_discordo_mb = self.atrium_discordo_mb;
      if (
        process.env.ATRIUM_MEM_DIAG === '1' ||
        process.env.ATRIUM_PACING_DIAG === '1'
      ) {
        if (now - lastMemDiagAt >= 5000) {
          lastMemDiagAt = now;
          ctx.log(
            `self-mem PSS=${self.atrium_mb.toFixed(0)}M ` +
              `(node=${self.atrium_node_mb.toFixed(0)}M ` +
              `ghostty=${self.atrium_ghostty_mb.toFixed(0)}M ` +
              `discordo=${self.atrium_discordo_mb.toFixed(0)}M ` +
              `plugins=${self.atrium_plugins_mb.toFixed(0)}M ` +
              `procs=${self.atrium_procs}) RSSΣ=${self.atrium_rss_mb.toFixed(0)}M`
          );
        }
      }
    }
    return out;
  }

  function paneVisible(localId) {
    const p = ctx.getPane(localId);
    return !!(p && p.visible);
  }

  /** Pick nest fields the destination actually shows. */
  function pickNest(nest, fields, full) {
    const n = nest || {};
    if (full) return Object.assign({}, n);
    const out = {};
    if (fields.fps || fields.frametime || fields.graph) {
      if (n.fps != null) out.fps = n.fps;
      if (n.frametime_ms != null) out.frametime_ms = n.frametime_ms;
    }
    if (fields.lows) {
      if (n.fps_1_low != null) out.fps_1_low = n.fps_1_low;
      if (n.fps_01_low != null) out.fps_01_low = n.fps_01_low;
    }
    if (fields.surf) {
      if (n.width != null) out.width = n.width;
      if (n.height != null) out.height = n.height;
      if (n.refresh_hz != null) out.refresh_hz = n.refresh_hz;
      if (n.pacing_policy != null) out.pacing_policy = n.pacing_policy;
      if (n.soft_fifo) out.soft_fifo = true;
      if (n.hold_cadence) out.hold_cadence = true;
    }
    return out;
  }

  function publishStats(nestStats) {
    const pillOn = paneVisible('pill');
    const tabOn = paneVisible('tab');
    if (!pillOn && !tabOn) return;

    const f = overlayFields;
    // Tab open → full overall. Game-mode pill only → enabled HUD fields.
    const full = tabOn;
    const need = {
      cpu: full || !!f.cpu,
      ram: full || !!f.ram,
      pool: full || !!f.pool,
      self: full || !!f.self,
    };
    const host = sampleHost(need);
    const nest = pickNest(nestStats, f, full);
    ctx.ipc.send('stats', Object.assign(nest, host));
  }

  let overlayFields = normalizeOverlayFields(ctx.storage.get('overlayFields', {}));

  function applyPillSize() {
    const pill = ctx.getPane('pill');
    if (!pill) return;
    const h = pillHeightFor(overlayFields);
    const cur = pill.raw && pill.raw._layout;
    const x = cur?.x ?? 16;
    const y = cur?.y ?? 64;
    try {
      pill.setRect(x, y, PILL_W, h);
    } catch (_) {}
  }

  function broadcastConfig() {
    ctx.ipc.send('hud-config', overlayFields);
    applyPillSize();
    // After height change, nudge the pill so the graph canvas can measure layout.
    setTimeout(() => {
      const pill = ctx.getPane('pill');
      const raw = pill && pill.raw;
      if (!raw || !raw.visible || typeof raw.executeScript !== 'function') return;
      try {
        raw.executeScript(
          `window.dispatchEvent(new Event('atrium-pane-shown'));`
        );
      } catch (_) {}
    }, 80);
  }

  if (process.env.ATRIUM_NO_PERF_PILL === '1') {
    ctx.log('ATRIUM_NO_PERF_PILL=1 — skipping in-game HUD pill (leak A/B)');
  } else {
    await ctx.registerHud({
      id: 'pill',
      entry: 'ui/pill.html',
      anchor: 'top-left',
      width: PILL_W,
      height: pillHeightFor(overlayFields),
      defaultVisible: true,
    });
  }

  if (process.env.ATRIUM_NO_PERF_TAB === '1') {
    ctx.log('ATRIUM_NO_PERF_TAB=1 — skipping Perf settings tab (leak A/B)');
  } else {
    await ctx.registerTab({
      id: 'tab',
      label: 'Perf',
      order: 80,
      entry: 'ui/index.html',
      input: { mode: 'spatial', handlesBack: false },
    });
  }

  ctx.onAction((act) => {
    if (!act || !act.action) return false;
    if (act.action === 'Nav' || act.action === 'Confirm') {
      ctx.ipc.send('action', act);
      return true;
    }
    return false;
  });

  ctx.ipc.on('hud-config', (cfg) => {
    if (!cfg || typeof cfg !== 'object') return;
    overlayFields = normalizeOverlayFields(cfg);
    ctx.storage.set('overlayFields', overlayFields);
    broadcastConfig();
    ctx.log('overlay fields updated');
  });
  ctx.ipc.on('hud-config-request', () => {
    broadcastConfig();
  });

  // Pill/tab may mount after activate — push config once surfaces are up.
  setTimeout(broadcastConfig, 400);
  setTimeout(broadcastConfig, 1200);

  if (process.env.ATRIUM_NO_HOST_SAMPLE === '1') {
    ctx.log('ATRIUM_NO_HOST_SAMPLE=1 — skipping onFrameStats (leak A/B)');
  } else {
    ctx.telemetry.onFrameStats((stats) => {
      publishStats(stats);
    });
  }
  ctx.log('perf-hud active (field-scoped stats)');
}

async function deactivate(ctx) {
  if (ctx && typeof ctx.disposeAll === 'function') ctx.disposeAll();
}

module.exports = { activate, deactivate };
