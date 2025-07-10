const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Порт, на котором будет работать сервер. Используем переменную окружения для Render.com
const PORT = process.env.PORT || 3000;
// Секретный ключ для JWT. ОЧЕНЬ ВАЖНО: используйте сложный ключ и храните его в переменных окружения на продакшене!
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_please_change_me';
// Учетные данные администратора. ОЧЕНЬ ВАЖНО: используйте переменные окружения на продакшене!
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'secure_password_123';

// Для обработки JSON-запросов (например, для логина)
app.use(express.json());

// Отдача статических файлов (HTML, JS, CSS) из текущей директории
app.use(express.static(path.join(__dirname)));

// Временное хранилище для подключенных клиентов (helper.js) и их данных
// Key: helperSessionId (уникальный ID студента), Value: { ws: WebSocket, latestScreenshot: String, latestHtml: String }
const activeHelpers = new Map();

// Обработка маршрута логина
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        // Если логин успешный, создаем JWT-токен
        const token = jwt.sign({ username: ADMIN_USERNAME, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ success: true, token: token });
    } else {
        res.status(401).json({ success: false, message: 'Неверный логин или пароль.' });
    }
});

// Middleware (функция-помощник) для проверки JWT-токена для WebSocket-соединений панели управления
function authenticateWebSocket(token) {
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded.role === 'admin';
    } catch (error) {
        // Токен недействителен (просрочен, изменен и т.д.)
        return false;
    }
}

// WebSocket логика
wss.on('connection', (ws, req) => {
    console.log('Новое WebSocket соединение установлено.');

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.error('Ошибка парсинга JSON сообщения:', message);
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат сообщения JSON.' }));
            return;
        }

        const { type, token, helperSessionId, screenshot, html, action, message: clientMessage } = parsedMessage;

        // 1. Авторизация панели управления (exam.js)
        if (type === 'auth_panel' && token) {
            if (authenticateWebSocket(token)) {
                ws.isAuthenticated = true; // Отмечаем соединение как авторизованное
                ws.send(JSON.stringify({ type: 'auth_success', message: 'Панель управления успешно авторизована.' }));
                console.log('Панель управления успешно авторизована.');

                // Отправляем текущие данные всех активных помощников новой авторизованной панели
                activeHelpers.forEach((helperData, id) => {
                    ws.send(JSON.stringify({
                        type: 'client_update',
                        clientId: id,
                        screenshot: helperData.latestScreenshot,
                        html: helperData.latestHtml,
                        // Добавляем флаг, что это начальная загрузка данных клиента
                        initialLoad: true 
                    }));
                });
            } else {
                ws.isAuthenticated = false;
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Недействительный токен авторизации.' }));
                ws.close(); // Закрываем соединение, если токен недействителен
                console.log('Попытка авторизации панели управления с недействительным токеном.');
            }
        } 
        // 2. Получение данных от клиента (helper.js)
        else if (type === 'helper_data' && helperSessionId) {
            let helperData = activeHelpers.get(helperSessionId);
            const isNewClient = !helperData;

            if (isNewClient) {
                helperData = { ws: ws, latestScreenshot: null, latestHtml: null };
                activeHelpers.set(helperSessionId, helperData);
                console.log(`Новый клиент подключился: ${helperSessionId}`);

                // Уведомляем все авторизованные панели о новом клиенте
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
                        client.send(JSON.stringify({
                            type: 'new_client',
                            clientId: helperSessionId
                        }));
                    }
                });
            } else {
                 // Обновляем ссылку на WebSocket, если клиент переподключился
                helperData.ws = ws; 
            }
            
            // Обновляем данные
            if (screenshot) {
                helperData.latestScreenshot = screenshot;
            }
            if (html) {
                helperData.latestHtml = html;
            }

            // Рассылаем данные всем авторизованным панелям управления
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
                    client.send(JSON.stringify({
                        type: 'client_update',
                        clientId: helperSessionId,
                        screenshot: screenshot, 
                        html: html
                    }));
                }
            });
            console.log(`Данные получены от клиента ${helperSessionId}.`);
        }
        // 3. Отправка команд клиентам (например, "отключить")
        else if (type === 'command_to_client' && ws.isAuthenticated) {
            const targetClientId = parsedMessage.clientId;
            const command = parsedMessage.command; // Например, 'disconnect'

            const targetHelperData = activeHelpers.get(targetClientId);
            if (targetHelperData && targetHelperData.ws && targetHelperData.ws.readyState === WebSocket.OPEN) {
                targetHelperData.ws.send(JSON.stringify({
                    type: 'server_command',
                    command: command,
                    message: clientMessage || 'Команда от администратора.'
                }));
                console.log(`Команда '${command}' отправлена клиенту ${targetClientId}.`);
            } else {
                console.warn(`Не удалось отправить команду клиенту ${targetClientId}: клиент не найден или неактивен.`);
                ws.send(JSON.stringify({ type: 'error', message: `Клиент ${targetClientId} не найден или неактивен.` }));
            }
        }
        // 4. Запрос панели управления на последние данные конкретного клиента
        else if (type === 'get_client_data' && parsedMessage.clientId && ws.isAuthenticated) {
            const requestedId = parsedMessage.clientId;
            const helperData = activeHelpers.get(requestedId);
            if (helperData) {
                ws.send(JSON.stringify({
                    type: 'client_update',
                    clientId: requestedId,
                    screenshot: helperData.latestScreenshot,
                    html: helperData.latestHtml
                }));
            } else {
                ws.send(JSON.stringify({ type: 'error', message: `Клиент ${requestedId} не найден.` }));
            }
        }
        else {
            console.warn('Получено неизвестное или неполное сообщение:', parsedMessage);
            if (!ws.isAuthenticated) {
                 ws.send(JSON.stringify({ type: 'error', message: 'Не авторизовано. Пожалуйста, авторизуйтесь.' }));
            } else {
                 ws.send(JSON.stringify({ type: 'error', message: 'Неизвестный тип сообщения или неполные данные.' }));
            }
           
        }
    });

    ws.on('close', () => {
        // Ищем и удаляем helper из activeHelpers, если его WebSocket закрылся
        let closedHelperId = null;
        for (const [id, helperData] of activeHelpers.entries()) {
            if (helperData.ws === ws) {
                closedHelperId = id;
                activeHelpers.delete(id);
                console.log(`Клиент отключился: ${id}`);
                
                // Уведомляем все авторизованные панели об отключении клиента
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
                        client.send(JSON.stringify({
                            type: 'client_disconnected',
                            clientId: id
                        }));
                    }
                });
                break;
            }
        }
        if (!closedHelperId && ws.isAuthenticated) {
            console.log('Панель управления отключилась.');
        } else if (!closedHelperId) {
             console.log('Неавторизованное соединение закрыто.');
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket ошибка:', error);
    });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Доступ к панели управления: http://localhost:${PORT}`);
    console.log('Для запуска сервера на Render.com убедитесь, что переменные окружения JWT_SECRET, ADMIN_USERNAME и ADMIN_PASSWORD установлены.');
});
