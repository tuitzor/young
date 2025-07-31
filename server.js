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
    const { screenshot, tempQuestionId, helperId, bypassAuth } = req.body;
    console.log('Сервер: Получен POST-запрос /api/upload-screenshot:', { tempQuestionId, helperId, bypassAuth });

    if (!screenshot || !tempQuestionId || !helperId || !bypassAuth) {
        console.error('Сервер: Неверные данные скриншота:', { screenshot: !!screenshot, tempQuestionId, helperId, bypassAuth });
        return res.status(400).json({ success: false, message: 'Неверные данные скриншота или отсутствует bypassAuth.' });
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

            frontendClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    console.log('Сервер: Отправка screenshot_info клиенту:', client);
                    client.send(JSON.stringify({
                        type: 'screenshot_info',
                        questionId: imageUrl,
                        imageUrl,
                        helperId
                    }));
                } else {
                    console.log('Сервер: Клиент не активен:', client);
                }
            });
        }

        res.status(200).json({ success: true, message: 'Скриншот успешно загружен', imageUrl });
    } catch (err) {
        console.error('Сервер: Ошибка при сохранении скриншота:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера при сохранении скриншота.' });
    }
});

async function ensureScreenshotsDir() {
    try {
        await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
        console.log('Сервер: Папка screenshots создана или уже существует:', SCREENSHOTS_DIR);
    } catch (error) {
        console.error(`Сервер: Ошибка при создании папки для скриншотов: ${error}`);
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
    res.status(200).json({ helpers });
});

app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('URL изображения не предоставлен.');

    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(response.data);
    } catch (error) {
        if (error.response?.status === 404) {
            return res.status(404).send('Изображение не найдено на удаленном сервере.');
        }
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
            }
        });
        console.log('Сервер: Загружены существующие скриншоты:', screenshotsByHelper);
    } catch (err) {
        console.error('Сервер: Ошибка при чтении папки скриншотов:', err);
    }
}

async function clearHelperScreenshots(helperId) {
    if (!helperId) return;

    try {
        const files = await fs.readdir(SCREENSHOTS_DIR);
        const filesToDelete = files.filter(file => file.startsWith(`${helperId}-`));

        for (const file of filesToDelete) {
            try {
                await fs.unlink(path.join(SCREENSHOTS_DIR, file));
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
                console.error(`Сервер: Ошибка при удалении файла:`, unlinkErr);
            }
        }

        if (screenshotsByHelper.has(helperId) && screenshotsByHelper.get(helperId).length === 0) {
            screenshotsByHelper.delete(helperId);
            frontendClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'helper_deleted',
                        helperId
                    }));
                }
            });
        }
    } catch (err) {
        console.error(`Сервер: Ошибка при чтении папки скриншотов:`, err);
    }
}

wss.on('connection', (ws) => {
    let currentHelperId = null;
    let isFrontend = false;

    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            console.log('Сервер: Получено WebSocket-сообщение:', data);

            if (data.role === 'helper') {
                currentHelperId = data.helperId;
                if (currentHelperId) {
                    helperClients.set(currentHelperId, ws);
                    console.log('Сервер: Зарегистрирован помощник:', currentHelperId);

                    if (screenshotsByHelper.has(currentHelperId)) {
                        screenshotsByHelper.get(currentHelperId).forEach(screenshot => {
                            if (screenshot.answer) {
                                ws.send(JSON.stringify({
                                    type: 'answer',
                                    questionId: screenshot.questionId,
                                    answer: screenshot.answer,
                                    clientId: currentHelperId
                                }));
                            }
                        });
                    }
                } else {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Требуется helperId для помощников'
                    }));
                }
            } else if (data.type === 'frontend_connect') {
                if (!frontendClients.has(ws)) {
                    if (!data.token) {
                        return ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Требуется токен авторизации'
                        }));
                    }

                    try {
                        jwt.verify(data.token, JWT_SECRET);
                        isFrontend = true;
                        frontendClients.add(ws);
                        console.log('Сервер: Зарегистрирован фронтенд-клиент');

                        const initialData = Array.from(screenshotsByHelper.entries()).map(([helperId, screenshots]) => ({
                            helperId,
                            hasAnswer: screenshots.every(s => s.answer)
                        }));

                        ws.send(JSON.stringify({
                            type: 'initial_data',
                            data: initialData
                        }));
                    } catch (err) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Неверный или истекший токен'
                        }));
                    }
                }
            } else if (data.type === 'submit_answer') {
                const { questionId, answer, adminUsername } = data;

                let targetHelperId = null;
                let foundScreenshot = null;

                for (const [helperId, screenshots] of screenshotsByHelper) {
                    foundScreenshot = screenshots.find(s => s.questionId === questionId);
                    if (foundScreenshot) {
                        targetHelperId = helperId;
                        break;
                    }
                }

                if (!foundScreenshot || !targetHelperId) {
                    return ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Скриншот не найден'
                    }));
                }

                foundScreenshot.answer = answer;
                foundScreenshot.answeredAt = new Date().toISOString();
                foundScreenshot.answeredBy = adminUsername || 'unknown';

                const targetHelperWs = helperClients.get(targetHelperId);
                if (targetHelperWs?.readyState === WebSocket.OPEN) {
                    targetHelperWs.send(JSON.stringify({
                        type: 'answer',
                        questionId,
                        answer,
                        answeredBy: adminUsername || 'unknown',
                        answeredAt: new Date().toISOString(),
                        clientId: targetHelperId
                    }));
                    console.log('Сервер: Ответ отправлен помощнику:', targetHelperId);
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

                        frontendClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'screenshot_deleted_specific',
                                    questionId
                                }));
                            }
                        });

                        if (screenshotsByHelper.has(helperIdOfDeletedScreenshot) &&
                            screenshotsByHelper.get(helperIdOfDeletedScreenshot).length === 0) {
                            screenshotsByHelper.delete(helperIdOfDeletedScreenshot);
                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'helper_deleted',
                                        helperId: helperIdOfDeletedScreenshot
                                    }));
                                }
                            });
                        }
                    } catch (err) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Ошибка при удалении скриншота.'
                        }));
                    }
                } else {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Скриншот не найден.'
                    }));
                }
            } else if (data.type === 'request_helper_screenshots') {
                const { helperId: requestedHelperId } = data;
                ws.send(JSON.stringify({
                    type: 'screenshots_by_helperId',
                    helperId: requestedHelperId,
                    screenshots: screenshotsByHelper.get(requestedHelperId) || []
                }));
            } else if (data.type === 'test') {
                ws.send(JSON.stringify({
                    type: 'test_response',
                    message: 'Pong from server'
                }));
            }

        } catch (error) {
            console.error('Сервер: Ошибка обработки WebSocket-сообщения:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Неверный формат сообщения.'
            }));
        }
    });

    ws.on('close', async () => {
        if (isFrontend) {
            frontendClients.delete(ws);
            console.log('Сервер: Фронтенд-клиент отключен');
        } else if (currentHelperId) {
            helperClients.delete(currentHelperId);
            await clearHelperScreenshots(currentHelperId);
            console.log('Сервер: Помощник отключен:', currentHelperId);
        }
    });

    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);
});

const pingInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

server.listen(PORT, async () => {
    console.log(`Сервер запущен на порту: ${PORT}`);
    await loadExistingScreenshots();
});
