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

// Изменено: Мап для хранения данных о скриншотах, сгруппированных по helperId.
// Ключ: helperId, Значение: Массив объектов скриншотов [{ questionId, imageUrl, answer }]
const screenshotsByHelper = new Map(); // Key: helperId, Value: Array of {questionId, imageUrl, answer}

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
    const filename = `${tempQuestionId}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    fs.writeFile(filepath, base64Data, 'base64', (err) => {
        if (err) {
            console.error('Сервер (POST): Ошибка при сохранении скриншота:', err);
            return res.status(500).json({ success: false, message: 'Ошибка сервера при сохранении скриншота.' });
        } else {
            const imageUrl = `/screenshots/${filename}`;
            const questionId = imageUrl; // Используем imageUrl как уникальный ID для фронтенда

            // Добавляем новый скриншот в Map
            if (!screenshotsByHelper.has(helperId)) {
                screenshotsByHelper.set(helperId, []);
            }
            screenshotsByHelper.get(helperId).push({ questionId, imageUrl, helperId, answer: '' }); // Добавляем пустой ответ

            let sentCount = 0;
            // Отправляем информацию о новом скриншоте всем фронтенд-клиентам
            // Отправляем информацию о новом скриншоте и helperId
            frontendClients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'screenshot_info',
                        questionId,
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
 * Заполняет Map screenshotsByHelper.
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

        // Очищаем Map перед загрузкой, чтобы избежать дублирования
        screenshotsByHelper.clear();

        const screenshotFiles = files.filter(file => file.endsWith('.png'));

        // Сортируем файлы, чтобы сохранить порядок (например, по имени, которое содержит timestamp)
        screenshotFiles.sort();

        screenshotFiles.forEach(file => {
            const parts = file.split('-');
            // helperId теперь будет "helper-<timestamp>" из имени файла
            const helperIdPart = parts[0]; // "helper"
            const timestampPart = parts[1]; // "<timestamp>"
            const helperId = `${helperIdPart}-${timestampPart}`; // "helper-<timestamp>"

            const imageUrl = `/screenshots/${file}`;
            const questionId = imageUrl; // Используем URL как уникальный ID

            if (!screenshotsByHelper.has(helperId)) {
                screenshotsByHelper.set(helperId, []);
            }
            screenshotsByHelper.get(helperId).push({ questionId, imageUrl, helperId, answer: '' });
        });
        console.log(`Сервер: Загружено ${screenshotFiles.length} существующих скриншотов для ${screenshotsByHelper.size} помощников.`);
    });
}


/**
 * Удаляет все скриншоты, связанные с данным helperId, из папки SCREENSHOTS_DIR и из screenshotsByHelper.
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

                    // Удаляем из screenshotsByHelper
                    if (screenshotsByHelper.has(helperId)) {
                        const helperScreenshots = screenshotsByHelper.get(helperId);
                        const initialLength = helperScreenshots.length;
                        screenshotsByHelper.set(helperId, helperScreenshots.filter(
                            s => s.imageUrl !== deletedImageUrl
                        ));
                        if (screenshotsByHelper.get(helperId).length === 0) {
                            screenshotsByHelper.delete(helperId); // Удаляем helperId, если нет скриншотов
                            // Оповещаем фронтенд о том, что helperId больше не существует
                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'helper_deleted',
                                        helperId: helperId
                                    }));
                                }
                            });
                        }
                    }

                    // Оповещаем фронтенд-клиентов об удалении конкретного скриншота
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

                    // --- ОТПРАВЛЯЕМ ВСЕ СУЩЕСТВУЮЩИЕ helperId И ИХ ПОСЛЕДНИЕ СКРИНШОТЫ НОВОМУ ФРОНТЕНД-КЛИЕНТУ ---
                    const initialData = [];
                    screenshotsByHelper.forEach((screenshots, helperId) => {
                        if (screenshots.length > 0) {
                            // Отправляем только последний скриншот для предпросмотра
                            const latestScreenshot = screenshots[screenshots.length - 1];
                            initialData.push({
                                helperId: helperId,
                                latestScreenshotUrl: latestScreenshot.imageUrl,
                                hasAnswer: !!latestScreenshot.answer // Если есть ответ, то помечаем
                            });
                        }
                    });
                    ws.send(JSON.stringify({
                        type: 'initial_data',
                        data: initialData
                    }));
                    console.log(`Сервер: Отправлено ${initialData.length} helperId и их последние скриншоты новому фронтенд-клиенту.`);
                }

                if (data.type === 'submit_answer') {
                    const { questionId, answer } = data; // questionId теперь это imageUrl

                    // Находим соответствующий скриншот в Map и обновляем его ответ
                    let foundScreenshot = null;
                    let targetHelperId = null;
                    for (const [hId, screenshots] of screenshotsByHelper) {
                        foundScreenshot = screenshots.find(s => s.questionId === questionId);
                        if (foundScreenshot) {
                            foundScreenshot.answer = answer; // Сохраняем ответ в данных
                            targetHelperId = hId;
                            break;
                        }
                    }

                    if (foundScreenshot && targetHelperId) {
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

                        // Также обновляем ответ на всех фронтенд-панелях (для HelperCard и для FullScreen)
                        frontendClients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'answer',
                                    questionId, // Это уже полный URL
                                    answer
                                }));
                                // Если ответ отправлен, также обновим hasAnswer для HelperCard
                                client.send(JSON.stringify({
                                    type: 'update_helper_card',
                                    helperId: targetHelperId,
                                    hasAnswer: !!answer
                                }));
                            }
                        });
                    } else {
                        console.warn(`Сервер: Скриншот с questionId ${questionId} не найден для обновления ответа.`);
                    }

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

                            // Удаляем из screenshotsByHelper
                            let helperIdOfDeletedScreenshot = null;
                            for (const [hId, screenshots] of screenshotsByHelper) {
                                const initialLength = screenshots.length;
                                screenshotsByHelper.set(hId, screenshots.filter(s => s.questionId !== questionId));
                                if (screenshotsByHelper.get(hId).length < initialLength) { // Если что-то удалили
                                    helperIdOfDeletedScreenshot = hId;
                                    if (screenshotsByHelper.get(hId).length === 0) {
                                        screenshotsByHelper.delete(hId); // Удаляем helperId, если нет скриншотов
                                        // Оповещаем фронтенд о том, что helperId больше не существует (карточка должна исчезнуть)
                                        frontendClients.forEach(client => {
                                            if (client.readyState === WebSocket.OPEN) {
                                                client.send(JSON.stringify({
                                                    type: 'helper_deleted',
                                                    helperId: hId
                                                }));
                                            }
                                        });
                                    } else {
                                        // Если helperId остался, но скриншот удален, обновим latestScreenshotUrl на карточке
                                        const newLatestScreenshot = screenshotsByHelper.get(hId)[screenshotsByHelper.get(hId).length - 1];
                                        frontendClients.forEach(client => {
                                            if (client.readyState === WebSocket.OPEN) {
                                                client.send(JSON.stringify({
                                                    type: 'update_helper_card',
                                                    helperId: hId,
                                                    latestScreenshotUrl: newLatestScreenshot.imageUrl,
                                                    hasAnswer: !!newLatestScreenshot.answer
                                                }));
                                            }
                                        });
                                    }
                                    break; // Нашли и удалили, выходим
                                }
                            }

                            // Оповещаем все фронтенд-панели об удалении конкретного скриншота
                            frontendClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'screenshot_deleted_specific',
                                        questionId: questionId // Отправляем полный URL
                                    }));
                                }
                            });
                        }
                    });
                } else if (data.type === 'request_helper_screenshots') { // НОВЫЙ ТИП СООБЩЕНИЯ
                    const { helperId: requestedHelperId } = data;
                    const screenshotsForHelper = screenshotsByHelper.get(requestedHelperId) || [];
                    console.log(`Сервер: Отправка ${screenshotsForHelper.length} скриншотов для helperId ${requestedHelperId} фронтенду.`);
                    ws.send(JSON.stringify({
                        type: 'screenshots_by_helperId',
                        helperId: requestedHelperId,
                        screenshots: screenshotsForHelper
                    }));
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

        // Если отключился помощник, очищаем его скриншоты и удаляем его из списка
        if (currentHelperId && helperClients.get(currentHelperId) === ws) {
            console.log(`Сервер: Помощник с ID: ${currentHelperId} отключился. Запускаю очистку скриншотов.`);
            helperClients.delete(currentHelperId);
            clearHelperScreenshots(currentHelperId); // Эта функция также отправит helper_deleted на фронтенд
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
