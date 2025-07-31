\const express = require('express');
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
const JWT_SECRET = process.env.JWT_SECRET || 'your-secure-jwt-secret';

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

const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Требуется токен авторизации' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Неверный или истекший токен' });
    }
};

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

app.get('/api/admin/list', authenticateAdmin, (req, res) => {
    const adminList = admins.map(admin => ({ username: admin.username }));
    res.status(200).json({ success: true, admins: adminList });
});

app.post('/api/upload-screenshot', async (req, res) => {
    const { screenshot, tempQuestionId, helperId } = req.body;
    console.log('Сервер: Получен POST-запрос /api/upload-screenshot:', { tempQuestionId, helperId });

    if (!screenshot || !tempQuestionId || !helperId) {
        console.error('Сервер: Неверные данные скриншота:', { screenshot: !!screenshot, tempQuestionId, helperId });
        return res.status(400).json({ success: false, message: 'Неверные данные скриншота.' });
    }

    if (!tempQuestionId.match(/^helper-[\w-]+-\d+-\d+$/) || !helperId.match(/^helper-[\w-]+-\d+$/)) {
        console.error('Сервер: Неверный формат tempQuestionId или helperId:', { tempQuestionId, helperId });
        return res.status(400).json({ success: false, message: 'Неверный формат tempQuestionId или helperId.' });
    }

    try {
        console.log('Сервер: Сохранение скриншота:', tempQuestionId);
        const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
        const filename = `${tempQuestionId}.png`;
        const filepath = path.join(SCREENSHOTS_DIR, filename);

        await fs.writeFile(filepath, base64Data, 'base64');
        const imageUrl = `/screenshots/${filename}`;
        console.log('Сервер: Скриншот сохранен:', imageUrl);

        if (!screenshotsByHelper.has(helperId)) {
            screenshotsByHelper.set(helperId, []);
        }

        if (!screenshotsByHelper.get(helperId).some(s => s.questionId === imageUrl)) {
            screenshotsByHelper.get(helperId).push({
                questionId: imageUrl,
                imageUrl,
                helperId,
                answer: ''
            });
            console.log('Сервер: Скриншот добавлен в коллекцию:', helperId, imageUrl);

            let sentCount = 0;
            frontendClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.helperId === helperId) {
                    client.send(JSON.stringify({
                        type: 'screenshot_info',
                        questionId: imageUrl,
                        imageUrl,
                        helperId
                    }));
                    sentCount++;
                }
            });
            console.log(`Сервер: Отправлено ${sentCount} сообщений screenshot_info для helperId: ${helperId}`);
        }

        res.status(200).json({ success: true, message: 'Скриншот успешно загружен', imageUrl });
    } catch (err) {
        console.error('Сервер: Ошибка при сохранении скриншота:', err.message, err.stack);
        res.status(500).json({ success: false, message: 'Ошибка сервера при сохранении скриншота.' });
    }
});

async function ensureScreenshotsDir() {
    try {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        console.log('Сервер: Папка screenshots создана или уже существует:', SCREENSHOTS_DIR);
    } catch (error) {
        console.error(`Сервер: Ошибка при создании папки для скриншотов: ${error.message}`);
    }
}

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
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(response.data);
    } catch (error) {
        if (error.response?.status === 404) {
            return res.status(404).send('Изображение не найдено на удаленном сервере.');
        }
        console.error('Сервер: Ошибка проксирования изображения:', imageUrl, error.message);
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
            if (parts.length >= 4 && parts[0] === 'helper') {
                const helperId = `${parts[0]}-${parts[1]}-${parts[2]}`;
                const imageUrl = `/screenshots/${file}`;

                if (!screenshotsByHelper.has(helperId)) {
                    screenshotsByHelper.set(helperId, []);
                }
                screenshotsByHelper.get(helperId).push({
                    questionId: imageUrl,
                    imageUrl,
                    helperId,
                    answer: ''
                });
            } else {
                console.warn(`Сервер: Неожиданный формат имени файла скриншота: ${file}. Пропуск.`);
            }
        });
        console.log(`Сервер: Загружено ${screenshotFiles.length} существующих скриншотов для ${screenshotsByHelper.size} помощников.`);
    } catch (err) {
        console.error('Сервер: Ошибка при чтении папки скриншотов:', err.message);
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
                    if (client.readyState === WebSocket.OPEN && client.helperId === helperId) {
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
                    if (client.readyState === WebSocket.OPEN && client.helperId === helperId) {
                        client.send(JSON.stringify({
                            type: 'screenshot_deleted_specific',
                            questionId: deletedImageUrl
                        }));
                    }
                });
            } catch (unlinkErr) {
                console.error(`Сервер: Ошибка при удалении файла ${filePath}:`, unlinkErr.message);
            }
        }

        if (screenshotsByHelper.has(helperId) && screenshotsByHelper.get(helperId).length === 0) {
            screenshotsByHelper.delete(helperId);
            frontendClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.helperId === helperId) {
                    client.send(JSON.stringify({ type: 'helper_deleted', helperId }));
                }
            });
        }
    } catch (err) {
        console.error(`Сервер: Ошибка при чтении папки скриншотов для удаления ${helperId}:`, err.message);
    }
}

wss.on('connection', (ws) => {
    let currentHelperId = null;

    console.log('Сервер: Новый клиент подключился по WebSocket');

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            console.log('Сервер: Получено сообщение по WS:', {
                type: data.type,
                role: data.role || 'unknown',
                helperId: data.helperId || 'none',
                questionId: data.tempQuestionId || 'none'
            });

            if (data.role === 'helper') {
                currentHelperId = data.helperId;
                if (currentHelperId && currentHelperId.match(/^helper-[\w-]+-\d+$/)) {
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
                                console.log(`Сервер: Отправлен сохраненный ответ для helperId: ${currentHelperId}, questionId: ${screenshot.questionId}`);
                            }
                        });
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Требуется корректный helperId для помощников' }));
                }
            } else if (data.type === 'frontend_connect') {
                if (!frontendClients.has(ws)) {
                    if (!data.token || !data.helperId || data.helperId === 'none' || !data.helperId.match(/^helper-[\w-]+-\d+$/)) {
                        console.warn('Сервер: Неверный токен или helperId в frontend_connect:', { token: !!data.token, helperId: data.helperId });
                        return ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Требуется токен авторизации и корректный helperId'
                        }));
                    }

                    try {
                        jwt.verify(data.token, JWT_SECRET);
                        ws.helperId = data.helperId;
                        frontendClients.add(ws);
                        console.log(`Сервер: Фронтенд-клиент идентифицирован для helperId: ${ws.helperId}, активных фронтенд-клиентов: ${frontendClients.size}`);

                        const screenshots = screenshotsByHelper.get(data.helperId) || [];
                        const initialData = screenshots.length > 0 ? [{
                            helperId: data.helperId,
                            hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== '')
                        }] : [];

                        ws.send(JSON.stringify({
                            type: 'initial_data',
                            data: initialData
                        }));
                        console.log(`Сервер: Отправлено ${initialData.length} helperId фронтенд-клиенту для helperId: ${data.helperId}`);

                        ws.send(JSON.stringify({
                            type: 'screenshots_by_helperId',
                            helperId: data.helperId,
                            screenshots: screenshots
                        }));
                        console.log(`Сервер: Отправлено ${screenshots.length} скриншотов для helperId: ${data.helperId}`);
                    } catch (err) {
                        console.error('Сервер: Ошибка проверки токена:', err.message);
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Неверный или истекший токен'
                        }));
                    }
                }
            } else if (data.type === 'screenshot') {
                const { screenshot, tempQuestionId, helperId } = data;
                if (!screenshot || !tempQuestionId || !helperId) {
                    console.error('Сервер: Неверные данные скриншота:', { screenshot: !!screenshot, tempQuestionId, helperId });
                    ws.send(JSON.stringify({ type: 'error', message: 'Неверные данные скриншота.' }));
                    return;
                }

                if (!tempQuestionId.match(/^helper-[\w-]+-\d+-\d+$/) || !helperId.match(/^helper-[\w-]+-\d+$/)) {
                    console.error('Сервер: Неверный формат tempQuestionId или helperId:', { tempQuestionId, helperId });
                    ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат tempQuestionId или helperId.' }));
                    return;
                }

                try {
                    console.log('Сервер: Сохранение скриншота:', tempQuestionId);
                    const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
                    const filename = `${tempQuestionId}.png`;
                    const filepath = path.join(SCREENSHOTS_DIR, filename);

                    await fs.writeFile(filepath, base64Data, 'base64');
                    const imageUrl = `/screenshots/${filename}`;
                    console.log('Сервер: Скриншот сохранен:', imageUrl);

                    if (!screenshotsByHelper.has(helperId)) {
                        screenshotsByHelper.set(helperId, []);
                    }

                    if (!screenshotsByHelper.get(helperId).some(s => s.questionId === imageUrl)) {
                        screenshotsByHelper.get(helperId).push({
                            questionId: imageUrl,
                            imageUrl,
                            helperId,
                            answer: ''
                        });
                        console.log('Сервер: Скриншот добавлен в коллекцию:', helperId, imageUrl);

                        let sentCount = 0;
                        frontendClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && client.helperId === helperId) {
                                client.send(JSON.stringify({
                                    type: 'screenshot_info',
                                    questionId: imageUrl,
                                    imageUrl,
                                    helperId
                                }));
                                sentCount++;
                            }
                        });
                        console.log(`Сервер: Отправлено ${sentCount} сообщений screenshot_info для helperId: ${helperId}`);
                        if (sentCount === 0) {
                            console.warn('Сервер: Нет активных фронтенд-клиентов для helperId:', helperId);
                        }
                    }
                } catch (err) {
                    console.error('Сервер: Ошибка при сохранении скриншота:', err.message, err.stack);
                    ws.send(JSON.stringify({ type: 'error', message: 'Ошибка сервера при сохранении скриншота.' }));
                }
            } else if (data.type === 'submit_answer') {
                const { questionId, answer } = data;

                let foundScreenshot = null;
                let targetHelperId = null;
                for (const [hId, screenshots] of screenshotsByHelper) {
                    foundScreenshot = screenshots.find(s => s.questionId === questionId);
                    if (foundScreenshot) {
                        targetHelperId = hId;
                        break;
                    }
                }

                if (foundScreenshot && targetHelperId) {
                    foundScreenshot.answer = answer;
                    foundScreenshot.answeredAt = new Date().toISOString();
                    foundScreenshot.answeredBy = data.adminUsername || 'unknown';

                    const targetHelperWs = helperClients.get(targetHelperId);
                    if (targetHelperWs && targetHelperWs.readyState === WebSocket.OPEN) {
                        targetHelperWs.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer
                        }));
                        console.log(`Сервер: Ответ отправлен помощнику helperId: ${targetHelperId}, questionId: ${questionId}`);
                    } else {
                        console.warn(`Сервер: Помощник с ID: ${targetHelperId} не найден или его WS закрыт`);
                    }

                    frontendClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.helperId === targetHelperId) {
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
                    console.warn(`Сервер: Скриншот с questionId ${questionId} не найден`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Скриншот не найден.' }));
                }
            } else if (data.type === 'delete_screenshot') {
                const { questionId } = data;
                const filename = path.basename(questionId);
                const filepath = path.join(SCREENSHOTS_DIR, filename);

                let helperIdOfDeletedScreenshot = null;
                for (const [hId, screenshots] of screenshotsByHelper) {
                    const initialLength = screenshots.length;
                    screenshotsByHelper.set(hId, screenshots.filter(s => s.questionId !== questionId));
                    if (screenshotsByHelper.get(hId).length < initialLength) {
                        helperIdOfDeletedScreenshot = hId;
                        break;
                    }
                }

                if (helperIdOfDeletedScreenshot) {
                    try {
                        await fs.unlink(filepath);
                        console.log(`Сервер: Файл скриншота удален: ${filepath}`);

                        frontendClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && client.helperId === helperIdOfDeletedScreenshot) {
                                client.send(JSON.stringify({
                                    type: 'screenshot_deleted_specific',
                                    questionId
                                }));
                            }
                        });

                        if (screenshotsByHelper.has(helperIdOfDeletedScreenshot) && screenshotsByHelper.get(helperIdOfDeletedScreenshot).length === 0) {
                            screenshotsByHelper.delete(helperIdOfDeletedScreenshot);
                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN && client.helperId === helperIdOfDeletedScreenshot) {
                                    client.send(JSON.stringify({
                                        type: 'helper_deleted',
                                        helperId: helperIdOfDeletedScreenshot
                                    }));
                                }
                            });
                        }
                    } catch (err) {
                        console.error(`Сервер: Ошибка при удалении файла скриншота ${filepath}:`, err.message);
                        ws.send(JSON.stringify({ type: 'error', message: 'Ошибка при удалении скриншота.' }));
                    }
                } else {
                    console.warn(`Сервер: Скриншот с questionId ${questionId} не найден`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Скриншот не найден.' }));
                }
            } else if (data.type === 'request_helper_screenshots') {
                const { helperId: requestedHelperId } = data;
                if (!requestedHelperId || !requestedHelperId.match(/^helper-[\w-]+-\d+$/)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат helperId.' }));
                    return;
                }
                const screenshots = screenshotsByHelper.get(requestedHelperId) || [];
                console.log(`Сервер: Отправка ${screenshots.length} скриншотов для helperId ${requestedHelperId}`);
                ws.send(JSON.stringify({
                    type: 'screenshots_by_helperId',
                    helperId: requestedHelperId,
                    screenshots
                }));
            } else if (data.type === 'test') {
                console.log(`Сервер: Получен тестовый пинг от клиента: ${data.message}, helperId: ${data.helperId}`);
                ws.send(JSON.stringify({ type: 'test_response', message: 'Pong from server' }));
            } else if (data.type === 'pageHTML') {
                console.log(`Сервер: Получен HTML страницы от helperId: ${data.helperId}`);
            }
        } catch (error) {
            console.error('Сервер: Ошибка при разборе сообщения:', error.message, error.stack);
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат сообщения.' }));
        }
    });

    ws.on('close', async () => {
        console.log('Сервер: Клиент отключился');
        if (frontendClients.has(ws)) {
            frontendClients.delete(ws);
            console.log(`Сервер: Фронтенд-клиент отключен, helperId: ${ws.helperId || 'unknown'}, активных фронтенд-клиентов: ${frontendClients.size}`);
        }
        if (currentHelperId && helperClients.get(currentHelperId) === ws) {
            helperClients.delete(currentHelperId);
            await clearHelperScreenshots(currentHelperId);
            console.log(`Сервер: Помощник отключен, helperId: ${currentHelperId}`);
        }
    });

    ws.on('error', error => {
        console.error('Сервер: Ошибка WebSocket:', error.message);
    });

    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`Сервер: Получен pong от клиента, helperId: ${ws.helperId || currentHelperId || 'unknown'}`);
    });
});

const pingInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) {
            console.log('Сервер: Клиент не отвечает на пинг, разрыв соединения');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
        console.log('Сервер: Отправлен ping клиенту');
    });
}, 30000);

wss.on('close', () => {
    clearInterval(pingInterval);
    console.log('Сервер: WebSocket-сервер закрыт');
});

function keepServerAwake() {
    const healthCheckInterval = 600000; // 10 минут
    const logInterval = 600000; // 10 минут
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}/healthz`;

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

    setInterval(async () => {
        try {
            const response = await axios.get(url);
            console.log(`Сервер: Успешный пинг на ${url} в ${new Date().toISOString()}: Статус ${response.status}`);
        } catch (error) {
            console.error(`Сервер: Ошибка пинга на ${url} в ${new Date().toISOString()}:`, error.message);
        }
    }, healthCheckInterval);

    setInterval(logServerStatus, logInterval);
    logServerStatus();
}

keepServerAwake();

server.listen(PORT, async () => {
    console.log(`Сервер запущен на порту: ${PORT}`);
    await loadExistingScreenshots();
});
