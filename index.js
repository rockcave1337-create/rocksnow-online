const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const onlinePlayers = new Map();
const TIMEOUT_MS = 15000;

const STATS_FILE = path.join(__dirname, 'stats.json');
const SAMPLE_INTERVAL_MS = 60_000;

let stats = {
    record: { count: 0, timestamp: null },
    samples: [],
    totalSamples: 0,
    sumSamples: 0
};

try {
    if (fs.existsSync(STATS_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        stats = { ...stats, ...loaded };
    }
} catch (e) {
    console.error('stats.json:', e.message);
}

function saveStats() {
    try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); }
    catch (e) { console.error('save:', e.message); }
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

    return {
        allTime: allTime.toFixed(1),
        last24h: last24h.toFixed(1),
        peak24h
    };
}

app.post('/ping', (req, res) => {
    const { uuid, name } = req.body;
    if (!uuid || !name) return res.status(400).json({ error: 'missing fields' });
    onlinePlayers.set(uuid, { name, lastSeen: Date.now() });
    updateRecord(onlinePlayers.size);
    res.json({ ok: true });
});

app.get('/online', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.entries()).map(([uuid, data]) => ({
        uuid, name: data.name, lastSeen: data.lastSeen
    }));
    res.json({ players, stats: { ...getStats(), record: stats.record } });
});

const PILL_PALETTES = [
    { bg: 'rgba(74,222,128,0.9)', text: '#052e16' },
    { bg: 'rgba(167,139,250,0.9)', text: '#1e1033' },
    { bg: 'rgba(244,114,182,0.9)', text: '#4a0826' },
    { bg: 'rgba(34,211,238,0.9)', text: '#083344' },
    { bg: 'rgba(251,146,60,0.9)', text: '#431407' },
    { bg: 'rgba(250,204,21,0.9)', text: '#422006' },
];

function pillForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return PILL_PALETTES[Math.abs(hash) % PILL_PALETTES.length];
}

function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 30) return 'online';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h`;
}

function buildSparkline(samples) {
    if (samples.length < 2) return '';
    const W = 320, H = 60;
    const max = Math.max(...samples.map(s => s.count), 1);
    const points = samples.map((s, i) => {
        const x = (i / (samples.length - 1)) * W;
        const y = H - 8 - (s.count / max) * (H - 16);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;opacity:0.7;">
            <polyline points="${points.join(' ')}" stroke="rgba(255,255,255,0.6)" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
        </svg>
    `;
}

app.get('/', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.entries()).map(([uuid, data]) => ({
        uuid, name: data.name, lastSeen: data.lastSeen
    }));
    const s = getStats();

    const playerPills = players.map(p => {
        const pill = pillForName(p.name);
        const status = timeAgo(p.lastSeen);
        return `
            <div class="player-pill">
                <span class="player-name">${p.name}</span>
                <div class="player-status" style="background:${pill.bg};color:${pill.text};">${status}</div>
            </div>
        `;
    }).join('');

    const emptyState = `
        <div style="color:rgba(255,255,255,0.4);font-size:14px;padding:12px 0;">
            Никого нет онлайн
        </div>
    `;

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rocksnow</title>
    <meta http-equiv="refresh" content="5">
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

        .liquid-bg {
            position: fixed;
            inset: 0;
            z-index: 0;
            pointer-events: none;
        }

        .liquid-bg svg {
            width: 100%;
            height: 100%;
        }

        @keyframes blob1 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            33% { transform: translate(30px, -40px) scale(1.1); }
            66% { transform: translate(-20px, 20px) scale(0.95); }
        }
        @keyframes blob2 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            33% { transform: translate(-40px, 30px) scale(1.05); }
            66% { transform: translate(20px, -30px) scale(1.1); }
        }
        @keyframes blob3 {
            0%, 100% { transform: translate(0, 0) scale(1); }
            50% { transform: translate(40px, 40px) scale(1.15); }
        }

        .blob-1 { animation: blob1 20s ease-in-out infinite; transform-origin: center; }
        .blob-2 { animation: blob2 25s ease-in-out infinite; transform-origin: center; }
        .blob-3 { animation: blob3 18s ease-in-out infinite; transform-origin: center; }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 32px 40px 60px;
            position: relative;
            z-index: 1;
            min-height: 100vh;
        }

        @media (max-width: 700px) {
            .container { padding: 24px 20px 40px; }
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 80px;
        }
        .logo {
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .logo-icon {
            width: 32px;
            height: 32px;
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 16px;
        }
        .logo-name {
            color: #fff;
            font-size: 16px;
            font-weight: 500;
        }

        .live-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            background: rgba(255,255,255,0.08);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.12);
            border-radius: 100px;
        }
        .live-dot {
            width: 6px; height: 6px;
            border-radius: 50%;
            background: #4ade80;
            box-shadow: 0 0 8px rgba(74,222,128,0.6);
            animation: pulse 2s ease-in-out infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .live-text { font-size: 13px; font-weight: 500; }

        .hero {
            margin-bottom: 60px;
            max-width: 720px;
        }
        .hero-title {
            font-size: clamp(48px, 8vw, 88px);
            font-weight: 600;
            line-height: 1.02;
            letter-spacing: -0.035em;
            color: #fff;
        }
        .count-pill {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            padding: 6px 24px 6px 20px;
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.18);
            border-radius: 100px;
            vertical-align: middle;
            margin: 0 4px;
        }
        .count-spark {
            width: 16px; height: 16px;
            color: #facc15;
        }

        .stats-row {
            display: flex;
            gap: 40px;
            margin-bottom: 80px;
            flex-wrap: wrap;
        }
        .stat-block {
            min-width: 90px;
        }
        .stat-value {
            color: #fff;
            font-size: 44px;
            font-weight: 600;
            line-height: 1;
            letter-spacing: -0.02em;
        }
        .stat-label {
            color: rgba(255,255,255,0.5);
            font-size: 13px;
            margin-top: 6px;
            font-weight: 400;
        }
        .stat-sub {
            color: rgba(255,255,255,0.35);
            font-size: 11px;
            margin-top: 2px;
        }

        .bottom-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 40px;
            align-items: end;
        }
        @media (max-width: 700px) {
            .bottom-row { grid-template-columns: 1fr; }
        }

        .players-section {
            display: flex;
            flex-direction: column;
            gap: 10px;
            align-items: flex-start;
        }
        .section-label {
            color: rgba(255,255,255,0.5);
            font-size: 12px;
            font-weight: 500;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            margin-bottom: 6px;
        }

        .player-pill {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 6px 6px 16px;
            background: rgba(20,15,30,0.5);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 100px;
            transition: transform 0.2s, background 0.2s;
            max-width: 100%;
        }
        .player-pill:hover {
            transform: translateX(4px);
            background: rgba(30,20,45,0.6);
        }
        .player-name {
            color: #fff;
            font-size: 14px;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 200px;
        }
        .player-status {
            padding: 4px 12px;
            border-radius: 100px;
            font-size: 11px;
            font-weight: 600;
            white-space: nowrap;
        }

        .chart-section {
            background: rgba(20,15,30,0.4);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 16px;
            padding: 18px 20px;
        }
        .chart-head {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 12px;
        }
        .chart-title {
            color: rgba(255,255,255,0.7);
            font-size: 12px;
            font-weight: 500;
        }
        .chart-meta {
            color: rgba(255,255,255,0.4);
            font-size: 11px;
        }

        .footer {
            text-align: left;
            color: rgba(255,255,255,0.25);
            font-size: 11px;
            margin-top: 60px;
        }
    </style>
</head>
<body>

    <div class="liquid-bg">
        <svg viewBox="0 0 1400 900" preserveAspectRatio="xMidYMid slice">
            <defs>
                <radialGradient id="liquid1" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.95"/>
                    <stop offset="40%" stop-color="#7c3aed" stop-opacity="0.7"/>
                    <stop offset="100%" stop-color="#0a0612" stop-opacity="0"/>
                </radialGradient>
                <radialGradient id="liquid2" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#c4b5fd" stop-opacity="0.6"/>
                    <stop offset="100%" stop-color="#0a0612" stop-opacity="0"/>
                </radialGradient>
                <radialGradient id="liquid3" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#1e1033" stop-opacity="0.95"/>
                    <stop offset="100%" stop-color="#0a0612" stop-opacity="0"/>
                </radialGradient>
                <radialGradient id="liquidHighlight" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stop-color="#ffffff" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
                </radialGradient>
                <filter id="liquidBlur">
                    <feGaussianBlur stdDeviation="40"/>
                </filter>
            </defs>
            <g filter="url(#liquidBlur)">
                <ellipse class="blob-1" cx="950" cy="350" rx="500" ry="380" fill="url(#liquid1)"/>
                <ellipse class="blob-2" cx="1100" cy="700" rx="400" ry="450" fill="url(#liquid1)" opacity="0.7"/>
                <ellipse class="blob-3" cx="700" cy="800" rx="350" ry="280" fill="url(#liquid2)"/>
                <ellipse class="blob-1" cx="400" cy="500" rx="300" ry="240" fill="url(#liquid3)"/>
                <ellipse class="blob-2" cx="1000" cy="500" rx="180" ry="140" fill="url(#liquidHighlight)"/>
                <ellipse class="blob-3" cx="800" cy="200" rx="120" ry="90" fill="url(#liquidHighlight)" opacity="0.6"/>
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

        <div class="hero">
            <h1 class="hero-title">
                Сейчас в игре<br>
                <span class="count-pill">
                    <svg class="count-spark" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M13 2 L4 14 L11 14 L11 22 L20 10 L13 10 Z"/>
                    </svg>
                    ${players.length}
                </span>
                <span style="opacity: 0.85;">${players.length === 1 ? 'игрок' : (players.length >= 2 && players.length <= 4) ? 'игрока' : 'игроков'}</span>
            </h1>
        </div>

        <div class="stats-row">
            <div class="stat-block">
                <div class="stat-value">${stats.record.count}</div>
                <div class="stat-label">Рекорд</div>
            </div>
            <div class="stat-block">
                <div class="stat-value">${s.last24h}</div>
                <div class="stat-label">Среднее 24ч</div>
            </div>
            <div class="stat-block">
                <div class="stat-value">${s.allTime}</div>
                <div class="stat-label">Всё время</div>
            </div>
        </div>

        <div class="bottom-row">
            <div class="players-section">
                <div class="section-label">Игроки онлайн</div>
                ${playerPills || emptyState}
            </div>

            ${s.peak24h.count > 0 ? `
            <div class="chart-section">
                <div class="chart-head">
                    <span class="chart-title">Активность 24ч</span>
                    <span class="chart-meta">пик ${s.peak24h.count}</span>
                </div>
                ${buildSparkline(stats.samples.filter(x => x.t >= Date.now() - 24*60*60*1000))}
            </div>
            ` : ''}
        </div>

        <div class="footer">Обновляется каждые 5 секунд</div>

    </div>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));
