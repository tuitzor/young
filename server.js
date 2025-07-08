const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots'); // Папка для сохранения скриншотов
if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true }); // Создаем папку, если ее нет
}

// Map для хранения соответствия questionId к WebSocket-соединению клиента-помощника
// Это нужно, чтобы отправить ответ конкретному клиенту, который прислал скриншот
const helperClients = new Map();

// Set для хранения всех WebSocket-соединений фронтенд-клиентов
// Это нужно, чтобы уведомить все открытые страницы просмотра о новых скриншотах или ответах
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
                // Если это скрипт-помощник (ваш скрипт)
                console.log('Подключился скрипт-помощник.');
                // В этом примере мы просто регистрируем его.
                // Фактическое связывание с questionId происходит при отправке скриншота.
            } else if (data.type === 'screenshot') {
                // Если получены данные скриншота
                const { screenshot, questionId } = data;
                // Удаляем префикс "data:image/png;base64," из строки
                const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
                const filename = `${questionId}.png`;
                const filepath = path.join(SCREENSHOTS_DIR, filename);

                // Сохраняем ссылку на WebSocket-соединение скрипта-помощника
                // это позволит отправить ответ обратно конкретному клиенту
                helperClients.set(questionId, ws);

                fs.writeFile(filepath, base64Data, 'base64', (err) => {
                    if (err) {
                        console.error('Ошибка при сохранении скриншота:', err);
                    } else {
                        console.log(`Скриншот сохранен: ${filename}`);
                        const imageUrl = `/screenshots/${filename}`; // URL для отображения во фронтенде

                        // Уведомляем все подключенные фронтенд-клиенты о новом скриншоте
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
                // Если получен ответ от фронтенда
                const { questionId, answer } = data;
                console.log(`Фронтенд отправил ответ для ${questionId}: ${answer}`);

                // Находим оригинальный WebSocket-клиент скрипта-помощника
                const targetHelperWs = helperClients.get(questionId);
                if (targetHelperWs && targetHelperWs.readyState === WebSocket.OPEN) {
                    // Отправляем ответ обратно оригинальному скрипту-помощнику
                    targetHelperWs.send(JSON.stringify({
                        type: 'answer',
                        questionId,
                        answer
                    }));
                    console.log(`Ответ отправлен обратно помощнику для ${questionId}`);
                } else {
                    console.warn(`Активный помощник для questionId: ${questionId} не найден или его WS закрыт.`);
                }

                // Также уведомляем все другие фронтенд-клиенты об обновлении ответа (для синхронизации)
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
                // Фронтенд-клиент идентифицирует себя
                frontendClients.add(ws);
                console.log('Подключился фронтенд-клиент.');
            }

        } catch (error) {
            console.error('Ошибка при разборе сообщения или обработке данных:', error);
        }
    });

    ws.on('close', () => {
        console.log('Клиент отключился.');
        // Удаляем из списка фронтенд-клиентов, если это был он
        frontendClients.delete(ws);
        // Более сложная логика нужна для очистки helperClients,
        // если помощник отключается, пока его скриншот ожидает ответа.
    });

    ws.on('error', error => {
        console.error('Ошибка WebSocket:', error);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${PORT}`);
});
