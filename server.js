const express = require('express');
const { Server } = require('ws');
const http = require('http');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

// Настройка CORS и статических файлов
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));

// Создание папки uploads
async function ensureUploadsDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
        console.log('Uploads directory ready');
    } catch (err) {
        console.error('Error creating uploads directory:', err);
    }
}
ensureUploadsDir();

// Инициализация answers.json
async function initAnswersFile() {
    try {
        const filePath = path.join(__dirname, 'answers.json');
        await fs.access(filePath);
        const content = await fs.readFile(filePath, 'utf8');
        JSON.parse(content);
        console.log('answers.json loaded successfully');
    } catch {
        console.log('Initializing answers.json');
        await fs.writeFile(
            filePath,
            JSON.stringify({ answers: [] }, null, 2)
        );
    }
}
initAnswersFile();

// Обработка WebSocket-соединений
wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', async (message) => {
        console.log('Raw message received:', message.toString());
        try {
            if (!message || typeof message !== 'string') {
                console.error('Invalid message received:', message);
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
                return;
            }
            const data = JSON.parse(message);
            console.log('Received:', data);

            if (data.type === 'screenshot') {
                console.log('Received screenshot, questionId:', data.questionId, 'size:', data.screenshot?.length);
                if (!data.screenshot || !data.questionId) {
                    throw new Error('Missing screenshot or questionId');
                }
                const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
                const filePath = path.join(__dirname, 'Uploads', `${data.questionId}.png`);
                await fs.writeFile(filePath, base64Data, 'base64');
                console.log(`Screenshot saved: ${filePath}`);

                // Сохраняем ответ в answers.json
                const answers = JSON.parse(await fs.readFile(path.join(__dirname, 'answers.json')));
                const answerText = `Screenshot ${data.questionId} processed successfully`;
                answers.answers.push({
                    questionId: data.questionId,
                    answer: answerText,
                    timestamp: new Date().toISOString()
                });
                await fs.writeFile(path.join(__dirname, 'answers.json'), JSON.stringify(answers, null, 2));
                console.log(`Answer for ${data.questionId} added to answers.json`);

                // Отправляем ответ клиенту
                ws.send(JSON.stringify({
                    type: 'answer',
                    questionId: data.questionId,
                    answer: answerText
                }));
            }
        } catch (error) {
            console.error('Error processing message:', error.message, message);
            ws.send(JSON.stringify({ type: 'error', message: `Error: ${error.message}` }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Эндпоинт для получения ответов
app.get('/answers', async (req, res) => {
    try {
        const answers = JSON.parse(await fs.readFile(path.join(__dirname, 'answers.json')));
        res.json(answers.answers);
    } catch (error) {
        console.error('Error fetching answers:', error);
        res.status(500).send('Failed to fetch answers');
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
```
