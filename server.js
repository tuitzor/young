const express = require('express');
const { Server } = require('ws');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const redis = require('redis');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

// Настройка Redis для сессий (production)
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.on('error', err => console.log('Redis Client Error', err));
redisClient.connect().then(() => console.log('Connected to Redis'));

// Конфигурация
const CONFIG = {
  MAX_ADMINS: 5,
  SESSION_SECRET: process.env.SESSION_SECRET || 'your-strong-secret-here',
  ADMIN_PASSWORD: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10)
};

// База данных
const DB = {
  admins: new Map([
    ['admin', { 
      login: 'admin',
      password: CONFIG.ADMIN_PASSWORD,
      isSuperAdmin: true,
      online: false 
    }]
  ]),
  activeConnections: new Map(),
  screenshotsData: new Map()
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 1 день
  }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Проверка прав администратора
function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  next();
}

// Проверка прав суперадмина
function requireSuperAdmin(req, res, next) {
  if (!req.session.admin || !DB.admins.get(req.session.admin)?.isSuperAdmin) {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  next();
}

// Инициализация директорий
async function initDirectories() {
  try {
    await fs.mkdir(path.join(__dirname, 'public'), { recursive: true });
    await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
  } catch (err) {
    console.error('Ошибка создания директорий:', err);
  }
}

// WebSocket обработчик
wss.on('connection', (ws) => {
  const connectionId = Date.now().toString();
  DB.activeConnections.set(connectionId, ws);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'screenshot') {
        const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
        const filename = `${data.questionId}.png`;
        await fs.writeFile(path.join(__dirname, 'uploads', filename), base64Data, 'base64');
        
        DB.screenshotsData.set(data.questionId, {
          connectionId,
          timestamp: Date.now(),
          answer: ""
        });
      }
    } catch (error) {
      console.error('WS error:', error);
    }
  });

  ws.on('close', () => {
    DB.activeConnections.delete(connectionId);
  });
});

// API endpoints
app.post('/api/admin/login', async (req, res) => {
  const { login, password } = req.body;
  const admin = DB.admins.get(login);
  
  if (admin && bcrypt.compareSync(password, admin.password)) {
    admin.online = true;
    req.session.admin = login;
    return res.json({ success: true });
  }
  
  res.status(401).json({ error: 'Неверные данные' });
});

app.post('/api/admin/logout', (req, res) => {
  const admin = DB.admins.get(req.session.admin);
  if (admin) admin.online = false;
  
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/stats', (req, res) => {
  res.json({
    totalAdmins: DB.admins.size,
    onlineAdmins: Array.from(DB.admins.values()).filter(a => a.online).length,
    activeConnections: DB.activeConnections.size,
    totalScreenshots: DB.screenshotsData.size,
    currentAdmin: req.session.admin
  });
});

app.get('/api/admin/list', requireSuperAdmin, (req, res) => {
  res.json(Array.from(DB.admins.values()));
});

app.post('/api/admin/add', requireSuperAdmin, (req, res) => {
  if (DB.admins.size >= CONFIG.MAX_ADMINS) {
    return res.status(400).json({ error: 'Достигнут лимит администраторов' });
  }
  
  const { login, password } = req.body;
  if (DB.admins.has(login)) {
    return res.status(400).json({ error: 'Администратор уже существует' });
  }
  
  DB.admins.set(login, {
    login,
    password: bcrypt.hashSync(password, 10),
    isSuperAdmin: false,
    online: false
  });
  
  res.json({ success: true });
});

app.post('/api/admin/remove', requireSuperAdmin, (req, res) => {
  const { login } = req.body;
  if (login === 'admin') {
    return res.status(400).json({ error: 'Нельзя удалить главного администратора' });
  }
  
  DB.admins.delete(login);
  res.json({ success: true });
});

app.get('/api/screenshots', requireAdmin, async (req, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'uploads'));
    const screenshots = files.filter(file => file.endsWith('.png')).map(file => ({
      id: file.replace('.png', ''),
      url: `/uploads/${file}`,
      timestamp: DB.screenshotsData.get(file.replace('.png', ''))?.timestamp || 0,
      answer: DB.screenshotsData.get(file.replace('.png', ''))?.answer || ""
    }));
    res.json(screenshots);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/answers', requireAdmin, (req, res) => {
  const { questionId, answer } = req.body;
  if (DB.screenshotsData.has(questionId)) {
    DB.screenshotsData.set(questionId, {
      ...DB.screenshotsData.get(questionId),
      answer
    });
    
    const connectionId = DB.screenshotsData.get(questionId).connectionId;
    if (DB.activeConnections.has(connectionId)) {
      DB.activeConnections.get(connectionId).send(JSON.stringify({
        type: 'answer',
        questionId,
        answer
      }));
    }
    
    return res.sendStatus(200);
  }
  res.sendStatus(404);
});

// Serve admin panel
app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Init and start
initDirectories().then(() => {
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
