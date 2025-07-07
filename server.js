const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Настройки
const PORT = process.env.PORT || 10000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SCREENSHOT_EXPIRE_MS = 24 * 60 * 60 * 1000; // 24 часа

// База данных в памяти
const db = {
  screenshots: new Map(),
  answers: new Map()
};

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

// Создаем директорию для загрузок
async function initUploadsDir() {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    console.log(`Upload directory created: ${UPLOAD_DIR}`);
  } catch (err) {
    console.error('Error creating upload directory:', err);
  }
}

// API для загрузки скриншотов
app.post('/upload', upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { originalname, filename, path: filePath } = req.file;
    const screenshotId = Date.now().toString();
    const screenshotUrl = `/uploads/${filename}`;

    // Сохраняем информацию о скриншоте
    db.screenshots.set(screenshotId, {
      id: screenshotId,
      url: screenshotUrl,
      path: filePath,
      timestamp: Date.now(),
      question: req.body.question || ''
    });

    console.log(`Screenshot uploaded: ${screenshotId}`);
    res.json({ 
      success: true, 
      screenshotId,
      screenshotUrl 
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API для отправки ответов
app.post('/answer', async (req, res) => {
  try {
    const { screenshotId, answer } = req.body;
    
    if (!db.screenshots.has(screenshotId)) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    db.answers.set(screenshotId, {
      answer,
      timestamp: Date.now()
    });

    console.log(`Answer saved for: ${screenshotId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Answer error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// API для получения скриншотов
app.get('/screenshots', (req, res) => {
  const screenshots = Array.from(db.screenshots.values()).map(screenshot => ({
    ...screenshot,
    answer: db.answers.get(screenshot.id)?.answer || null
  }));
  res.json(screenshots);
});

// Очистка старых скриншотов
async function cleanupOldScreenshots() {
  const now = Date.now();
  for (const [id, screenshot] of db.screenshots) {
    if (now - screenshot.timestamp > SCREENSHOT_EXPIRE_MS) {
      try {
        await fs.unlink(screenshot.path);
        db.screenshots.delete(id);
        db.answers.delete(id);
        console.log(`Cleaned up old screenshot: ${id}`);
      } catch (err) {
        console.error(`Error cleaning up screenshot ${id}:`, err);
      }
    }
  }
}

// Запуск сервера
async function startServer() {
  await initUploadsDir();
  
  // Очистка каждые 6 часов
  setInterval(cleanupOldScreenshots, 6 * 60 * 60 * 1000);
  
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
