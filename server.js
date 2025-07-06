const express = require('express');
const { Server } = require('ws');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

// Конфигурация
const CONFIG = {
  MAX_ADMINS: 5,
  SESSION_SECRET: 'your-secret-key-here', // Замените на случайную строку
  ADMIN_PASSWORD: bcrypt.hashSync('admin123', 10) // Пароль по умолчанию для главного админа
};

// База данных (временная, в памяти)
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
  screenshotsData: new Map(),
  adminSessions: new Map()
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Проверка прав администратора
function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.redirect('/admin/login');
  }
  next();
}

// Проверка прав суперадмина
function requireSuperAdmin(req, res, next) {
  if (!req.session.admin || !DB.admins.get(req.session.admin)?.isSuperAdmin) {
    return res.status(403).send('Доступ запрещён');
  }
  next();
}

// Инициализация директорий
async function initDirectories() {
  try {
    await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
  } catch (err) {
    console.error('Ошибка создания директорий:', err);
  }
}

// Очистка соединений
async function cleanupConnection(connectionId) {
  for (const [questionId, data] of DB.screenshotsData.entries()) {
    if (data.connectionId === connectionId) {
      try {
        await fs.unlink(path.join(__dirname, 'uploads', `${questionId}.png`));
        DB.screenshotsData.delete(questionId);
      } catch (err) {
        console.error('Ошибка удаления файла:', err);
      }
    }
  }
}

// WebSocket обработчик
wss.on('connection', (ws) => {
  const connectionId = Date.now().toString();
  DB.activeConnections.set(connectionId, ws);

  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30000);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'screenshot') {
        const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
        const filePath = path.join(__dirname, 'uploads', `${data.questionId}.png`);
        await fs.writeFile(filePath, base64Data, 'base64');
        
        DB.screenshotsData.set(data.questionId, {
          connectionId,
          timestamp: Date.now(),
          answer: ""
        });
      }
    } catch (error) {
      console.error('Ошибка WebSocket:', error);
    }
  });

  ws.on('close', async () => {
    clearInterval(pingInterval);
    await cleanupConnection(connectionId);
    DB.activeConnections.delete(connectionId);
  });
});

// API для админ-панели
app.post('/api/admin/login', async (req, res) => {
  const { login, password } = req.body;
  const admin = DB.admins.get(login);
  
  if (admin && bcrypt.compareSync(password, admin.password)) {
    admin.online = true;
    req.session.admin = login;
    DB.adminSessions.set(req.session.id, login);
    return res.json({ success: true });
  }
  
  res.status(401).json({ error: 'Неверные данные' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const admin = DB.admins.get(req.session.admin);
  if (admin) admin.online = false;
  
  DB.adminSessions.delete(req.session.id);
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const stats = {
    totalAdmins: DB.admins.size,
    onlineAdmins: Array.from(DB.admins.values()).filter(a => a.online).length,
    activeConnections: DB.activeConnections.size,
    totalScreenshots: DB.screenshotsData.size
  };
  res.json(stats);
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
  
  if (!DB.admins.has(login)) {
    return res.status(404).json({ error: 'Администратор не найден' });
  }
  
  DB.admins.delete(login);
  res.json({ success: true });
});

// API для работы со скриншотами
app.get('/api/screenshots', requireAdmin, async (req, res) => {
  try {
    const validScreenshots = [];
    for (const [id, data] of DB.screenshotsData.entries()) {
      try {
        await fs.access(path.join(__dirname, 'uploads', `${id}.png`));
        validScreenshots.push({
          id,
          url: `/uploads/${id}.png`,
          timestamp: data.timestamp,
          answer: data.answer
        });
      } catch {
        DB.screenshotsData.delete(id);
      }
    }
    res.json(validScreenshots);
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/answers', requireAdmin, async (req, res) => {
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

// Роуты админ-панели
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Запуск сервера
initDirectories().then(() => {
  const PORT = process.env.PORT || 8080;
  server.listen(PORT, () => console.log(`Сервер запущен на http://localhost:${PORT}`));
});
