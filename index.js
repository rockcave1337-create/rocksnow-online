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

    const hourCutoff = Date.now() - 60 * 60 * 1000;
    const lastHour = stats.samples.filter(s => s.t >= hourCutoff);
    const hourAvg = lastHour.length > 0
        ? lastHour.reduce((sum, s) => sum + s.count, 0) / lastHour.length : 0;
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
        uuid, name: data.name, lastSeen: data.lastSeen
    }));
    res.json({ players, stats: { ...getStats(), record: stats.record } });
});

const AVATAR_PALETTES = [
    { bg: '#ede9fe', fg: '#6d28d9' },
    { bg: '#fce7f3', fg: '#be185d' },
    { bg: '#dcfce7', fg: '#15803d' },
    { bg: '#dbeafe', fg: '#1d4ed8' },
    { bg: '#fed7aa', fg: '#c2410c' },
    { bg: '#cffafe', fg: '#0e7490' },
    { bg: '#fef3c7', fg: '#a16207' },
    { bg: '#fee2e2', fg: '#b91c1c' },
];

function avatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length];
}

function initials(name) {
    return name.slice(0, 2).toUpperCase();
}

function formatDate(ts, withTime = true) {
    if (!ts) return '—';
    const d = new Date(ts);
    const dateStr = d.toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        day: 'numeric', month: 'short'
    });
    if (!withTime) return dateStr;
    const timeStr = d.toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        hour: '2-digit', minute: '2-digit'
    });
    return { date: dateStr, time: timeStr };
}

function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        hour: '2-digit', minute: '2-digit'
    });
}

function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return 'только что';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} мин назад`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} ч назад`;
    return formatDate(ts, false);
}

function buildSparkline(samples) {
    if (samples.length < 2) {
        return `<div style="color:#a8a29e;font-size:12px;text-align:center;padding:24px 0;">
                    Накапливаем данные за сутки
                </div>`;
    }

    const W = 400, H = 80;
    const max = Math.max(...samples.map(s => s.count), 1);

    const points = samples.map((s, i) => {
        const x = (i / (samples.length - 1)) * W;
        const y = H - 8 - (s.count / max) * (H - 16);
        return [x, y];
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${W},${H} L 0,${H} Z`;

    const peakIdx = samples.reduce((maxI, s, i) => s.count > samples[maxI].count ? i : maxI, 0);
    const peakPt = points[peakIdx];

    return `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:60px;display:block;">
            <defs>
                <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#7c3aed" stop-opacity="0.15"/>
                    <stop offset="100%" stop-color="#7c3aed" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <path d="${areaPath}" fill="url(#area)"/>
            <path d="${linePath}" stroke="#7c3aed" stroke-width="2" fill="none" stroke-linejoin="round"/>
            <circle cx="${peakPt[0].toFixed(1)}" cy="${peakPt[1].toFixed(1)}" r="3" fill="#7c3aed"/>
        </svg>
    `;
}

app.get('/', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.entries())
        .map(([uuid, data]) => ({ uuid, name: data.name, lastSeen: data.lastSeen }))
        .sort((a, b) => b.lastSeen - a.lastSeen);

    const s = getStats();
    const recordDate = formatDate(stats.record.timestamp);

    const trendBadge = s.trend > 0
        ? `<div class="trend-badge trend-up">↑ +${s.trend} за час</div>`
        : s.trend < 0
            ? `<div class="trend-badge trend-down">↓ ${s.trend} за час</div>`
            : `<div class="trend-badge trend-flat">— стабильно</div>`;

    const playerRows = players.map((p, i) => {
        const c = avatarColor(p.name);
        const isActive = (Date.now() - p.lastSeen) < 30000;
        const statusEl = isActive
            ? `<div class="status-online"><div class="status-dot"></div>в сети</div>`
            : `<div class="status-recent">${timeAgo(p.lastSeen)}</div>`;
        return `
            <div class="player-row ${i === players.length - 1 ? 'last' : ''}">
                <div class="avatar" style="background:${c.bg};color:${c.fg};">${initials(p.name)}</div>
                <div class="player-info">
                    <div class="player-name">${p.name}</div>
                    <div class="player-uuid">${p.uuid}</div>
                </div>
                ${statusEl}
            </div>
        `;
    }).join('');

    const emptyState = `
        <div style="text-align:center;padding:48px 20px;color:#a8a29e;font-size:14px;">
            Сейчас никого нет онлайн
        </div>
    `;

    const peakInfo = s.peak24h.count > 0
        ? `пик ${s.peak24h.count}<br>в ${formatTime(s.peak24h.t)}`
        : 'нет<br>данных';

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rocksnow</title>
    <meta http-equiv="refresh" content="5">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: #fafaf9; }
        body {
            color: #1c1917;
            font-family: 'Inter', -apple-system, sans-serif;
            min-height: 100vh;
            -webkit-font-smoothing: antialiased;
            padding: 32px 20px;
        }
        .container { max-width: 920px; margin: 0 auto; }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 24px;
            padding-bottom: 20px;
            border-bottom: 1px solid #e7e5e4;
        }
        .logo { display: flex; align-items: center; gap: 12px; }
        .logo-icon {
            width: 36px; height: 36px;
            background: #7c3aed;
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #fff;
            font-size: 18px;
        }
        .logo-name {
            color: #1c1917;
            font-size: 16px;
            font-weight: 600;
            line-height: 1.2;
        }
        .logo-sub {
            color: #78716c;
            font-size: 12px;
            margin-top: 1px;
        }
        .live-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 14px;
            background: #f0fdf4;
            border: 1px solid #bbf7d0;
            border-radius: 100px;
        }
        .live-dot {
            width: 6px; height: 6px;
            border-radius: 50%;
            background: #22c55e;
            animation: livePulse 2s ease-in-out infinite;
        }
        @keyframes livePulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }
        .live-text {
            color: #15803d;
            font-size: 12px;
            font-weight: 500;
        }

        .top-grid {
            display: grid;
            grid-template-columns: 1.3fr 1fr;
            gap: 16px;
            margin-bottom: 16px;
        }
        @media (max-width: 700px) {
            .top-grid { grid-template-columns: 1fr; }
        }

        .card {
            background: #fff;
            border: 1px solid #e7e5e4;
            border-radius: 12px;
        }

        .main-card { padding: 24px; }
        .main-label {
            color: #78716c;
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 10px;
        }
        .main-value-row {
            display: flex;
            align-items: baseline;
            gap: 12px;
            margin-bottom: 18px;
            flex-wrap: wrap;
        }
        .main-value {
            color: #1c1917;
            font-size: 56px;
            font-weight: 600;
            line-height: 1;
            letter-spacing: -0.03em;
        }
        @media (max-width: 600px) {
            .main-value { font-size: 44px; }
        }
        .trend-badge {
            font-size: 13px;
            font-weight: 500;
            padding: 4px 10px;
            border-radius: 6px;
        }
        .trend-up { color: #15803d; background: #f0fdf4; }
        .trend-down { color: #b91c1c; background: #fef2f2; }
        .trend-flat { color: #78716c; background: #f5f5f4; }

        .chart-axis {
            display: flex;
            justify-content: space-between;
            margin-top: 6px;
            color: #a8a29e;
            font-size: 11px;
        }

        .side-stats {
            display: grid;
            grid-template-rows: 1fr 1fr 1fr;
            gap: 12px;
        }
        .stat-card {
            background: #fff;
            border: 1px solid #e7e5e4;
            border-radius: 12px;
            padding: 14px 18px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }
        .stat-label {
            color: #78716c;
            font-size: 12px;
            font-weight: 500;
            margin-bottom: 4px;
        }
        .stat-value {
            color: #1c1917;
            font-size: 22px;
            font-weight: 600;
            letter-spacing: -0.02em;
            line-height: 1.1;
        }
        .stat-meta {
            color: #a8a29e;
            font-size: 11px;
            text-align: right;
            line-height: 1.3;
        }

        .players-card {
            overflow: hidden;
        }
        .players-header {
            padding: 16px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #f5f5f4;
        }
        .players-title {
            color: #1c1917;
            font-size: 14px;
            font-weight: 600;
        }
        .players-count {
            color: #78716c;
            font-size: 12px;
        }

        .player-row {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 12px 20px;
            border-bottom: 1px solid #f5f5f4;
            transition: background 0.15s;
        }
        .player-row:hover { background: #fafaf9; }
        .player-row.last { border-bottom: none; }

        .avatar {
            width: 36px; height: 36px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 13px;
            font-weight: 600;
            flex-shrink: 0;
        }
        .player-info { flex: 1; min-width: 0; }
        .player-name {
            color: #1c1917;
            font-size: 14px;
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .player-uuid {
            color: #a8a29e;
            font-size: 11px;
            font-family: 'SF Mono', Menlo, monospace;
            margin-top: 2px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .status-online {
            display: flex;
            align-items: center;
            gap: 6px;
            color: #15803d;
            font-size: 12px;
            font-weight: 500;
            flex-shrink: 0;
        }
        .status-dot {
            width: 6px; height: 6px;
            border-radius: 50%;
            background: #22c55e;
        }
        .status-recent {
            color: #78716c;
            font-size: 12px;
            flex-shrink: 0;
        }

        .footer {
            text-align: center;
            color: #a8a29e;
            font-size: 11px;
            margin-top: 24px;
        }
    </style>
</head>
<body>
    <div class="container">

        <div class="header">
            <div class="logo">
                <div class="logo-icon">❄</div>
                <div>
                    <div class="logo-name">Rocksnow</div>
                    <div class="logo-sub">Online dashboard</div>
                </div>
            </div>
            <div class="live-badge">
                <div class="live-dot"></div>
                <span class="live-text">Обновляется автоматически</span>
            </div>
        </div>

        <div class="top-grid">
            <div class="card main-card">
                <div class="main-label">Сейчас онлайн</div>
                <div class="main-value-row">
                    <div class="main-value">${players.length}</div>
                    ${trendBadge}
                </div>
                ${buildSparkline(s.recent)}
                <div class="chart-axis">
                    <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>сейчас</span>
                </div>
            </div>

            <div class="side-stats">
                <div class="stat-card">
                    <div>
                        <div class="stat-label">Рекорд</div>
                        <div class="stat-value">${stats.record.count}</div>
                    </div>
                    <div class="stat-meta">${typeof recordDate === 'object' ? recordDate.date + '<br>' + recordDate.time : recordDate}</div>
                </div>
                <div class="stat-card">
                    <div>
                        <div class="stat-label">Среднее за 24ч</div>
                        <div class="stat-value">${s.last24h}</div>
                    </div>
                    <div class="stat-meta">${peakInfo}</div>
                </div>
                <div class="stat-card">
                    <div>
                        <div class="stat-label">Всё время</div>
                        <div class="stat-value">${s.allTime}</div>
                    </div>
                    <div class="stat-meta">${stats.totalSamples.toLocaleString('ru-RU')}<br>замеров</div>
                </div>
            </div>
        </div>

        <div class="card players-card">
            <div class="players-header">
                <div class="players-title">Игроки онлайн</div>
                <div class="players-count">${players.length} ${players.length === 1 ? 'активный' : 'активных'}</div>
            </div>
            ${playerRows || emptyState}
        </div>

        <div class="footer">Обновляется каждые 5 секунд</div>

    </div>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));
