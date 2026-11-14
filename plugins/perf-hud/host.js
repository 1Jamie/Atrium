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
};

const PILL_W = 300;

function pillHeightFor(fields) {
  let h = 16; // padding
  if (fields.fps || fields.frametime) h += 36;
  const grid =
    fields.lows || fields.cpu || fields.ram || fields.pool || fields.surf;
  if (grid) h += 78;
  if (fields.pool) h += 16;
  if (fields.hint && fields.lows) h += 14;
  if (fields.graph) h += 40;
  return Math.max(72, Math.min(280, h));
}

async function activate(ctx) {
  let prevCpu = readProcStat() || cpuTimesFallback();

  function sampleHost() {
    const { cpuPct, next } = sampleCpu(prevCpu);
    prevCpu = next;
    return Object.assign({ cpu_pct: cpuPct }, sampleMemory());
  }

  let overlayFields = Object.assign(
    {},
    DEFAULT_OVERLAY_FIELDS,
    ctx.storage.get('overlayFields', {})
  );

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

  await ctx.registerHud({
    id: 'pill',
    entry: 'ui/pill.html',
    anchor: 'top-left',
    width: PILL_W,
    height: pillHeightFor(overlayFields),
    defaultVisible: true,
  });

  await ctx.registerTab({
    id: 'tab',
    label: 'Perf',
    order: 80,
    entry: 'ui/index.html',
    input: { mode: 'spatial', handlesBack: false },
  });

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
    overlayFields = Object.assign({}, DEFAULT_OVERLAY_FIELDS, cfg);
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

  ctx.telemetry.onFrameStats((stats) => {
    ctx.ipc.send('stats', Object.assign({}, stats, sampleHost()));
  });
  ctx.log('perf-hud active (rich overlay + customizable fields)');
}

async function deactivate(ctx) {
  if (ctx && typeof ctx.disposeAll === 'function') ctx.disposeAll();
}

module.exports = { activate, deactivate };
