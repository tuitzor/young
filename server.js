const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;
const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secure-jwt-secret'; // Replace with env variable in production

// Список администраторов с хешированными паролями
const admins = [
    { username: 'admin1', passwordHash: bcrypt.hashSync('admin1A', 10) },
    { username: 'admin2', passwordHash: bcrypt.hashSync('admin2A', 10) },
    { username: 'admin3', passwordHash: bcrypt.hashSync('admin3A', 10) },
    { username: 'admin4', passwordHash: bcrypt.hashSync('admin4A', 10) },
    { username: 'admin5', passwordHash: bcrypt.hashSync('admin5A', 10) },
    { username: 'admin6', passwordHash: bcrypt.hashSync('admin6A', 10) }
];

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to verify JWT
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Требуется токен авторизации' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Неверный или истекший токен' });
    }
};

// Admin login endpoint
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Требуются имя пользователя и пароль' });
    }

    const admin = admins.find(a => a.username === username);
    if (!admin || !await bcrypt.compare(password, admin.passwordHash)) {
        return res.status(401).json({ success: false, message: 'Неверное имя пользователя или пароль' });
    }

    try {
        const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '1h' });
        res.status(200).json({ success: true, token });
    } catch (err) {
        console.error('Сервер: Ошибка при входе админа:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера при входе' });
    }
});

// Protected route to get list of admins
app.get('/api/admin/list', authenticateAdmin, (req, res) => {
    const adminList = admins.map(admin => ({ username: admin.username }));
    res.status(200).json({ success: true, admins: adminList });
});

async function ensureScreenshotsDir() {
    try {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        console.log(`Сервер: Папка для скриншотов существует или создана: ${SCREENSHOTS_DIR}`);
    } catch (error) {
        console.error(`Сервер: Ошибка при создании папки для скриншотов: ${error}`);
    }
}
ensureScreenshotsDir();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/healthz', (req, res) => {
    res.status(200).send('OK');
});

app.get('/api/active-helpers', (req, res) => {
    const helpers = Array.from(helperClients.keys());
    console.log(`Сервер: Запрос активных помощников, найдено: ${helpers.length}`);
    res.status(200).json({ helpers });
});

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
            console.log(`Сервер: Для helperId ${helperId} скриншотов не найдено для удаления.`);
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
            console.log('Сервер: Получено сообщение по WS:', { type: data.type, role: data.role || 'unknown', helperId: data.helperId || 'none' });

            if (data.role === 'helper') {
                currentHelperId = data.helperId;
                if (currentHelperId) {
                    helperClients.set(currentHelperId, ws);
                    console.log(`Сервер: Подключился помощник с ID: ${currentHelperId}, активных помощников: ${helperClients.size}`);
                    if (screenshotsByHelper.has(currentHelperId)) {
                        const screenshots = screenshotsByHelper.get(currentHelperId);
                        screenshots.forEach(screenshot => {
                            if (screenshot.answer && screenshot.answer.trim() !== '') {
                                ws.send(JSON.stringify({
                                    type: 'answer',
                                    questionId: screenshot.questionId,
                                    answer: screenshot.answer
                                }));
                                console.log(`Сервер: Отправлен сохраненный ответ для helperId: ${currentHelperId}, questionId: ${screenshot.questionId}, answer: ${screenshot.answer}`);
                            }
                        });
                    }
                }
            } else if (data.type === 'frontend_connect') {
                if (!frontendClients.has(ws)) {
                    frontendClients.add(ws);
                    console.log('Сервер: Фронтенд-клиент идентифицирован, активных фронтенд-клиентов: ', frontendClients.size);

                    const initialData = [];
                    screenshotsByHelper.forEach((screenshots, helperId) => {
                        if (screenshots.length > 0) {
                            initialData.push({
                                helperId: helperId,
                                hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== '')
                            });
                        }
                    });
                    ws.send(JSON.stringify({
                        type: 'initial_data',
                        data: initialData
                    }));
                    console.log(`Сервер: Отправлено ${initialData.length} helperId фронтенд-клиенту.`);
                }
            } else if (data.type === 'screenshot') {
                const { screenshot, tempQuestionId, helperId } = data;
                if (!screenshot || !tempQuestionId || !helperId) {
                    console.error('Сервер: Неверные данные скриншота:', data);
                    ws.send(JSON.stringify({ type: 'error', message: 'Неверные данные скриншота.' }));
                    return;
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
                        console.log(`Сервер: Скриншот сохранен: ${filepath}`);

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
                        console.log(`Сервер: Отправлено ${sentCount} скриншот-сообщений фронтенд-клиентам.`);
                        if (sentCount === 0) {
                            console.warn('Сервер: Нет активных фронтенд-клиентов для отправки скриншотов.');
                        }
                    } else {
                        console.log(`Сервер: Скриншот ${questionId} уже существует, пропуск сохранения.`);
                    }
                } catch (err) {
                    console.error('Сервер: Ошибка при сохранении скриншота:', err);
                    ws.send(JSON.stringify({ type: 'error', message: 'Ошибка сервера при сохранении скриншота.' }));
                }
            } else if (data.type === 'submit_answer') {
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
                        console.log(`Сервер: Ответ "${answer}" отправлен помощнику helperId: ${targetHelperId}, questionId: ${questionId}`);
                    } else {
                        console.warn(`Сервер: Помощник с ID: ${targetHelperId} не найден или его WS закрыт для questionId: ${questionId}. Ответ сохранен для отправки при повторном подключении.`);
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
                            const helperHasAnswer = currentHelperScreenshots.every(s => s.answer && s.answer.trim() !== '');

                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'update_helper_card',
                                        helperId: helperIdOfDeletedScreenshot,
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
            } else if (data.type === 'test') {
                console.log(`Сервер: Получен тестовый пинг от клиента: ${data.message}, helperId: ${data.helperId}`);
                ws.send(JSON.stringify({ type: 'test_response', message: 'Pong from server' }));
            } else if (data.type === 'pageHTML') {
                console.log(`Сервер: Получен HTML страницы от helperId: ${data.helperId}`);
                // Здесь можно добавить логику для обработки HTML, если требуется
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
            console.log('Сервер: Фронтенд-клиент удален, активных фронтенд-клиентов: ', frontendClients.size);
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

    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`Сервер: Получен pong от клиента, helperId: ${currentHelperId || 'unknown'}`);
    });
});

const pingInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
            console.log('Сервер: Клиент не отвечает на пинг, разрыв соединения.');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
        console.log('Сервер: Отправлен ping клиенту.');
    });
}, 30000);

wss.on('close', () => {
    clearInterval(pingInterval);
});

function keepServerAwake() {
    const healthCheckInterval = 600000; // 10 минут
    const logInterval = 600000; // 10 минут
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}/healthz`;

    // Функция для отправки логов о состоянии сервера
    function logServerStatus() {
        const status = {
            timestamp: new Date().toISOString(),
            status: 'active',
            helpersCount: helperClients.size,
            frontendsCount: frontendClients.size,
            screenshotsCount: Array.from(screenshotsByHelper.values()).reduce((acc, val) => acc + val.length, 0),
            memoryUsage: process.memoryUsage()
        };
        console.log('Сервер: Статус сервера:', JSON.stringify(status, null, 2));
    }

    // Запускаем периодические проверки здоровья
    setInterval(async () => {
        try {
            const response = await axios.get(url);
            console.log(`Сервер: Успешный пинг на ${url} в ${new Date().toISOString()}: Статус ${response.status}`);
        } catch (error) {
            console.error(`Сервер: Ошибка пинга на ${url} в ${new Date().toISOString()}:`, error.message);
        }
    }, healthCheckInterval);

    // Запускаем периодическое логирование
    setInterval(logServerStatus, logInterval);
    
    // Первое логирование при запуске
    logServerStatus();
}

keepServerAwake();

server.listen(PORT, async () => {
    console.log(`Сервер запущен на порту: ${PORT}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${PORT}`);
    await loadExistingScreenshots();
});
