const express = require('express');
const { Server } = require('ws');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

const activeConnections = new Map();
const screenshotsData = new Map();

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

// Cleanup function
async function cleanupConnection(connectionId) {
    // Delete all screenshots from this connection
    for (const [questionId, data] of screenshotsData.entries()) {
        if (data.connectionId === connectionId) {
            try {
                await fs.unlink(path.join(__dirname, 'uploads', `${questionId}.png`));
                screenshotsData.delete(questionId);
                console.log(`Deleted screenshot ${questionId}`);
            } catch (err) {
                console.error('Error deleting file:', err);
            }
        }
    }
}

// WebSocket handler
wss.on('connection', (ws) => {
    const connectionId = Date.now().toString();
    activeConnections.set(connectionId, ws);
    console.log(`New connection: ${connectionId}`);

    // Send ping every 30 seconds to check connection
    const pingInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.ping();
        }
    }, 30000);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'screenshot') {
                const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
                const filePath = path.join(__dirname, 'uploads', `${data.questionId}.png`);
                await fs.writeFile(filePath, base64Data, 'base64');
                
                screenshotsData.set(data.questionId, {
                    connectionId,
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
            console.error('Error:', error);
        }
    });

    ws.on('close', async () => {
        console.log(`Connection closed: ${connectionId}`);
        clearInterval(pingInterval);
        await cleanupConnection(connectionId);
        activeConnections.delete(connectionId);
    });

    ws.on('error', async (error) => {
        console.log(`Connection error: ${connectionId}`, error);
        clearInterval(pingInterval);
        await cleanupConnection(connectionId);
        activeConnections.delete(connectionId);
    });
});

// API endpoints
app.get('/api/screenshots', async (req, res) => {
    try {
        // Verify files actually exist
        const validScreenshots = [];
        for (const [id, data] of screenshotsData.entries()) {
            try {
                await fs.access(path.join(__dirname, 'uploads', `${id}.png`));
                validScreenshots.push({
                    id,
                    url: `/uploads/${id}.png`,
                    timestamp: data.timestamp,
                    answer: data.answer
                });
            } catch {
                screenshotsData.delete(id);
            }
        }
        
        res.json(validScreenshots);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/answers', express.json(), async (req, res) => {
    const { questionId, answer } = req.body;
    if (screenshotsData.has(questionId)) {
        screenshotsData.set(questionId, {
            ...screenshotsData.get(questionId),
            answer: answer
        });
        
        // Send answer back to client if still connected
        const connectionId = screenshotsData.get(questionId).connectionId;
        if (activeConnections.has(connectionId)) {
            activeConnections.get(connectionId).send(JSON.stringify({
                type: 'answer',
                questionId,
                answer
            }));
        }
        
        return res.sendStatus(200);
    }
    res.sendStatus(404);
});

// Init and start
initDirectories().then(() => {
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
});
