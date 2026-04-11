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

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Running'));
