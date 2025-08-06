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

const screenshotDir = path.join(__dirname, 'public/screenshots');
if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
    console.log('Сервер: Папка для скриншотов создана:', screenshotDir);
}

let helperData = new Map(); // helperId -> [screenshots]
const clients = new Map();  // clientId -> WebSocket
const helpers = new Map();  // helperId -> WebSocket

function loadHelperData() {
    const filePath = path.join(__dirname, 'helperData.json');
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        helperData = new Map(Object.entries(JSON.parse(data)));
    }
}
loadHelperData();

function saveHelperData() {
    const data = Object.fromEntries(helperData);
    fs.writeFileSync(path.join(__dirname, 'helperData.json'), JSON.stringify(data, null, 2), 'utf8');
}

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
    });

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (err) {
            console.error('Сервер: Ошибка разбора сообщения:', err);
            return;
        }

        if (data.type === 'helper_connect' && data.role === 'helper') {
            ws.helperId = data.helperId;
            ws.clientId = data.clientId;
            helpers.set(data.helperId, ws);
            clients.set(data.clientId, ws);

            if (!helperData.has(data.helperId)) {
                helperData.set(data.helperId, []);
            }
            console.log(`Сервер: Подключился помощник с ID: ${data.helperId}`);
            
            const screenshots = helperData.get(data.helperId) || [];
            screenshots.forEach(ss => {
                if (ss.answer) {
                    ws.send(JSON.stringify({ type: 'answer', questionId: ss.questionId, answer: ss.answer }));
                }
            });

            const initialData = Array.from(helperData.entries()).map(([helperId, screenshots]) => ({
                helperId,
                screenshotsCount: screenshots.length,
                answeredCount: screenshots.filter(s => s.answer && s.answer.trim() !== '').length,
                hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== '')
            }));

            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.role === 'frontend') {
                    client.send(JSON.stringify({ type: 'initial_data', data: initialData }));
                }
            });

        } else if (data.type === 'frontend_connect' && data.role === 'frontend') {
            ws.clientId = data.clientId;
            ws.role = 'frontend';
            clients.set(ws.clientId, ws);
            console.log(`Сервер: Фронтенд-клиент идентифицирован, clientId: ${ws.clientId}`);
            
            const initialData = Array.from(helperData.entries()).map(([helperId, screenshots]) => ({
                helperId,
                screenshotsCount: screenshots.length,
                answeredCount: screenshots.filter(s => s.answer && s.answer.trim() !== '').length,
                hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== '')
            }));
            ws.send(JSON.stringify({ type: 'initial_data', data: initialData }));
        
        } else if (data.type === 'screenshot') {
            const timestamp = Date.now();
            const filename = `${data.helperId}-${timestamp}-0.png`;
            const screenshotPath = path.join(screenshotDir, filename);
            const buffer = Buffer.from(data.dataUrl.split(',')[1], 'base64');
            
            sharp(buffer)
                .resize({ width: 1280 })
                .png({ quality: 90 }) // Улучшено качество
                .toFile(screenshotPath)
                .then(() => {
                    console.log(`Сервер: Скриншот сохранен: ${screenshotPath}`);
                    const imageUrl = `/screenshots/${filename}`;
                    const questionId = `${data.helperId}-${timestamp}-0`;
                    
                    if (!helperData.has(data.helperId)) {
                        helperData.set(data.helperId, []);
                    }
                    helperData.get(data.helperId).push({ questionId, imageUrl, clientId: data.clientId, answer: '' });
                    saveHelperData();

                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.role === 'frontend') {
                            client.send(JSON.stringify({
                                type: 'screenshot_info',
                                questionId,
                                imageUrl,
                                helperId: data.helperId
                            }));
                        }
                    });
                })
                .catch(err => {
                    console.error('Сервер: Ошибка сохранения скриншота:', err);
                });

        } else if (data.type === 'submit_answer' || data.type === 'edit_answer') {
            const { questionId, answer, helperId } = data;
            
            let screenshotToUpdate = null;
            if (helperData.has(helperId)) {
                screenshotToUpdate = helperData.get(helperId).find(s => s.questionId === questionId);
            }

            if (screenshotToUpdate) {
                screenshotToUpdate.answer = answer;
                saveHelperData();
                console.log(`Сервер: Обновлён ответ для questionId: ${questionId}`);
                
                const targetClientWs = clients.get(screenshotToUpdate.clientId);
                if (targetClientWs && targetClientWs.readyState === WebSocket.OPEN) {
                    targetClientWs.send(JSON.stringify({ type: 'answer', questionId, answer }));
                }
                
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.role === 'frontend') {
                        const screenshots = helperData.get(helperId) || [];
                        const hasAnswer = screenshots.every(s => s.answer && s.answer.trim() !== '');
                        client.send(JSON.stringify({ type: 'update_helper_card', helperId, hasAnswer }));
                    }
                });
            }
        } else if (data.type === 'delete_screenshot') {
            const { questionId } = data;
            
            for (const [helperId, screenshots] of helperData.entries()) {
                const screenshotIndex = screenshots.findIndex(s => s.questionId === questionId);
                if (screenshotIndex !== -1) {
                    const screenshot = screenshots[screenshotIndex];
                    screenshots.splice(screenshotIndex, 1);
                    
                    const filePath = path.join(screenshotDir, path.basename(screenshot.imageUrl));
                    fs.unlink(filePath, (err) => {
                        if (err) console.error(`Сервер: Ошибка удаления файла ${filePath}:`, err);
                        else console.log(`Сервер: Файл удален: ${filePath}`);
                    });
                    
                    saveHelperData();
                    
                    // Обновляем все фронтенды
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.role === 'frontend') {
                            client.send(JSON.stringify({ type: 'screenshot_deleted', helperId, questionId }));
                        }
                    });
                    
                    // Если у помощника не осталось скриншотов, удаляем его из списка
                    if (screenshots.length === 0) {
                        helperData.delete(helperId);
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && client.role === 'frontend') {
                                client.send(JSON.stringify({ type: 'helper_deleted', helperId }));
                            }
                        });
                    }
                    break;
                }
            }
        } else if (data.type === 'request_helper_screenshots') {
            const { helperId } = data;
            const screenshots = helperData.get(helperId) || [];
            if (ws.role === 'frontend') {
                ws.send(JSON.stringify({ type: 'screenshots_by_helperId', helperId, screenshots }));
            }
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился');
        if (ws.role === 'helper' && ws.helperId) {
            const helperId = ws.helperId;
            const screenshots = helperData.get(helperId) || [];
            // Удаляем все скриншоты этого помощника с диска
            screenshots.forEach(ss => {
                const filePath = path.join(screenshotDir, path.basename(ss.imageUrl));
                fs.unlink(filePath, (err) => {
                    if (err) console.error(`Сервер: Ошибка удаления файла ${filePath}:`, err);
                    else console.log(`Сервер: Файл удален: ${filePath}`);
                });
            });

            // Удаляем данные помощника из памяти
            helperData.delete(helperId);
            saveHelperData();

            helpers.delete(helperId);
            clients.delete(ws.clientId);
            console.log(`Сервер: Помощник с ID ${helperId} отключился. Все его данные и скриншоты удалены.`);

            // Уведомляем все фронтенд-панели, что помощник был удален
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.role === 'frontend') {
                    client.send(JSON.stringify({ type: 'helper_deleted', helperId }));
                }
            });
        } else if (ws.role === 'frontend' && ws.clientId) {
            clients.delete(ws.clientId);
            console.log(`Сервер: Фронтенд-клиент ${ws.clientId} отключился`);
        }
    });
});
