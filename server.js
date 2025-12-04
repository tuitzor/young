const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/tests', express.static(path.join(__dirname, 'public/tests')));

// Папка для хранения тестов
const testsDir = path.join(__dirname, 'public/tests');
if (!fs.existsSync(testsDir)) {
    fs.mkdirSync(testsDir, { recursive: true });
}

// Хранилище: helperId → данные теста
const activeTests = new Map(); // helperId → { data, timestamp, url, clientId }

const clients = new Map(); // clientId → ws (фронтенд)
const helpers = new Map(); // helperId → ws
const admins = new Map();  // adminId → ws

// === Запуск сервера ===
const server = app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
    console.log(`Тесты будут доступны по: http://localhost:${PORT}/tests`);
});

const wss = new WebSocket.Server({ server });

// === WebSocket обработка ===
wss.on('connection', (ws) => {
    console.log('Новый клиент подключился');

    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);

    ws.on('message', (msg) => {
        let data;
        try {
            data = JSON.parse(msg);
        } catch (e) {
            console.error('Ошибка парсинга:', e);
            return;
        }

        // === 1. Подключение фронтенда (студента) ===
        if (data.type === 'frontend_connect' && data.role === 'frontend') {
            ws.clientId = data.clientId || `client-${Date.now()}`;
            clients.set(ws.clientId, ws);
            console.log(`Фронтенд подключён: ${ws.clientId}`);

            // Отправляем ему список всех активных тестов
            const list = Array.from(activeTests.entries()).map(([helperId, info]) => ({
                helperId,
                url: info.url,
                title: info.title || 'Без названия',
                total: info.data.length,
                timestamp: info.timestamp
            }));
            ws.send(JSON.stringify({ type: 'tests_list', list }));
        }

        // === 2. Подключение админа ===
        if (data.type === 'admin_connect' && data.role === 'admin') {
            ws.adminId = `admin-${Date.now()}`;
            admins.set(ws.adminId, ws);
            console.log(`Админ подключён: ${ws.adminId}`);

            // Отправляем админу ВСЁ
            ws.send(JSON.stringify({
                type: 'all_tests_full',
                tests: Object.fromEntries(activeTests)
            }));
        }

        // === 3. Подключение помощника (хелпера) ===
        if (data.type === 'helper_connect' && (data.role === 'helper' || data.role === 'auto_helper')) {
            ws.helperId = data.helperId;
            helpers.set(data.helperId, ws);
            console.log(`Хелпер подключён: ${data.helperId}`);
        }

        // === 4. Приём полного теста от хелпера (ГЛАВНОЕ!) ===
        if (data.type === 'all_tests_auto' || data.type === 'all_tests_collected') {
            const { helperId, clientId, url, title, tests } = data;

            if (!helperId || !Array.isArray(tests) || tests.length === 0) {
                console.log('Некорректные данные теста от', helperId);
                return;
            }

            console.log(`\nПолучен тест от ${helperId}`);
            console.log(`Вопросов: ${tests.length} | URL: ${url}`);

            const testData = {
                helperId,
                clientId: clientId || null,
                url,
                title: title || new URL(url).pathname.split('/').pop() || 'test',
                timestamp: Date.now(),
                receivedAt: new Date().toISOString(),
                data: tests
            };

            // Сохраняем в память
            activeTests.set(helperId, testData);

            // Сохраняем на диск (JSON + удобно открывать в браузере)
            const safeName = helperId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const jsonPath = path.join(testsDir, `${safeName}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(testData, null, 2));
            console.log(`Тест сохранён: /tests/${safeName}.json`);

            // Рассылаем всем
            const notifyPayload = {
                type: 'new_test_received',
                helperId,
                url,
                title: testData.title,
                total: tests.length,
                jsonUrl: `/tests/${safeName}.json`,
                timestamp: testData.timestamp
            };

            // Всем фронтендам
            clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(notifyPayload));
                }
            });

            // Всем админам — полные данные
            admins.forEach(admin => {
                if (admin.readyState === WebSocket.OPEN) {
                    admin.send(JSON.stringify({
                        type: 'full_test_update',
                        helperId,
                        test: testData
                    }));
                }
            });

            console.log(`Тест от ${helperId} разослан всем клиентам\n`);
        }
    });

    ws.on('close', () => {
        if (ws.clientId) clients.delete(ws.clientId);
        if (ws.helperId) helpers.delete(ws.helperId);
        if (ws.adminId) admins.delete(ws.adminId);
        console.log('Клиент отключился');
    });
});

// Пинг-понг для живых соединений
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// === Простая страница со списком тестов ===
app.get('/', (req, res) => {
    const files = fs.readdirSync(testsDir).filter(f => f.endsWith('.json'));
    let html = `<h1>Активные тесты (${files.length})</h1><ul>`;
    files.forEach(f => {
        const helperId = f.replace('.json', '');
        const info = activeTests.get(helperId) || {};
        html += `<li><a href="/tests/${f}" target="_blank">${helperId}</a> — ${info.total || '?'} вопросов — ${info.url || ''}</li>`;
    });
    html += `</ul><hr><small>Сервер работает. Тесты приходят автоматически.</small>`;
    res.send(html);
});

console.log(`Готов к приёму тестов на ws://localhost:${PORT}`);
