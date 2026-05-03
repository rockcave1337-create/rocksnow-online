const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const onlinePlayers = new Map();
const TIMEOUT_MS = 15000;

// ---------- Статистика ----------
const STATS_FILE = path.join(__dirname, 'stats.json');
const SAMPLE_INTERVAL_MS = 60_000; // снимаем замер раз в минуту

let stats = {
    record: { count: 0, timestamp: null }, // пик онлайна
    samples: [],                            // [{ t, count }] — для среднего
    totalSamples: 0,                        // для скользящего среднего без хранения всей истории
    sumSamples: 0
};

// Загружаем из файла, если есть
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

// Раз в минуту фиксируем текущий онлайн в статистику
setInterval(() => {
    cleanupOffline();
    const count = onlinePlayers.size;

    stats.totalSamples += 1;
    stats.sumSamples += count;

    // Храним последние 1440 замеров (≈ сутки) для среднего за 24ч
    stats.samples.push({ t: Date.now(), count });
    if (stats.samples.length > 1440) stats.samples.shift();

    updateRecord(count);
    saveStats();
}, SAMPLE_INTERVAL_MS);

function getAverages() {
    const allTime = stats.totalSamples > 0
        ? stats.sumSamples / stats.totalSamples
        : 0;

    const dayCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = stats.samples.filter(s => s.t >= dayCutoff);
    const last24h = recent.length > 0
        ? recent.reduce((sum, s) => sum + s.count, 0) / recent.length
        : 0;

    return {
        allTime: allTime.toFixed(2),
        last24h: last24h.toFixed(2)
    };
}

// ---------- Эндпоинты ----------
app.post('/ping', (req, res) => {
    const { uuid, name } = req.body;
    if (!uuid || !name) return res.status(400).json({ error: 'missing fields' });
    onlinePlayers.set(uuid, { name, lastSeen: Date.now() });

    // Обновляем рекорд сразу при пинге, не дожидаясь интервала
    updateRecord(onlinePlayers.size);

    res.json({ ok: true });
});

app.get('/online', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.entries()).map(([uuid, data]) => ({
        uuid, name: data.name
    }));
    res.json({
        players,
        stats: {
            current: players.length,
            record: stats.record,
            average: getAverages()
        }
    });
});

// ---------- Страничка ----------
app.get('/', (req, res) => {
    cleanupOffline();
    const players = Array.from(onlinePlayers.values());
    const averages = getAverages();
    const recordDate = stats.record.timestamp
        ? new Date(stats.record.timestamp).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })
        : '—';

    const rows = players.map(p =>
        `<tr><td>${p.name}</td><td>${p.uuid}</td></tr>`
    ).join('');

    res.send(`
        <html>
        <head>
            <title>Rocksnow Online</title>
            <meta http-equiv="refresh" content="5">
            <style>
                body { background: #1a1a2e; color: #eee; font-family: monospace; padding: 20px; }
                h1 { color: #a78bfa; }
                table { border-collapse: collapse; width: 100%; margin-top: 10px; }
                th, td { padding: 8px 16px; border: 1px solid #333; text-align: left; }
                th { background: #2d2d44; color: #a78bfa; }
                tr:hover { background: #2d2d44; }
                .count { font-size: 24px; color: #4ade80; margin-bottom: 20px; }
                .stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
                .card {
                    background: #2d2d44; padding: 12px 20px; border-radius: 8px;
                    border-left: 3px solid #a78bfa; min-width: 180px;
                }
                .card .label { color: #888; font-size: 12px; text-transform: uppercase; }
                .card .value { font-size: 22px; color: #fff; margin-top: 4px; }
                .card .sub { font-size: 11px; color: #666; margin-top: 4px; }
            </style>
        </head>
        <body>
            <h1>🎮 Rocksnow — Онлайн</h1>
            <div class="count">Игроков с клиентом: ${players.length}</div>

            <div class="stats">
                <div class="card">
                    <div class="label">Рекорд</div>
                    <div class="value">${stats.record.count}</div>
                    <div class="sub">${recordDate}</div>
                </div>
                <div class="card">
                    <div class="label">Средний (24ч)</div>
                    <div class="value">${averages.last24h}</div>
                    <div class="sub">за последние сутки</div>
                </div>
                <div class="card">
                    <div class="label">Средний (всё время)</div>
                    <div class="value">${averages.allTime}</div>
                    <div class="sub">${stats.totalSamples} замеров</div>
                </div>
            </div>

            <table>
                <tr><th>Ник</th><th>UUID</th></tr>
                ${rows || '<tr><td colspan="2">Никого нет онлайн</td></tr>'}
            </table>
            <p style="color:#666">Обновляется каждые 5 сек · замер раз в минуту</p>
        </body>
        </html>
    `);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));
