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

const clientScreenshots = new Map(); // clientId -> [{ questionId, imageUrl, answer }]
const clients = new Map();          // clientId -> WebSocket
const admins = new Set();           // WebSocket админов

function loadExistingScreenshots() {
    fs.readdirSync(screenshotDir).forEach(file => {
        const match = file.match(/^client-([^-]+)-(\d+-\d+)\.png$/);
        if (match) {
            const clientId = `client-${match[1]}`;
            const questionId = `${clientId}-${match[2]}`;
            if (!clientScreenshots.has(clientId)) {
                clientScreenshots.set(clientId, []);
            }
            clientScreenshots.get(clientId).push({ 
                questionId, 
                imageUrl: `/screenshots/${file}`, 
                answer: '' 
            });
        }
    });
    console.log(`Сервер: Загружено ${clientScreenshots.size} клиентов с ${Array.from(clientScreenshots.values()).reduce((sum, v) => sum + v.length, 0)} скриншотами`);
}

loadExistingScreenshots();

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

wss.on('connection', (ws) => {
    console.log('Сервер: Новый клиент подключился по WebSocket');
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        console.log(`Сервер: Получен pong от ${ws.clientId ? 'клиента' : 'админа'}: ${ws.clientId || 'admin'}`);
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

        if (data.type === 'client_connect') {
            // Подключение клиента
            ws.clientId = data.clientId || `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            clients.set(ws.clientId, ws);
            
            if (!clientScreenshots.has(ws.clientId)) {
                clientScreenshots.set(ws.clientId, []);
            }
            
            console.log(`Сервер: Клиент подключен, clientId: ${ws.clientId}, активных клиентов: ${clients.size}`);
            
            // Отправляем клиенту его скриншоты
            const screenshots = clientScreenshots.get(ws.clientId) || [];
            ws.send(JSON.stringify({ 
                type: 'initial_data', 
                screenshots,
                clientId: ws.clientId 
            }));
            
        } else if (data.type === 'admin_connect') {
            // Подключение админа
            admins.add(ws);
            console.log(`Сервер: Админ подключен, активных админов: ${admins.size}`);
            
            // Отправляем админу все скриншоты всех клиентов
            const allScreenshots = Array.from(clientScreenshots.entries()).flatMap(([clientId, screens]) => 
                screens.map(s => ({ ...s, clientId }))
            );
            ws.send(JSON.stringify({ 
                type: 'all_screenshots', 
                screenshots: allScreenshots 
            }));
            
        } else if (data.type === 'screenshot') {
            // Клиент отправляет скриншот
            if (!ws.clientId) return;
            
            const uniqueTimeLabel = `save-screenshot-${ws.clientId}-${Date.now()}`;
            console.time(uniqueTimeLabel);
            const timestamp = Date.now();
            const filename = `${ws.clientId}-${timestamp}-0.png`;
            const screenshotPath = path.join(screenshotDir, filename);
            const buffer = Buffer.from(data.dataUrl.split(',')[1], 'base64');
            
            sharp(buffer)
                .resize({ width: 1280 })
                .png({ quality: 80 })
                .toFile(screenshotPath)
                .then(() => {
                    console.log(`Сервер: Скриншот сохранен: ${screenshotPath}`);
                    const imageUrl = `/screenshots/${filename}`;
                    const questionId = `${ws.clientId}-${timestamp}-0`;
                    
                    const screenshotData = { 
                        questionId, 
                        imageUrl, 
                        answer: '' 
                    };
                    
                    clientScreenshots.get(ws.clientId).push(screenshotData);
                    
                    // Уведомляем всех админов о новом скриншоте
                    admins.forEach(admin => {
                        if (admin.readyState === WebSocket.OPEN) {
                            admin.send(JSON.stringify({
                                type: 'new_screenshot',
                                ...screenshotData,
                                clientId: ws.clientId
                            }));
                        }
                    });
                    
                    console.timeEnd(uniqueTimeLabel);
                })
                .catch(err => {
                    console.error('Сервер: Ошибка сохранения скриншота:', err);
                    console.timeEnd(uniqueTimeLabel);
                });
                
        } else if (data.type === 'submit_answer') {
            // Админ отправляет ответ на скриншот
            const { questionId, answer, clientId } = data;
            
            if (!clientId || !clientScreenshots.has(clientId)) return;
            
            const screenshots = clientScreenshots.get(clientId);
            const screenshot = screenshots.find(s => s.questionId === questionId);
            
            if (screenshot) {
                screenshot.answer = answer;
                
                // Отправляем ответ конкретному клиенту
                const client = clients.get(clientId);
                if (client && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'answer',
                        questionId,
                        answer
                    }));
                    console.log(`Сервер: Ответ отправлен клиенту ${clientId} для questionId: ${questionId}`);
                }
                
                // Уведомляем всех админов об обновлении
                admins.forEach(admin => {
                    if (admin.readyState === WebSocket.OPEN) {
                        admin.send(JSON.stringify({
                            type: 'answer_updated',
                            questionId,
                            answer,
                            clientId
                        }));
                    }
                });
            }
            
        } else if (data.type === 'delete_screenshot') {
            // Удаление скриншота
            const { questionId, clientId } = data;
            
            if (!clientId || !clientScreenshots.has(clientId)) return;
            
            const screenshots = clientScreenshots.get(clientId);
            const screenshotIndex = screenshots.findIndex(s => s.questionId === questionId);
            
            if (screenshotIndex !== -1) {
                const [deletedScreenshot] = screenshots.splice(screenshotIndex, 1);
                
                // Удаляем файл
                fs.unlink(path.join(screenshotDir, path.basename(deletedScreenshot.imageUrl)), (err) => {
                    if (err) console.error(`Сервер: Ошибка удаления файла:`, err);
                });
                
                // Уведомляем клиента
                const client = clients.get(clientId);
                if (client && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'screenshot_deleted',
                        questionId
                    }));
                }
                
                // Уведомляем админов
                admins.forEach(admin => {
                    if (admin.readyState === WebSocket.OPEN) {
                        admin.send(JSON.stringify({
                            type: 'screenshot_deleted',
                            questionId,
                            clientId
                        }));
                    }
                });
            }
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился');
        
        if (ws.clientId) {
            // Отключение клиента
            clients.delete(ws.clientId);
            console.log(`Сервер: Клиент отключен, clientId: ${ws.clientId}, активных клиентов: ${clients.size}`);
            
        } else if (admins.has(ws)) {
            // Отключение админа
            admins.delete(ws);
            console.log(`Сервер: Админ отключен, активных админов: ${admins.size}`);
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
        clientsCount: clients.size,
        adminsCount: admins.size,
        screenshotsCount: Array.from(clientScreenshots.values()).reduce((sum, v) => sum + v.length, 0),
        memoryUsage: process.memoryUsage()
    });
});

app.get('/list-screenshots', (req, res) => {
    fs.readdir(screenshotDir, (err, files) => {
        if (err) return res.status(500).send('Ошибка чтения папки');
        res.json(files);
    });
});
