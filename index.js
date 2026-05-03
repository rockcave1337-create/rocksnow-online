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

    // Пик за 24ч
    const peak24h = recent.length > 0
        ? recent.reduce((max, s) => s.count > max.count ? s : max, recent[0])
        : { count: 0, t: null };

    // Тренд за час (для стрелочки)
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

// ---------- API ----------
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

// ---------- Утилиты для шаблона ----------
function avatarGradient(name) {
    // Стабильный цвет из имени
    const palettes = [
        ['#a78bfa', '#7c3aed'],
        ['#f472b6', '#db2777'],
        ['#4ade80', '#16a34a'],
        ['#60a5fa', '#2563eb'],
        ['#fb923c', '#ea580c'],
        ['#22d3ee', '#0891b2'],
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const [a, b] = palettes[Math.abs(hash) % palettes.length];
    return `linear-gradient(135deg, ${a}, ${b})`;
}

function initials(name) {
    return name.slice(0, 2).toUpperCase();
}

function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('ru-RU', {
        timeZone: 'Asia/Almaty',
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });
}

function buildSparkline(samples) {
    if (samples.length < 2) {
        return `<div style="color:#6b7280;font-size:12px;text-align:center;padding:30px 0;">
                    Накапливаем данные…
                </div>`;
    }

    const W = 600, H = 140;
    const max = Math.max(...samples.map(s => s.count), 1);
    const min = 0;

    const points = samples.map((s, i) => {
        const x = (i / (samples.length - 1)) * W;
        const y = H - 20 - ((s.count - min) / (max - min || 1)) * (H - 40);
        return [x, y];
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${W},${H} L 0,${H} Z`;

    // Точка пика
    const peakIdx = samples.reduce((maxI, s, i) => s.count > samples[maxI].count ? i : maxI, 0);
    const peakPt = points[peakIdx];

    return `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">
            <defs>
                <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <line x1="0" y1="35" x2="${W}" y2="35" stroke="#1f1f2e" stroke-width="1"/>
            <line x1="0" y1="70" x2="${W}" y2="70" stroke="#1f1f2e" stroke-width="1"/>
            <line x1="0" y1="105" x2="${W}" y2="105" stroke="#1f1f2e" stroke-width="1"/>
            <path d="${areaPath}" fill="url(#area)"/>
            <path d="${linePath}" stroke="#a78bfa" stroke-width="2" fill="none" stroke-linejoin="round"/>
            <circle cx="${peakPt[0].toFixed(1)}" cy="${peakPt[1].toFixed(1)}" r="8" fill="#a78bfa" opacity="0.3"/>
            <circle cx="${peakPt[0].toFixed(1)}" cy="${peakPt[1].toFixed(1)}" r="4" fill="#a78bfa"/>
        </svg>
    `;
}

// ---------- Страничка ----------
app.get('/', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.values());
    const s = getStats();

    const trendEl = s.trend > 0
        ? `<div style="color:#4ade80;font-size:11px;margin-top:6px;">↑ ${s.trend} за час</div>`
        : s.trend < 0
            ? `<div style="color:#f87171;font-size:11px;margin-top:6px;">↓ ${Math.abs(s.trend)} за час</div>`
            : `<div style="color:#6b7280;font-size:11px;margin-top:6px;">— стабильно</div>`;

    const playerRows = players.map(p => `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:8px;transition:background 0.15s;"
             onmouseover="this.style.background='rgba(167,139,250,0.05)'"
             onmouseout="this.style.background='transparent'">
            <div style="width:32px;height:32px;border-radius:8px;background:${avatarGradient(p.name)};display:flex;align-items:center;justify-content:center;color:#fff;font-size:13px;font-weight:500;flex-shrink:0;">
                ${initials(p.name)}
            </div>
            <div style="flex:1;min-width:0;">
                <div style="color:#fff;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.name}</div>
                <div style="color:#6b7280;font-size:11px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.uuid}</div>
            </div>
            <div style="width:6px;height:6px;border-radius:50%;background:#4ade80;flex-shrink:0;"></div>
        </div>
    `).join('');

    const emptyState = `
        <div style="text-align:center;padding:40px 20px;color:#6b7280;font-size:13px;">
            Сейчас никого нет онлайн
        </div>
    `;

    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rocksnow Online</title>
    <meta http-equiv="refresh" content="5">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: #0a0a14;
            color: #fff;
            font-family: 'Inter', -apple-system, sans-serif;
            min-height: 100vh;
            padding: 24px 16px;
            -webkit-font-smoothing: antialiased;
        }
        .container { max-width: 720px; margin: 0 auto; }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 28px;
        }
        .logo {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .logo-icon {
            width: 40px; height: 40px;
            border-radius: 10px;
            background: linear-gradient(135deg, #a78bfa, #7c3aed);
            display: flex; align-items: center; justify-content: center;
            font-size: 20px;
        }
        .logo-title { font-size: 18px; font-weight: 500; letter-spacing: -0.01em; }
        .logo-sub { color: #6b7280; font-size: 12px; }
        .live-badge {
            display: flex; align-items: center; gap: 8px;
            padding: 6px 12px;
            background: rgba(74, 222, 128, 0.1);
            border: 0.5px solid rgba(74, 222, 128, 0.3);
            border-radius: 999px;
        }
        .live-dot {
            width: 6px; height: 6px;
            border-radius: 50%;
            background: #4ade80;
            animation: pulse 2s ease-in-out infinite;
        }
        .live-text { color: #4ade80; font-size: 12px; font-weight: 500; }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 12px;
            margin-bottom: 24px;
        }
        @media (max-width: 600px) {
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
        }
        .stat-card {
            background: #14141f;
            border: 0.5px solid rgba(167, 139, 250, 0.15);
            border-radius: 12px;
            padding: 16px;
            transition: border-color 0.2s;
        }
        .stat-card:hover { border-color: rgba(167, 139, 250, 0.4); }
        .stat-label {
            color: #6b7280;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 8px;
        }
        .stat-value {
            color: #fff;
            font-size: 28px;
            font-weight: 500;
            line-height: 1;
        }
        .stat-sub {
            color: #6b7280;
            font-size: 11px;
            margin-top: 6px;
        }

        .panel {
            background: #14141f;
            border: 0.5px solid rgba(167, 139, 250, 0.15);
            border-radius: 12px;
            margin-bottom: 24px;
            overflow: hidden;
        }
        .panel-header {
            padding: 16px 20px;
            border-bottom: 0.5px solid rgba(167, 139, 250, 0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .panel-title { font-size: 14px; font-weight: 500; }
        .panel-meta { color: #6b7280; font-size: 12px; }

        .chart-wrap { padding: 20px; }
        .chart-axis {
            display: flex;
            justify-content: space-between;
            margin-top: 8px;
            color: #6b7280;
            font-size: 11px;
        }

        .footer {
            text-align: center;
            color: #6b7280;
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
                    <div class="logo-title">Rocksnow</div>
                    <div class="logo-sub">Online dashboard</div>
                </div>
            </div>
            <div class="live-badge">
                <div class="live-dot"></div>
                <span class="live-text">Live</span>
            </div>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Сейчас</div>
                <div class="stat-value">${players.length}</div>
                ${trendEl}
            </div>
            <div class="stat-card">
                <div class="stat-label">Рекорд</div>
                <div class="stat-value">${stats.record.count}</div>
                <div class="stat-sub">${formatDate(stats.record.timestamp)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Средний 24ч</div>
                <div class="stat-value">${s.last24h}</div>
                <div class="stat-sub">за сутки</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Всё время</div>
                <div class="stat-value">${s.allTime}</div>
                <div class="stat-sub">${stats.totalSamples} замеров</div>
            </div>
        </div>

        <div class="panel">
            <div class="panel-header">
                <div class="panel-title">Онлайн за 24 часа</div>
                <div class="panel-meta">Пик: ${s.peak24h.count} ${s.peak24h.t ? 'в ' + formatDate(s.peak24h.t).split(', ')[1] : ''}</div>
            </div>
            <div class="chart-wrap">
                ${buildSparkline(s.recent)}
            </div>
        </div>

        <div class="panel">
            <div class="panel-header">
                <div class="panel-title">Игроки онлайн</div>
                <div class="panel-meta">${players.length} активных</div>
            </div>
            <div style="padding: 4px 8px;">
                ${playerRows || emptyState}
            </div>
        </div>

        <div class="footer">Обновляется каждые 5 секунд</div>
    </div>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));
