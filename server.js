const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs').promises; // Используем promisified fs
const axios = require('axios');
const cors = require('cors'); // Импортируем cors

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Порт для Render (или локально 10000, если нет process.env.PORT)
const PORT = process.env.PORT || 10000;
const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots');

// --- CORS НАСТРОЙКИ ---
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type'],
    credentials: false
}));

// Создаем папку для скриншотов, если ее нет
async function ensureScreenshotsDir() {
    try {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        console.log(`Сервер: Папка для скриншотов существует или создана: ${SCREENSHOTS_DIR}`);
    } catch (error) {
        console.error(`Сервер: Ошибка при создании папки для скриншотов: ${error}`);
    }
}
ensureScreenshotsDir();

// Увеличиваем лимиты для приема больших JSON-запросов (скриншотов)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Основная страница фронтенда
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Эндпоинт для проверки активности сервера ---
app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

// --- API-маршрут для проксирования изображений ---
app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(400).send('URL изображения не предоставлен.');
    }
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
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
app.post('/api/upload-screenshot', async (req, res) => {
    const { type, screenshot, tempQuestionId, helperId } = req.body;
    console.log("Сервер (POST): Получен запрос на загрузку скриншота.", { tempQuestionId, helperId });

    if (type !== 'screenshot' || !screenshot || !tempQuestionId || !helperId) {
        console.error('Сервер (POST): Неверные данные скриншота.');
        return res.status(400).json({ success: false, message: 'Неверные данные скриншота.' });
    }

    const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
    const filename = `${tempQuestionId}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    try {
        await fs.writeFile(filepath, base64Data, 'base64');
        const imageUrl = `/screenshots/${filename}`;
        const questionId = imageUrl;

        if (!screenshotsByHelper.has(helperId)) {
            screenshotsByHelper.set(helperId, []);
        }
        const existingScreenshot = screenshotsByHelper.get(helperId).find(s => s.questionId === questionId);
        if (!existingScreenshot) {
            screenshotsByHelper.get(helperId).push({ questionId, imageUrl, helperId, answer: '' });
            console.log(`Сервер (POST): Скриншот сохранен: ${filepath}`);

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
                }
            });
            console.log(`Сервер (POST): Отправлено ${sentCount} скриншот-сообщений фронтенд-клиентам.`);
            if (sentCount === 0) {
                console.warn('Сервер (POST): Нет активных фронтенд-клиентов для отправки скриншотов.');
            }
        } else {
            console.log(`Сервер (POST): Скриншот ${questionId} уже существует, пропуск сохранения.`);
        }

        return res.status(200).json({ success: true, message: 'Скриншот успешно загружен.' });

    } catch (err) {
        console.error('Сервер (POST): Ошибка при сохранении скриншота:', err);
        return res.status(500).json({ success: false, message: 'Ошибка сервера при сохранении скриншота.' });
    }
});

// --- WebSocket-соединения ---
const helperClients = new Map();
const frontendClients = new Set();
const screenshotsByHelper = new Map();

async function loadExistingScreenshots() {
    try {
        await ensureScreenshotsDir();
        const files = await fs.readdir(SCREENSHOTS_DIR);
        const screenshotFiles = files.filter(file => file.endsWith('.png'));

        screenshotsByHelper.clear();
        screenshotFiles.sort();

        screenshotFiles.forEach(file => {
            const parts = file.split('-');
            let helperId = '';
            let tempQuestionIdPart = '';
            if (parts.length >= 4 && parts[0] === 'helper') {
                helperId = `${parts[0]}-${parts[1]}-${parts[2]}`;
                tempQuestionIdPart = `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3].replace('.png', '')}`;
            } else {
                console.warn(`Сервер: Неожиданный формат имени файла скриншота: ${file}. Пропуск.`);
                return;
            }

            const imageUrl = `/screenshots/${file}`;
            const questionId = imageUrl;

            if (!screenshotsByHelper.has(helperId)) {
                screenshotsByHelper.set(helperId, []);
            }
            screenshotsByHelper.get(helperId).push({ questionId, imageUrl, helperId, answer: '' });
        });
        console.log(`Сервер: Загружено ${screenshotFiles.length} существующих скриншотов для ${screenshotsByHelper.size} помощников.`);
    } catch (err) {
        console.error("Сервер: Ошибка при чтении или создании папки скриншотов:", err);
    }
}

async function clearHelperScreenshots(helperId) {
    if (!helperId) return;

    try {
        const files = await fs.readdir(SCREENSHOTS_DIR);
        const filesToDelete = files.filter(file => file.startsWith(`${helperId}-`));

        if (filesToDelete.length === 0) {
            console.log(`Сервер: Для helperId ${10:21 AM +05 on Monday, July 21, 2025} скриншотов не найдено для удаления.`);
            if (screenshotsByHelper.has(helperId)) {
                screenshotsByHelper.delete(helperId);
                frontendClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'helper_deleted', helperId }));
                    }
                });
            }
            return;
        }

        console.log(`Сервер: Удаление ${filesToDelete.length} скриншотов для helperId: ${helperId}`);
        for (const file of filesToDelete) {
            const filePath = path.join(SCREENSHOTS_DIR, file);
            try {
                await fs.unlink(filePath);
                console.log(`Сервер: Файл удален: ${filePath}`);
                const deletedImageUrl = `/screenshots/${file}`;

                if (screenshotsByHelper.has(helperId)) {
                    const helperScreenshots = screenshotsByHelper.get(helperId);
                    screenshotsByHelper.set(helperId, helperScreenshots.filter(s => s.imageUrl !== deletedImageUrl));
                }

                frontendClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'screenshot_deleted_specific',
                            questionId: deletedImageUrl
                        }));
                    }
                });
            } catch (unlinkErr) {
                console.error(`Сервер: Ошибка при удалении файла ${filePath}:`, unlinkErr);
            }
        }

        if (screenshotsByHelper.has(helperId) && screenshotsByHelper.get(helperId).length === 0) {
            screenshotsByHelper.delete(helperId);
            frontendClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'helper_deleted', helperId }));
                }
            });
        }
    } catch (err) {
        console.error(`Сервер: Ошибка при чтении папки скриншотов для удаления ${helperId}:`, err);
    }
}

wss.on('connection', (ws) => {
    let currentHelperId = null;

    console.log('Сервер: Новый клиент подключился по WebSocket');

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            console.log('Сервер: Получено сообщение по WS:', data.type, data.role || 'unknown');

            if (data.role === 'helper') {
                currentHelperId = data.helperId;
                if (currentHelperId) {
                    helperClients.set(currentHelperId, ws);
                    console.log(`Сервер: Подключился помощник с ID: ${currentHelperId}`);
                }
            } else {
                if (!frontendClients.has(ws)) {
                    frontendClients.add(ws);
                    console.log('Сервер: Фронтенд-клиент идентифицирован и добавлен.');

                    const initialData = [];
                    screenshotsByHelper.forEach((screenshots, helperId) => {
                        if (screenshots.length > 0) {
                            const latestScreenshot = screenshots[screenshots.length - 1];
                            initialData.push({
                                helperId: helperId,
                                latestScreenshotUrl: latestScreenshot.imageUrl,
                                hasAnswer: !!latestScreenshot.answer
                            });
                        }
                    });
                    ws.send(JSON.stringify({
                        type: 'initial_data',
                        data: initialData
                    }));
                    console.log(`Сервер: Отправлено ${initialData.length} helperId и их последние скриншоты новому фронтенд-клиенту.`);
                }

                if (data.type === 'submit_answer') {
                    const { questionId, answer } = data;

                    let foundScreenshot = null;
                    let targetHelperId = null;
                    for (const [hId, screenshots] of screenshotsByHelper) {
                        foundScreenshot = screenshots.find(s => s.questionId === questionId);
                        if (foundScreenshot) {
                            foundScreenshot.answer = answer;
                            targetHelperId = hId;
                            break;
                        }
                    }

                    if (foundScreenshot && targetHelperId) {
                        const targetHelperWs = helperClients.get(targetHelperId);
                        if (targetHelperWs && targetHelperWs.readyState === WebSocket.OPEN) {
                            targetHelperWs.send(JSON.stringify({
                                type: 'answer',
                                questionId,
                                answer
                            }));
                            console.log(`Сервер: Ответ "${answer}" отправлен обратно помощнику для ${questionId}`);
                        } else {
                            console.warn(`Сервер: Активный помощник с ID: ${targetHelperId} не найден или его WS закрыт для questionId: ${questionId}.`);
                        }

                        frontendClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'answer',
                                    questionId,
                                    answer
                                }));
                                const currentHelperScreenshots = screenshotsByHelper.get(targetHelperId);
                                const helperHasAnswer = currentHelperScreenshots ? currentHelperScreenshots.every(s => s.answer && s.answer.trim() !== '') : false;
                                client.send(JSON.stringify({
                                    type: 'update_helper_card',
                                    helperId: targetHelperId,
                                    hasAnswer: helperHasAnswer
                                }));
                            }
                        });
                    } else {
                        console.warn(`Сервер: Скриншот с questionId ${questionId} не найден для обновления ответа.`);
                    }

                } else if (data.type === 'delete_screenshot') {
                    const { questionId } = data;
                    const filenameWithExt = path.basename(questionId);
                    const filepath = path.join(SCREENSHOTS_DIR, filenameWithExt);

                    let helperIdOfDeletedScreenshot = null;
                    let initialHelperScreenshotCount = 0;

                    for (const [hId, screenshots] of screenshotsByHelper) {
                        const initialLength = screenshots.length;
                        screenshotsByHelper.set(hId, screenshots.filter(s => s.questionId !== questionId));
                        if (screenshotsByHelper.get(hId).length < initialLength) {
                            helperIdOfDeletedScreenshot = hId;
                            initialHelperScreenshotCount = initialLength;
                            break;
                        }
                    }

                    if (helperIdOfDeletedScreenshot) {
                        try {
                            await fs.unlink(filepath);
                            console.log(`Сервер: Файл скриншота удален: ${filepath}`);

                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'screenshot_deleted_specific',
                                        questionId: questionId
                                    }));
                                }
                            });

                            if (screenshotsByHelper.has(helperIdOfDeletedScreenshot) && screenshotsByHelper.get(helperIdOfDeletedScreenshot).length === 0) {
                                screenshotsByHelper.delete(helperIdOfDeletedScreenshot);
                                frontendClients.forEach(client => {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(JSON.stringify({
                                            type: 'helper_deleted',
                                            helperId: helperIdOfDeletedScreenshot
                                        }));
                                    }
                                });
                            } else if (screenshotsByHelper.has(helperIdOfDeletedScreenshot)) {
                                const currentHelperScreenshots = screenshotsByHelper.get(helperIdOfDeletedScreenshot);
                                const newLatestScreenshot = currentHelperScreenshots[currentHelperScreenshots.length - 1];
                                const helperHasAnswer = currentHelperScreenshots.every(s => s.answer && s.answer.trim() !== '');

                                frontendClients.forEach(client => {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(JSON.stringify({
                                            type: 'update_helper_card',
                                            helperId: helperIdOfDeletedScreenshot,
                                            latestScreenshotUrl: newLatestScreenshot.imageUrl,
                                            hasAnswer: helperHasAnswer
                                        }));
                                    }
                                });
                            }
                        } catch (err) {
                            console.error(`Сервер: Ошибка при удалении файла скриншота ${filepath}:`, err);
                            ws.send(JSON.stringify({ type: 'error', message: 'Ошибка при удалении скриншота.' }));
                        }
                    } else {
                        console.warn(`Сервер: Скриншот с questionId ${questionId} не найден для удаления.`);
                        ws.send(JSON.stringify({ type: 'error', message: 'Скриншот не найден.' }));
                    }

                } else if (data.type === 'request_helper_screenshots') {
                    const { helperId: requestedHelperId } = data;
                    const screenshotsForHelper = screenshotsByHelper.get(requestedHelperId) || [];
                    console.log(`Сервер: Отправка ${screenshotsForHelper.length} скриншотов для helperId ${requestedHelperId} фронтенду.`);
                    ws.send(JSON.stringify({
                        type: 'screenshots_by_helperId',
                        helperId: requestedHelperId,
                        screenshots: screenshotsForHelper
                    }));
                }
            }
        } catch (error) {
            console.error('Сервер: Ошибка при разборе сообщения или обработке данных:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат сообщения.' }));
        }
    });

    ws.on('close', async () => {
        console.log('Сервер: Клиент отключился.');
        if (frontendClients.has(ws)) {
            frontendClients.delete(ws);
            console.log('Сервер: Фронтенд-клиент удален из списка.');
        }

        if (currentHelperId && helperClients.get(currentHelperId) === ws) {
            console.log(`Сервер: Помощник с ID: ${currentHelperId} отключился. Запускаю очистку скриншотов.`);
            helperClients.delete(currentHelperId);
            await clearHelperScreenshots(currentHelperId);
        }
    });

    ws.on('error', error => {
        console.error('Сервер: Ошибка WebSocket:', error);
    });
});

// --- Функция периодического самопингования для поддержания активности ---
function keepServerAwake() {
    const interval = 300000; // 5 минут (300 секунд)
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}/healthz`;

    setInterval(async () => {
        try {
            const response = await axios.get(url);
            console.log(`Сервер: Успешный пинг на ${url} в ${new Date().toISOString()}: Статус ${response.status}`);
        } catch (error) {
            console.error(`Сервер: Ошибка пинга на ${url} в ${new Date().toISOString()}:`, error.message);
        }
    }, interval);
}

// Запускаем самопингование
keepServerAwake();

server.listen(PORT, async () => {
    console.log(`Сервер запущен на порту: ${PORT}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${PORT}`);
    await loadExistingScreenshots();
});
