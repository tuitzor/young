const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;
const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots');

// --- Секретный вопрос и ответ ---
const SECRET_QUESTION = "Что нужно делать, если упал онлайн?";
const SECRET_ANSWER = "поднять онлайн"; // Ваш секретный ответ. МОЖЕТЕ ИЗМЕНИТЬ НА ЛЮБОЙ ДРУГОЙ

// Создаем папку для скриншотов, если ее нет
if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    console.log(`Сервер: Создана папка для скриншотов: ${SCREENSHOTS_DIR}`);
} else {
    console.log(`Сервер: Папка для скриншотов уже существует: ${SCREENSHOTS_DIR}`);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// --- API Маршрут для ответа на опрос ---
app.post('/api/quiz/answer', (req, res) => {
    const { answer } = req.body;
    if (answer && answer.toLowerCase().trim() === SECRET_ANSWER.toLowerCase().trim()) {
        res.status(200).json({ success: true, message: 'Доступ разрешен' });
    } else {
        res.status(401).json({ success: false, message: 'Неверный ответ' });
    }
});

// Маршрут для получения вопроса
app.get('/api/quiz/question', (req, res) => {
    res.status(200).json({ question: SECRET_QUESTION });
});


app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- WebSocket-соединения ---
const helperClients = new Map(); // Карта для отслеживания помощников по helperId
const frontendClients = new Set(); // Набор для отслеживания фронтендов (админов/просмотрщиков)

/**
 * Удаляет все скриншоты, связанные с данным helperId, из папки SCREENSHOTS_DIR.
 * @param {string} helperId - Уникальный идентификатор помощника.
 */
function clearHelperScreenshots(helperId) {
    if (!helperId) return;

    fs.readdir(SCREENSHOTS_DIR, (err, files) => {
        if (err) {
            console.error(`Ошибка при чтении папки скриншотов для удаления ${helperId}:`, err);
            return;
        }

        const filesToDelete = files.filter(file => file.startsWith(`${helperId}-`));
        if (filesToDelete.length === 0) {
            console.log(`Сервер: Для helperId ${helperId} скриншотов не найдено для удаления.`);
            return;
        }

        console.log(`Сервер: Удаление ${filesToDelete.length} скриншотов для helperId: ${helperId}`);
        filesToDelete.forEach(file => {
            const filePath = path.join(SCREENSHOTS_DIR, file);
            fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) {
                    console.error(`Сервер: Ошибка при удалении файла ${filePath}:`, unlinkErr);
                } else {
                    console.log(`Сервер: Файл удален: ${filePath}`);
                    // Оповещаем фронтенд-клиентов об удалении скриншота
                    frontendClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'screenshot_deleted',
                                questionIdPrefix: `${helperId}-`
                            }));
                        }
                    });
                }
            });
        });
    });
}

app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(400).send('URL изображения не предоставлен.');
    }
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*'); // Разрешаем CORS
        res.send(response.data);
    } catch (error) {
        console.error('Ошибка проксирования изображения:', imageUrl, error.message);
        res.status(500).send('Не удалось загрузить изображение.');
    }
});


wss.on('connection', (ws, req) => {
    let currentHelperId = null;
    console.log('Новый клиент подключился по WebSocket');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);

            if (data.role === 'helper') {
                currentHelperId = data.helperId;
                if (currentHelperId) {
                    helperClients.set(currentHelperId, ws);
                    console.log(`Сервер: Подключился помощник с ID: ${currentHelperId}`);
                }

                if (data.type === 'screenshot') {
                    const { screenshot, questionId, helperId } = data;
                    const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
                    // Убедимся, что имя файла уникально и не содержит недопустимых символов
                    const filename = `${helperId}-${questionId.split('-').slice(1).join('-')}.png`;
                    const filepath = path.join(SCREENSHOTS_DIR, filename);

                    fs.writeFile(filepath, base64Data, 'base64', (err) => {
                        if (err) {
                            console.error('Сервер: Ошибка при сохранении скриншота:', err);
                        } else {
                            const imageUrl = `/screenshots/${filename}`;
                            console.log(`Сервер: Скриншот сохранен: ${filename}. Отправка фронтендам...`);
                            let sentCount = 0;

                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'screenshot_info',
                                        questionId,
                                        imageUrl,
                                        helperId
                                    }));
                                    sentCount++;
                                } else {
                                    console.warn(`Сервер: Фронтенд-клиент не готов к отправке (state: ${client.readyState}).`);
                                }
                            });
                            console.log(`Сервер: Отправлено скриншот-сообщений ${sentCount} фронтенд-клиентам.`);
                            if (sentCount === 0) {
                                console.warn('Сервер: Нет активных фронтенд-клиентов для отправки скриншотов.');
                            }
                        }
                    });
                } else if (data.type === 'pageHTML') {
                    // console.log('Сервер: Получен HTML страницы от помощника (не сохраняем в этом примере).');
                } else if (data.type === 'ping') { // Обработка пинг-сообщений от помощника
                    // console.log(`Сервер: Получен пинг от helperId: ${data.helperId}`);
                    // Просто игнорируем, чтобы поддерживать соединение активным
                }
            } else { // Это должен быть фронтенд-клиент (просмотрщик)
                if (data.type === 'frontend_connect') {
                    // Проверяем, что клиент отправил правильный ответ на опрос
                    if (data.authPassed) { // Фронтенд отправляет authPassed: true, если опрос пройден
                        frontendClients.add(ws);
                        console.log('Сервер: Подключился фронтенд-клиент (опрос пройден).');
                    } else {
                        console.warn('Сервер: Фронтенд-клиент попытался подключиться без прохождения опроса. Отклонено.');
                        ws.close(); // Закрываем соединение, если опрос не пройден
                    }
                } else if (data.type === 'submit_answer') {
                    const { questionId, answer } = data;

                    const parts = questionId.split('-');
                    // Helper ID состоит из первой и второй части ID (e.g., helper-1234567890)
                    const targetHelperId = `${parts[0]}-${parts[1]}`;

                    const targetHelperWs = helperClients.get(targetHelperId);
                    if (targetHelperWs && targetHelperWs.readyState === WebSocket.OPEN) {
                        targetHelperWs.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer
                        }));
                        console.log(`Сервер: Ответ отправлен обратно помощнику для ${questionId}`);
                    } else {
                        console.warn(`Сервер: Активный помощник с ID: ${targetHelperId} не найден или его WS закрыт для questionId: ${questionId}.`);
                    }

                    // Также обновляем ответ на всех фронтенд-панелях
                    frontendClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'answer',
                                questionId,
                                answer
                            }));
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Сервер: Ошибка при разборе сообщения или обработке данных:', error);
            // Если ошибка парсинга JSON, это может быть невалидное сообщение
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат сообщения.' }));
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился.');
        // Удаляем из списка фронтенд-клиентов
        frontendClients.delete(ws);

        // Проверяем, был ли это помощник и удаляем его из карты
        // Важно: currentHelperId устанавливается только если это помощник,
        // и только для этого конкретного WebSocket-соединения
        if (currentHelperId && helperClients.get(currentHelperId) === ws) {
            console.log(`Сервер: Помощник с ID: ${currentHelperId} отключился. Запускаю очистку скриншотов.`);
            helperClients.delete(currentHelperId);
            clearHelperScreenshots(currentHelperId);
        }
    });

    ws.on('error', error => {
        console.error('Сервер: Ошибка WebSocket:', error);
    });
});


server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${PORT}`);
});
