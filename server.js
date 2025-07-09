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

// Создаем папку для скриншотов, если ее нет
if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    console.log(`Сервер: Создана папка для скриншотов: ${SCREENSHOTS_DIR}`);
} else {
    console.log(`Сервер: Папка для скриншотов уже существует: ${SCREENSHOTS_DIR}`);
}

app.use(express.json({ limit: '50mb' })); // Увеличиваем лимит размера JSON для больших скриншотов
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- API-маршрут для проксирования изображений ---
// Этот прокси-сервер должен быть доступен helper.js
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
        if (error.response && error.response.status === 404) {
            console.warn(`Сервер (Proxy): Изображение не найдено по URL: ${imageUrl}`);
            return res.status(404).send('Изображение не найдено на удаленном сервере.');
        }
        console.error('Сервер (Proxy): Ошибка проксирования изображения:', imageUrl, error.message);
        res.status(500).send('Не удалось загрузить изображение через прокси.');
    }
});

// --- API-маршрут для загрузки скриншотов через HTTP POST ---
// helper.js использует этот маршрут для отправки скриншотов
app.post('/api/upload-screenshot', (req, res) => {
    const { type, screenshot, questionId, helperId } = req.body;

    if (type !== 'screenshot' || !screenshot || !questionId || !helperId) {
        return res.status(400).json({ success: false, message: 'Неверные данные скриншота.' });
    }

    const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
    // Убедимся, что имя файла уникально и не содержит недопустимых символов
    const filename = `${helperId}-${questionId.split('-').slice(1).join('-')}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    fs.writeFile(filepath, base64Data, 'base64', (err) => {
        if (err) {
            console.error('Сервер (POST): Ошибка при сохранении скриншота:', err);
            return res.status(500).json({ success: false, message: 'Ошибка сервера при сохранении скриншота.' });
        } else {
            const imageUrl = `/screenshots/${filename}`;
            console.log(`Сервер (POST): Скриншот сохранен: ${filename}. Отправка фронтендам через WebSocket...`);
            let sentCount = 0;

            // Отправляем информацию о скриншоте всем подключенным фронтенд-клиентам
            frontendClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'screenshot_info',
                        questionId,
                        imageUrl,
                        helperId
                    }));
                    sentCount++;
                }
            });
            console.log(`Сервер (POST): Отправлено скриншот-сообщений ${sentCount} фронтенд-клиентам.`);
            if (sentCount === 0) {
                console.warn('Сервер (POST): Нет активных фронтенд-клиентов для отправки скриншотов.');
            }
            return res.status(200).json({ success: true, message: 'Скриншот успешно загружен.' });
        }
    });
});


// --- WebSocket-соединения ---
const helperClients = new Map(); // Карта для отслеживания помощников по helperId
const frontendClients = new Set(); // Набор для отслеживания фронтендов (просмотрщиков)

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

wss.on('connection', (ws, req) => {
    let currentHelperId = null;
    // Определяем тип клиента по его первому сообщению или по запросу
    // В данном упрощенном случае, фронтенд сразу добавляется в frontendClients
    // Хелпер идентифицирует себя сообщением { role: 'helper' }

    console.log('Сервер: Новый клиент подключился по WebSocket');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);

            if (data.role === 'helper') {
                currentHelperId = data.helperId;
                if (currentHelperId) {
                    helperClients.set(currentHelperId, ws);
                    console.log(`Сервер: Подключился помощник с ID: ${currentHelperId}`);
                }

                if (data.type === 'pageHTML') {
                    // console.log('Сервер: Получен HTML страницы от помощника (не сохраняем в этом примере).');
                } else if (data.type === 'ping') { // Обработка пинг-сообщений от помощника
                    // console.log(`Сервер: Получен пинг от helperId: ${data.helperId}`);
                }
            } else { // Это фронтенд-клиент (просмотрщик)
                // Если фронтенд отправляет любое сообщение (например, submit_answer), добавляем его в набор
                // Это предполагает, что фронтенд-клиенты НЕ будут отправлять 'role: helper'
                if (!frontendClients.has(ws)) {
                    frontendClients.add(ws);
                    console.log('Сервер: Фронтенд-клиент идентифицирован и добавлен.');
                }

                if (data.type === 'submit_answer') {
                    const { questionId, answer } = data;

                    const parts = questionId.split('-');
                    const targetHelperId = `${parts[0]}-${parts[1]}`; // helperId в формате helper-<timestamp>-<random>

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
                } else if (data.type === 'delete_screenshot') {
                    const { questionId } = data;
                    const filename = questionId.split('/').pop(); // Извлечь имя файла из questionId
                    const filepath = path.join(SCREENSHOTS_DIR, filename + '.png'); // Добавляем .png

                    fs.unlink(filepath, (err) => {
                        if (err) {
                            console.error(`Сервер: Ошибка при удалении файла скриншота ${filepath}:`, err);
                            ws.send(JSON.stringify({ type: 'error', message: 'Ошибка при удалении скриншота.' }));
                        } else {
                            console.log(`Сервер: Файл скриншота удален: ${filepath}`);
                            // Оповещаем все фронтенд-панели об удалении скриншота
                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'screenshot_deleted_specific',
                                        questionId: questionId // Отправляем полный questionId
                                    }));
                                }
                            });
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Сервер: Ошибка при разборе сообщения или обработке данных:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат сообщения.' }));
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился.');
        // Удаляем клиент из списка фронтендов, если он там был
        if (frontendClients.has(ws)) {
            frontendClients.delete(ws);
        }

        // Если это был помощник, удаляем его и очищаем скриншоты
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
