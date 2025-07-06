const express = require('express');
const { Server } = require('ws');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

// Конфигурация
const CONFIG = {
  MAX_ADMINS: 5,
  SESSION_SECRET: process.env.SESSION_SECRET || 'your-strong-secret-here',
  ADMIN_PASSWORD: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10)
};

// Временная "база данных" в памяти
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

// Создание необходимых директорий
async function initDirectories() {
  try {
    await fs.mkdir(path.join(__dirname, 'public'), { recursive: true });
    await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
    
    // Создаем index.html если его нет
    try {
      await fs.access(path.join(__dirname, 'public', 'index.html'));
    } catch {
      await fs.writeFile(
        path.join(__dirname, 'public', 'index.html'),
        '<!-- Ваш HTML будет сгенерирован автоматически -->'
      );
    }
  } catch (err) {
    console.error('Ошибка инициализации директорий:', err);
  }
}

// WebSocket обработчик
wss.on('connection', (ws) => {
  const connectionId = Date.now().toString();
  DB.activeConnections.set(connectionId, ws);
  console.log(`Новое подключение: ${connectionId}`);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'screenshot') {
        const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
        const filename = `${data.questionId}.png`;
        const filePath = path.join(__dirname, 'uploads', filename);
        
        await fs.writeFile(filePath, base64Data, 'base64');
        console.log(`Скриншот сохранен: ${filename}`);
        
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

  ws.on('close', () => {
    console.log(`Соединение закрыто: ${connectionId}`);
    DB.activeConnections.delete(connectionId);
  });
});

// Проверка авторизации
function requireAuth(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  next();
}

// Проверка прав суперадмина
function requireSuperAdmin(req, res, next) {
  if (!req.session.admin || !DB.admins.get(req.session.admin)?.isSuperAdmin) {
    return res.status(403).json({ error: 'Доступ запрещен' });
  }
  next();
}

// API для авторизации
app.post('/api/admin/login', async (req, res) => {
  const { login, password } = req.body;
  const admin = DB.admins.get(login);
  
  if (admin && bcrypt.compareSync(password, admin.password)) {
    admin.online = true;
    req.session.admin = login;
    return res.json({ success: true, isSuperAdmin: admin.isSuperAdmin });
  }
  
  res.status(401).json({ error: 'Неверные учетные данные' });
});

app.post('/api/admin/logout', (req, res) => {
  const admin = DB.admins.get(req.session.admin);
  if (admin) admin.online = false;
  
  req.session.destroy();
  res.json({ success: true });
});

// API для работы со скриншотами
app.get('/api/screenshots', requireAuth, async (req, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'uploads'));
    const screenshots = files
      .filter(file => file.endsWith('.png'))
      .map(file => ({
        id: file.replace('.png', ''),
        url: `/uploads/${file}`,
        timestamp: DB.screenshotsData.get(file.replace('.png', ''))?.timestamp || Date.now(),
        answer: DB.screenshotsData.get(file.replace('.png', ''))?.answer || ""
      }));
    
    res.json(screenshots);
  } catch (error) {
    console.error('Ошибка получения скриншотов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/answers', requireAuth, (req, res) => {
  const { questionId, answer } = req.body;
  
  if (DB.screenshotsData.has(questionId)) {
    DB.screenshotsData.set(questionId, {
      ...DB.screenshotsData.get(questionId),
      answer
    });
    
    // Отправляем ответ клиенту через WebSocket
    const connectionId = DB.screenshotsData.get(questionId).connectionId;
    if (DB.activeConnections.has(connectionId)) {
      DB.activeConnections.get(connectionId).send(JSON.stringify({
        type: 'answer',
        questionId,
        answer
      }));
    }
    
    return res.json({ success: true });
  }
  
  res.status(404).json({ error: 'Скриншот не найден' });
});

// API для управления администраторами
app.get('/api/admin/stats', requireAuth, (req, res) => {
  res.json({
    totalAdmins: DB.admins.size,
    onlineAdmins: Array.from(DB.admins.values()).filter(a => a.online).length,
    activeConnections: DB.activeConnections.size,
    totalScreenshots: DB.screenshotsData.size,
    currentAdmin: req.session.admin,
    isSuperAdmin: DB.admins.get(req.session.admin)?.isSuperAdmin || false
  });
});

app.get('/api/admin/list', requireSuperAdmin, (req, res) => {
  res.json(Array.from(DB.admins.values()));
});

app.post('/api/admin/add', requireSuperAdmin, (req, res) => {
  const { login, password } = req.body;
  
  if (DB.admins.size >= CONFIG.MAX_ADMINS) {
    return res.status(400).json({ error: 'Достигнут лимит администраторов' });
  }
  
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

// Отдача index.html для всех остальных GET-запросов
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Инициализация и запуск сервера
initDirectories().then(() => {
  const PORT = process.env.PORT || 10000;
  server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log('Предупреждение: Для production используйте Redis для хранения сессий');
  });
});
