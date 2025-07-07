const express = require('express');
const { Server } = require('ws');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

// Хранилище данных
const DB = {
  activeConnections: new Map(),
  connectionScreenshots: new Map(),
  screenshotsData: new Map()
};

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Разрешаем CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Создание директорий
async function initDirectories() {
  try {
    await fs.mkdir(path.join(__dirname, 'public'), { recursive: true });
    await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
  } catch (err) {
    console.error('Ошибка инициализации директорий:', err);
  }
}

// Очистка соединения
async function cleanupConnection(connectionId) {
  const screenshotIds = DB.connectionScreenshots.get(connectionId) || [];
  
  for (const id of screenshotIds) {
    try {
      await fs.unlink(path.join(__dirname, 'uploads', `${id}.png`));
      DB.screenshotsData.delete(id);
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
          timestamp: Date.now()
        });
        
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
  });
});

// API для получения списка скриншотов
app.get('/api/screenshots', async (req, res) => {
  try {
    const files = await fs.readdir(path.join(__dirname, 'uploads'));
    const screenshots = files
      .filter(file => file.endsWith('.png'))
      .map(file => ({
        id: file.replace('.png', ''),
        url: `/uploads/${file}`,
        timestamp: DB.screenshotsData.get(file.replace('.png', ''))?.timestamp || Date.now()
      }));
    
    res.json(screenshots);
  } catch (error) {
    console.error('Error getting screenshots:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Запуск сервера
initDirectories();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  
  // Очистка неактивных соединений каждые 5 минут
  setInterval(async () => {
    const now = Date.now();
    for (const [connectionId] of DB.activeConnections) {
      if (!DB.connectionScreenshots.has(connectionId)) continue;
      
      const screenshotIds = DB.connectionScreenshots.get(connectionId) || [];
      if (screenshotIds.length > 0) {
        const firstScreenshot = DB.screenshotsData.get(screenshotIds[0]);
        if (firstScreenshot && now - firstScreenshot.timestamp > 300000) {
          await cleanupConnection(connectionId);
        }
      }
    }
  }, 300000);
});
