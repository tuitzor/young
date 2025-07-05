const express = require('express');
const { Server } = require('ws');
const http = require('http');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

async function ensureUploadsDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
        console.log('Uploads directory created or already exists');
    } catch (err) {
        console.error('Error creating uploads directory:', err.message);
        throw err;
    }
}

async function startServer() {
    await ensureUploadsDir();
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('No URL provided');
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
        const buffer = await response.buffer();
        res.set('Content-Type', response.headers.get('content-type'));
        res.send(buffer);
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send('Failed to fetch image');
    }
});

wss.on('connection', (ws) => {
    console.log('Client connected');
    const clientScreenshots = new Set(); // Хранит questionId для этого клиента

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received:', data);

            if (data.role === 'helper') {
                console.log('Helper client registered');
                ws.send(JSON.stringify({ type: 'ack', message: 'Helper registered' }));
            } else if (data.type === 'pageHTML') {
                console.log('Received page HTML:', data.html.substring(0, 50) + '...');
                ws.send(JSON.stringify({ type: 'ack', message: 'HTML received' }));
            } else if (data.type === 'screenshot') {
                console.log('Received screenshot, questionId:', data.questionId);
                const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
                const filePath = path.join(__dirname, 'uploads', `${data.questionId}.png`);
                await fs.writeFile(filePath, base64Data, 'base64');
                console.log(`Screenshot saved: ${filePath}`);
                clientScreenshots.add(data.questionId); // Сохраняем questionId

                // Автоматический ответ (можно заменить на ручной)
                const answer = `Screenshot ${data.questionId} processed`;
                ws.send(JSON.stringify({
                    type: 'answer',
                    questionId: data.questionId,
                    answer: answer
                }));
            }
        } catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
    });

    ws.on('close', async () => {
        console.log('Client disconnected, cleaning up screenshots');
        for (const questionId of clientScreenshots) {
            const filePath = path.join(__dirname, 'uploads', `${questionId}.png`);
            try {
                await fs.unlink(filePath);
                console.log(`Deleted screenshot: ${filePath}`);
            } catch (err) {
                console.error(`Error deleting screenshot ${filePath}:`, err);
            }
        }
        clientScreenshots.clear();
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/screenshots', async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, 'uploads'));
        const screenshots = files.filter(file => file.endsWith('.png')).map(file => ({
            id: file.replace('.png', ''),
            url: `/uploads/${file}`,
            timestamp: file.replace('.png', '')
        }));
        res.json(screenshots);
    } catch (error) {
        console.error('Error listing screenshots:', error);
        res.status(500).send('Failed to list screenshots');
    }
});

app.post('/send-answer', (req, res) => {
    const { questionId, answer } = req.body;
    if (!questionId || !answer) return res.status(400).send('Question ID and answer are required');
    console.log(`Received answer for questionId ${questionId}: ${answer}`);

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'answer',
                questionId: questionId,
                answer: answer
            }));
        }
    });

    res.send({ status: 'answer sent' });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
