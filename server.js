const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-very-secure-jwt-secret-1234567890abcdef';
const admins = [
    { username: 'AYAZ', passwordHash: bcrypt.hashSync('AYAZ1', 10) },
    { username: 'XASAN', passwordHash: bcrypt.hashSync('XASAN1', 10) },
    { username: 'XUSAN', passwordHash: bcrypt.hashSync('XUSAN1', 10) },
    { username: 'JOHON', passwordHash: bcrypt.hashSync('JOHON1', 10) },
    { username: 'EDOS', passwordHash: bcrypt.hashSync('edos16', 10) },
    { username: 'KOMRON', passwordHash: bcrypt.hashSync('KOMRON1', 10) }
];

app.use(cors());
app.use(express.json());
app.use('/screenshots', express.static(path.join(__dirname, 'public', 'screenshots')));
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(port, () => {
    console.log(`Сервер запущен на порту: ${port}`);
});

const wss = new WebSocket.Server({ server });
console.log(`WebSocket-сервер запущен на ws://localhost:${port}`);

let helpers = [];
let screenshots = [];

async function ensureScreenshotDir() {
    const screenshotDir = path.join(__dirname, 'public', 'screenshots');
    try {
        await fs.access(screenshotDir);
        console.log(`Сервер: Папка для скриншотов существует: ${screenshotDir}`);
    } catch {
        await fs.mkdir(screenshotDir, { recursive: true });
        console.log(`Сервер: Папка для скриншотов создана: ${screenshotDir}`);
    }
}

async function loadScreenshots() {
    const screenshotDir = path.join(__dirname, 'public', 'screenshots');
    try {
        await ensureScreenshotDir();
        const files = await fs.readdir(screenshotDir);
        screenshots = [];
        for (const file of files) {
            if (file.endsWith('.png')) {
                const [helperId, questionId] = file.split('_');
                const answerPath = path.join(screenshotDir, `${helperId}_${questionId}.txt`);
                let answer = '';
                try {
                    answer = await fs.readFile(answerPath, 'utf8');
                } catch {}
                screenshots.push({
                    helperId,
                    questionId: questionId.replace('.png', ''),
                    imageUrl: `/screenshots/${file}`,
                    answer
                });
            }
        }
        helpers = [...new Set(screenshots.map(s => s.helperId))].map(helperId => ({
            helperId,
            hasAnswer: screenshots.some(s => s.helperId === helperId && s.answer)
        }));
        console.log(`Сервер: Загружено ${screenshots.length} скриншотов для ${helpers.length} помощников`);
    } catch (err) {
        console.error('Сервер: Ошибка загрузки скриншотов:', err);
    }
}

app.get('/healthz', (req, res) => res.send('OK'));

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Сервер: Попытка входа с username: ${username}, password: ${password}`);
    if (!username || !password) {
        console.log('Сервер: Отсутствует username или password');
        return res.status(400).json({ success: false, message: 'Требуются имя пользователя и пароль' });
    }
    const admin = admins.find(a => a.username === username);
    if (!admin) {
        console.log(`Сервер: Пользователь ${username} не найден`);
        return res.status(401).json({ success: false, message: 'Неверное имя пользователя или пароль' });
    }
    const passwordMatch = await bcrypt.compare(password, admin.passwordHash);
    console.log(`Сервер: Пароль для ${username} ${passwordMatch ? 'совпал' : 'не совпал'}`);
    if (!passwordMatch) {
        return res.status(401).json({ success: false, message: 'Неверное имя пользователя или пароль' });
    }
    try {
        const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '1h' });
        console.log(`Сервер: Токен создан для ${username}`);
        res.status(200).json({ success: true, token });
    } catch (err) {
        console.error('Сервер: Ошибка при создании токена:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера при входе' });
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        console.log('Сервер: Токен отсутствует');
        return res.status(401).json({ success: false, message: 'Токен отсутствует' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        console.log(`Сервер: Токен верифицирован для ${decoded.username}`);
        next();
    } catch (err) {
        console.log('Сервер: Неверный токен');
        return res.status(403).json({ success: false, message: 'Неверный токен' });
    }
}

app.get('/api/admin/list', authenticateToken, async (req, res) => {
    try {
        console.log(`Сервер: Запрос списка помощников от ${req.user.username}`);
        res.json(helpers);
    } catch (err) {
        console.error('Сервер: Ошибка получения списка:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

wss.on('connection', (ws) => {
    console.log('Сервер: Новый WebSocket-клиент подключен');
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Сервер: Получено сообщение:', data);
            if (data.type === 'frontend_connect') {
                ws.send(JSON.stringify({ type: 'initial_data', data: helpers }));
            } else if (data.type === 'submit_screenshot') {
                const { helperId, questionId, imageData } = data;
                const screenshotPath = path.join(__dirname, 'public', 'screenshots', `${helperId}_${questionId}.png`);
                const base64Data = imageData.replace(/^data:image\/png;base64,/, '');
                await fs.writeFile(screenshotPath, base64Data, 'base64');
                console.log(`Сервер: Скриншот сохранен: ${screenshotPath}`);
                screenshots.push({ helperId, questionId, imageUrl: `/screenshots/${helperId}_${questionId}.png`, answer: '' });
                if (!helpers.some(h => h.helperId === helperId)) {
                    helpers.push({ helperId, hasAnswer: false });
                }
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'screenshot_info',
                            helperId,
                            questionId,
                            imageUrl: `/screenshots/${helperId}_${questionId}.png`
                        }));
                    }
                });
            } else if (data.type === 'submit_answer') {
                const { questionId, answer } = data;
                const screenshot = screenshots.find(s => s.questionId === questionId);
                if (screenshot) {
                    screenshot.answer = answer;
                    const answerPath = path.join(__dirname, 'public', 'screenshots', `${screenshot.helperId}_${questionId}.txt`);
                    await fs.writeFile(answerPath, answer);
                    console.log(`Сервер: Ответ сохранен для вопроса ${questionId}`);
                    const helper = helpers.find(h => h.helperId === screenshot.helperId);
                    if (helper) {
                        helper.hasAnswer = screenshots.some(s => s.helperId === helper.helperId && s.answer);
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'update_helper_card',
                                    helperId: helper.helperId,
                                    hasAnswer: helper.hasAnswer
                                }));
                            }
                        });
                    }
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'answer', questionId, answer }));
                        }
                    });
                }
            } else if (data.type === 'delete_screenshot') {
                const { questionId } = data;
                const screenshot = screenshots.find(s => s.questionId === questionId);
                if (screenshot) {
                    const screenshotPath = path.join(__dirname, 'public', 'screenshots', `${screenshot.helperId}_${questionId}.png`);
                    const answerPath = path.join(__dirname, 'public', 'screenshots', `${screenshot.helperId}_${questionId}.txt`);
                    try {
                        await fs.unlink(screenshotPath);
                        console.log(`Сервер: Скриншот удален: ${screenshotPath}`);
                        try {
                            await fs.unlink(answerPath);
                            console.log(`Сервер: Ответ удален: ${answerPath}`);
                        } catch {}
                        screenshots = screenshots.filter(s => s.questionId !== questionId);
                        const helper = helpers.find(h => h.helperId === screenshot.helperId);
                        if (helper && !screenshots.some(s => s.helperId === helper.helperId)) {
                            helpers = helpers.filter(h => h.helperId !== helper.helperId);
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({ type: 'helper_deleted', helperId: helper.helperId }));
                                }
                            });
                        } else if (helper) {
                            helper.hasAnswer = screenshots.some(s => s.helperId === helper.helperId && s.answer);
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'update_helper_card',
                                        helperId: helper.helperId,
                                        hasAnswer: helper.hasAnswer
                                    }));
                                }
                            });
                        }
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ type: 'screenshot_deleted_specific', questionId }));
                            }
                        });
                    } catch (err) {
                        console.error('Сервер: Ошибка удаления скриншота:', err);
                    }
                }
            } else if (data.type === 'request_helper_screenshots') {
                const { helperId } = data;
                const helperScreenshots = screenshots.filter(s => s.helperId === helperId);
                ws.send(JSON.stringify({ type: 'screenshots_by_helperId', helperId, screenshots: helperScreenshots }));
            }
        } catch (err) {
            console.error('Сервер: Ошибка обработки сообщения:', err);
        }
    });
    ws.on('close', () => console.log('Сервер: WebSocket-клиент отключен'));
});

loadScreenshots();
