const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const onlinePlayers = new Map();
const TIMEOUT_MS = 15000;
const PLAYTIME_GAP_MS = 30_000;

const STATS_FILE = path.join(__dirname, 'stats.json');
const PLAYTIME_FILE = path.join(__dirname, 'playtime.json');
const SAMPLE_INTERVAL_MS = 60_000;

let stats = {
    record: { count: 0, timestamp: null },
    samples: [],
    totalSamples: 0,
    sumSamples: 0
};

let playtime = {};

try {
    if (fs.existsSync(STATS_FILE)) {
        stats = { ...stats, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) };
    }
    if (fs.existsSync(PLAYTIME_FILE)) {
        playtime = JSON.parse(fs.readFileSync(PLAYTIME_FILE, 'utf8'));
    }
} catch (e) {
    console.error('load:', e.message);
}

function saveStats() {
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); }
    catch (e) { console.error('save stats:', e.message); }
}

function savePlaytime() {
    try { fs.writeFileSync(PLAYTIME_FILE, JSON.stringify(playtime, null, 2)); }
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

function trackPlaytime(uuid, name) {
    const now = Date.now();
    const existing = playtime[uuid];
    if (existing) {
        const gap = now - existing.lastPing;
        if (gap < PLAYTIME_GAP_MS) {
            existing.totalMs += gap;
        }
        existing.lastPing = now;
        existing.name = name;
    } else {
        playtime[uuid] = {
            name,
            totalMs: 0,
            lastPing: now,
            firstSeen: now
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
        allTime: allTime.toFixed(1),
        last24h: last24h.toFixed(1),
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

app.post('/ping', (req, res) => {
    const { uuid, name } = req.body;
    if (!uuid || !name) return res.status(400).json({ error: 'missing fields' });
    onlinePlayers.set(uuid, { name, lastSeen: Date.now() });
    trackPlaytime(uuid, name);
    updateRecord(onlinePlayers.size);
    res.json({ ok: true });
});

app.get('/online', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.entries()).map(([uuid, data]) => ({
        uuid, name: data.name, lastSeen: data.lastSeen
    }));
    res.json({
        players,
        stats: { ...getStats(), record: stats.record },
        top: getTopPlayers(3)
    });
});

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

function buildSparkline(samples) {
    if (samples.length < 2) {
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
        <div class="podium-card podium-${place}">
            <div class="podium-medal medal-${place}">${place}</div>
            <div class="podium-avatar" style="background:${c.bg};border-color:${c.border};color:${c.fg};">
                ${initials(player.name)}
            </div>
            <div class="podium-divider ${isFirst ? 'gold' : ''}"></div>
            <div class="podium-name">${player.name}</div>
            <div class="podium-time ${isFirst ? 'gold-time' : ''}">${formatPlaytime(player.totalMs)}</div>
        </div>
    `;
}

app.get('/', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.entries())
        .map(([uuid, data]) => ({ uuid, name: data.name, lastSeen: data.lastSeen }))
        .sort((a, b) => b.lastSeen - a.lastSeen);

    const s = getStats();
    const top = getTopPlayers(3);
    const recordDate = formatDate(stats.record.timestamp);

    const trendBadge = s.trend > 0
        ? `<div class="trend-pill trend-up">↑ +${s.trend} за час</div>`
        : s.trend < 0
            ? `<div class="trend-pill trend-down">↓ ${s.trend} за час</div>`
            : `<div class="trend-pill trend-flat">— стабильно</div>`;

    const playerCards = players.map(p => {
        const c = avatarColor(p.name);
        const isActive = (Date.now() - p.lastSeen) < 30000;
        const status = isActive
            ? `<div class="status-dot online" title="в сети"></div>`
            : `<div class="status-time">${timeAgo(p.lastSeen)}</div>`;
        return `
            <div class="player-card" data-name="${p.name.toLowerCase()}" data-uuid="${p.uuid}">
                <div class="avatar" style="background:${c.bg};border-color:${c.border};color:${c.fg};">${initials(p.name)}</div>
                <div class="player-info">
                    <div class="player-name">${p.name}</div>
                    <div class="player-uuid">${p.uuid.slice(0, 8)}...</div>
                </div>
                ${status}
            </div>
        `;
    }).join('');

    const emptyState = `<div style="text-align:center;padding:40px 20px;color:rgba(255,255,255,0.4);font-size:14px;grid-column: 1 / -1;">Сейчас никого нет онлайн</div>`;
    const peakInfo = s.peak24h.count > 0 ? `пик ${s.peak24h.count}<br>в ${formatTime(s.peak24h.t)}` : 'нет<br>данных';
    const peakChartLabel = s.peak24h.count > 0 ? `пик ${s.peak24h.count} в ${formatTime(s.peak24h.t)}` : '';

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rocksnow</title>
    <meta http-equiv="refresh" content="10">
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
        }
        .live-dot {
            width: 6px; height: 6px; border-radius: 50%;
            background: #4ade80;
            box-shadow: 0 0 8px rgba(74,222,128,0.7);
            animation: livePulse 2s ease-in-out infinite;
        }
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
        .hero-value { color: #fff; font-size: 96px; font-weight: 700; line-height: 0.9; letter-spacing: -0.05em; }
        @media (max-width: 600px) { .hero-value { font-size: 72px; } }
        .trend-pill { display: flex; align-items: center; gap: 6px; padding: 6px 12px; backdrop-filter: blur(20px); border-radius: 100px; font-size: 12px; font-weight: 600; white-space: nowrap; }
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
        .stat-value { color: #fff; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
        .stat-meta { color: rgba(255,255,255,0.4); font-size: 10px; text-align: right; line-height: 1.3; }

        .section-head {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 28px 4px 16px;
        }
        .section-title {
            color: #fff;
            font-size: 14px;
            font-weight: 600;
        }
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
            cursor: default;
        }
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
            position: absolute;
            top: -12px;
            left: 50%;
            transform: translateX(-50%);
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 13px;
            font-weight: 700;
            border: 2px solid #0a0612;
        }
        .medal-1 {
            width: 32px; height: 32px;
            top: -14px;
            background: linear-gradient(135deg, #fde047, #ca8a04);
            color: #422006;
            font-size: 14px;
            box-shadow: 0 0 12px rgba(250,204,21,0.4);
        }
        .medal-2 {
            background: linear-gradient(135deg, #d1d5db, #9ca3af);
            color: #1f2937;
        }
        .medal-3 {
            background: linear-gradient(135deg, #fdba74, #c2410c);
            color: #431407;
        }

        .podium-avatar {
            width: 56px;
            height: 56px;
            border-radius: 50%;
            border: 1.5px solid;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            font-weight: 700;
            margin: 0 auto 12px;
        }
        .podium-1 .podium-avatar {
            width: 64px; height: 64px;
            border-width: 2px;
            font-size: 20px;
            margin-bottom: 14px;
        }
        .empty-avatar {
            background: rgba(255,255,255,0.05);
            border-color: rgba(255,255,255,0.1);
            color: rgba(255,255,255,0.3);
        }

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
            color: #fff;
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .podium-1 .podium-name { font-size: 14px; }
        .empty-name { color: rgba(255,255,255,0.4); font-weight: 500; }

        .podium-time {
            color: rgba(255,255,255,0.5);
            font-size: 11px;
            font-variant-numeric: tabular-nums;
        }
        .gold-time {
            color: #fde047;
            font-size: 12px;
            font-weight: 600;
        }

        .players-card { overflow: hidden; }
        .players-head {
            padding: 14px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
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
            transition: background 0.15s;
            cursor: pointer;
        }
        .player-card:nth-child(odd) { border-right: 1px solid rgba(255,255,255,0.04); }
        .player-card:hover { background: rgba(255,255,255,0.03); }

        .avatar {
            width: 32px; height: 32px;
            border-radius: 50%;
            border: 1px solid;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: 700;
            flex-shrink: 0;
        }
        .player-info { flex: 1; min-width: 0; }
        .player-name {
            color: #fff;
            font-size: 13px;
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .player-uuid {
            color: rgba(255,255,255,0.3);
            font-size: 10px;
            font-family: 'SF Mono', Menlo, monospace;
            margin-top: 1px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
        .status-dot.online { background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,0.6); }
        .status-time { color: rgba(255,255,255,0.4); font-size: 11px; flex-shrink: 0; }

        .footer { text-align: center; color: rgba(255,255,255,0.25); font-size: 11px; margin-top: 24px; }
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
            <div class="live-badge">
                <div class="live-dot"></div>
                <span class="live-text">Live</span>
            </div>
        </div>

        <div class="top-grid">
            <div class="glass hero-card">
                <div>
                    <div class="hero-label">Сейчас в игре</div>
                    <div class="hero-row">
                        <div class="hero-value">${players.length}</div>
                        ${trendBadge}
                    </div>
                </div>
                <div class="chart-block">
                    <div class="chart-head">
                        <div class="chart-title">Активность 24ч</div>
                        <div class="chart-meta">${peakChartLabel}</div>
                    </div>
                    ${buildSparkline(s.recent)}
                </div>
            </div>

            <div class="side-stats">
                <div class="glass stat-card">
                    <div>
                        <div class="stat-label">Рекорд</div>
                        <div class="stat-value">${stats.record.count}</div>
                    </div>
                    <div class="stat-meta">${recordDate.date}<br>${recordDate.time}</div>
                </div>
                <div class="glass stat-card">
                    <div>
                        <div class="stat-label">Среднее 24ч</div>
                        <div class="stat-value">${s.last24h}</div>
                    </div>
                    <div class="stat-meta">${peakInfo}</div>
                </div>
                <div class="glass stat-card">
                    <div>
                        <div class="stat-label">Всё время</div>
                        <div class="stat-value">${s.allTime}</div>
                    </div>
                    <div class="stat-meta">${stats.totalSamples.toLocaleString('ru-RU')}<br>замеров</div>
                </div>
            </div>
        </div>

        <div class="section-head">
            <div class="section-title">Топ игроков</div>
            <div class="section-tag">по времени</div>
        </div>

        <div class="podium">
            ${buildPodiumCard(top[1], 2)}
            ${buildPodiumCard(top[0], 1)}
            ${buildPodiumCard(top[2], 3)}
        </div>

        <div class="glass players-card">
            <div class="players-head">
                <div class="players-title-row">
                    <div class="players-title">Игроки</div>
                    <div class="count-badge">${players.length} онлайн</div>
                </div>
                <input class="search-input" id="player-search" placeholder="Поиск по нику..." autocomplete="off"/>
            </div>
            <div class="players-grid" id="players-grid">
                ${playerCards || emptyState}
            </div>
        </div>

        <div class="footer">Обновляется каждые 10 секунд</div>

    </div>

    <script>
        const search = document.getElementById('player-search');
        const grid = document.getElementById('players-grid');
        if (search && grid) {
            search.addEventListener('input', (e) => {
                const q = e.target.value.toLowerCase().trim();
                grid.querySelectorAll('.player-card').forEach(card => {
                    const name = card.dataset.name || '';
                    card.style.display = !q || name.includes(q) ? 'flex' : 'none';
                });
            });
        }
        document.querySelectorAll('.player-card').forEach(card => {
            card.addEventListener('click', () => {
                const uuid = card.dataset.uuid;
                if (uuid && navigator.clipboard) {
                    navigator.clipboard.writeText(uuid).then(() => {
                        const orig = card.style.background;
                        card.style.background = 'rgba(74,222,128,0.1)';
                        setTimeout(() => { card.style.background = orig; }, 400);
                    });
                }
            });
        });
    </script>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));
