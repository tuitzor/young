const express = require('express');
const { Server } = require('ws');
const http = require('http');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

// Настройка CORS и статических файлов
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    setHeaders: (res) => res.set('Content-Type', 'image/png')
}));

// Секрет для JWT
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_key';

// Middleware для проверки JWT
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).send('Unauthorized');
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        console.error('Auth error:', error);
        res.status(401).send('Invalid token');
    }
}

// Создание папки uploads
async function ensureUploadsDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'Uploads'), { recursive: true });
        console.log('Uploads directory ready');
    } catch (err) {
        console.error('Error creating uploads directory:', err);
    }
}
ensureUploadsDir();

// Инициализация users.json
async function initUsersFile() {
    try {
        const filePath = path.join(__dirname, 'users.json');
        await fs.access(filePath);
        const content = await fs.readFile(filePath, 'utf8');
        JSON.parse(content); // Проверяем валидность
    } catch {
        console.log('Initializing users.json');
        await fs.writeFile(
            path.join(__dirname, 'users.json'),
            JSON.stringify({ admins: [], screenshots: [] }, null, 2)
        );
    }
}
initUsersFile();

// Эндпоинт для прокси изображений
app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('No URL provided');
    try {
        const token = req.headers.authorization;
        const response = await fetch(imageUrl, {
            headers: token ? { Authorization: token } : {}
        });
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
        const buffer = await response.buffer();
        res.set('Content-Type', response.headers.get('content-type'));
        res.send(buffer);
    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send('Failed to fetch image');
    }
});

// Эндпоинт для логина админа
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'password') {
        const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
        const users = JSON.parse(await fs.readFile(path.join(__dirname, 'users.json')));
        if (!users.admins.find(admin => admin.username === username)) {
            users.admins.push({ username, role: 'admin', lastLogin: new Date().toISOString() });
            await fs.writeFile(path.join(__dirname, 'users.json'), JSON.stringify(users, null, 2));
            console.log(`Admin ${username} added to users.json`);
        }
        res.json({ token });
    } else {
        res.status(401).send('Invalid credentials');
    }
});

// Обработка WebSocket-соединений
wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', async (message) => {
        console.log('Raw message received:', message.toString());
        try {
            if (!message || typeof message !== 'string') {
                console.error('Invalid message received:', message);
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
                return;
            }
            const data = JSON.parse(message);
            console.log('Received:', data);

            if (data.role === 'helper') {
                console.log('Helper client registered');
                ws.send(JSON.stringify({ type: 'ack', message: 'Helper registered' }));
            } else if (data.type === 'pageHTML') {
                console.log('Received page HTML:', data.html?.substring(0, 50) + '...');
                ws.send(JSON.stringify({ type: 'ack', message: 'HTML received' }));
            } else if (data.type === 'screenshot') {
                console.log('Received screenshot, questionId:', data.questionId, 'size:', data.screenshot?.length);
                if (!data.screenshot || !data.questionId) {
                    throw new Error('Missing screenshot or questionId');
                }
                const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
                const filePath = path.join(__dirname, 'Uploads', `${data.questionId}.png`);
                await fs.writeFile(filePath, base64Data, 'base64');
                console.log(`Screenshot saved: ${filePath}`);

                const users = JSON.parse(await fs.readFile(path.join(__dirname, 'users.json')));
                users.screenshots.push({
                    questionId: data.questionId,
                    timestamp: new Date().toISOString(),
                    filePath
                });
                await fs.writeFile(path.join(__dirname, 'users.json'), JSON.stringify(users, null, 2));
                console.log(`Screenshot ${data.questionId} added to users.json`);

                const answer = `Screenshot ${data.questionId} processed successfully`;
                ws.send(JSON.stringify({
                    type: 'answer',
                    questionId: data.questionId,
                    answer
                }));
            }
        } catch (error) {
            console.error('Error processing message:', error.message, message);
            ws.send(JSON.stringify({ type: 'error', message: `Error: ${error.message}` }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Эндпоинт для получения списка скриншотов
app.get('/screenshots', authMiddleware, async (req, res) => {
    try {
        const files = await fs.readdir(path.join(__dirname, 'Uploads'));
        const screenshots = files.filter(file => file.endsWith('.png')).map(file => ({
            id: file.replace('.png', ''),
            url: `/uploads/${file}`,
            timestamp: file.replace('.png', '')
        }));
        res.json(screenshots);
    } catch (error) {
        console.error('Error listing screenshots:', error);
        res.status(500).send('Failed to list screenshots');
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
