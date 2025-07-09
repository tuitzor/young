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
const wss = new WebSocket.Server({ server }); // Исправлена опечатка

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
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 24 часа
    }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// --- API Маршруты для авторизации ---
app.get('/api/auth/status', (req, res) => {
    if (req.session.userId) {
        res.status(200).json({ authenticated: true, username: req.session.userId });
    } else {
        res.status(200).json({ authenticated: false });
    }
});

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

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Ошибка выхода:', err);
            return res.status(500).json({ message: 'Не удалось выйти' });
        }
        res.status(200).json({ message: 'Выход выполнен' });
    });
});

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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- WebSocket-соединения ---
const helperClients = new Map(); // Карта для отслеживания помощников по helperId
const frontendClients = new Set(); // Набор для отслеживания фронтендов (админов)

/**
 * Удаляет все скриншоты, связанные с данным helperId, из папки SCREENSHOTS_DIR.
 * @param {string} helperId - Уникальный идентификатор помощника.
 */
function clearHelperScreenshots(helperId) {
    if (!helperId) return;

    fs.readdir(SCREENSHOTS_DIR, (err, files) => {
        if (err) {
            console.error(`Ошибка при чтении папки скриншотов для удаления ${helperId}:`, err);
            return;
        }

        const filesToDelete = files.filter(file => file.startsWith(`${helperId}-`));
        if (filesToDelete.length === 0) {
            console.log(`Сервер: Для helperId ${helperId} скриншотов не найдено для удаления.`);
            return;
        }

        console.log(`Сервер: Удаление ${filesToDelete.length} скриншотов для helperId: ${helperId}`);
        filesToDelete.forEach(file => {
            const filePath = path.join(SCREENSHOTS_DIR, file);
            fs.unlink(filePath, (unlinkErr) => {
                if (unlinkErr) {
                    console.error(`Сервер: Ошибка при удалении файла ${filePath}:`, unlinkErr);
                } else {
                    console.log(`Сервер: Файл удален: ${filePath}`);
                    // Оповещаем фронтенд-клиентов об удалении скриншота
                    frontendClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'screenshot_deleted',
                                questionIdPrefix: `${helperId}-` // Отправляем префикс для удаления
                            }));
                        }
                    });
                }
            });
        });
    });
}


wss.on('connection', (ws, req) => {
    // Временно храним helperId для этого WS-соединения
    let currentHelperId = null;

    console.log('Новый клиент подключился по WebSocket');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            // console.log('Получено сообщение:', data.type); // Можно раскомментировать для дебага

            if (data.role === 'helper') {
                currentHelperId = data.helperId; // Сохраняем helperId
                if (currentHelperId) {
                    // Добавляем WS-соединение помощника в Map
                    // Если helperId уже есть, это просто обновляет ссылку на WS
                    helperClients.set(currentHelperId, ws);
                    console.log(`Сервер: Подключился помощник с ID: ${currentHelperId}`);
                }

                if (data.type === 'screenshot') {
                    const { screenshot, questionId, helperId } = data; // Получаем helperId из данных
                    const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
                    // Имя файла теперь включает helperId
                    const filename = `${helperId}-${questionId.split('-').slice(1).join('-')}.png`;
                    const filepath = path.join(SCREENSHOTS_DIR, filename);

                    fs.writeFile(filepath, base64Data, 'base64', (err) => {
                        if (err) {
                            console.error('Сервер: Ошибка при сохранении скриншота:', err);
                        } else {
                            const imageUrl = `/screenshots/${filename}`;
                            console.log(`Сервер: Скриншот сохранен: ${filename}. Отправка фронтендам...`);
                            let sentCount = 0;

                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'screenshot_info',
                                        questionId,
                                        imageUrl,
                                        helperId // Передаем helperId фронтенду
                                    }));
                                    sentCount++;
                                } else {
                                    console.warn(`Сервер: Фронтенд-клиент не готов к отправке (state: ${client.readyState}).`);
                                }
                            });
                            console.log(`Сервер: Отправлено скриншот-сообщений ${sentCount} фронтенд-клиентам.`);
                            if (sentCount === 0) {
                                console.warn('Сервер: Нет активных фронтенд-клиентов для отправки скриншотов.');
                            }
                        }
                    });
                } else if (data.type === 'pageHTML') {
                    // console.log('Сервер: Получен HTML страницы от помощника (не сохраняем в этом примере).');
                }
            } else { // Это должен быть фронтенд-клиент (админ)
                if (data.type === 'frontend_connect') {
                    frontendClients.add(ws);
                    console.log('Сервер: Подключился фронтенд-клиент (админ).');
                } else if (data.type === 'submit_answer') {
                    const { questionId, answer } = data;

                    // Отправляем ответ только тому помощнику, который отправлял скриншот
                    // Находим helperId из questionId (e.g., 'helper-123-timestamp-0')
                    const parts = questionId.split('-');
                    const targetHelperId = parts[0] + '-' + parts[1]; // 'helper-123'

                    const targetHelperWs = helperClients.get(targetHelperId); // Получаем WS по helperId
                    if (targetHelperWs && targetHelperWs.readyState === WebSocket.OPEN) {
                        targetHelperWs.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer
                        }));
                        console.log(`Сервер: Ответ отправлен обратно помощнику для ${questionId}`);
                    } else {
                        console.warn(`Сервер: Активный помощник с ID: ${targetHelperId} не найден или его WS закрыт для questionId: ${questionId}.`);
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
            console.error('Сервер: Ошибка при разборе сообщения или обработке данных:', error);
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился.');
        // Если это был фронтенд-клиент, удаляем его из Set
        frontendClients.delete(ws);

        // Если это был помощник, запускаем логику удаления скриншотов
        if (currentHelperId && helperClients.get(currentHelperId) === ws) {
            console.log(`Сервер: Помощник с ID: ${currentHelperId} отключился. Запускаю очистку скриншотов.`);
            helperClients.delete(currentHelperId); // Удаляем из карты активных помощников
            clearHelperScreenshots(currentHelperId); // Вызываем функцию удаления
        }
    });

    ws.on('error', error => {
        console.error('Сервер: Ошибка WebSocket:', error);
    });
});


server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${PORT}`);
});
