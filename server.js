const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 10000;
const secretKey = 'your-secret-key'; // Замените на безопасный ключ в продакшене

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'public/screenshots')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/keep-alive', (req, res) => {
    console.log('Сервер: Получен keep-alive запрос');
    res.json({ status: 'active', timestamp: new Date().toISOString() });
});

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const validCredentials = {
        'AYAZ': 'AYAZ1',
        'admin1': 'admin1A',
        'admin2': 'admin2A',
        'admin3': 'admin3A',
        'admin4': 'admin4A',
        'admin5': 'admin5A'
    };

    if (validCredentials[username] && validCredentials[username] === password) {
        const token = jwt.sign({ username }, secretKey, { expiresIn: '1h' });
        res.json({ token });
    } else {
        res.status(401).json({ message: 'Неверное имя пользователя или пароль' });
    }
});

app.get('/api/check-auth', (req, res) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Токен отсутствует' });

    jwt.verify(token, secretKey, (err, decoded) => {
        if (err) return res.status(401).json({ message: 'Неверный или истёкший токен' });
        res.json({ authenticated: true, username: decoded.username });
    });
});

const wss = new WebSocket.Server({ server: app.listen(port, () => {
    console.log(`Сервер запущен на порту: ${port}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${port}`);
    loadHelperData(); // Загрузка данных при старте
}) });

const screenshotDir = path.join(__dirname, 'public/screenshots');
const dataFile = path.join(__dirname, 'helperData.json');
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log('Сервер: Папка для скриншотов создана:', screenshotDir);
}

let helperData = new Map();

function saveHelperData() {
    const data = Object.fromEntries(helperData);
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
    console.log('Сервер: Данные helperData сохранены в', dataFile);
}

function loadHelperData() {
    if (fs.existsSync(dataFile)) {
        const rawData = fs.readFileSync(dataFile, 'utf8');
        const data = JSON.parse(rawData);
        helperData = new Map(Object.entries(data).map(([key, value]) => [key, value]));
        console.log('Сервер: Данные helperData загружены из', dataFile);
    } else {
        console.log('Сервер: Файл helperData.json не найден, начата новая сессия');
    }
}

// Сохранение данных перед завершением
process.on('SIGTERM', () => {
    saveHelperData();
    process.exit(0);
});
process.on('SIGINT', () => {
    saveHelperData();
    process.exit(0);
});

const clients = new Map();    // clientId -> WebSocket
const helpers = new Map();    // helperId -> WebSocket

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
            ws.clientId = data.clientId || `anonymous-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            clients.set(ws.clientId, ws);
            console.log(`Сервер: Фронтенд-клиент идентифицирован, clientId: ${ws.clientId}, активных фронтенд-клиентов: ${clients.size}`);
            const initialData = Array.from(helperData.entries()).map(([helperId, screenshots]) => ({
                helperId,
                hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== '')
            }));
            ws.send(JSON.stringify({ type: 'initial_data', data: initialData, clientId: ws.clientId }));
        } else if (data.type === 'request_initial_data') {
            const initialData = Array.from(helperData.entries()).map(([helperId, screenshots]) => ({
                helperId,
                hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== '')
            }));
            ws.send(JSON.stringify({ type: 'initial_data', data: initialData, clientId: data.clientId || 'anonymous' }));
        } else if (data.type === 'helper_connect' && data.role === 'helper') {
            ws.helperId = data.helperId;
            helpers.set(data.helperId, ws);
            if (!helperData.has(data.helperId)) {
                helperData.set(data.helperId, []);
            }
            console.log(`Сервер: Подключился помощник с ID: ${data.helperId}, активных помощников: ${helpers.size}`);
            saveHelperData(); // Сохранение при подключении нового помощника
        } else if (data.type === 'screenshot') {
            const uniqueTimeLabel = `save-screenshot-${data.helperId}-${Date.now()}`;
            console.time(uniqueTimeLabel);
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
                        helperData.set(data.helperId, []);
                    }
                    helperData.get(data.helperId).push({ questionId, imageUrl, clientId: data.clientId || null, answer: '' });
                    saveHelperData(); // Сохранение после добавления скриншота
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.clientId && client.clientId !== data.clientId) {
                            client.send(JSON.stringify({
                                type: 'screenshot_info',
                                questionId,
                                imageUrl,
                                helperId: data.helperId,
                                clientId: client.clientId
                            }));
                            console.log(`Сервер: Сообщение о скриншоте отправлено фронтенду ${client.clientId}`);
                        }
                    });
                    console.timeEnd(uniqueTimeLabel);
                })
                .catch(err => {
                    console.error('Сервер: Ошибка сохранения скриншота:', err);
                    console.timeEnd(uniqueTimeLabel);
                });
        } else if (data.type === 'submit_answer') {
            const { questionId, answer, clientId } = data;
            for (const [helperId, screenshots] of helperData.entries()) {
                const screenshot = screenshots.find(s => s.questionId === questionId);
                if (screenshot) {
                    screenshot.answer = answer;
                    const targetClientId = screenshot.clientId;
                    const hasAnswer = screenshots.every(s => s.answer && s.answer.trim() !== '');
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.clientId) {
                            if (client.clientId === targetClientId) {
                                client.send(JSON.stringify({
                                    type: 'answer',
                                    questionId,
                                    answer,
                                    clientId: targetClientId
                                }));
                                console.log(`Сервер: Ответ отправлен клиенту ${targetClientId} для questionId: ${questionId}`);
                            }
                            client.send(JSON.stringify({
                                type: 'update_helper_card',
                                helperId,
                                hasAnswer,
                                clientId: client.clientId
                            }));
                            if (client.clientId !== targetClientId) {
                                client.send(JSON.stringify({
                                    type: 'answer',
                                    questionId,
                                    answer,
                                    clientId: client.clientId
                                }));
                            }
                        }
                    });
                    const helperClient = helpers.get(helperId);
                    if (helperClient && helperClient.readyState === WebSocket.OPEN) {
                        helperClient.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer,
                            clientId: targetClientId
                        }));
                    }
                    saveHelperData(); // Сохранение после обновления ответа
                    break;
                }
            }
        } else if (data.type === 'delete_screenshot') {
            const { questionId, clientId } = data;
            for (const [helperId, screenshots] of helperData.entries()) {
                const screenshotIndex = screenshots.findIndex(s => s.questionId === questionId);
                if (screenshotIndex !== -1) {
                    const screenshot = screenshots[screenshotIndex];
                    screenshots.splice(screenshotIndex, 1);
                    fs.unlink(path.join(screenshotDir, path.basename(screenshot.questionId) + '.png'), (err) => {
                        if (err) console.error(`Сервер: Ошибка удаления файла ${screenshot.questionId}:`, err);
                        else console.log(`Сервер: Файл удален: ${screenshot.questionId}`);
                    });
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.clientId) {
                            if (client.clientId === clientId) {
                                client.send(JSON.stringify({
                                    type: 'screenshot_deleted_specific',
                                    questionId,
                                    clientId
                                }));
                            }
                        }
                    });
                    if (screenshots.length === 0) {
                        helperData.delete(helperId);
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && client.clientId) {
                                client.send(JSON.stringify({
                                    type: 'helper_deleted',
                                    helperId,
                                    clientId: client.clientId
                                }));
                            }
                        });
                    }
                    saveHelperData(); // Сохранение после удаления
                    break;
                }
            }
        } else if (data.type === 'request_helper_screenshots') {
            const helperInfo = helperData.get(data.helperId);
            if (helperInfo) {
                const frontendClient = clients.get(data.clientId) || ws;
                if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                    frontendClient.send(JSON.stringify({
                        type: 'screenshots_by_helperId',
                        helperId: data.helperId,
                        screenshots: helperInfo,
                        clientId: data.clientId || 'anonymous'
                    }));
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился');
        if (ws.clientId) {
            const clientId = ws.clientId;
            clients.delete(clientId);
            console.log(`Сервер: Фронтенд-клиент удален, clientId: ${clientId}, активных фронтенд-клиентов: ${clients.size}`);
            // Не удаляем скриншоты при отключении админа, только клиента
            for (const [helperId, screenshots] of helperData.entries()) {
                const initialLength = screenshots.length;
                if (initialLength > 0 && screenshots.every(s => s.clientId === clientId)) {
                    screenshots.forEach(screenshot => {
                        fs.unlink(path.join(screenshotDir, path.basename(screenshot.questionId) + '.png'), (err) => {
                            if (err) console.error(`Сервер: Ошибка удаления файла ${screenshot.questionId}:`, err);
                            else console.log(`Сервер: Файл удален при отключении клиента: ${screenshot.questionId}`);
                        });
                    });
                    helperData.delete(helperId);
                    saveHelperData(); // Сохранение после удаления
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.clientId) {
                            client.send(JSON.stringify({
                                type: 'helper_deleted',
                                helperId,
                                clientId: client.clientId
                            }));
                        }
                    });
                }
            }
        }
        if (ws.helperId) {
            const helperId = ws.helperId;
            helpers.delete(helperId);
            console.log(`Сервер: Помощник с ID: ${helperId} отключился`);
            saveHelperData(); // Сохранение при отключении помощника
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
        screenshotsCount: Array.from(helperData.values()).reduce((sum, v) => sum + v.length, 0),
        memoryUsage: process.memoryUsage()
    });
});

app.get('/list-screenshots', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) return res.status(500).send('Ошибка чтения папки');
        res.json(files);
    });
});
