const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Устанавливаем порт на 10000
const PORT = process.env.PORT || 10000;

const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots'); // Папка для сохранения скриншотов
if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true }); // Создаем папку, если ее нет
}

const helperClients = new Map();
const frontendClients = new Set();

// Раздаем статические файлы из папки 'public'
app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', ws => {
    console.log('Новый клиент подключился по WebSocket');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            console.log('Получено сообщение:', data.type);

            if (data.role === 'helper') {
                console.log('Подключился скрипт-помощник.');
            } else if (data.type === 'screenshot') {
                const { screenshot, questionId } = data;
                const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
                const filename = `${questionId}.png`;
                const filepath = path.join(SCREENSHOTS_DIR, filename);

                helperClients.set(questionId, ws);

                fs.writeFile(filepath, base64Data, 'base64', (err) => {
                    if (err) {
                        console.error('Ошибка при сохранении скриншота:', err);
                    } else {
                        console.log(`Скриншот сохранен: ${filename}`);
                        const imageUrl = `/screenshots/${filename}`;

                        frontendClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'screenshot_info',
                                    questionId,
                                    imageUrl
                                }));
                            }
                        });
                    }
                });
            } else if (data.type === 'pageHTML') {
                console.log('Получен HTML страницы от помощника (не сохраняем в этом примере).');
            } else if (data.type === 'submit_answer') {
                const { questionId, answer } = data;
                console.log(`Фронтенд отправил ответ для ${questionId}: ${answer}`);

                const targetHelperWs = helperClients.get(questionId);
                if (targetHelperWs && targetHelperWs.readyState === WebSocket.OPEN) {
                    targetHelperWs.send(JSON.stringify({
                        type: 'answer',
                        questionId,
                        answer
                    }));
                    console.log(`Ответ отправлен обратно помощнику для ${questionId}`);
                } else {
                    console.warn(`Активный помощник для questionId: ${questionId} не найден или его WS закрыт.`);
                }

                frontendClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer
                        }));
                    }
                });
            } else if (data.type === 'frontend_connect') {
                frontendClients.add(ws);
                console.log('Подключился фронтенд-клиент.');
            }

        } catch (error) {
            console.error('Ошибка при разборе сообщения или обработке данных:', error);
        }
    });

    ws.on('close', () => {
        console.log('Клиент отключился.');
        frontendClients.delete(ws);
    });

    ws.on('error', error => {
        console.error('Ошибка WebSocket:', error);
    });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${PORT}`);
});
