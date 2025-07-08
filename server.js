const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Статическая раздача фронтенда
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище ответов (для примера, можно заменить на базу данных)
const responses = new Map();

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('message', (message) => {
    console.log('Received:', message);
    const data = JSON.parse(message);
    if (data.type === 'screenshot') {
      const questionId = data.questionId;
      // Симуляция ответа (замени на свою логику)
      const answer = `Response for screenshot ${questionId.split('-')[0]}`;
      responses.set(questionId, answer);
      ws.send(JSON.stringify({ type: 'answer', questionId, answer }));
    } else if (data.type === 'answer') {
      const { questionId, answer } = data;
      responses.set(questionId, answer); // Сохранение ответа пользователя
      ws.send(JSON.stringify({ type: 'answer', questionId, answer: `User answer received: ${answer}` }));
    }
  });
  ws.on('close', () => console.log('Client disconnected'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
