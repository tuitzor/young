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
const answers = new Map();

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function ensureUploadsDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
    } catch (err) {
        console.error('Error creating uploads directory:', err);
    }
}
ensureUploadsDir();

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'screenshot') {
                const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
                const filePath = path.join(__dirname, 'uploads', `${data.questionId}.png`);
                await fs.writeFile(filePath, base64Data, 'base64');
                answers.set(data.questionId, { answer: "", timestamp: Date.now() });
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
});

app.post('/save-answer', async (req, res) => {
    const { questionId, answer } = req.body;
    if (answers.has(questionId)) {
        answers.set(questionId, { 
            answer: answer,
            timestamp: answers.get(questionId).timestamp
        });
        return res.sendStatus(200);
    }
    res.sendStatus(404);
});

app.get('/screenshots', async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, 'uploads'));
        const screenshots = files.filter(file => file.endsWith('.png')).map(file => ({
            id: file.replace('.png', ''),
            url: `/uploads/${file}`,
            timestamp: file.replace('.png', ''),
            answer: answers.get(file.replace('.png', ''))?.answer || ""
        }));
        res.json(screenshots);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Server error');
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
