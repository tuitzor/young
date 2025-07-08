const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Статическая раздача фронтенда
app.use(express.static(path.join(__dirname, 'public')));

// Обработка WebSocket
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('message', (message) => {
    console.log('Received:', message);
    const data = JSON.parse(message);
    if (data.type === 'screenshot') {
      // Здесь можно обработать скриншот (например, сохранить или отправить ответ)
      ws.send(JSON.stringify({ type: 'answer', answer: 'Screenshot received!' }));
    }
  });
  ws.on('close', () => console.log('Client disconnected'));
});

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
