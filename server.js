const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors'); // Импортируем cors

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 1000; // Используем порт 1000, как вы указали
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_for_exam_monitoring'; // !!! ВАЖНО: В продакшене используйте переменную окружения и ОЧЕНЬ надежный ключ
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'securepassword123'; // !!! ВАЖНО: В продакшене используйте переменную окружения и ОЧЕНЬ надежный пароль

// Middleware для обработки JSON-запросов (например, для логина)
app.use(express.json());

// Разрешаем CORS для всех запросов
app.use(cors());

// Отдача статических файлов (HTML, JS, CSS)
// Убедитесь, что index.html, exam.js, style.css находятся в этой же директории
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

// Middleware для проверки JWT-токена для WebSocket-соединений панели управления
function authenticateWebSocket(token) {
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded.role === 'admin';
    } catch (error) {
        console.error("Ошибка верификации JWT:", error.message);
        return false;
    }
}

// WebSocket логика
wss.on('connection', (ws, req) => {
    console.log('Новое WebSocket соединение.');

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
        } catch (e) {
            console.error('Неверный JSON формат:', message);
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат сообщения.' }));
            return;
        }

        const { type, token, helperSessionId, screenshot, html } = parsedMessage;

        if (type === 'auth_panel' && token) {
            // Это панель управления (exam.js), пытается авторизоваться
            if (authenticateWebSocket(token)) {
                ws.isAuthenticated = true; // Отмечаем соединение как авторизованное
                ws.send(JSON.stringify({ type: 'auth_success', message: 'Авторизация панели управления успешна.' }));
                console.log('Панель управления успешно авторизована.');

                // Отправляем текущие данные всех активных помощников новой авторизованной панели
                activeHelpers.forEach((helperData, id) => {
                    ws.send(JSON.stringify({
                        type: 'client_update',
                        clientId: id,
                        screenshot: helperData.latestScreenshot,
                        html: helperData.latestHtml
                    }));
                });

            } else {
                ws.isAuthenticated = false;
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Недействительный токен.' }));
                ws.close(); // Закрываем соединение, если токен недействителен
                console.log('Попытка авторизации панели управления с недействительным токеном.');
            }
        } else if (type === 'helper_data' && helperSessionId) {
            // Это клиент (helper.js), отправляющий данные (скриншот/HTML)
            let helperData = activeHelpers.get(helperSessionId);
            if (!helperData) {
                // Если это новый helper, добавляем его и уведомляем панели
                helperData = { ws: ws, latestScreenshot: null, latestHtml: null };
                activeHelpers.set(helperSessionId, helperData);
                console.log(`Новый клиент подключился: ${helperSessionId}`);

                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
                        client.send(JSON.stringify({
                            type: 'new_client',
                            clientId: helperSessionId
                        }));
                    }
                });
            } else {
                // Если helper уже существует, обновляем его WebSocket-объект (на случай переподключения)
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
                        screenshot: screenshot, // Отправляем только те данные, которые были отправлены helper'ом
                        html: html              // Чтобы избежать отправки null
                    }));
                }
            });
            console.log(`Данные получены от клиента ${helperSessionId}`);

        } else if (type === 'get_client_data' && parsedMessage.clientId) {
            // Панель управления запрашивает последние данные конкретного клиента
            if (ws.isAuthenticated) {
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
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован для получения данных.' }));
            }
        } else {
            console.warn('Неизвестный тип сообщения или неполные данные:', parsedMessage);
            ws.send(JSON.stringify({ type: 'error', message: 'Неизвестный тип сообщения или неполные данные.' }));
        }
    });

    ws.on('close', () => {
        // Если это helper.js, удаляем его из списка активных
        let closedHelperId = null;
        for (const [id, helperData] of activeHelpers.entries()) {
            if (helperData.ws === ws) { // Ищем helper по его WebSocket-объекту
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
            console.log('Неавторизованное WebSocket соединение закрыто.');
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket ошибка:', error);
    });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Доступ к панели управления (локально): http://localhost:${PORT}`);
});
