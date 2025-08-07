const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const { performance } = require('perf_hooks');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server }); // WebSocket на том же сервере, что и Express
const clients = new Map();
const helpers = new Map();
const helperData = new Map();
const admins = new Map();

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret'; // Используем переменную окружения или дефолтный секрет

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    // Пример проверки (замените на реальную базу данных)
    if (username === 'admin1' && password === 'admin1A') {
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } else {
        res.status(401).json({ message: 'Неверное имя пользователя или пароль' });
    }
});

wss.on('connection', (ws, req) => {
    console.log('Сервер: Новое WebSocket соединение, заголовки:', req.headers);

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log('Сервер: Получено сообщение по WS:', data);
        } catch (err) {
            console.error('Сервер: Ошибка разбора сообщения:', err);
            return;
        }

        if (data.type === 'frontend_connect') {
            const { clientId } = data;
            if (clientId) {
                ws.clientId = clientId;
                ws.isAdmin = false;
                clients.set(clientId, ws);
                console.log(`Сервер: Фронтенд подключен с clientId: ${clientId}`);
            }
        } else if (data.type === 'admin_connect') {
            const { token } = data;
            try {
                const decoded = jwt.verify(token, JWT_SECRET);
                ws.adminId = decoded.username;
                ws.isAdmin = true;
                admins.set(ws.adminId, ws);
                console.log(`Сервер: Администратор подключен с adminId: ${ws.adminId}`);

                const initialData = Array.from(helperData.entries()).map(([helperId, screenshots]) => ({
                    helperId,
                    hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== ''),
                    screenshots
                }));
                ws.send(JSON.stringify({
                    type: 'admin_initial_data',
                    data: initialData,
                    adminId: ws.adminId
                }));
                console.log(`Сервер: Отправлены начальные данные администратору ${ws.adminId}`);
            } catch (err) {
                console.error('Сервер: Ошибка верификации токена:', err);
                ws.send(JSON.stringify({ type: 'error', message: 'Неверный токен' }));
                ws.close();
            }
        } else if (data.type === 'request_initial_data') {
            const { clientId } = data;
            const client = clients.get(clientId);
            if (client) {
                const initialData = Array.from(helperData.entries()).map(([helperId, screenshots]) => ({
                    helperId,
                    hasAnswer: screenshots.every(s => s.answer && s.answer.trim() !== '')
                }));
                client.send(JSON.stringify({
                    type: 'initial_data',
                    data: initialData,
                    clientId
                }));
                console.log(`Сервер: Отправлены начальные данные клиенту ${clientId}`);
            }
        } else if (data.type === 'request_helper_screenshots') {
            const { helperId, clientId, adminId } = data;
            const screenshots = helperData.get(helperId) || [];
            if (clientId) {
                const client = clients.get(clientId);
                if (client) {
                    client.send(JSON.stringify({
                        type: 'screenshots_by_helperId',
                        helperId,
                        screenshots: screenshots.filter(s => !s.clientId || s.clientId === clientId),
                        clientId
                    }));
                    console.log(`Сервер: Отправлены скриншоты клиенту ${clientId} для helperId: ${helperId}`);
                }
            } else if (adminId) {
                const admin = admins.get(adminId);
                if (admin) {
                    admin.send(JSON.stringify({
                        type: 'screenshots_by_helperId',
                        helperId,
                        screenshots,
                        adminId
                    }));
                    console.log(`Сервер: Отправлены скриншоты администратору ${adminId} для helperId: ${helperId}`);
                }
            }
        } else if (data.type === 'screenshot') {
            const start = performance.now();
            const { dataUrl, helperId, clientId } = data;
            if (!helperId || !clientId || !dataUrl) {
                console.error('Сервер: Недостаточно данных для скриншота:', { helperId, clientId, dataUrl });
                return;
            }

            helpers.set(helperId, ws);
            ws.helperId = helperId;

            if (!helperData.has(helperId)) {
                helperData.set(helperId, []);
            }

            const timestamp = Date.now();
            const index = helperData.get(helperId).length;
            const filename = `helper-${helperId}-${timestamp}-${index}.png`;
            const filepath = path.join(__dirname, 'public', 'screenshots', filename);

            try {
                await fs.mkdir(path.dirname(filepath), { recursive: true });
                const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
                await fs.writeFile(filepath, base64Data, 'base64');
                console.log(`Сервер: Скриншот сохранен: ${filepath}`);

                const imageUrl = `/screenshots/${filename}`;
                const questionId = `helper-${helperId}-${timestamp}-${index}`;
                helperData.get(helperId).push({ questionId, imageUrl, clientId, answer: '' });

                admins.forEach(admin => {
                    if (admin.readyState === WebSocket.OPEN) {
                        admin.send(JSON.stringify({
                            type: 'screenshot_info',
                            questionId,
                            imageUrl,
                            helperId,
                            clientId,
                            adminId: admin.adminId
                        }));
                        console.log(`Сервер: Сообщение о скриншоте отправлено администратору ${admin.adminId}`);
                    }
                });

                const client = clients.get(clientId);
                if (client && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'screenshot_info',
                        questionId,
                        imageUrl,
                        helperId,
                        clientId
                    }));
                    console.log(`Сервер: Сообщение о скриншоте отправлено клиенту ${clientId}`);
                }

                const end = performance.now();
                console.log(`save-screenshot-${filename}: ${(end - start).toFixed(3)}ms`);
            } catch (err) {
                console.error('Сервер: Ошибка сохранения скриншота:', err);
            }
        } else if (data.type === 'submit_answer') {
            const { questionId, answer, clientId, adminId } = data;
            console.log(`Сервер: Обработка submit_answer: questionId=${questionId}, answer=${answer}, clientId=${clientId || 'none'}, adminId=${adminId || 'none'}`);
            for (const [helperId, screenshots] of helperData.entries()) {
                const screenshot = screenshots.find(s => s.questionId === questionId);
                if (screenshot) {
                    screenshot.answer = answer;
                    const targetClientId = screenshot.clientId;
                    const hasAnswer = screenshots.every(s => s.answer && s.answer.trim() !== '');
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            if (client.isAdmin) {
                                client.send(JSON.stringify({
                                    type: 'answer',
                                    questionId,
                                    answer,
                                    helperId,
                                    adminId: client.adminId,
                                    fromAdmin: adminId || false
                                }));
                                client.send(JSON.stringify({
                                    type: 'update_helper_card',
                                    helperId,
                                    hasAnswer,
                                    adminId: client.adminId
                                }));
                                console.log(`Сервер: Ответ отправлен администратору ${client.adminId} для questionId: ${questionId}`);
                            } else if (client.clientId === targetClientId) {
                                client.send(JSON.stringify({
                                    type: 'answer',
                                    questionId,
                                    answer,
                                    clientId: targetClientId,
                                    fromAdmin: adminId || false
                                }));
                                client.send(JSON.stringify({
                                    type: 'update_helper_card',
                                    helperId,
                                    hasAnswer,
                                    clientId: client.clientId
                                }));
                                console.log(`Сервер: Ответ отправлен клиенту ${targetClientId} для questionId: ${questionId}`);
                            }
                        }
                    });
                    const helperClient = helpers.get(helperId);
                    if (helperClient && helperClient.readyState === WebSocket.OPEN) {
                        helperClient.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer,
                            clientId: targetClientId,
                            fromAdmin: adminId || false
                        }));
                        console.log(`Сервер: Ответ отправлен помощнику ${helperId} для questionId: ${questionId}`);
                    }
                    break;
                }
            }
        } else if (data.type === 'delete_screenshot') {
            const { questionId, clientId, adminId } = data;
            console.log(`Сервер: Обработка delete_screenshot: questionId=${questionId}, clientId=${clientId || 'none'}, adminId=${adminId || 'none'}`);
            for (const [helperId, screenshots] of helperData.entries()) {
                const screenshotIndex = screenshots.findIndex(s => s.questionId === questionId);
                if (screenshotIndex !== -1) {
                    const [screenshot] = screenshots.splice(screenshotIndex, 1);
                    const filepath = path.join(__dirname, 'public', screenshot.imageUrl);
                    try {
                        await fs.unlink(filepath);
                        console.log(`Сервер: Скриншот удален: ${filepath}`);
                    } catch (err) {
                        console.error('Сервер: Ошибка удаления скриншота:', err);
                    }

                    if (screenshots.length === 0) {
                        helperData.delete(helperId);
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                if (client.isAdmin) {
                                    client.send(JSON.stringify({
                                        type: 'helper_deleted',
                                        helperId,
                                        adminId: client.adminId
                                    }));
                                    console.log(`Сервер: Отправлено helper_deleted администратору ${client.adminId}`);
                                } else {
                                    client.send(JSON.stringify({
                                        type: 'helper_deleted',
                                        helperId,
                                        clientId: client.clientId
                                    }));
                                    console.log(`Сервер: Отправлено helper_deleted клиенту ${client.clientId}`);
                                }
                            }
                        });
                        console.log(`Сервер: Помощник ${helperId} удален, так как скриншоты закончились`);
                    } else {
                        const hasAnswer = screenshots.every(s => s.answer && s.answer.trim() !== '');
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                if (client.isAdmin) {
                                    client.send(JSON.stringify({
                                        type: 'screenshot_deleted_specific',
                                        questionId,
                                        helperId,
                                        adminId: client.adminId
                                    }));
                                    client.send(JSON.stringify({
                                        type: 'update_helper_card',
                                        helperId,
                                        hasAnswer,
                                        adminId: client.adminId
                                    }));
                                    console.log(`Сервер: Отправлено screenshot_deleted_specific администратору ${client.adminId}`);
                                } else {
                                    client.send(JSON.stringify({
                                        type: 'screenshot_deleted_specific',
                                        questionId,
                                        helperId,
                                        clientId: client.clientId
                                    }));
                                    client.send(JSON.stringify({
                                        type: 'update_helper_card',
                                        helperId,
                                        hasAnswer,
                                        clientId: client.clientId
                                    }));
                                    console.log(`Сервер: Отправлено screenshot_deleted_specific клиенту ${client.clientId}`);
                                }
                            }
                        });
                    }
                    break;
                }
            }
        }
    });

    ws.on('close', () => {
        if (ws.clientId) {
            clients.delete(ws.clientId);
            console.log(`Сервер: Фронтенд с clientId ${ws.clientId} отключен`);
        }
        if (ws.helperId) {
            helpers.delete(ws.helperId);
            console.log(`Сервер: Помощник с helperId ${ws.helperId} отключен`);
        }
        if (ws.adminId) {
            admins.delete(ws.adminId);
            console.log(`Сервер: Администратор с adminId ${ws.adminId} отключен`);
        }
    });
});

// Используем PORT из окружения Render или 8080 локально
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
