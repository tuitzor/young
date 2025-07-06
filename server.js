const express = require('express');
const { Server } = require('ws');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

const activeClients = new Map();
const screenshotsDB = new Map();

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure directories exist
async function initDirectories() {
    try {
        await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
    } catch (err) {
        console.error('Directory error:', err);
    }
}

// WebSocket handler
wss.on('connection', (ws) => {
    const clientId = Date.now().toString();
    activeClients.set(clientId, ws);
    console.log(`Client connected: ${clientId}`);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'screenshot') {
                const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
                const filename = `${data.questionId}.png`;
                await fs.writeFile(path.join(__dirname, 'uploads', filename), base64Data, 'base64');
                
                screenshotsDB.set(data.questionId, {
                    clientId,
                    filename,
                    timestamp: Date.now(),
                    answer: ""
                });

                ws.send(JSON.stringify({
                    type: 'acknowledge',
                    questionId: data.questionId,
                    status: 'screenshot_received'
                }));
            }
        } catch (error) {
            console.error('WS error:', error);
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${clientId}`);
        activeClients.delete(clientId);
    });
});

// API endpoints
app.get('/api/screenshots', async (req, res) => {
    try {
        const screenshots = Array.from(screenshotsDB.entries()).map(([id, data]) => ({
            id,
            url: `/uploads/${data.filename}`,
            timestamp: data.timestamp,
            answer: data.answer
        }));
        res.json(screenshots);
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/answers', express.json(), async (req, res) => {
    try {
        const { questionId, answer } = req.body;
        if (screenshotsDB.has(questionId)) {
            const data = screenshotsDB.get(questionId);
            data.answer = answer;
            screenshotsDB.set(questionId, data);
            
            // Send answer back to client
            if (activeClients.has(data.clientId)) {
                activeClients.get(data.clientId).send(JSON.stringify({
                    type: 'answer',
                    questionId,
                    answer
                }));
            }
            
            return res.sendStatus(200);
        }
        res.status(404).json({ error: 'Screenshot not found' });
    } catch (error) {
        console.error('Answer error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Init and start
initDirectories().then(() => {
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
});
