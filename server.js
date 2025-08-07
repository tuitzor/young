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

const server = app.listen(port, () => {
    console.log(`Сервер запущен на порту: ${port}`);
});

const wss = new WebSocket.Server({ server });
console.log(`WebSocket-сервер запущен на ws://localhost:${port}`);

const screenshotDir = path.join(__dirname, 'public/screenshots');
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log('Сервер: Папка для скриншотов создана:', screenshotDir);
}

// Заменим helperData на более универсальную структуру
// Вместо helperId используем questionId как ключ для хранения информации о каждом скриншоте.
// Это позволит админу работать с каждым скриншотом отдельно, независимо от клиента.
const screenshotsData = new Map(); // questionId -> { imageUrl, clientId, answer }
const clients = new Map();         // clientId -> WebSocket
const admins = new Map();          // adminId -> WebSocket (универсальные админы)

function loadExistingScreenshots() {
    fs.readdirSync(screenshotDir).forEach(file => {
        const match = file.match(/^(\d+-\d+)\.png$/); // Изменяем формат имени файла, чтобы не привязываться к helperId
        if (match) {
            const questionId = match[1];
            if (!screenshotsData.has(questionId)) {
                screenshotsData.set(questionId, {
                    imageUrl: `/screenshots/${file}`,
                    clientId: null, // При загрузке с диска clientId неизвестен
                    answer: ''
                });
            }
        }
    });
    console.log(`Сервер: Загружено ${screenshotsData.size} существующих скриншотов.`);
}

loadExistingScreenshots();

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    const validCredentials = {
        'admin1': 'admin1A',
        'admin2': 'admin2A'
        // Добавьте или измените данные администраторов по необходимости
    };

    if (validCredentials[username] && validCredentials[username] === password) {
        // Убрали привязку к конкретному ID, теперь это универсальный админ
        const adminId = username; 
        const token = jwt.sign({ username: adminId, role: 'admin' }, secretKey, { expiresIn: '1h' });
        res.json({ token, adminId });
    } else {
        res.status(401).json({ message: 'Неверное имя пользователя или пароль' });
    }
});

wss.on('connection', (ws) => {
    console.log('Сервер: Новый клиент подключился по WebSocket');
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`Сервер: Получен pong от клиента, clientId: ${ws.clientId || 'unknown'}, adminId: ${ws.adminId || 'unknown'}`);
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

        // Подключение фронтенда (клиента)
        if (data.type === 'frontend_connect' && data.role === 'frontend') {
            ws.clientId = data.clientId || `anonymous-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            clients.set(ws.clientId, ws);
            console.log(`Сервер: Фронтенд-клиент идентифицирован, clientId: ${ws.clientId}, активных фронтенд-клиентов: ${clients.size}`);
            
            // Отправляем клиенту только те скриншоты, которые принадлежат ему
            const clientScreenshots = Array.from(screenshotsData.values()).filter(s => s.clientId === ws.clientId);
            ws.send(JSON.stringify({ type: 'initial_data', screenshots: clientScreenshots, clientId: ws.clientId }));

        // Подключение админа
        } else if (data.type === 'admin_connect' && data.role === 'admin') {
            ws.adminId = data.adminId;
            admins.set(data.adminId, ws);
            console.log(`Сервер: Подключился админ с ID: ${data.adminId}, активных админов: ${admins.size}`);
            
            // Отправляем админу все скриншоты для обработки
            const allScreenshots = Array.from(screenshotsData.entries()).map(([questionId, info]) => ({
                questionId,
                imageUrl: info.imageUrl,
                clientId: info.clientId,
                answer: info.answer
            }));
            ws.send(JSON.stringify({ type: 'initial_screenshots', screenshots: allScreenshots }));

        } else if (data.type === 'screenshot') {
            const timestamp = Date.now();
            const filename = `${timestamp}-${data.clientId}.png`;
            const screenshotPath = path.join(screenshotDir, filename);
            const questionId = `${timestamp}-${data.clientId}`; // ID вопроса теперь привязан к timestamp и clientId

            const buffer = Buffer.from(data.dataUrl.split(',')[1], 'base64');
            sharp(buffer)
                .resize({ width: 1280 })
                .png({ quality: 80 })
                .toFile(screenshotPath)
                .then(() => {
                    console.log(`Сервер: Скриншот сохранен: ${screenshotPath}`);
                    const imageUrl = `/screenshots/${filename}`;
                    
                    // Сохраняем данные о скриншоте
                    screenshotsData.set(questionId, { imageUrl, clientId: data.clientId, answer: '' });

                    // Отправляем уведомление всем админам
                    admins.forEach(adminWs => {
                        if (adminWs.readyState === WebSocket.OPEN) {
                            adminWs.send(JSON.stringify({
                                type: 'new_screenshot',
                                questionId,
                                imageUrl,
                                clientId: data.clientId
                            }));
                            console.log(`Сервер: Уведомление о новом скриншоте отправлено админу ${adminWs.adminId}`);
                        }
                    });

                })
                .catch(err => {
                    console.error('Сервер: Ошибка сохранения скриншота:', err);
                });
        
        // Админ отправляет ответ
        } else if (data.type === 'submit_answer') {
            const { questionId, answer, adminId } = data;
            const screenshotInfo = screenshotsData.get(questionId);

            if (screenshotInfo) {
                screenshotInfo.answer = answer; // Обновляем ответ в базе данных
                const targetClientId = screenshotInfo.clientId;
                
                const clientWs = clients.get(targetClientId);
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    // Отправляем ответ ТОЛЬКО клиенту, который задал вопрос
                    clientWs.send(JSON.stringify({
                        type: 'answer',
                        questionId,
                        answer,
                        clientId: targetClientId
                    }));
                    console.log(`Сервер: Ответ отправлен клиенту ${targetClientId} для questionId: ${questionId}`);
                }

                // Отправляем уведомление всем админам, что скриншот обработан
                admins.forEach(adminWs => {
                    if (adminWs.readyState === WebSocket.OPEN) {
                        adminWs.send(JSON.stringify({
                            type: 'answer_submitted',
                            questionId,
                            answer,
                            adminId
                        }));
                    }
                });
            }
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился');
        if (ws.clientId) {
            const clientId = ws.clientId;
            clients.delete(clientId);
            console.log(`Сервер: Фронтенд-клиент удален, clientId: ${clientId}, активных фронтенд-клиентов: ${clients.size}`);
        }
        if (ws.adminId) {
            const adminId = ws.adminId;
            admins.delete(adminId);
            console.log(`Сервер: Админ с ID: ${adminId} отключился`);
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
        adminsCount: admins.size,
        frontendsCount: clients.size,
        screenshotsCount: screenshotsData.size,
        memoryUsage: process.memoryUsage()
    });
});
