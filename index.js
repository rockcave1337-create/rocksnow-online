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

function initials(name) {
    return name.slice(0, 2).toUpperCase();
}

function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-US', {
        timeZone: 'Asia/Almaty',
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    });
}

function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleString('en-US', {
        timeZone: 'Asia/Almaty',
        hour: '2-digit', minute: '2-digit', hour12: false
    });
}

function trendText(trend) {
    if (trend > 0) return `+${trend} in the last hour`;
    if (trend < 0) return `${trend} in the last hour`;
    return 'Steady activity';
}

function buildSparkline(samples) {
    if (samples.length < 2) {
        return `<div style="color:rgba(255,255,255,0.2);font-size:12px;text-align:center;padding:30px 0;font-weight:300;letter-spacing:0.05em;">
                    Collecting data
                </div>`;
    }

    const W = 600, H = 100;
    const max = Math.max(...samples.map(s => s.count), 1);

    const points = samples.map((s, i) => {
        const x = (i / (samples.length - 1)) * W;
        const y = H - 15 - (s.count / max) * (H - 30);
        return [x, y];
    });

    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

    const peakIdx = samples.reduce((maxI, s, i) => s.count > samples[maxI].count ? i : maxI, 0);
    const peakPt = points[peakIdx];

    return `
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;">
            <path d="${linePath}" stroke="rgba(255,255,255,0.5)" stroke-width="1" fill="none" stroke-linejoin="round"/>
            <circle cx="${peakPt[0].toFixed(1)}" cy="${peakPt[1].toFixed(1)}" r="6" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
            <circle cx="${peakPt[0].toFixed(1)}" cy="${peakPt[1].toFixed(1)}" r="3" fill="#fff"/>
        </svg>
    `;
}

app.get('/', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.values());
    const s = getStats();

    const playerRows = players.map((p, i) => {
        const isLast = i === players.length - 1;
        return `
            <div class="player-row" style="${isLast ? '' : 'border-bottom: 1px solid rgba(255,255,255,0.05);'}">
                <div class="player-info">
                    <div class="player-avatar">${initials(p.name)}</div>
                    <div>
                        <div class="player-name">${p.name}</div>
                        <div class="player-uuid">${p.uuid.slice(0, 8)}...</div>
                    </div>
                </div>
                <div class="player-status"></div>
            </div>
        `;
    }).join('');

    const emptyState = `
        <div style="text-align:center;padding:40px 0;color:rgba(255,255,255,0.3);font-size:13px;font-weight:300;">
            No players online
        </div>
    `;

    const peakLabel = s.peak24h.count > 0
        ? `Peak ${s.peak24h.count} at ${formatTime(s.peak24h.t)}`
        : 'Awaiting first peak';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Rocksnow</title>
    <meta http-equiv="refresh" content="5">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { background: #000; }
        body {
            color: #fff;
            font-family: 'Inter', -apple-system, sans-serif;
            min-height: 100vh;
            -webkit-font-smoothing: antialiased;
            position: relative;
            overflow-x: hidden;
        }

        .ambient {
            position: fixed;
            inset: 0;
            pointer-events: none;
            z-index: 0;
        }

        .container {
            max-width: 720px;
            margin: 0 auto;
            padding: 40px 32px 60px;
            position: relative;
            z-index: 1;
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
        .logo-icon { display: flex; align-items: center; justify-content: center; }
        .logo-name {
            color: #fff;
            font-size: 14px;
            font-weight: 400;
            letter-spacing: 0.02em;
        }
        .live-badge {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 14px;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 100px;
        }
        .live-dot {
            width: 6px; height: 6px;
            border-radius: 50%;
            background: #4ade80;
            animation: livePulse 2s ease-in-out infinite;
        }
        @keyframes livePulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .live-text {
            color: rgba(255,255,255,0.7);
            font-size: 12px;
            font-weight: 400;
        }

        .hero {
            text-align: center;
            margin: 80px 0 100px;
        }
        .hero-label {
            color: rgba(255,255,255,0.4);
            font-size: 13px;
            letter-spacing: 0.15em;
            text-transform: uppercase;
            margin-bottom: 24px;
            font-weight: 300;
        }
        .hero-value {
            color: #fff;
            font-size: 120px;
            font-weight: 200;
            line-height: 1;
            letter-spacing: -0.04em;
        }
        @media (max-width: 600px) {
            .hero-value { font-size: 88px; }
        }
        .hero-sub {
            color: rgba(255,255,255,0.4);
            font-size: 14px;
            margin-top: 24px;
            font-weight: 300;
        }

        .stats-row {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 1px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 8px;
            overflow: hidden;
            margin-bottom: 56px;
        }
        @media (max-width: 600px) {
            .stats-row { grid-template-columns: 1fr; }
        }
        .stat-cell {
            background: #000;
            padding: 28px 24px;
        }
        .stat-label {
            color: rgba(255,255,255,0.4);
            font-size: 11px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            margin-bottom: 14px;
            font-weight: 300;
        }
        .stat-value {
            color: #fff;
            font-size: 36px;
            font-weight: 200;
            line-height: 1;
            letter-spacing: -0.02em;
        }
        .stat-sub {
            color: rgba(255,255,255,0.3);
            font-size: 11px;
            margin-top: 10px;
            font-weight: 300;
        }

        .chart-section {
            margin-bottom: 48px;
        }
        .section-head {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 24px;
        }
        .section-label {
            color: rgba(255,255,255,0.6);
            font-size: 12px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            font-weight: 300;
        }
        .section-meta {
            color: rgba(255,255,255,0.3);
            font-size: 11px;
            font-weight: 300;
        }

        .players-section {
            border-top: 1px solid rgba(255,255,255,0.08);
            padding-top: 32px;
        }
        .player-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 0;
            transition: padding-left 0.2s;
        }
        .player-row:hover { padding-left: 8px; }
        .player-info {
            display: flex;
            align-items: center;
            gap: 14px;
        }
        .player-avatar {
            width: 32px; height: 32px;
            border-radius: 50%;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            display: flex;
            align-items: center;
            justify-content: center;
            color: rgba(255,255,255,0.7);
            font-size: 11px;
            font-weight: 400;
        }
        .player-name {
            color: #fff;
            font-size: 14px;
            font-weight: 400;
        }
        .player-uuid {
            color: rgba(255,255,255,0.3);
            font-size: 11px;
            font-family: 'SF Mono', Menlo, monospace;
            margin-top: 2px;
        }
        .player-status {
            width: 5px; height: 5px;
            border-radius: 50%;
            background: #4ade80;
        }

        .footer {
            text-align: center;
            color: rgba(255,255,255,0.2);
            font-size: 11px;
            margin-top: 48px;
            font-weight: 300;
            letter-spacing: 0.05em;
        }
    </style>
</head>
<body>

    <svg class="ambient" viewBox="0 0 1400 900" preserveAspectRatio="xMidYMid slice">
        <defs>
            <radialGradient id="ambientGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#ffffff" stop-opacity="0.08"/>
                <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
            </radialGradient>
        </defs>
        <ellipse cx="1100" cy="200" rx="500" ry="350" fill="url(#ambientGlow)"/>
        <path d="M -100,300 Q 700,80 1500,400" stroke="rgba(255,255,255,0.08)" stroke-width="0.5" fill="none"/>
        <path d="M -100,400 Q 700,180 1500,500" stroke="rgba(255,255,255,0.06)" stroke-width="0.5" fill="none"/>
        <path d="M -100,500 Q 700,280 1500,600" stroke="rgba(255,255,255,0.04)" stroke-width="0.5" fill="none"/>
        <path d="M -100,250 Q 700,30 1500,350" stroke="rgba(255,255,255,0.03)" stroke-width="0.5" fill="none"/>
    </svg>

    <div class="container">

        <div class="header">
            <div class="logo">
                <div class="logo-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                        <path d="M12 2 L14 9 L21 9 L15.5 13.5 L17.5 21 L12 16.5 L6.5 21 L8.5 13.5 L3 9 L10 9 Z" stroke="#fff" stroke-width="1" fill="none"/>
                    </svg>
                </div>
                <span class="logo-name">Rocksnow</span>
            </div>
            <div class="live-badge">
                <div class="live-dot"></div>
                <span class="live-text">Live</span>
            </div>
        </div>

        <div class="hero">
            <div class="hero-label">Players online</div>
            <div class="hero-value">${players.length}</div>
            <div class="hero-sub">${trendText(s.trend)}</div>
        </div>

        <div class="stats-row">
            <div class="stat-cell">
                <div class="stat-label">Record</div>
                <div class="stat-value">${stats.record.count}</div>
                <div class="stat-sub">${formatDate(stats.record.timestamp)}</div>
            </div>
            <div class="stat-cell">
                <div class="stat-label">24h average</div>
                <div class="stat-value">${s.last24h}</div>
                <div class="stat-sub">Last 24 hours</div>
            </div>
            <div class="stat-cell">
                <div class="stat-label">All time</div>
                <div class="stat-value">${s.allTime}</div>
                <div class="stat-sub">${stats.totalSamples.toLocaleString('en-US')} samples</div>
            </div>
        </div>

        <div class="chart-section">
            <div class="section-head">
                <div class="section-label">Activity / 24h</div>
                <div class="section-meta">${peakLabel}</div>
            </div>
            ${buildSparkline(s.recent)}
        </div>

        <div class="players-section">
            <div class="section-head">
                <div class="section-label">Players</div>
                <div class="section-meta">${players.length} online</div>
            </div>
            ${playerRows || emptyState}
        </div>

        <div class="footer">Auto-refresh every 5 seconds</div>

    </div>
</body>
</html>`);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));
