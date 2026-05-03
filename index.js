const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const onlinePlayers = new Map();
const TIMEOUT_MS = 15000;

// ---------- Статистика ----------
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
    console.error('Не удалось загрузить stats.json:', e.message);
}

function saveStats() {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    } catch (e) {
        console.error('Не удалось сохранить stats.json:', e.message);
    }
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
        ? recent.reduce((sum, s) => sum + s.count, 0) / recent.length
        : 0;
    const peak24h = recent.length > 0
        ? recent.reduce((max, s) => s.count > max.count ? s : max, recent[0])
        : { count: 0, t: null };

    const hourCutoff = Date.now() - 60 * 60 * 1000;
    const lastHour = stats.samples.filter(s => s.t >= hourCutoff);
    const hourAvg = lastHour.length > 0
        ? lastHour.reduce((sum, s) => sum + s.count, 0) / lastHour.length
        : 0;
    const trend = onlinePlayers.size - Math.round(hourAvg);

    return {
        allTime: allTime.toFixed(1),
        last24h: last24h.toFixed(1),
        peak24h,
        trend,
        recent
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
        uuid, name: data.name
    }));
    res.json({ players, stats: { ...getStats(), record: stats.record } });
});

// ---------- Утилиты ----------
const NEON_COLORS = [
    { hex: '#a78bfa', rgb: '167,139,250' },  // фиолетовый
    { hex: '#f472b6', rgb: '244,114,182' },  // розовый
    { hex: '#22d3ee', rgb: '34,211,238' },   // циан
    { hex: '#fb923c', rgb: '251,146,60' },   // оранжевый
    { hex: '#4ade80', rgb: '74,222,128' },   // зелёный
    { hex: '#facc15', rgb: '250,204,21' },   // жёлтый
];

function colorForName(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return NEON_COLORS[Math.abs(hash) % NEON_COLORS.length];
}

function initials(name) {
    return name.slice(0, 2).toUpperCase();
}

function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    }).replace(',', ' /');
}

function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        hour: '2-digit', minute: '2-digit'
    });
}

function buildSparkline(samples) {
    if (samples.length < 2) {
        return `<div style="color:rgba(167,139,250,0.5);font-size:11px;text-align:center;padding:30px 0;letter-spacing:0.2em;">
                    >> COLLECTING_DATA...
                </div>`;
    }

    const W = 600, H = 140;
    const max = Math.max(...samples.map(s => s.count), 1);

    const points = samples.map((s, i) => {
        const x = (i / (samples.length - 1)) * W;
        const y = H - 20 - (s.count / max) * (H - 40);
        return [x, y];
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${W},${H} L 0,${H} Z`;

    const peakIdx = samples.reduce((maxI, s, i) => s.count > samples[maxI].count ? i : maxI, 0);
    const peakPt = points[peakIdx];

    return `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">
            <defs>
                <linearGradient id="neonarea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.5"/>
                    <stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>
                </linearGradient>
                <filter id="glow">
                    <feGaussianBlur stdDeviation="3" result="blur"/>
                    <feMerge>
                        <feMergeNode in="blur"/>
                        <feMergeNode in="SourceGraphic"/>
                    </feMerge>
                </filter>
            </defs>
            <line x1="0" y1="35" x2="${W}" y2="35" stroke="rgba(167,139,250,0.1)" stroke-width="1" stroke-dasharray="2,4"/>
            <line x1="0" y1="70" x2="${W}" y2="70" stroke="rgba(167,139,250,0.1)" stroke-width="1" stroke-dasharray="2,4"/>
            <line x1="0" y1="105" x2="${W}" y2="105" stroke="rgba(167,139,250,0.1)" stroke-width="1" stroke-dasharray="2,4"/>
            <path d="${areaPath}" fill="url(#neonarea)"/>
            <path d="${linePath}" stroke="#a78bfa" stroke-width="2" fill="none" filter="url(#glow)"/>
            <circle cx="${peakPt[0].toFixed(1)}" cy="${peakPt[1].toFixed(1)}" r="5" fill="#f472b6" filter="url(#glow)"/>
        </svg>
    `;
}

// ---------- Страничка ----------
app.get('/', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.values());
    const s = getStats();

    const trendEl = s.trend > 0
        ? `<div style="color:#4ade80;font-size:10px;margin-top:6px;text-shadow:0 0 6px rgba(74,222,128,0.6);letter-spacing:0.1em;">▲ +${s.trend} / 1H</div>`
        : s.trend < 0
            ? `<div style="color:#f87171;font-size:10px;margin-top:6px;text-shadow:0 0 6px rgba(248,113,113,0.6);letter-spacing:0.1em;">▼ ${s.trend} / 1H</div>`
            : `<div style="color:rgba(167,139,250,0.5);font-size:10px;margin-top:6px;letter-spacing:0.1em;">— STABLE</div>`;

    const playerRows = players.map(p => {
        const c = colorForName(p.name);
        return `
            <div class="player-row" style="display:flex;align-items:center;gap:14px;padding:10px 12px;border-left:2px solid transparent;transition:all 0.2s;"
                 onmouseover="this.style.background='rgba(${c.rgb},0.05)';this.style.borderLeftColor='${c.hex}'"
                 onmouseout="this.style.background='transparent';this.style.borderLeftColor='transparent'">
                <div style="width:34px;height:34px;border:1.5px solid ${c.hex};background:rgba(${c.rgb},0.1);display:flex;align-items:center;justify-content:center;color:${c.hex};font-size:12px;font-weight:bold;box-shadow:0 0 10px rgba(${c.rgb},0.3);flex-shrink:0;">
                    ${initials(p.name)}
                </div>
                <div style="flex:1;min-width:0;">
                    <div style="color:#fff;font-size:13px;font-weight:bold;letter-spacing:0.05em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</div>
                    <div style="color:rgba(167,139,250,0.5);font-size:10px;font-family:'Courier New',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">UID :: ${p.uuid}</div>
                </div>
                <div style="color:#4ade80;font-size:10px;text-shadow:0 0 6px rgba(74,222,128,0.6);letter-spacing:0.2em;flex-shrink:0;">● ON</div>
            </div>
        `;
    }).join('');

    const emptyState = `
        <div style="text-align:center;padding:40px 20px;color:rgba(167,139,250,0.5);font-size:11px;letter-spacing:0.3em;">
            >> NO_PLAYERS_DETECTED
        </div>
    `;

    const peakTime = s.peak24h.t ? formatTime(s.peak24h.t) : '--:--';

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ROCKSNOW :: ONLINE</title>
    <meta http-equiv="refresh" content="5">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Orbitron:wght@500;700;900&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #05050d;
            color: #fff;
            font-family: 'JetBrains Mono', 'Courier New', monospace;
            min-height: 100vh;
            padding: 24px 16px;
            -webkit-font-smoothing: antialiased;
            position: relative;
            overflow-x: hidden;
        }

        /* Сетка на фоне */
        body::before {
            content: '';
            position: fixed;
            inset: 0;
            background-image:
                linear-gradient(rgba(167,139,250,0.04) 1px, transparent 1px),
                linear-gradient(90deg, rgba(167,139,250,0.04) 1px, transparent 1px);
            background-size: 40px 40px;
            pointer-events: none;
            z-index: 0;
        }

        /* Вспышки света */
        body::after {
            content: '';
            position: fixed;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background:
                radial-gradient(circle at 20% 30%, rgba(167,139,250,0.08), transparent 40%),
                radial-gradient(circle at 80% 70%, rgba(244,114,182,0.06), transparent 40%);
            pointer-events: none;
            z-index: 0;
        }

        .container { max-width: 720px; margin: 0 auto; position: relative; z-index: 1; }

        /* Header */
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 28px;
        }
        .logo { display: flex; align-items: center; gap: 14px; }
        .logo-icon {
            width: 44px; height: 44px;
            border: 1.5px solid #a78bfa;
            background: rgba(167,139,250,0.1);
            display: flex; align-items: center; justify-content: center;
            font-size: 22px;
            box-shadow: 0 0 20px rgba(167,139,250,0.5), inset 0 0 10px rgba(167,139,250,0.2);
            transform: rotate(45deg);
        }
        .logo-icon span {
            transform: rotate(-45deg);
            color: #a78bfa;
            text-shadow: 0 0 8px #a78bfa;
        }
        .logo-title {
            font-family: 'Orbitron', sans-serif;
            font-size: 22px;
            font-weight: 900;
            letter-spacing: 0.15em;
            text-shadow: 0 0 12px rgba(167,139,250,0.8);
        }
        .logo-sub {
            color: #a78bfa;
            font-size: 10px;
            letter-spacing: 0.3em;
            text-transform: uppercase;
            opacity: 0.7;
        }
        .live-badge {
            display: flex; align-items: center; gap: 10px;
            padding: 8px 14px;
            border: 1px solid #4ade80;
            background: rgba(74,222,128,0.05);
            box-shadow: 0 0 15px rgba(74,222,128,0.3), inset 0 0 8px rgba(74,222,128,0.1);
        }
        .live-dot {
            width: 8px; height: 8px;
            background: #4ade80;
            box-shadow: 0 0 8px #4ade80;
            animation: pulse 1.5s ease-in-out infinite;
        }
        .live-text {
            color: #4ade80;
            font-size: 11px;
            font-weight: bold;
            letter-spacing: 0.2em;
            text-shadow: 0 0 6px #4ade80;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; box-shadow: 0 0 8px #4ade80; }
            50% { opacity: 0.4; box-shadow: 0 0 16px #4ade80; }
        }

        /* Stat cards */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px;
            margin-bottom: 20px;
        }
        @media (max-width: 600px) {
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
        }
        .stat-card {
            border: 1px solid;
            padding: 14px;
            position: relative;
            transition: transform 0.2s;
        }
        .stat-card:hover { transform: translateY(-2px); }
        .stat-card .corner {
            position: absolute;
            width: 12px; height: 12px;
        }
        .stat-card .corner-tl { top: -1px; left: -1px; border-top: 2px solid; border-left: 2px solid; }
        .stat-card .corner-br { bottom: -1px; right: -1px; border-bottom: 2px solid; border-right: 2px solid; }
        .stat-card.purple { border-color: rgba(167,139,250,0.4); background: linear-gradient(135deg, rgba(167,139,250,0.08), transparent); box-shadow: 0 0 20px rgba(167,139,250,0.15); }
        .stat-card.purple .corner { border-color: #a78bfa; }
        .stat-card.pink { border-color: rgba(244,114,182,0.4); background: linear-gradient(135deg, rgba(244,114,182,0.08), transparent); box-shadow: 0 0 20px rgba(244,114,182,0.15); }
        .stat-card.pink .corner { border-color: #f472b6; }
        .stat-card.cyan { border-color: rgba(34,211,238,0.4); background: linear-gradient(135deg, rgba(34,211,238,0.08), transparent); box-shadow: 0 0 20px rgba(34,211,238,0.15); }
        .stat-card.cyan .corner { border-color: #22d3ee; }
        .stat-card.orange { border-color: rgba(251,146,60,0.4); background: linear-gradient(135deg, rgba(251,146,60,0.08), transparent); box-shadow: 0 0 20px rgba(251,146,60,0.15); }
        .stat-card.orange .corner { border-color: #fb923c; }

        .stat-label {
            font-size: 9px;
            letter-spacing: 0.25em;
            margin-bottom: 8px;
            opacity: 0.8;
        }
        .stat-value {
            color: #fff;
            font-family: 'Orbitron', sans-serif;
            font-size: 32px;
            font-weight: 700;
            line-height: 1;
        }
        .stat-sub {
            font-size: 10px;
            margin-top: 6px;
            opacity: 0.7;
            letter-spacing: 0.1em;
        }
        .purple .stat-label, .purple .stat-sub { color: #a78bfa; }
        .pink .stat-label, .pink .stat-sub { color: #f472b6; }
        .cyan .stat-label, .cyan .stat-sub { color: #22d3ee; }
        .orange .stat-label, .orange .stat-sub { color: #fb923c; }
        .purple .stat-value { text-shadow: 0 0 12px rgba(167,139,250,0.6); }
        .pink .stat-value { text-shadow: 0 0 12px rgba(244,114,182,0.6); }
        .cyan .stat-value { text-shadow: 0 0 12px rgba(34,211,238,0.6); }
        .orange .stat-value { text-shadow: 0 0 12px rgba(251,146,60,0.6); }

        /* Panels */
        .panel {
            border: 1px solid rgba(167,139,250,0.3);
            background: rgba(10,10,20,0.6);
            box-shadow: 0 0 20px rgba(167,139,250,0.1);
            margin-bottom: 20px;
        }
        .panel-header {
            padding: 14px 18px;
            border-bottom: 1px solid rgba(167,139,250,0.2);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .panel-title {
            color: #a78bfa;
            font-size: 11px;
            letter-spacing: 0.25em;
            font-weight: bold;
        }
        .panel-meta {
            font-size: 10px;
            letter-spacing: 0.15em;
        }

        .chart-wrap { padding: 18px; }
        .chart-axis {
            display: flex;
            justify-content: space-between;
            margin-top: 8px;
            color: rgba(167,139,250,0.5);
            font-size: 10px;
            letter-spacing: 0.1em;
        }

        .footer {
            text-align: center;
            color: rgba(167,139,250,0.4);
            font-size: 10px;
            margin-top: 24px;
            letter-spacing: 0.3em;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">
                <div class="logo-icon"><span>❄</span></div>
                <div>
                    <div class="logo-title">ROCKSNOW</div>
                    <div class="logo-sub">// online_monitor.exe</div>
                </div>
            </div>
            <div class="live-badge">
                <div class="live-dot"></div>
                <span class="live-text">● LIVE</span>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card purple">
                <div class="corner corner-tl"></div>
                <div class="corner corner-br"></div>
                <div class="stat-label">[ ONLINE ]</div>
                <div class="stat-value">${players.length}</div>
                ${trendEl}
            </div>
            <div class="stat-card pink">
                <div class="corner corner-tl"></div>
                <div class="corner corner-br"></div>
                <div class="stat-label">[ RECORD ]</div>
                <div class="stat-value">${stats.record.count}</div>
                <div class="stat-sub">${formatDate(stats.record.timestamp)}</div>
            </div>
            <div class="stat-card cyan">
                <div class="corner corner-tl"></div>
                <div class="corner corner-br"></div>
                <div class="stat-label">[ AVG_24H ]</div>
                <div class="stat-value">${s.last24h}</div>
                <div class="stat-sub">PER 24 HOURS</div>
            </div>
            <div class="stat-card orange">
                <div class="corner corner-tl"></div>
                <div class="corner corner-br"></div>
                <div class="stat-label">[ AVG_ALL ]</div>
                <div class="stat-value">${s.allTime}</div>
                <div class="stat-sub">${stats.totalSamples} SAMPLES</div>
            </div>
        </div>

        <div class="panel">
            <div class="panel-header">
                <div class="panel-title">>> TRAFFIC_24H.LOG</div>
                <div class="panel-meta" style="color:#f472b6;text-shadow:0 0 6px rgba(244,114,182,0.5);">
                    PEAK :: ${s.peak24h.count} @ ${peakTime}
                </div>
            </div>
            <div class="chart-wrap">
                ${buildSparkline(s.recent)}
            </div>
        </div>

        <div class="panel">
            <div class="panel-header">
                <div class="panel-title">>> PLAYERS.DAT</div>
                <div class="panel-meta" style="color:#4ade80;text-shadow:0 0 6px rgba(74,222,128,0.5);">
                    [ ${players.length} ACTIVE ]
                </div>
            </div>
            <div style="padding: 4px 8px;">
                ${playerRows || emptyState}
            </div>
        </div>

        <div class="footer">>> AUTO_REFRESH :: 5_SEC</div>
    </div>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));
