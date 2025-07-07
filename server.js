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

// Временная "база данных" в памяти
const DB = {
  admins: new Map(),
  activeConnections: new Map(),
  screenshotsData: new Map()
};

// Инициализация админа
function initAdmin() {
  const hashedPassword = bcrypt.hashSync(CONFIG.ADMIN_PASSWORD, 10);
  DB.admins.set('admin', {
    login: 'admin',
    password: hashedPassword,
    isSuperAdmin: true,
    online: false
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
        '<!DOCTYPE html><html><head><title>Screenshot Server</title></head><body><h1>Screenshot Server is Running</h1></body></html>'
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
      }
    } catch (error) {
      console.error('Ошибка WebSocket:', error);
    }
  });

  ws.on('close', () => {
    DB.activeConnections.delete(connectionId);
  });
});

// Проверка авторизации
function requireAuth(req, res, next) {
  if (req.session.admin) {
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

// API для авторизации
app.post('/api/admin/login', async (req, res) => {
  const { login, password } = req.body;
  const admin = DB.admins.get(login);
  
  if (admin && bcrypt.compareSync(password, admin.password)) {
    admin.online = true;
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

// API для статистики
app.get('/api/admin/stats', requireAuth, (req, res) => {
  const admin = DB.admins.get(req.session.admin);
  res.json({
    totalAdmins: DB.admins.size,
    onlineAdmins: Array.from(DB.admins.values()).filter(a => a.online).length,
    activeConnections: DB.activeConnections.size,
    totalScreenshots: DB.screenshotsData.size,
    currentAdmin: req.session.admin,
    isSuperAdmin: admin?.isSuperAdmin || false
  });
});

// Отдача index.html для всех остальных GET-запросов
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Инициализация и запуск сервера
initDirectories();
initAdmin();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Admin credentials:');
  console.log(`Login: admin`);
  console.log(`Password: ${CONFIG.ADMIN_PASSWORD}`);
});
