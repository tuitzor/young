const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;
const USERS_FILE = path.join(__dirname, 'users.json');
const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots');

// Создаем папку для скриншотов, если ее нет
if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// Загрузка пользователей из файла или создание пустого массива
let users = [];
if (fs.existsSync(USERS_FILE)) {
    try {
        users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) {
        console.error('Ошибка чтения users.json:', e);
    }
}

// Проверяем, есть ли администраторы. Если нет, создаем пользователя по умолчанию.
if (users.length === 0) {
    console.log('Администраторы не найдены. Создаю администратора по умолчанию (admin/password).');
    const defaultPassword = bcrypt.hashSync('password', 10);
    users.push({ username: 'admin', password: defaultPassword });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}


// --- Настройка сессий ---
app.use(session({
    secret: 'super_secret_key_for_session', // ОБЯЗАТЕЛЬНО ИЗМЕНИТЬ В PROD!
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // true для HTTPS в продакшене (Render)
        httpOnly: true, // Куки доступны только через HTTP(S)
        maxAge: 1000 * 60 * 60 * 24 // 24 часа
    }
}));

// Middleware для парсинга JSON и URL-кодированных тел запросов
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Раздаем статические файлы из папки 'public'
app.use(express.static(path.join(__dirname, 'public')));

// --- API Маршруты для авторизации ---

// Проверка статуса авторизации (для фронтенда)
app.get('/api/auth/status', (req, res) => {
    if (req.session.userId) {
        res.status(200).json({ authenticated: true, username: req.session.userId });
    } else {
        res.status(200).json({ authenticated: false });
    }
});

// Маршрут для обработки входа
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);

    if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user.username;
        console.log(`Пользователь ${username} успешно вошел.`);
        res.status(200).json({ message: 'Авторизован', username: user.username });
    } else {
        console.log(`Попытка входа с неверными данными: ${username}`);
        res.status(401).json({ message: 'Неверный логин или пароль' });
    }
});

// Маршрут для выхода
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Ошибка выхода:', err);
            return res.status(500).json({ message: 'Не удалось выйти' });
        }
        res.status(200).json({ message: 'Выход выполнен' });
    });
});

// --- Маршрут для проксирования изображений (доступен без авторизации для helper.js) ---
app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(400).send('URL изображения не предоставлен.');
    }
    try {
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(response.data);
    } catch (error) {
        console.error('Ошибка проксирования изображения:', imageUrl, error.message);
        res.status(500).send('Не удалось загрузить изображение.');
    }
});

// --- Основной маршрут: всегда отдаем index.html ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- WebSocket-соединения ---
const helperClients = new Map();
const frontendClients = new Set();

// Функция для получения сессии по ID
function getSession(sessionID, callback) {
    app.request.sessionStore.get(sessionID, callback);
}

wss.on('connection', (ws, req) => {
    // Внимание: req.session здесь не работает "из коробки" для WS-соединения
    // Для строгой проверки авторизации WS, нужна дополнительная логика.
    // Пока что будем считать, что клиентский JS (index.html) будет подключаться к WS только после авторизации.

    console.log('Новый клиент подключился по WebSocket');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);

            // Если это помощник (helper.js), ему не нужна авторизация для отправки скриншотов
            if (data.role === 'helper') {
                if (data.type === 'screenshot') {
                    const { screenshot, questionId } = data;
                    const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
                    const filename = `${questionId}.png`;
                    const filepath = path.join(SCREENSHOTS_DIR, filename);

                    helperClients.set(questionId, ws);

                    fs.writeFile(filepath, base64Data, 'base64', (err) => {
                        if (err) {
                            console.error('Ошибка при сохранении скриншота:', err);
                        } else {
                            const imageUrl = `/screenshots/${filename}`;
                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'screenshot_info',
                                        questionId,
                                        imageUrl
                                    }));
                                }
                            });
                        }
                    });
                } else if (data.type === 'pageHTML') {
                    // console.log('Получен HTML страницы от помощника.');
                }
            } else { // Это должен быть фронтенд-клиент (админ)
                if (data.type === 'frontend_connect') {
                    // Можно было бы здесь проверять session cookie, если он передается
                    // Например, через ws.request.headers.cookie
                    frontendClients.add(ws);
                    console.log('Подключился фронтенд-клиент (админ).');
                } else if (data.type === 'submit_answer') {
                    const { questionId, answer } = data;
                    // Здесь в идеале нужна проверка, что пользователь ws авторизован
                    // Если это сообщение пришло от неавторизованного, его нужно игнорировать.

                    const targetHelperWs = helperClients.get(questionId);
                    if (targetHelperWs && targetHelperWs.readyState === WebSocket.OPEN) {
                        targetHelperWs.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer
                        }));
                        console.log(`Ответ отправлен обратно помощнику для ${questionId}`);
                    } else {
                        console.warn(`Активный помощник для questionId: ${questionId} не найден или его WS закрыт.`);
                    }

                    frontendClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'answer',
                                questionId,
                                answer
                            }));
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Ошибка при разборе сообщения или обработке данных:', error);
        }
    });

    ws.on('close', () => {
        console.log('Клиент отключился.');
        frontendClients.delete(ws);
    });

    ws.on('error', error => {
        console.error('Ошибка WebSocket:', error);
    });
});


server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${PORT}`);
});
