const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const onlinePlayers = new Map();
const TIMEOUT_MS = 15000;
const PLAYTIME_GAP_MS = 30_000;

// Папка с данными. На Railway укажите DATA_DIR=/data и подключите volume по этому пути.
// Если переменная не задана — fallback на локальную папку рядом со скриптом (как раньше).
const DATA_DIR = process.env.DATA_DIR || __dirname;
try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
    console.error('mkdir DATA_DIR:', e.message);
}
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const PLAYTIME_FILE = path.join(DATA_DIR, 'playtime.json');
console.log('DATA_DIR =', DATA_DIR);

const SAMPLE_INTERVAL_MS = 60_000;

let stats = {
    record: { count: 0, timestamp: null },
    samples: [],
    totalSamples: 0,
    sumSamples: 0
};

let playtime = {};

function loadJson(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) return fallback;
        return JSON.parse(raw);
    } catch (e) {
        // Если файл побит — пробуем .bak
        const bak = file + '.bak';
        if (fs.existsSync(bak)) {
            try {
                console.warn('main JSON corrupted, falling back to .bak:', file);
                return JSON.parse(fs.readFileSync(bak, 'utf8'));
            } catch (e2) {
                console.error('bak also corrupted:', file, e2.message);
            }
        }
        console.error('load failed for', file, '-', e.message);
        return fallback;
    }
}

try {
    stats = { ...stats, ...loadJson(STATS_FILE, {}) };
    playtime = loadJson(PLAYTIME_FILE, {});
    console.log('loaded:', Object.keys(playtime).length, 'players,', stats.totalSamples, 'samples');
} catch (e) {
    console.error('load:', e.message);
}

// Атомарная запись: пишем во временный файл, fsync, переименовываем поверх.
// Без этого если процесс упадёт в момент записи — файл будет полупустой и при старте JSON.parse провалится.
function atomicWrite(file, data) {
    const tmp = file + '.tmp';
    const bak = file + '.bak';
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    // Сохраняем предыдущую версию как .bak (на случай если новая запись окажется битой)
    if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, bak); } catch (e) { /* не критично */ }
    }
    fs.renameSync(tmp, file);
}

function saveStats() {
    try { atomicWrite(STATS_FILE, JSON.stringify(stats, null, 2)); }
    catch (e) { console.error('save stats:', e.message); }
}

function savePlaytime() {
    try { atomicWrite(PLAYTIME_FILE, JSON.stringify(playtime, null, 2)); }
    catch (e) { console.error('save playtime:', e.message); }
}

let saveTimer = null;
function schedulePlaytimeSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        savePlaytime();
        saveTimer = null;
    }, 5000);
}

function cleanupOffline() {
    const now = Date.now();
    for (const [uuid, data] of onlinePlayers.entries()) {
        if (now - data.lastSeen > TIMEOUT_MS) onlinePlayers.delete(uuid);
    }
}

function updateRecord(count) {
    if (count > stats.record.count) {
        stats.record = { count, timestamp: Date.now() };
        saveStats();
    }
}

function trackPlaytime(uuid, name, server) {
    const now = Date.now();
    const existing = playtime[uuid];
    if (existing) {
        const gap = now - existing.lastPing;
        if (gap < PLAYTIME_GAP_MS) {
            existing.totalMs += gap;
        }
        existing.lastPing = now;
        existing.name = name;
        if (server) existing.lastServer = server;
    } else {
        playtime[uuid] = {
            name,
            totalMs: 0,
            lastPing: now,
            firstSeen: now,
            lastServer: server || null
        };
    }
    schedulePlaytimeSave();
}

setInterval(() => {
    cleanupOffline();
    const count = onlinePlayers.size;
    stats.totalSamples += 1;
    stats.sumSamples += count;
    stats.samples.push({ t: Date.now(), count });
    if (stats.samples.length > 1440) stats.samples.shift();
    updateRecord(count);
    saveStats();
}, SAMPLE_INTERVAL_MS);

function getStats() {
    const allTime = stats.totalSamples > 0 ? stats.sumSamples / stats.totalSamples : 0;
    const dayCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = stats.samples.filter(s => s.t >= dayCutoff);
    const last24h = recent.length > 0
        ? recent.reduce((sum, s) => sum + s.count, 0) / recent.length : 0;
    const peak24h = recent.length > 0
        ? recent.reduce((max, s) => s.count > max.count ? s : max, recent[0])
        : { count: 0, t: null };
    const hourCutoff = Date.now() - 60 * 60 * 1000;
    const lastHour = stats.samples.filter(s => s.t >= hourCutoff);
    const hourAvg = lastHour.length > 0
        ? lastHour.reduce((sum, s) => sum + s.count, 0) / lastHour.length : 0;
    const trend = onlinePlayers.size - Math.round(hourAvg);
    return {
        allTime: +allTime.toFixed(1),
        last24h: +last24h.toFixed(1),
        peak24h, trend, recent
    };
}

function getTopPlayers(limit = 3) {
    return Object.entries(playtime)
        .map(([uuid, data]) => ({ uuid, ...data }))
        .filter(p => p.totalMs > 0)
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, limit);
}

// --- API ---

app.post('/ping', (req, res) => {
    const { uuid, name, server } = req.body;
    if (!uuid || !name) return res.status(400).json({ error: 'missing fields' });
    onlinePlayers.set(uuid, {
        name,
        server: server || null,
        lastSeen: Date.now()
    });
    trackPlaytime(uuid, name, server);
    updateRecord(onlinePlayers.size);
    res.json({ ok: true });
});

app.get('/online', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.entries()).map(([uuid, data]) => ({
        uuid,
        name: data.name,
        server: data.server || null,
        lastSeen: data.lastSeen
    }));
    res.json({
        players,
        stats: { ...getStats(), record: stats.record, totalSamples: stats.totalSamples },
        top: getTopPlayers(3)
    });
});

app.get('/player/:uuid', (req, res) => {
    const uuid = req.params.uuid;
    const pt = playtime[uuid];
    const online = onlinePlayers.get(uuid);
    if (!pt && !online) return res.status(404).json({ error: 'not found' });
    res.json({
        uuid,
        name: (online && online.name) || (pt && pt.name) || 'Unknown',
        online: !!online,
        currentServer: online ? online.server : null,
        lastServer: pt ? pt.lastServer : (online ? online.server : null),
        totalMs: pt ? pt.totalMs : 0,
        firstSeen: pt ? pt.firstSeen : null,
        lastSeen: online ? online.lastSeen : (pt ? pt.lastPing : null)
    });
});

// --- Server-rendered initial page ---

const AVATAR_PALETTES = [
    { bg: 'rgba(167,139,250,0.18)', border: 'rgba(167,139,250,0.35)', fg: '#c4b5fd' },
    { bg: 'rgba(244,114,182,0.18)', border: 'rgba(244,114,182,0.35)', fg: '#f9a8d4' },
    { bg: 'rgba(74,222,128,0.18)', border: 'rgba(74,222,128,0.35)', fg: '#86efac' },
    { bg: 'rgba(96,165,250,0.18)', border: 'rgba(96,165,250,0.35)', fg: '#93c5fd' },
    { bg: 'rgba(251,146,60,0.18)', border: 'rgba(251,146,60,0.35)', fg: '#fdba74' },
    { bg: 'rgba(34,211,238,0.18)', border: 'rgba(34,211,238,0.35)', fg: '#67e8f9' },
    { bg: 'rgba(250,204,21,0.18)', border: 'rgba(250,204,21,0.35)', fg: '#fde047' },
    { bg: 'rgba(248,113,113,0.18)', border: 'rgba(248,113,113,0.35)', fg: '#fca5a5' },
];

function avatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
}

function initials(name) {
    return name.slice(0, 2).toUpperCase();
}

function formatPlaytime(ms) {
    const totalMin = Math.floor(ms / 60000);
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    if (hours === 0) return `${mins}м`;
    return `${hours}ч ${String(mins).padStart(2, '0')}м`;
}

function formatDate(ts) {
    if (!ts) return { date: '—', time: '' };
    const d = new Date(ts);
    return {
        date: d.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'short' }),
        time: d.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit' })
    };
}

function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit'
    });
}

function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return 'только что';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}м`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}ч`;
    return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'short' });
}

function shortServer(server) {
    if (!server) return '—';
    if (server === 'single') return 'singleplayer';
    // обрезаем порт по умолчанию ":25565" чтобы не мусорить
    return server.replace(/:25565$/, '');
}

function buildSparkline(samples) {
    if (!samples || samples.length < 2) {
        return `<div style="color:rgba(255,255,255,0.3);font-size:11px;text-align:center;padding:14px 0;">Накапливаем данные</div>`;
    }
    const W = 400, H = 60;
    const max = Math.max(...samples.map(s => s.count), 1);
    const points = samples.map((s, i) => {
        const x = (i / (samples.length - 1)) * W;
        const y = H - 6 - (s.count / max) * (H - 14);
        return [x, y];
    });
    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${W},${H} L 0,${H} Z`;
    const peakIdx = samples.reduce((maxI, s, i) => s.count > samples[maxI].count ? i : maxI, 0);
    const peakPt = points[peakIdx];
    return `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:50px;display:block;">
            <defs>
                <linearGradient id="chartArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.5"/>
                    <stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <path d="${areaPath}" fill="url(#chartArea)"/>
            <path d="${linePath}" stroke="#c4b5fd" stroke-width="2" fill="none" stroke-linejoin="round"/>
            <circle cx="${peakPt[0].toFixed(1)}" cy="${peakPt[1].toFixed(1)}" r="8" fill="rgba(196,181,253,0.2)"/>
            <circle cx="${peakPt[0].toFixed(1)}" cy="${peakPt[1].toFixed(1)}" r="4" fill="#fff" stroke="#a78bfa" stroke-width="1.5"/>
        </svg>
    `;
}

function buildPodiumCard(player, place) {
    if (!player) {
        const labels = { 1: 'Никого', 2: '—', 3: '—' };
        return `
            <div class="podium-card podium-empty podium-${place}">
                <div class="podium-medal medal-${place}">${place}</div>
                <div class="podium-avatar empty-avatar">?</div>
                <div class="podium-divider"></div>
                <div class="podium-name empty-name">${labels[place]}</div>
                <div class="podium-time">—</div>
            </div>
        `;
    }
    const c = avatarColor(player.name);
    const isFirst = place === 1;
    return `
        <div class="podium-card podium-${place}" data-uuid="${player.uuid}" data-name="${escapeHtml(player.name)}">
            <div class="podium-medal medal-${place}">${place}</div>
            <div class="podium-avatar" style="background:${c.bg};border-color:${c.border};color:${c.fg};">
                ${initials(player.name)}
            </div>
            <div class="podium-divider ${isFirst ? 'gold' : ''}"></div>
            <div class="podium-name">${escapeHtml(player.name)}</div>
            <div class="podium-time ${isFirst ? 'gold-time' : ''}">${formatPlaytime(player.totalMs)}</div>
        </div>
    `;
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildPlayerCard(p) {
    const c = avatarColor(p.name);
    const isActive = (Date.now() - p.lastSeen) < 30000;
    const status = isActive
        ? `<div class="status-dot online" title="в сети"></div>`
        : `<div class="status-time">${timeAgo(p.lastSeen)}</div>`;
    const sub = shortServer(p.server);
    return `
        <div class="player-card" data-name="${escapeHtml(p.name.toLowerCase())}" data-uuid="${escapeHtml(p.uuid)}" data-displayname="${escapeHtml(p.name)}">
            <div class="avatar" style="background:${c.bg};border-color:${c.border};color:${c.fg};">${initials(p.name)}</div>
            <div class="player-info">
                <div class="player-name">${escapeHtml(p.name)}</div>
                <div class="player-sub" title="${escapeHtml(p.server || '')}">${escapeHtml(sub)}</div>
            </div>
            ${status}
        </div>
    `;
}

app.get('/', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.entries())
        .map(([uuid, data]) => ({
            uuid,
            name: data.name,
            server: data.server || null,
            lastSeen: data.lastSeen
        }))
        .sort((a, b) => b.lastSeen - a.lastSeen);

    const s = getStats();
    const top = getTopPlayers(3);
    const recordDate = formatDate(stats.record.timestamp);

    const trendBadge = s.trend > 0
        ? `<div class="trend-pill trend-up">↑ +${s.trend} за час</div>`
        : s.trend < 0
            ? `<div class="trend-pill trend-down">↓ ${s.trend} за час</div>`
            : `<div class="trend-pill trend-flat">— стабильно</div>`;

    const playerCards = players.map(buildPlayerCard).join('');
    const emptyState = `<div class="empty-state">Сейчас никого нет онлайн</div>`;
    const peakInfo = s.peak24h.count > 0 ? `пик ${s.peak24h.count}<br>в ${formatTime(s.peak24h.t)}` : 'нет<br>данных';
    const peakChartLabel = s.peak24h.count > 0 ? `пик ${s.peak24h.count} в ${formatTime(s.peak24h.t)}` : '';

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rocksnow</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: #0a0612; }
        body {
            color: #fff;
            font-family: 'Inter', -apple-system, sans-serif;
            min-height: 100vh;
            -webkit-font-smoothing: antialiased;
            position: relative;
            overflow-x: hidden;
        }

        .liquid-bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
        .liquid-bg svg { width: 100%; height: 100%; }
        @keyframes blob1 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            33% { transform: translate(60px, -40px) scale(1.1); }
            66% { transform: translate(-40px, 30px) scale(0.95); }
        }
        @keyframes blob2 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            50% { transform: translate(-50px, 40px) scale(1.15); }
        }
        @keyframes blob3 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            50% { transform: translate(40px, 50px) scale(1.1); }
        }
        .blob-1 { animation: blob1 25s ease-in-out infinite; transform-origin: center; }
        .blob-2 { animation: blob2 30s ease-in-out infinite; transform-origin: center; }
        .blob-3 { animation: blob3 22s ease-in-out infinite; transform-origin: center; }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 24px 28px 40px;
            position: relative;
            z-index: 1;
        }
        @media (max-width: 700px) { .container { padding: 20px 16px 32px; } }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 24px;
        }
        .logo { display: flex; align-items: center; gap: 10px; }
        .logo-icon {
            width: 32px; height: 32px;
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.18);
            border-radius: 10px;
            display: flex; align-items: center; justify-content: center;
            color: #fff; font-size: 16px;
        }
        .logo-name { color: #fff; font-size: 16px; font-weight: 600; }
        .live-badge {
            display: flex; align-items: center; gap: 8px;
            padding: 7px 14px;
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.18);
            border-radius: 100px;
            transition: opacity 0.25s ease;
        }
        .live-badge.refreshing { opacity: 0.5; }
        .live-dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: #4ade80;
            box-shadow: 0 0 8px rgba(74,222,128,0.7);
            animation: livePulse 2s ease-in-out infinite;
        }
        .live-badge.refreshing .live-dot { animation: livePulse 0.7s ease-in-out infinite; }
        @keyframes livePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .live-text { color: #fff; font-size: 12px; font-weight: 500; }

        .top-grid {
            display: grid;
            grid-template-columns: 1.3fr 1fr;
            gap: 16px;
            margin-bottom: 16px;
            align-items: stretch;
        }
        @media (max-width: 800px) { .top-grid { grid-template-columns: 1fr; } }

        .glass {
            background: rgba(255,255,255,0.05);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 18px;
        }

        .hero-card { padding: 24px 26px; display: flex; flex-direction: column; justify-content: space-between; min-height: 280px; }
        .hero-label { color: rgba(255,255,255,0.55); font-size: 11px; font-weight: 500; margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.08em; }
        .hero-row { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
        .hero-value {
            color: #fff; font-size: 96px; font-weight: 700;
            line-height: 0.9; letter-spacing: -0.05em;
            transition: opacity 0.2s ease, transform 0.3s cubic-bezier(.2,.7,.3,1.2);
            font-variant-numeric: tabular-nums;
        }
        .hero-value.bump { transform: scale(1.06); }
        @media (max-width: 600px) { .hero-value { font-size: 72px; } }
        .trend-pill { display: flex; align-items: center; gap: 6px; padding: 6px 12px; backdrop-filter: blur(20px); border-radius: 100px; font-size: 12px; font-weight: 600; white-space: nowrap; transition: background 0.25s, color 0.25s, border-color 0.25s; }
        .trend-up { background: rgba(74,222,128,0.18); border: 1px solid rgba(74,222,128,0.35); color: #86efac; }
        .trend-down { background: rgba(248,113,113,0.18); border: 1px solid rgba(248,113,113,0.35); color: #fca5a5; }
        .trend-flat { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: rgba(255,255,255,0.7); }
        .chart-block { margin-top: 20px; }
        .chart-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .chart-title { color: rgba(255,255,255,0.5); font-size: 11px; font-weight: 500; }
        .chart-meta { color: rgba(255,255,255,0.4); font-size: 11px; }

        .side-stats { display: grid; grid-template-rows: 1fr 1fr 1fr; gap: 10px; }
        .stat-card { padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; border-radius: 14px; }
        .stat-label { color: rgba(255,255,255,0.5); font-size: 11px; font-weight: 500; margin-bottom: 2px; }
        .stat-value { color: #fff; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; font-variant-numeric: tabular-nums; }
        .stat-meta { color: rgba(255,255,255,0.4); font-size: 10px; text-align: right; line-height: 1.3; }

        .section-head {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 28px 4px 16px;
        }
        .section-title { color: #fff; font-size: 14px; font-weight: 600; }
        .section-tag {
            padding: 2px 8px;
            background: rgba(250,204,21,0.15);
            border: 1px solid rgba(250,204,21,0.3);
            border-radius: 100px;
            color: #fde047;
            font-size: 11px;
            font-weight: 600;
        }

        .podium {
            display: grid;
            grid-template-columns: 1fr 1.15fr 1fr;
            gap: 14px;
            align-items: end;
            margin-bottom: 24px;
            padding-top: 18px;
        }
        @media (max-width: 600px) {
            .podium { grid-template-columns: 1fr; padding-top: 0; }
        }

        .podium-card {
            position: relative;
            padding: 28px 16px 20px;
            text-align: center;
            border-radius: 18px;
            transition: transform 0.25s ease, box-shadow 0.25s ease;
            background: rgba(255,255,255,0.05);
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            border: 1px solid rgba(255,255,255,0.1);
            cursor: pointer;
        }
        .podium-card.podium-empty { cursor: default; }
        .podium-card:hover {
            transform: translateY(-6px) scale(1.03);
            box-shadow: 0 12px 40px rgba(0,0,0,0.3);
        }
        .podium-1 {
            padding: 32px 16px 22px;
            background: rgba(255,255,255,0.07);
            border: 1px solid rgba(250,204,21,0.3);
            box-shadow: 0 0 30px rgba(250,204,21,0.08);
        }
        .podium-1:hover {
            box-shadow: 0 12px 40px rgba(0,0,0,0.3), 0 0 40px rgba(250,204,21,0.15);
        }

        .podium-medal {
            position: absolute; top: -12px; left: 50%;
            transform: translateX(-50%);
            width: 28px; height: 28px;
            border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 13px; font-weight: 700;
            border: 2px solid #0a0612;
        }
        .medal-1 {
            width: 32px; height: 32px; top: -14px;
            background: linear-gradient(135deg, #fde047, #ca8a04);
            color: #422006; font-size: 14px;
            box-shadow: 0 0 12px rgba(250,204,21,0.4);
        }
        .medal-2 { background: linear-gradient(135deg, #d1d5db, #9ca3af); color: #1f2937; }
        .medal-3 { background: linear-gradient(135deg, #fdba74, #c2410c); color: #431407; }

        .podium-avatar {
            width: 56px; height: 56px;
            border-radius: 50%;
            border: 1.5px solid;
            display: flex; align-items: center; justify-content: center;
            font-size: 18px; font-weight: 700;
            margin: 0 auto 12px;
        }
        .podium-1 .podium-avatar {
            width: 64px; height: 64px;
            border-width: 2px;
            font-size: 20px;
            margin-bottom: 14px;
        }
        .empty-avatar { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.1); color: rgba(255,255,255,0.3); }

        .podium-divider {
            height: 1px;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
            margin: 0 auto 10px;
        }
        .podium-divider.gold {
            background: linear-gradient(90deg, transparent, rgba(250,204,21,0.4), transparent);
            margin-bottom: 12px;
        }

        .podium-name {
            color: #fff; font-size: 13px; font-weight: 600;
            margin-bottom: 4px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .podium-1 .podium-name { font-size: 14px; }
        .empty-name { color: rgba(255,255,255,0.4); font-weight: 500; }

        .podium-time {
            color: rgba(255,255,255,0.5);
            font-size: 11px;
            font-variant-numeric: tabular-nums;
        }
        .gold-time { color: #fde047; font-size: 12px; font-weight: 600; }

        .players-card { overflow: hidden; }
        .players-head {
            padding: 14px 20px;
            display: flex; justify-content: space-between; align-items: center;
            gap: 12px;
            border-bottom: 1px solid rgba(255,255,255,0.06);
            flex-wrap: wrap;
        }
        .players-title-row { display: flex; align-items: center; gap: 10px; }
        .players-title { color: #fff; font-size: 14px; font-weight: 600; }
        .count-badge {
            padding: 2px 8px;
            background: rgba(74,222,128,0.15);
            border: 1px solid rgba(74,222,128,0.3);
            border-radius: 100px;
            color: #86efac;
            font-size: 11px;
            font-weight: 600;
            transition: background 0.2s;
        }
        .search-input {
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 8px;
            padding: 6px 12px;
            color: #fff;
            font-size: 12px;
            font-family: inherit;
            width: 180px;
            outline: none;
            transition: border-color 0.15s, background 0.15s;
        }
        .search-input::placeholder { color: rgba(255,255,255,0.4); }
        .search-input:focus { border-color: rgba(167,139,250,0.5); background: rgba(255,255,255,0.08); }

        .players-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
        @media (max-width: 600px) {
            .players-grid { grid-template-columns: 1fr; }
            .players-grid .player-card { border-right: none !important; }
        }

        .player-card {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 16px;
            border-bottom: 1px solid rgba(255,255,255,0.04);
            transition: background 0.15s, opacity 0.25s, transform 0.25s;
            cursor: pointer;
        }
        .player-card:nth-child(odd) { border-right: 1px solid rgba(255,255,255,0.04); }
        .player-card:hover { background: rgba(255,255,255,0.03); }

        /* fade in for newly inserted cards */
        .player-card.appearing { opacity: 0; transform: translateY(4px); }
        .player-card.leaving { opacity: 0; transform: translateY(-4px); }

        .empty-state { text-align:center; padding:40px 20px; color:rgba(255,255,255,0.4); font-size:14px; grid-column: 1 / -1; }

        .avatar {
            width: 32px; height: 32px;
            border-radius: 50%;
            border: 1px solid;
            display: flex; align-items: center; justify-content: center;
            font-size: 11px; font-weight: 700;
            flex-shrink: 0;
        }
        .player-info { flex: 1; min-width: 0; }
        .player-name {
            color: #fff; font-size: 13px; font-weight: 500;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .player-sub {
            color: rgba(255,255,255,0.45);
            font-size: 10px;
            font-family: 'SF Mono', Menlo, monospace;
            margin-top: 1px;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .status-dot.online { background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,0.6); }
        .status-time { color: rgba(255,255,255,0.4); font-size: 11px; flex-shrink: 0; }

        .footer { text-align: center; color: rgba(255,255,255,0.25); font-size: 11px; margin-top: 24px; }

        /* ===== Modal ===== */
        .modal-overlay {
            position: fixed; inset: 0;
            background: rgba(5, 2, 12, 0.55);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            display: flex; align-items: center; justify-content: center;
            padding: 20px;
            z-index: 1000;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s ease;
        }
        .modal-overlay.open { opacity: 1; pointer-events: auto; }

        .modal {
            position: relative;
            width: 100%;
            max-width: 420px;
            background: rgba(20, 14, 35, 0.85);
            backdrop-filter: blur(30px);
            -webkit-backdrop-filter: blur(30px);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 22px;
            overflow: hidden;
            transform: translateY(10px) scale(0.97);
            transition: transform 0.25s cubic-bezier(.2,.7,.3,1.2);
        }
        .modal-overlay.open .modal { transform: translateY(0) scale(1); }

        .modal-header {
            padding: 24px 24px 18px;
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            border-bottom: 1px solid rgba(255,255,255,0.06);
            position: relative;
        }
        .modal-close {
            position: absolute; top: 14px; right: 14px;
            width: 28px; height: 28px;
            border-radius: 50%;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.1);
            color: #fff;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer;
            font-size: 14px;
            transition: background 0.15s;
        }
        .modal-close:hover { background: rgba(255,255,255,0.14); }
        .modal-avatar {
            width: 64px; height: 64px;
            border-radius: 50%;
            border: 2px solid;
            display: flex; align-items: center; justify-content: center;
            font-size: 22px; font-weight: 700;
            margin-bottom: 12px;
        }
        .modal-name {
            color: #fff; font-size: 18px; font-weight: 700;
            margin-bottom: 4px;
            max-width: 100%;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .modal-status {
            font-size: 11px; font-weight: 600;
            display: inline-flex; align-items: center; gap: 6px;
            padding: 3px 10px;
            border-radius: 100px;
        }
        .modal-status.online { background: rgba(74,222,128,0.15); color: #86efac; border: 1px solid rgba(74,222,128,0.3); }
        .modal-status.offline { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.1); }
        .modal-status .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
        .modal-status.online .dot { box-shadow: 0 0 6px currentColor; }

        .modal-body { padding: 16px 20px 20px; }
        .modal-row {
            display: flex; justify-content: space-between; align-items: center;
            padding: 10px 4px;
            border-bottom: 1px solid rgba(255,255,255,0.04);
            font-size: 13px;
            gap: 12px;
        }
        .modal-row:last-child { border-bottom: none; }
        .modal-row-label { color: rgba(255,255,255,0.5); flex-shrink: 0; }
        .modal-row-value {
            color: #fff;
            font-weight: 500;
            font-variant-numeric: tabular-nums;
            text-align: right;
            overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .modal-row-value.mono { font-family: 'SF Mono', Menlo, monospace; font-size: 12px; }

        .modal-actions {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            padding: 4px 20px 20px;
        }
        .modal-btn {
            padding: 10px 14px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 10px;
            color: #fff;
            font-size: 12px;
            font-weight: 500;
            font-family: inherit;
            cursor: pointer;
            transition: background 0.15s, border-color 0.15s, transform 0.1s;
            display: flex; align-items: center; justify-content: center; gap: 6px;
        }
        .modal-btn:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.18); }
        .modal-btn:active { transform: scale(0.97); }
        .modal-btn.copied {
            background: rgba(74,222,128,0.15);
            border-color: rgba(74,222,128,0.4);
            color: #86efac;
        }
        .modal-loading {
            padding: 30px 20px;
            text-align: center;
            color: rgba(255,255,255,0.4);
            font-size: 13px;
        }
    </style>
</head>
<body>

    <div class="liquid-bg">
        <svg viewBox="0 0 1400 900" preserveAspectRatio="xMidYMid slice">
            <defs>
                <radialGradient id="liquidA" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.95"/>
                    <stop offset="50%" stop-color="#7c3aed" stop-opacity="0.55"/>
                    <stop offset="100%" stop-color="#0a0612" stop-opacity="0"/>
                </radialGradient>
                <radialGradient id="liquidB" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#ec4899" stop-opacity="0.5"/>
                    <stop offset="100%" stop-color="#0a0612" stop-opacity="0"/>
                </radialGradient>
                <radialGradient id="liquidC" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#1e1033" stop-opacity="0.95"/>
                    <stop offset="100%" stop-color="#0a0612" stop-opacity="0"/>
                </radialGradient>
                <radialGradient id="liquidHi" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
                </radialGradient>
                <filter id="liquidBlur"><feGaussianBlur stdDeviation="50"/></filter>
            </defs>
            <g filter="url(#liquidBlur)">
                <ellipse class="blob-1" cx="200" cy="250" rx="380" ry="280" fill="url(#liquidA)" opacity="0.7"/>
                <ellipse class="blob-2" cx="1200" cy="180" rx="400" ry="280" fill="url(#liquidA)"/>
                <ellipse class="blob-3" cx="1300" cy="700" rx="320" ry="380" fill="url(#liquidB)"/>
                <ellipse class="blob-1" cx="100" cy="800" rx="280" ry="240" fill="url(#liquidC)"/>
                <ellipse class="blob-2" cx="700" cy="450" rx="240" ry="180" fill="url(#liquidHi)" opacity="0.5"/>
                <ellipse class="blob-3" cx="1100" cy="380" rx="120" ry="90" fill="url(#liquidHi)"/>
            </g>
        </svg>
    </div>

    <div class="container">

        <div class="header">
            <div class="logo">
                <div class="logo-icon">❄</div>
                <span class="logo-name">Rocksnow</span>
            </div>
            <div class="live-badge" id="live-badge">
                <div class="live-dot"></div>
                <span class="live-text">Live</span>
            </div>
        </div>

        <div class="top-grid">
            <div class="glass hero-card">
                <div>
                    <div class="hero-label">Сейчас в игре</div>
                    <div class="hero-row">
                        <div class="hero-value" id="hero-value">${players.length}</div>
                        <div id="trend-slot">${trendBadge}</div>
                    </div>
                </div>
                <div class="chart-block">
                    <div class="chart-head">
                        <div class="chart-title">Активность 24ч</div>
                        <div class="chart-meta" id="chart-meta">${peakChartLabel}</div>
                    </div>
                    <div id="chart-slot">${buildSparkline(s.recent)}</div>
                </div>
            </div>

            <div class="side-stats">
                <div class="glass stat-card">
                    <div>
                        <div class="stat-label">Рекорд</div>
                        <div class="stat-value" id="record-value">${stats.record.count}</div>
                    </div>
                    <div class="stat-meta" id="record-meta">${recordDate.date}<br>${recordDate.time}</div>
                </div>
                <div class="glass stat-card">
                    <div>
                        <div class="stat-label">Среднее 24ч</div>
                        <div class="stat-value" id="avg-value">${s.last24h}</div>
                    </div>
                    <div class="stat-meta" id="avg-meta">${peakInfo}</div>
                </div>
                <div class="glass stat-card">
                    <div>
                        <div class="stat-label">Всё время</div>
                        <div class="stat-value" id="alltime-value">${s.allTime}</div>
                    </div>
                    <div class="stat-meta" id="alltime-meta">${stats.totalSamples.toLocaleString('ru-RU')}<br>замеров</div>
                </div>
            </div>
        </div>

        <div class="section-head">
            <div class="section-title">Топ игроков</div>
            <div class="section-tag">по времени</div>
        </div>

        <div class="podium" id="podium-slot">
            ${buildPodiumCard(top[1], 2)}
            ${buildPodiumCard(top[0], 1)}
            ${buildPodiumCard(top[2], 3)}
        </div>

        <div class="glass players-card">
            <div class="players-head">
                <div class="players-title-row">
                    <div class="players-title">Игроки</div>
                    <div class="count-badge" id="count-badge">${players.length} онлайн</div>
                </div>
                <input class="search-input" id="player-search" placeholder="Поиск по нику..." autocomplete="off"/>
            </div>
            <div class="players-grid" id="players-grid">
                ${playerCards || emptyState}
            </div>
        </div>

        <div class="footer">Обновляется в реальном времени</div>

    </div>

    <!-- Player modal -->
    <div class="modal-overlay" id="modal-overlay">
        <div class="modal" id="modal">
            <div class="modal-header">
                <button class="modal-close" id="modal-close" aria-label="Закрыть">×</button>
                <div class="modal-avatar" id="modal-avatar">??</div>
                <div class="modal-name" id="modal-name">—</div>
                <div class="modal-status offline" id="modal-status">
                    <span class="dot"></span><span id="modal-status-text">оффлайн</span>
                </div>
            </div>
            <div class="modal-body" id="modal-body">
                <div class="modal-loading">Загружаем...</div>
            </div>
            <div class="modal-actions" id="modal-actions" style="display:none;">
                <button class="modal-btn" id="copy-name-btn">Копировать ник</button>
                <button class="modal-btn" id="copy-uuid-btn">Копировать UUID</button>
            </div>
        </div>
    </div>

    <script>
        // ===== Avatar palette (mirror of server-side) =====
        const PALETTES = ${JSON.stringify(AVATAR_PALETTES)};
        function avatarColor(name) {
            let hash = 0;
            for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
            return PALETTES[Math.abs(hash) % PALETTES.length];
        }
        function initials(name) { return (name || '??').slice(0, 2).toUpperCase(); }
        function escapeHtml(s) {
            if (s == null) return '';
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function shortServer(server) {
            if (!server) return '—';
            if (server === 'single') return 'singleplayer';
            return server.replace(/:25565$/, '');
        }
        function formatPlaytime(ms) {
            const totalMin = Math.floor((ms || 0) / 60000);
            const hours = Math.floor(totalMin / 60);
            const mins = totalMin % 60;
            if (hours === 0) return mins + 'м';
            return hours + 'ч ' + String(mins).padStart(2, '0') + 'м';
        }
        function timeAgo(ts) {
            if (!ts) return '—';
            const sec = Math.floor((Date.now() - ts) / 1000);
            if (sec < 60) return 'только что';
            const min = Math.floor(sec / 60);
            if (min < 60) return min + 'м';
            const hr = Math.floor(min / 60);
            if (hr < 24) return hr + 'ч';
            return new Date(ts).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'short' });
        }
        function formatDateTime(ts) {
            if (!ts) return '—';
            return new Date(ts).toLocaleString('ru-RU', {
                timeZone: 'Asia/Almaty',
                day: 'numeric', month: 'short',
                hour: '2-digit', minute: '2-digit'
            });
        }
        function formatTime(ts) {
            if (!ts) return '';
            return new Date(ts).toLocaleString('ru-RU', {
                timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit'
            });
        }

        // ===== Sparkline (client-side) =====
        function buildSparkline(samples) {
            if (!samples || samples.length < 2) {
                return '<div style="color:rgba(255,255,255,0.3);font-size:11px;text-align:center;padding:14px 0;">Накапливаем данные</div>';
            }
            const W = 400, H = 60;
            const max = Math.max.apply(null, samples.map(s => s.count).concat([1]));
            const points = samples.map((s, i) => {
                const x = (i / (samples.length - 1)) * W;
                const y = H - 6 - (s.count / max) * (H - 14);
                return [x, y];
            });
            const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + ' ' + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
            const areaPath = linePath + ' L ' + W + ',' + H + ' L 0,' + H + ' Z';
            let peakIdx = 0;
            for (let i = 1; i < samples.length; i++) if (samples[i].count > samples[peakIdx].count) peakIdx = i;
            const peakPt = points[peakIdx];
            return [
                '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:50px;display:block;">',
                '<defs><linearGradient id="chartArea2" x1="0" y1="0" x2="0" y2="1">',
                '<stop offset="0%" stop-color="#a78bfa" stop-opacity="0.5"/>',
                '<stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>',
                '</linearGradient></defs>',
                '<path d="' + areaPath + '" fill="url(#chartArea2)"/>',
                '<path d="' + linePath + '" stroke="#c4b5fd" stroke-width="2" fill="none" stroke-linejoin="round"/>',
                '<circle cx="' + peakPt[0].toFixed(1) + '" cy="' + peakPt[1].toFixed(1) + '" r="8" fill="rgba(196,181,253,0.2)"/>',
                '<circle cx="' + peakPt[0].toFixed(1) + '" cy="' + peakPt[1].toFixed(1) + '" r="4" fill="#fff" stroke="#a78bfa" stroke-width="1.5"/>',
                '</svg>'
            ].join('');
        }

        // ===== Trend & podium builders =====
        function buildTrendPill(trend) {
            if (trend > 0) return '<div class="trend-pill trend-up">↑ +' + trend + ' за час</div>';
            if (trend < 0) return '<div class="trend-pill trend-down">↓ ' + trend + ' за час</div>';
            return '<div class="trend-pill trend-flat">— стабильно</div>';
        }

        function buildPodiumCard(player, place) {
            if (!player) {
                const labels = { 1: 'Никого', 2: '—', 3: '—' };
                return ''
                    + '<div class="podium-card podium-empty podium-' + place + '">'
                    +   '<div class="podium-medal medal-' + place + '">' + place + '</div>'
                    +   '<div class="podium-avatar empty-avatar">?</div>'
                    +   '<div class="podium-divider"></div>'
                    +   '<div class="podium-name empty-name">' + labels[place] + '</div>'
                    +   '<div class="podium-time">—</div>'
                    + '</div>';
            }
            const c = avatarColor(player.name);
            const isFirst = place === 1;
            return ''
                + '<div class="podium-card podium-' + place + '" data-uuid="' + escapeHtml(player.uuid) + '" data-displayname="' + escapeHtml(player.name) + '">'
                +   '<div class="podium-medal medal-' + place + '">' + place + '</div>'
                +   '<div class="podium-avatar" style="background:' + c.bg + ';border-color:' + c.border + ';color:' + c.fg + ';">' + initials(player.name) + '</div>'
                +   '<div class="podium-divider' + (isFirst ? ' gold' : '') + '"></div>'
                +   '<div class="podium-name">' + escapeHtml(player.name) + '</div>'
                +   '<div class="podium-time' + (isFirst ? ' gold-time' : '') + '">' + formatPlaytime(player.totalMs) + '</div>'
                + '</div>';
        }

        function buildPlayerCardHtml(p) {
            const c = avatarColor(p.name);
            const isActive = (Date.now() - p.lastSeen) < 30000;
            const status = isActive
                ? '<div class="status-dot online" title="в сети"></div>'
                : '<div class="status-time">' + escapeHtml(timeAgo(p.lastSeen)) + '</div>';
            const sub = shortServer(p.server);
            return ''
                + '<div class="avatar" style="background:' + c.bg + ';border-color:' + c.border + ';color:' + c.fg + ';">' + initials(p.name) + '</div>'
                + '<div class="player-info">'
                +   '<div class="player-name">' + escapeHtml(p.name) + '</div>'
                +   '<div class="player-sub" title="' + escapeHtml(p.server || '') + '">' + escapeHtml(sub) + '</div>'
                + '</div>'
                + status;
        }

        // ===== Live update (DOM diff, no full reload) =====
        const grid = document.getElementById('players-grid');
        const heroValueEl = document.getElementById('hero-value');
        const trendSlot = document.getElementById('trend-slot');
        const chartSlot = document.getElementById('chart-slot');
        const chartMeta = document.getElementById('chart-meta');
        const recordValue = document.getElementById('record-value');
        const recordMeta = document.getElementById('record-meta');
        const avgValue = document.getElementById('avg-value');
        const avgMeta = document.getElementById('avg-meta');
        const allTimeValue = document.getElementById('alltime-value');
        const allTimeMeta = document.getElementById('alltime-meta');
        const podiumSlot = document.getElementById('podium-slot');
        const countBadge = document.getElementById('count-badge');
        const liveBadge = document.getElementById('live-badge');
        const search = document.getElementById('player-search');

        function applyFilter() {
            const q = (search.value || '').toLowerCase().trim();
            grid.querySelectorAll('.player-card').forEach(card => {
                const name = card.dataset.name || '';
                card.style.display = !q || name.includes(q) ? 'flex' : 'none';
            });
        }
        search.addEventListener('input', applyFilter);

        function updatePlayersDom(players) {
            // Empty state
            const existingEmpty = grid.querySelector('.empty-state');
            if (players.length === 0) {
                if (!existingEmpty) {
                    grid.innerHTML = '<div class="empty-state">Сейчас никого нет онлайн</div>';
                }
                return;
            }
            if (existingEmpty) existingEmpty.remove();

            const incomingByUuid = new Map(players.map(p => [p.uuid, p]));
            const present = new Map();
            grid.querySelectorAll('.player-card').forEach(card => {
                present.set(card.dataset.uuid, card);
            });

            // remove cards that left
            present.forEach((card, uuid) => {
                if (!incomingByUuid.has(uuid)) {
                    card.classList.add('leaving');
                    setTimeout(() => { if (card.parentNode) card.parentNode.removeChild(card); }, 250);
                }
            });

            // upsert in correct order
            players.forEach((p, idx) => {
                let card = present.get(p.uuid);
                if (card) {
                    // update only if changed (avoid flicker)
                    const newHtml = buildPlayerCardHtml(p);
                    if (card.innerHTML !== newHtml) card.innerHTML = newHtml;
                    card.dataset.name = p.name.toLowerCase();
                    card.dataset.displayname = p.name;
                } else {
                    card = document.createElement('div');
                    card.className = 'player-card appearing';
                    card.dataset.uuid = p.uuid;
                    card.dataset.name = p.name.toLowerCase();
                    card.dataset.displayname = p.name;
                    card.innerHTML = buildPlayerCardHtml(p);
                    requestAnimationFrame(() => card.classList.remove('appearing'));
                }
                // place at index idx
                const target = grid.children[idx];
                if (target !== card) grid.insertBefore(card, target || null);
            });
            applyFilter();
        }

        let lastCount = ${players.length};
        function updateHero(count, trend) {
            if (count !== lastCount) {
                heroValueEl.classList.add('bump');
                setTimeout(() => heroValueEl.classList.remove('bump'), 300);
                lastCount = count;
            }
            heroValueEl.textContent = count;
            trendSlot.innerHTML = buildTrendPill(trend);
        }

        async function refresh() {
            try {
                liveBadge.classList.add('refreshing');
                const r = await fetch('/online', { cache: 'no-store' });
                if (!r.ok) throw new Error('http ' + r.status);
                const data = await r.json();

                const players = (data.players || []).slice().sort((a, b) => b.lastSeen - a.lastSeen);
                updatePlayersDom(players);
                updateHero(players.length, data.stats.trend || 0);
                countBadge.textContent = players.length + ' онлайн';

                chartSlot.innerHTML = buildSparkline(data.stats.recent);
                chartMeta.textContent = data.stats.peak24h && data.stats.peak24h.count > 0
                    ? 'пик ' + data.stats.peak24h.count + ' в ' + formatTime(data.stats.peak24h.t)
                    : '';

                if (data.stats.record) {
                    recordValue.textContent = data.stats.record.count;
                    if (data.stats.record.timestamp) {
                        const d = new Date(data.stats.record.timestamp);
                        recordMeta.innerHTML =
                            d.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'short' })
                            + '<br>' + d.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit' });
                    }
                }
                avgValue.textContent = (data.stats.last24h ?? 0).toFixed(1);
                avgMeta.innerHTML = data.stats.peak24h && data.stats.peak24h.count > 0
                    ? 'пик ' + data.stats.peak24h.count + '<br>в ' + formatTime(data.stats.peak24h.t)
                    : 'нет<br>данных';
                allTimeValue.textContent = (data.stats.allTime ?? 0).toFixed(1);
                if (data.stats.totalSamples != null) {
                    allTimeMeta.innerHTML = data.stats.totalSamples.toLocaleString('ru-RU') + '<br>замеров';
                }

                const top = data.top || [];
                podiumSlot.innerHTML = buildPodiumCard(top[1], 2) + buildPodiumCard(top[0], 1) + buildPodiumCard(top[2], 3);
            } catch (e) {
                // mute network errors, will retry
            } finally {
                setTimeout(() => liveBadge.classList.remove('refreshing'), 250);
            }
        }

        setInterval(refresh, 5000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

        // ===== Player modal =====
        const overlay = document.getElementById('modal-overlay');
        const modalAvatar = document.getElementById('modal-avatar');
        const modalName = document.getElementById('modal-name');
        const modalStatus = document.getElementById('modal-status');
        const modalStatusText = document.getElementById('modal-status-text');
        const modalBody = document.getElementById('modal-body');
        const modalActions = document.getElementById('modal-actions');
        const copyNameBtn = document.getElementById('copy-name-btn');
        const copyUuidBtn = document.getElementById('copy-uuid-btn');
        const modalCloseBtn = document.getElementById('modal-close');

        let currentModal = { uuid: null, name: null };

        function openModal(uuid, name) {
            currentModal = { uuid, name };
            const c = avatarColor(name || '??');
            modalAvatar.textContent = initials(name || '??');
            modalAvatar.style.background = c.bg;
            modalAvatar.style.borderColor = c.border;
            modalAvatar.style.color = c.fg;
            modalName.textContent = name || 'Загрузка...';
            modalStatus.className = 'modal-status offline';
            modalStatusText.textContent = '...';
            modalBody.innerHTML = '<div class="modal-loading">Загружаем...</div>';
            modalActions.style.display = 'none';
            overlay.classList.add('open');
            document.body.style.overflow = 'hidden';

            fetch('/player/' + encodeURIComponent(uuid), { cache: 'no-store' })
                .then(r => r.ok ? r.json() : Promise.reject(r.status))
                .then(data => {
                    currentModal.name = data.name;
                    modalName.textContent = data.name;
                    if (data.online) {
                        modalStatus.className = 'modal-status online';
                        modalStatusText.textContent = 'в сети';
                    } else {
                        modalStatus.className = 'modal-status offline';
                        modalStatusText.textContent = 'оффлайн';
                    }
                    const serverDisplay = data.online && data.currentServer
                        ? shortServer(data.currentServer)
                        : (data.lastServer ? shortServer(data.lastServer) + ' (последний)' : '—');

                    const rows = [
                        { label: 'Время игры', value: formatPlaytime(data.totalMs) },
                        { label: data.online ? 'Сервер' : 'Последний сервер', value: serverDisplay, mono: true },
                        { label: data.online ? 'Был онлайн' : 'Последний онлайн', value: data.online ? 'сейчас' : timeAgo(data.lastSeen) },
                        { label: 'Первый раз', value: formatDateTime(data.firstSeen) },
                        { label: 'UUID', value: data.uuid, mono: true }
                    ];
                    modalBody.innerHTML = rows.map(r =>
                        '<div class="modal-row">'
                        + '<span class="modal-row-label">' + escapeHtml(r.label) + '</span>'
                        + '<span class="modal-row-value' + (r.mono ? ' mono' : '') + '" title="' + escapeHtml(r.value) + '">' + escapeHtml(r.value) + '</span>'
                        + '</div>'
                    ).join('');
                    modalActions.style.display = 'grid';
                })
                .catch(() => {
                    modalBody.innerHTML = '<div class="modal-loading">Не удалось загрузить</div>';
                });
        }
        function closeModal() {
            overlay.classList.remove('open');
            document.body.style.overflow = '';
        }
        modalCloseBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

        async function copyToClipboard(text, btn, label) {
            try {
                await navigator.clipboard.writeText(text);
            } catch {
                // fallback
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch {}
                document.body.removeChild(ta);
            }
            const orig = btn.textContent;
            btn.classList.add('copied');
            btn.textContent = '✓ скопировано';
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.textContent = label;
            }, 1200);
        }
        copyNameBtn.addEventListener('click', () => {
            if (currentModal.name) copyToClipboard(currentModal.name, copyNameBtn, 'Копировать ник');
        });
        copyUuidBtn.addEventListener('click', () => {
            if (currentModal.uuid) copyToClipboard(currentModal.uuid, copyUuidBtn, 'Копировать UUID');
        });

        // delegated click handler — works with re-rendered cards too
        document.addEventListener('click', (e) => {
            const card = e.target.closest('.player-card, .podium-card');
            if (!card) return;
            if (card.classList.contains('podium-empty')) return;
            const uuid = card.dataset.uuid;
            const name = card.dataset.displayname;
            if (uuid) openModal(uuid, name);
        });
    </script>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));

// При остановке (SIGTERM от Railway, SIGINT от Ctrl+C) — успеваем сохранить актуальный playtime.
// Без этого последние ~5 секунд активности теряются на каждом редеплое.
function gracefulShutdown(signal) {
    console.log(signal + ' received, flushing data...');
    try {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        savePlaytime();
        saveStats();
        console.log('flushed OK');
    } catch (e) {
        console.error('flush failed:', e.message);
    }
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
