const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;
const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots');

// Массив для хранения данных о скриншотах, которые будут отправляться клиентам
// questionId теперь будет полным URL к скриншоту, чтобы он был уникальным и удобным для фронтенда
const screenshotsData = [];

// --- НАСТРОЙКИ CORS ---
const corsOptions = {
    origin: 'https://papaya-speculoos-1311a6.netlify.app',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

// Создаем папку для скриншотов, если ее нет
if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    console.log(`Сервер: Создана папка для скриншотов: ${SCREENSHOTS_DIR}`);
} else {
    console.log(`Сервер: Папка для скриншотов уже существует: ${SCREENSHOTS_DIR}`);
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- API-маршрут для проксирования изображений ---
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
        if (error.response && error.response.status === 404) {
            console.warn(`Сервер (Proxy): Изображение не найдено по URL: ${imageUrl}`);
            return res.status(404).send('Изображение не найдено на удаленном сервере.');
        }
        console.error('Сервер (Proxy): Ошибка проксирования изображения:', imageUrl, error.message);
        res.status(500).send('Не удалось загрузить изображение через прокси.');
    }
});

// --- API-маршрут для загрузки скриншотов через HTTP POST ---
app.post('/api/upload-screenshot', (req, res) => {
    const { type, screenshot, tempQuestionId, helperId } = req.body; // tempQuestionId это questionId, который генерирует helper
    console.log("Сервер (POST): Получен запрос на загрузку скриншота.", {tempQuestionId, helperId});

    if (type !== 'screenshot' || !screenshot || !tempQuestionId || !helperId) {
        return res.status(400).json({ success: false, message: 'Неверные данные скриншота.' });
    }

    const base64Data = screenshot.replace(/^data:image\/png;base64,/, "");
    // Имя файла будет helperId-<timestamp>-<index>.png
    // TempQuestionId приходит как helper-<timestamp>-<index>
    const filename = `${tempQuestionId}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    fs.writeFile(filepath, base64Data, 'base64', (err) => {
        if (err) {
            console.error('Сервер (POST): Ошибка при сохранении скриншота:', err);
            return res.status(500).json({ success: false, message: 'Ошибка сервера при сохранении скриншота.' });
        } else {
            const imageUrl = `/screenshots/${filename}`;
            // Для questionId используем полный URL, чтобы он был уникальным и соответствовал imageUrl
            const questionId = imageUrl; // Используем imageUrl как уникальный ID для фронтенда
            console.log(`Сервер (POST): Скриншот сохранен: ${filename}. QuestionId (для фронтенда): ${questionId}`);

            // Добавляем новый скриншот в наш массив данных
            screenshotsData.push({ questionId, imageUrl, helperId });

            let sentCount = 0;
            // Отправляем информацию о скриншоте всем подключенным фронтенд-клиентам
            frontendClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'screenshot_info',
                        questionId, // Теперь это URL
                        imageUrl,
                        helperId
                    }));
                    sentCount++;
                }
            });
            console.log(`Сервер (POST): Отправлено скриншот-сообщений ${sentCount} фронтенд-клиентам.`);
            if (sentCount === 0) {
                console.warn('Сервер (POST): Нет активных фронтенд-клиентов для отправки скриншотов.');
            }
            return res.status(200).json({ success: true, message: 'Скриншот успешно загружен.' });
        }
    });
});


// --- WebSocket-соединения ---
const helperClients = new Map();
const frontendClients = new Set();

/**
 * Загружает информацию о существующих скриншотах из директории SCREENSHOTS_DIR.
 * Заполняет массив screenshotsData.
 */
function loadExistingScreenshots() {
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
        console.log("Сервер: Папка скриншотов не найдена при загрузке. Создаем.");
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        return;
    }

    fs.readdir(SCREENSHOTS_DIR, (err, files) => {
        if (err) {
            console.error("Сервер: Ошибка при чтении папки скриншотов:", err);
            return;
        }

        // Отсортируем файлы по имени, чтобы новые были в конце (или начале, как удобнее)
        files.sort((a, b) => {
            // Предполагаем формат helper-<timestamp>-<index>.png
            const timeA = parseInt(a.split('-')[1]);
            const timeB = parseInt(b.split('-')[1]);
            return timeA - timeB; // Сортировка по возрастанию времени
        });

        screenshotsData.length = 0; // Очищаем массив на случай повторного вызова
        files.forEach(file => {
            if (file.endsWith('.png')) {
                const parts = file.split('-');
                const helperId = `${parts[0]}-${parts[1]}`; // helper-<timestamp>
                const imageUrl = `/screenshots/${file}`;
                const questionId = imageUrl; // Используем URL как уникальный ID для фронтенда

                screenshotsData.push({ questionId, imageUrl, helperId });
            }
        });
        console.log(`Сервер: Загружено ${screenshotsData.length} существующих скриншотов.`);
    });
}

/**
 * Удаляет все скриншоты, связанные с данным helperId, из папки SCREENSHOTS_DIR и из screenshotsData.
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
                    const deletedImageUrl = `/screenshots/${file}`;

                    // Удаляем из screenshotsData
                    const initialLength = screenshotsData.length;
                    screenshotsData.splice(0, screenshotsData.length, ...screenshotsData.filter(
                        s => s.imageUrl !== deletedImageUrl
                    ));
                    if (initialLength > screenshotsData.length) {
                        console.log(`Сервер: Удален 1 элемент из screenshotsData.`);
                    }

                    // Оповещаем фронтенд-клиентов об удалении скриншота
                    frontendClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'screenshot_deleted_specific', // Используем specific, чтобы удалить по URL
                                questionId: deletedImageUrl // Отправляем URL, который был questionId
                            }));
                        }
                    });
                }
            });
        });
    });
}


wss.on('connection', (ws, req) => {
    let currentHelperId = null;

    console.log('Сервер: Новый клиент подключился по WebSocket');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);

            if (data.role === 'helper') {
                currentHelperId = data.helperId;
                if (currentHelperId) {
                    helperClients.set(currentHelperId, ws);
                    console.log(`Сервер: Подключился помощник с ID: ${currentHelperId}`);
                }
                if (data.type === 'pageHTML') {
                    // console.log('Сервер: Получен HTML страницы от помощника (не сохраняем в этом примере).');
                } else if (data.type === 'ping') {
                    // console.log(`Сервер: Получен пинг от helperId: ${data.helperId}`);
                }
            } else { // Это фронтенд-клиент (просмотрщик)
                if (!frontendClients.has(ws)) {
                    frontendClients.add(ws);
                    console.log('Сервер: Фронтенд-клиент идентифицирован и добавлен.');

                    // --- ОТПРАВЛЯЕМ ВСЕ СУЩЕСТВУЮЩИЕ СКРИНШОТЫ НОВОМУ ФРОНТЕНД-КЛИЕНТУ ---
                    screenshotsData.forEach(screenshot => {
                        ws.send(JSON.stringify({
                            type: 'screenshot_info',
                            questionId: screenshot.questionId, // Это уже полный URL
                            imageUrl: screenshot.imageUrl,
                            helperId: screenshot.helperId
                        }));
                    });
                    console.log(`Сервер: Отправлено ${screenshotsData.length} существующих скриншотов новому фронтенд-клиенту.`);
                }

                if (data.type === 'submit_answer') {
                    const { questionId, answer } = data; // questionId теперь это imageUrl

                    // Находим соответствующий скриншот в screenshotsData и обновляем его ответ
                    const screenshot = screenshotsData.find(s => s.questionId === questionId);
                    if (screenshot) {
                        screenshot.answer = answer; // Сохраняем ответ в данных
                    }

                    // Извлекаем helperId из questionId (который является URL изображения)
                    const filename = questionId.split('/').pop(); // "helper-1234567890-0.png"
                    const parts = filename.split('-');
                    const targetHelperId = `${parts[0]}-${parts[1]}`; // "helper-1234567890"

                    const targetHelperWs = helperClients.get(targetHelperId);
                    if (targetHelperWs && targetHelperWs.readyState === WebSocket.OPEN) {
                        targetHelperWs.send(JSON.stringify({
                            type: 'answer',
                            questionId, // Это уже полный URL
                            answer
                        }));
                        console.log(`Сервер: Ответ "${answer}" отправлен обратно помощнику для ${questionId}`);
                    } else {
                        console.warn(`Сервер: Активный помощник с ID: ${targetHelperId} не найден или его WS закрыт для questionId: ${questionId}.`);
                    }

                    // Также обновляем ответ на всех фронтенд-панелях
                    frontendClients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'answer',
                                questionId, // Это уже полный URL
                                answer
                            }));
                        }
                    });
                } else if (data.type === 'delete_screenshot') {
                    const { questionId } = data; // questionId здесь это полный URL /screenshots/filename.png
                    const filenameWithExt = questionId.split('/').pop();
                    const filepath = path.join(SCREENSHOTS_DIR, filenameWithExt);

                    fs.unlink(filepath, (err) => {
                        if (err) {
                            console.error(`Сервер: Ошибка при удалении файла скриншота ${filepath}:`, err);
                            ws.send(JSON.stringify({ type: 'error', message: 'Ошибка при удалении скриншота.' }));
                        } else {
                            console.log(`Сервер: Файл скриншота удален: ${filepath}`);

                            // Удаляем из screenshotsData
                            const initialLength = screenshotsData.length;
                            screenshotsData.splice(0, screenshotsData.length, ...screenshotsData.filter(
                                s => s.questionId !== questionId // Сравниваем по полному URL
                            ));
                            if (initialLength > screenshotsData.length) {
                                console.log(`Сервер: Удален 1 элемент из screenshotsData.`);
                            }

                            // Оповещаем все фронтенд-панели об удалении скриншота
                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'screenshot_deleted_specific',
                                        questionId: questionId // Отправляем полный URL, чтобы фронтенд знал, какой элемент удалить
                                    }));
                                }
                            });
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Сервер: Ошибка при разборе сообщения или обработке данных:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат сообщения.' }));
        }
    });

    ws.on('close', () => {
        console.log('Сервер: Клиент отключился.');
        if (frontendClients.has(ws)) {
            frontendClients.delete(ws);
        }

        if (currentHelperId && helperClients.get(currentHelperId) === ws) {
            console.log(`Сервер: Помощник с ID: ${currentHelperId} отключился. Запускаю очистку скриншотов.`);
            helperClients.delete(currentHelperId);
            clearHelperScreenshots(currentHelperId);
        }
    });

    ws.on('error', error => {
        console.error('Сервер: Ошибка WebSocket:', error);
    });
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log(`WebSocket-сервер запущен на ws://localhost:${PORT}`);
    loadExistingScreenshots(); // Загружаем существующие скриншоты при старте сервера
});
