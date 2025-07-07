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
  SESSION_SECRET: process.env.SESSION_SECRET || 'strong-secret-here',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123'
};

// Временная база данных
const DB = {
  admins: new Map(),
  activeConnections: new Map(),
  screenshotsData: new Map(),
  connectionScreenshots: new Map() // Для отслеживания скриншотов по соединению
};

// Инициализация админа
function initAdmin() {
  const hashedPassword = bcrypt.hashSync(CONFIG.ADMIN_PASSWORD, 10);
  DB.admins.set('admin', {
    login: 'admin',
    password: hashedPassword,
    isSuperAdmin: true,
    online: false,
    lastActive: Date.now()
  });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Разрешаем CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Создание директорий
async function initDirectories() {
  try {
    await fs.mkdir(path.join(__dirname, 'public'), { recursive: true });
    await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
  } catch (err) {
    console.error('Ошибка инициализации директорий:', err);
  }
}

// Удаление скриншотов соединения
async function cleanupConnection(connectionId) {
  const screenshotIds = DB.connectionScreenshots.get(connectionId) || [];
  
  for (const id of screenshotIds) {
    try {
      await fs.unlink(path.join(__dirname, 'uploads', `${id}.png`));
      DB.screenshotsData.delete(id);
      console.log(`Удален скриншот: ${id}`);
    } catch (err) {
      console.error(`Ошибка удаления скриншота ${id}:`, err);
    }
  }
  
  DB.connectionScreenshots.delete(connectionId);
  DB.activeConnections.delete(connectionId);
}

// WebSocket обработчик
wss.on('connection', (ws) => {
  const connectionId = Date.now().toString();
  DB.activeConnections.set(connectionId, ws);
  DB.connectionScreenshots.set(connectionId, []);
  console.log(`Новое подключение: ${connectionId}`);

  // Обновляем активность админа
  if (ws.admin) {
    const admin = DB.admins.get(ws.admin);
    if (admin) {
      admin.lastActive = Date.now();
      admin.online = true;
    }
  }

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'screenshot') {
        const base64Data = data.screenshot.replace(/^data:image\/png;base64,/, '');
        const filename = `${data.questionId}.png`;
        const filePath = path.join(__dirname, 'uploads', filename);
        
        await fs.writeFile(filePath, base64Data, 'base64');
        
        DB.screenshotsData.set(data.questionId, {
          connectionId,
          timestamp: Date.now(),
          answer: ""
        });
        
        // Сохраняем ID скриншота для соединения
        const connScreenshots = DB.connectionScreenshots.get(connectionId) || [];
        connScreenshots.push(data.questionId);
        DB.connectionScreenshots.set(connectionId, connScreenshots);
      }
    } catch (error) {
      console.error('Ошибка WebSocket:', error);
    }
  });

  ws.on('close', async () => {
    console.log(`Соединение закрыто: ${connectionId}`);
    await cleanupConnection(connectionId);
    
    // Помечаем админа как оффлайн, если это было его соединение
    if (ws.admin) {
      const admin = DB.admins.get(ws.admin);
      if (admin) {
        admin.online = false;
      }
    }
  });
});

// Проверка авторизации
function requireAuth(req, res, next) {
  if (req.session.admin) {
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

// Проверка суперадмина
function requireSuperAdmin(req, res, next) {
  const admin = DB.admins.get(req.session.admin);
  if (admin && admin.isSuperAdmin) {
    return next();
  }
  res.status(403).json({ error: 'Admin privileges required' });
}

// API для авторизации
app.post('/api/admin/login', async (req, res) => {
  const { login, password } = req.body;
  const admin = DB.admins.get(login);
  
  if (admin && bcrypt.compareSync(password, admin.password)) {
    admin.online = true;
    admin.lastActive = Date.now();
    req.session.admin = login;
    return res.json({ 
      success: true, 
      isSuperAdmin: admin.isSuperAdmin 
    });
  }
  
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/logout', (req, res) => {
  const admin = DB.admins.get(req.session.admin);
  if (admin) admin.online = false;
  
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({ error: 'Logout error' });
    }
    res.json({ success: true });
  });
});

// API для работы со скриншотами
app.get('/api/screenshots', requireAuth, async (req, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'uploads'));
    const screenshots = files
      .filter(file => file.endsWith('.png'))
      .map(file => {
        const id = file.replace('.png', '');
        return {
          id,
          url: `/uploads/${file}`,
          timestamp: DB.screenshotsData.get(id)?.timestamp || Date.now(),
          answer: DB.screenshotsData.get(id)?.answer || ""
        };
      });
    
    res.json(screenshots);
  } catch (error) {
    console.error('Error getting screenshots:', error);
    res.status(500).json({ error: 'Server error' });
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
  
  res.status(404).json({ error: 'Screenshot not found' });
});

// API для управления администраторами
app.get('/api/admin/stats', requireAuth, (req, res) => {
  const admin = DB.admins.get(req.session.admin);
  
  // Помечаем неактивных админов как оффлайн
  const now = Date.now();
  for (const [login, admin] of DB.admins) {
    if (admin.online && now - admin.lastActive > 30000) { // 30 секунд неактивности
      admin.online = false;
    }
  }
  
  res.json({
    totalAdmins: DB.admins.size,
    onlineAdmins: Array.from(DB.admins.values()).filter(a => a.online).length,
    activeConnections: DB.activeConnections.size,
    totalScreenshots: DB.screenshotsData.size,
    currentAdmin: req.session.admin,
    isSuperAdmin: admin?.isSuperAdmin || false
  });
});

app.get('/api/admin/list', requireAuth, requireSuperAdmin, (req, res) => {
  res.json(Array.from(DB.admins.values()));
});

app.post('/api/admin/add', requireAuth, requireSuperAdmin, (req, res) => {
  const { login, password } = req.body;
  
  if (DB.admins.size >= CONFIG.MAX_ADMINS) {
    return res.status(400).json({ error: 'Admin limit reached' });
  }
  
  if (DB.admins.has(login)) {
    return res.status(400).json({ error: 'Admin already exists' });
  }
  
  DB.admins.set(login, {
    login,
    password: bcrypt.hashSync(password, 10),
    isSuperAdmin: false,
    online: false,
    lastActive: Date.now()
  });
  
  res.json({ success: true });
});

app.post('/api/admin/remove', requireAuth, requireSuperAdmin, (req, res) => {
  const { login } = req.body;
  
  if (login === 'admin') {
    return res.status(400).json({ error: 'Cannot remove super admin' });
  }
  
  if (!DB.admins.has(login)) {
    return res.status(404).json({ error: 'Admin not found' });
  }
  
  DB.admins.delete(login);
  res.json({ success: true });
});

// Отдача index.html для всех GET-запросов
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Инициализация и запуск сервера
initDirectories();
initAdmin();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Super admin credentials:');
  console.log(`Login: admin`);
  console.log(`Password: ${CONFIG.ADMIN_PASSWORD}`);
  
  // Очистка неактивных соединений каждую минуту
  setInterval(async () => {
    const now = Date.now();
    for (const [connectionId] of DB.activeConnections) {
      // Для пользовательских соединений (не админ)
      if (!DB.connectionScreenshots.has(connectionId)) continue;
      
      const screenshotIds = DB.connectionScreenshots.get(connectionId) || [];
      if (screenshotIds.length > 0) {
        const firstScreenshot = DB.screenshotsData.get(screenshotIds[0]);
        if (firstScreenshot && now - firstScreenshot.timestamp > 300000) { // 5 минут
          await cleanupConnection(connectionId);
        }
      }
    }
  }, 60000); // Каждую минуту
});
