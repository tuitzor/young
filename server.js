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

// Ensure uploads directory exists
async function ensureUploadsDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
    } catch (err) {
        console.error('Error creating uploads directory:', err);
    }
}
ensureUploadsDir();

// WebSocket handler
wss.on('connection', (ws) => {
    const connectionId = Date.now().toString();
    activeConnections.set(connectionId, ws);
    console.log(`New connection: ${connectionId}`);

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
                    type: 'answer',
                    questionId: data.questionId,
                    answer: ""
                }));
            }
        } catch (error) {
            console.error('Error:', error);
        }
    });

    ws.on('close', async () => {
        console.log(`Connection closed: ${connectionId}`);
        
        // Delete all screenshots from this connection
        for (const [questionId, data] of screenshotsData.entries()) {
            if (data.connectionId === connectionId) {
                try {
                    await fs.unlink(path.join(__dirname, 'uploads', `${questionId}.png`));
                    screenshotsData.delete(questionId);
                } catch (err) {
                    console.error('Error deleting file:', err);
                }
            }
        }
        
        activeConnections.delete(connectionId);
    });
});

// API endpoints
app.get('/screenshots', async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, 'uploads'));
        const screenshots = files.filter(file => file.endsWith('.png')).map(file => {
            const id = file.replace('.png', '');
            return {
                id,
                url: `/uploads/${file}`,
                timestamp: screenshotsData.get(id)?.timestamp || 0,
                answer: screenshotsData.get(id)?.answer || ""
            };
        });
        res.json(screenshots);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Server error');
    }
});

app.post('/save-answer', express.json(), async (req, res) => {
    const { questionId, answer } = req.body;
    if (screenshotsData.has(questionId)) {
        screenshotsData.set(questionId, {
            ...screenshotsData.get(questionId),
            answer: answer
        });
        return res.sendStatus(200);
    }
    res.sendStatus(404);
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
