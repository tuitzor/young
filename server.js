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

// Хранилище ответов
const answers = new Map();

// Настройка CORS и статических файлов
app.use(cors({ origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));

// Создание папки uploads
async function ensureUploadsDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
    } catch (err) {
        console.error('Ошибка создания папки uploads:', err);
    }
}
ensureUploadsDir();

// Прокси изображений
app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('URL не указан');
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Ошибка загрузки: ${response.statusText}`);
        const buffer = await response.buffer();
        res.set('Content-Type', response.headers.get('content-type'));
        res.send(buffer);
    } catch (error) {
        console.error('Ошибка прокси:', error);
        res.status(500).send('Не удалось загрузить изображение');
    }
});

// WebSocket обработчик
wss.on('connection', (ws) => {
    console.log('Клиент подключен');
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Получено:', data);

            if (data.role === 'helper') {
                console.log('Подключен помощник');
                ws.send(JSON.stringify({ type: 'ack', message: 'Помощник зарегистрирован' }));
            } else if (data.type === 'pageHTML') {
                console.log('Получен HTML:', data.html.substring(0, 50) + '...');
                ws.send(JSON.stringify({ type: 'ack', message: 'HTML получен' }));
            } else if (data.type === 'screenshot') {
                console.log('Получен скриншот, questionId:', data.questionId);
                const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
                const filePath = path.join(__dirname, 'uploads', `${data.questionId}.png`);
                await fs.writeFile(filePath, base64Data, 'base64');
                console.log(`Скриншот сохранен: ${filePath}`);

                // Сохраняем ответ
                answers.set(data.questionId, {
                    answer: `Ответ для ${data.questionId}`,
                    timestamp: Date.now()
                });

                ws.send(JSON.stringify({
                    type: 'answer',
                    questionId: data.questionId,
                    answer: `Ответ для ${data.questionId}`
                }));
            }
        } catch (error) {
            console.error('Ошибка обработки:', error);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
    });

    ws.on('close', () => {
        console.log('Клиент отключен');
    });
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Получение списка скриншотов
app.get('/screenshots', async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, 'uploads'));
        const screenshots = files.filter(file => file.endsWith('.png')).map(file => {
            const id = file.replace('.png', '');
            return {
                id: id,
                url: `/uploads/${file}`,
                timestamp: file.replace('.png', ''),
                answer: answers.get(id)?.answer || "Ответ еще не готов"
            };
        });
        res.json(screenshots);
    } catch (error) {
        console.error('Ошибка загрузки скриншотов:', error);
        res.status(500).send('Ошибка сервера');
    }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
