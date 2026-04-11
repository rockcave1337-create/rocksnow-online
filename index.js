const express = require('express');
const app = express();
app.use(express.json());

const onlinePlayers = new Map();
const TIMEOUT_MS = 15000;

app.post('/ping', (req, res) => {
    const { uuid, name } = req.body;
    if (!uuid || !name) return res.status(400).json({ error: 'missing fields' });
    onlinePlayers.set(uuid, { name, lastSeen: Date.now() });
    res.json({ ok: true });
});

app.get('/online', (req, res) => {
    const now = Date.now();
    for (const [uuid, data] of onlinePlayers.entries()) {
        if (now - data.lastSeen > TIMEOUT_MS) onlinePlayers.delete(uuid);
    }
    const players = Array.from(onlinePlayers.entries()).map(([uuid, data]) => ({
        uuid, name: data.name
    }));
    res.json({ players });
});

// Красивая страничка
app.get('/', (req, res) => {
    const now = Date.now();
    for (const [uuid, data] of onlinePlayers.entries()) {
        if (now - data.lastSeen > TIMEOUT_MS) onlinePlayers.delete(uuid);
    }
    const players = Array.from(onlinePlayers.values());
    
    const rows = players.map(p => `<tr><td>${p.name}</td><td>${p.uuid}</td></tr>`).join('');
    
    res.send(`
        <html>
        <head>
            <title>Rocksnow Online</title>
            <meta http-equiv="refresh" content="5">
            <style>
                body { background: #1a1a2e; color: #eee; font-family: monospace; padding: 20px; }
                h1 { color: #a78bfa; }
                table { border-collapse: collapse; width: 100%; }
                th, td { padding: 8px 16px; border: 1px solid #333; text-align: left; }
                th { background: #2d2d44; color: #a78bfa; }
                tr:hover { background: #2d2d44; }
                .count { font-size: 24px; color: #4ade80; margin-bottom: 20px; }
            </style>
        </head>
        <body>
            <h1>🎮 Rocksnow — Онлайн</h1>
            <div class="count">Игроков с клиентом: ${players.length}</div>
            <table>
                <tr><th>Ник</th><th>UUID</th></tr>
                ${rows || '<tr><td colspan="2">Никого нет онлайн</td></tr>'}
            </table>
            <p style="color:#666">Обновляется каждые 5 сек</p>
        </body>
        </html>
    `);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));
