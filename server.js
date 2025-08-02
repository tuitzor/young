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

const wss = new WebSocket.Server({ server: app.listen(port, () => {
    console.log(`Сервер запущен на порту: ${port}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${port}`);
}) });

const screenshotDir = path.join(__dirname, 'public/screenshots');
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log('Сервер: Папка для скриншотов создана:', screenshotDir);
}

const helperData = new Map(); // helperId -> Map(clientId -> [screenshots])
const clients = new Map();    // clientId -> WebSocket
const helpers = new Map();    // helperId -> WebSocket

function loadExistingScreenshots() {
    fs.readdirSync(screenshotDir).forEach(file => {
        const match = file.match(/^helper-([^-]+)-(\d+-\d+)\.png$/);
        if (match) {
            const helperId = `helper-${match[1]}`;
            const questionId = `${helperId}-${match[2]}`;
            if (!helperData.has(helperId)) {
                helperData.set(helperId, new Map());
            }
            helperData.get(helperId).set('legacy', [{ questionId, imageUrl: `/screenshots/${file}`, clientId: 'legacy', answer: '' }]);
        }
    });
    console.log(`Сервер: Загружено ${helperData.size} помощников с ${Array.from(helperData.values()).reduce((sum, m) => sum + Array.from(m.values()).reduce((s, v) => s + v.length, 0), 0)} скриншотами`);
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
            ws.clientId = data.clientId || `anonymous-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            clients.set(ws.clientId, ws);
            console.log(`Сервер: Фронтенд-клиент идентифицирован, clientId: ${ws.clientId}, активных фронтенд-клиентов: ${clients.size}`);
            const initialData = Array.from(helperData.entries()).map(([helperId, clientMap]) => ({
                helperId,
                hasAnswer: Array.from(clientMap.values()).every(screenshots => screenshots.every(s => s.answer && s.answer.trim() !== ''))
            }));
            ws.send(JSON.stringify({ type: 'initial_data', data: initialData, clientId: ws.clientId }));
        } else if (data.type === 'request_initial_data') {
            const initialData = Array.from(helperData.entries()).map(([helperId, clientMap]) => ({
                helperId,
                hasAnswer: Array.from(clientMap.values()).some(screenshots => screenshots.some(s => s.clientId === data.clientId && s.answer && s.answer.trim() !== ''))
            }));
            ws.send(JSON.stringify({ type: 'initial_data', data: initialData, clientId: data.clientId || 'anonymous' }));
        } else if (data.type === 'helper_connect' && data.role === 'helper') {
            ws.helperId = data.helperId;
            helpers.set(data.helperId, ws);
            if (!helperData.has(data.helperId)) {
                helperData.set(data.helperId, new Map());
            }
            console.log(`Сервер: Подключился помощник с ID: ${data.helperId}, активных помощников: ${helpers.size}`);
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
                    const clientId = data.clientId || 'anonymous';
                    if (!helperData.has(data.helperId)) {
                        helperData.set(data.helperId, new Map());
                    }
                    const clientScreenshots = helperData.get(data.helperId).get(clientId) || [];
                    clientScreenshots.push({ questionId, imageUrl, clientId, answer: '' });
                    helperData.get(data.helperId).set(clientId, clientScreenshots);
                    const frontendClient = clients.get(clientId);
                    if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                        frontendClient.send(JSON.stringify({
                            type: 'screenshot_info',
                            questionId,
                            imageUrl,
                            helperId: data.helperId,
                            clientId
                        }));
                        console.log(`Сервер: Сообщение о скриншоте отправлено клиенту ${clientId}`);
                    } else {
                        console.log(`Сервер: Клиент ${clientId} не найден, скриншот сохранен для ${clientId}`);
                    }
                    console.timeEnd(uniqueTimeLabel);
                })
                .catch(err => {
                    console.error('Сервер: Ошибка сохранения скриншота:', err);
                    console.timeEnd(uniqueTimeLabel);
                });
        } else if (data.type === 'submit_answer') {
            const { questionId, answer, clientId } = data;
            for (const [helperId, clientMap] of helperData.entries()) {
                const screenshots = clientMap.get(clientId);
                if (screenshots) {
                    const screenshot = screenshots.find(s => s.questionId === questionId);
                    if (screenshot) {
                        screenshot.answer = answer;
                        const hasAnswer = screenshots.every(s => s.answer && s.answer.trim() !== '');
                        clientMap.set(clientId, screenshots);
                        const frontendClient = clients.get(clientId);
                        if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                            frontendClient.send(JSON.stringify({
                                type: 'answer',
                                questionId,
                                answer,
                                clientId
                            }));
                            frontendClient.send(JSON.stringify({
                                type: 'update_helper_card',
                                helperId,
                                hasAnswer,
                                clientId
                            }));
                        }
                        const helperClient = helpers.get(helperId);
                        if (helperClient && helperClient.readyState === WebSocket.OPEN) {
                            helperClient.send(JSON.stringify({
                                type: 'answer',
                                questionId,
                                answer,
                                clientId
                            }));
                        }
                        break;
                    }
                }
            }
        } else if (data.type === 'delete_screenshot') {
            const { questionId, clientId } = data;
            for (const [helperId, clientMap] of helperData.entries()) {
                const screenshots = clientMap.get(clientId);
                if (screenshots) {
                    const screenshotIndex = screenshots.findIndex(s => s.questionId === questionId);
                    if (screenshotIndex !== -1) {
                        const screenshot = screenshots[screenshotIndex];
                        screenshots.splice(screenshotIndex, 1);
                        clientMap.set(clientId, screenshots);
                        fs.unlink(path.join(screenshotDir, path.basename(screenshot.questionId)), (err) => {
                            if (err) console.error(`Сервер: Ошибка удаления файла ${screenshot.questionId}:`, err);
                            else console.log(`Сервер: Файл удален: ${screenshot.questionId}`);
                        });
                        const frontendClient = clients.get(clientId);
                        if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                            frontendClient.send(JSON.stringify({
                                type: 'screenshot_deleted_specific',
                                questionId,
                                clientId
                            }));
                        }
                        if (screenshots.length === 0) {
                            clientMap.delete(clientId);
                            if (Array.from(clientMap.values()).every(s => s.length === 0)) {
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
                        }
                        break;
                    }
                }
            }
        } else if (data.type === 'request_helper_screenshots') {
            const helperInfo = helperData.get(data.helperId);
            if (helperInfo) {
                const screenshots = helperInfo.get(data.clientId) || [];
                const frontendClient = clients.get(data.clientId) || ws;
                if (frontendClient && frontendClient.readyState === WebSocket.OPEN) {
                    frontendClient.send(JSON.stringify({
                        type: 'screenshots_by_helperId',
                        helperId: data.helperId,
                        screenshots,
                        clientId: data.clientId || 'anonymous'
                    }));
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
            helpers.delete(ws.helperId);
            console.log(`Сервер: Помощник с ID: ${ws.helperId} отключился`);
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
        screenshotsCount: Array.from(helperData.values()).reduce((sum, m) => sum + Array.from(m.values()).reduce((s, v) => s + v.length, 0), 0),
        memoryUsage: process.memoryUsage()
    });
});

app.get('/list-screenshots', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) return res.status(500).send('Ошибка чтения папки');
        res.json(files);
    });
});
