const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
const port = process.env.PORT || 10000;
const secretKey = 'your-secret-key'; // Замените на безопасный ключ в продакшене

app.use(express.json());
app.use('/screenshots', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
}, express.static(path.join(__dirname, 'public/screenshots')));

// Добавляем обработчик для корневого маршрута
app.get('/', (req, res) => {
    res.send('Сервер работает! Добро пожаловать!');
});

const wss = new WebSocket.Server({ server: app.listen(port, () => {
    console.log(`Сервер запущен на порту: ${port}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${port}`);
}) });

const screenshotDir = path.join(__dirname, 'public/screenshots');
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log('Сервер: Папка для скриншотов создана:', screenshotDir);
}

const helperData = new Map();
const screenshotCache = new Map();
const clients = new Map();

function loadExistingScreenshots() {
    fs.readdirSync(screenshotDir).forEach(file => {
        const match = file.match(/^helper-([^-]+)-(\d+-\d+)\.png$/);
        if (match) {
            const helperId = `helper-${match[1]}`;
            const questionId = `${helperId}-${match[2]}`;
            const clientId = 'legacy';
            if (!helperData.has(helperId)) {
                helperData.set(helperId, { hasAnswer: false, screenshots: [] });
            }
            helperData.get(helperId).screenshots.push({ questionId, imageUrl: `/screenshots/${file}`, clientId });
        }
    });
    console.log(`Сервер: Загружено ${helperData.size} помощников с ${Array.from(helperData.values()).reduce((sum, h) => sum + h.screenshots.length, 0)} скриншотами`);
}

loadExistingScreenshots();

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const validCredentials = {
        'AYAZ': 'AYAZ1',
        'admin1': 'admin1A',
        'admin2': 'admin2A'
    };

    if (validCredentials[username] && validCredentials[username] === password) {
        const token = jwt.sign({ username }, secretKey, { expiresIn: '1h' });
        res.json({ token });
    } else {
        res.status(401).json({ message: 'Неверное имя пользователя или пароль' });
    }
});

wss.on('connection', (ws) => {
    console.log('Сервер: Новый клиент подключился по WebSocket');
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`Сервер: Получен pong от клиента, helperId: ${ws.helperId || 'unknown'}, clientId: ${ws.clientId || 'unknown'}`);
    });

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log('Сервер: Получено сообщение по WS:', data);
        } catch (err) {
            console.error('Сервер: Ошибка разбора сообщения:', err);
            return;
        }

        if (data.type === 'frontend_connect' && data.role === 'frontend') {
            ws.clientId = data.clientId;
            clients.set(data.clientId, ws);
            console.log(`Сервер: Фронтенд-клиент идентифицирован, clientId: ${data.clientId}, активных фронтенд-клиентов: ${clients.size}`);
            const initialData = Array.from(helperData.entries()).map(([helperId, info]) => ({
                helperId,
                hasAnswer: info.hasAnswer
            }));
            ws.send(JSON.stringify({ type: 'initial_data', data: initialData, clientId: data.clientId }));
            const cachedScreenshots = screenshotCache.get(data.clientId) || [];
            cachedScreenshots.forEach(screenshot => {
                ws.send(JSON.stringify({ type: 'screenshot_info', ...screenshot }));
            });
            screenshotCache.delete(data.clientId);
        } else if (data.type === 'helper_connect' && data.role === 'helper') {
            ws.helperId = data.helperId;
            if (!helperData.has(data.helperId)) {
                helperData.set(data.helperId, { hasAnswer: false, screenshots: [] });
            }
            console.log(`Сервер: Подключился помощник с ID: ${data.helperId}, активных помощников: ${helperData.size}`);
        } else if (data.type === 'screenshot') {
            console.time(`save-screenshot-${data.helperId}`);
            const timestamp = Date.now();
            const filename = `${data.helperId}-${timestamp}-0.png`;
            const screenshotPath = path.join(screenshotDir, filename);
            const buffer = Buffer.from(data.dataUrl.split(',')[1], 'base64');
            sharp(buffer)
                .resize({ width: 1280 })
                .png({ quality: 80 })
                .toFile(screenshotPath)
                .then(() => {
                    console.log(`Сервер: Скриншот сохранен: ${screenshotPath}`);
                    const imageUrl = `/screenshots/${filename}`;
                    const questionId = `${data.helperId}-${timestamp}-0`;
                    if (!helperData.has(data.helperId)) {
                        helperData.set(data.helperId, { hasAnswer: false, screenshots: [] });
                    }
                    helperData.get(data.helperId).screenshots.push({ questionId, imageUrl, answer: '', clientId: data.clientId });
                    const frontendClient = clients.get(data.clientId);
                    if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                        frontendClient.send(JSON.stringify({
                            type: 'screenshot_info',
                            questionId,
                            imageUrl,
                            helperId: data.helperId,
                            clientId: data.clientId
                        }));
                        console.log(`Сервер: Сообщение о скриншоте отправлено клиенту ${data.clientId}`);
                    } else {
                        console.log(`Сервер: Клиент ${data.clientId} не найден, кэшируем скриншот`);
                        const cache = screenshotCache.get(data.clientId) || [];
                        cache.push({ questionId, imageUrl, helperId: data.helperId, clientId: data.clientId });
                        screenshotCache.set(data.clientId, cache);
                    }
                    console.timeEnd(`save-screenshot-${data.helperId}`);
                })
                .catch(err => {
                    console.error('Сервер: Ошибка сохранения скриншота:', err);
                });
        } else if (data.type === 'submit_answer') {
            for (const [helperId, info] of helperData.entries()) {
                const screenshot = info.screenshots.find(s => s.questionId === data.questionId);
                if (screenshot) {
                    screenshot.answer = data.answer;
                    info.hasAnswer = info.screenshots.every(s => s.answer && s.answer.trim() !== '');
                    const frontendClient = clients.get(data.clientId);
                    if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                        frontendClient.send(JSON.stringify({
                            type: 'answer',
                            questionId: data.questionId,
                            answer: data.answer,
                            clientId: data.clientId
                        }));
                        frontendClient.send(JSON.stringify({
                            type: 'update_helper_card',
                            helperId,
                            hasAnswer: info.hasAnswer,
                            clientId: data.clientId
                        }));
                    }
                    break;
                }
            }
        } else if (data.type === 'delete_screenshot') {
            for (const [helperId, info] of helperData.entries()) {
                const screenshotIndex = info.screenshots.findIndex(s => s.questionId === data.questionId);
                if (screenshotIndex !== -1) {
                    const screenshot = info.screenshots[screenshotIndex];
                    info.screenshots.splice(screenshotIndex, 1);
                    fs.unlink(path.join(screenshotDir, path.basename(screenshot.questionId)), (err) => {
                        if (err) {
                            console.error(`Сервер: Ошибка удаления файла ${screenshot.questionId}:`, err);
                        } else {
                            console.log(`Сервер: Файл удален: ${screenshot.questionId}`);
                        }
                    });
                    const frontendClient = clients.get(data.clientId);
                    if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                        frontendClient.send(JSON.stringify({
                            type: 'screenshot_deleted_specific',
                            questionId: data.questionId,
                            clientId: data.clientId
                        }));
                    }
                    if (info.screenshots.length === 0) {
                        helperData.delete(helperId);
                        const frontendClient = clients.get(data.clientId);
                        if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                            frontendClient.send(JSON.stringify({
                                type: 'helper_deleted',
                                helperId,
                                clientId: data.clientId
                            }));
                        }
                    }
                    break;
                }
            }
        } else if (data.type === 'request_helper_screenshots') {
            const helperInfo = helperData.get(data.helperId);
            if (helperInfo) {
                const screenshots = helperInfo.screenshots.filter(s => !s.clientId || s.clientId === data.clientId);
                const frontendClient = clients.get(data.clientId);
                if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                    frontendClient.send(JSON.stringify({
                        type: 'screenshots_by_helperId',
                        helperId: data.helperId,
                        screenshots,
                        clientId: data.clientId
                    }));
                    console.log(`Сервер: Отправка ${screenshots.length} скриншотов для helperId ${data.helperId} фронтенду ${data.clientId}`);
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился');
        if (ws.clientId) {
            clients.delete(ws.clientId);
            console.log(`Сервер: Фронтенд-клиент удален, clientId: ${ws.clientId}, активных фронтенд-клиентов: ${clients.size}`);
        }
        if (ws.helperId) {
            console.log(`Сервер: Помощник с ID: ${ws.helperId} отключился. Запускаю очистку скриншотов`);
            const helperInfo = helperData.get(ws.helperId);
            if (helperInfo) {
                console.log(`Сервер: Удаление ${helperInfo.screenshots.length} скриншотов для helperId: ${ws.helperId}`);
                helperInfo.screenshots.forEach(screenshot => {
                    fs.unlink(path.join(screenshotDir, path.basename(screenshot.questionId)), (err) => {
                        if (err) {
                            console.error(`Сервер: Ошибка удаления файла ${screenshot.questionId}:`, err);
                        } else {
                            console.log(`Сервер: Файл удален: ${screenshot.questionId}`);
                        }
                    });
                });
                helperData.delete(ws.helperId);
            }
        }
    });
});

setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
        console.log('Сервер: Отправлен ping клиенту');
    });
}, 30000);

app.get('/status', (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        status: 'active',
        helpersCount: helperData.size,
        frontendsCount: clients.size,
        screenshotsCount: Array.from(helperData.values()).reduce((sum, h) => sum + h.screenshots.length, 0),
        memoryUsage: process.memoryUsage()
    });
});

app.get('/list-screenshots', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) return res.status(500).send('Ошибка чтения папки');
        res.json(files);
    });
});
