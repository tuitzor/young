const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Статическая раздача фронтенда
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище скриншотов и ответов
const screenshots = new Map();

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('message', (message) => {
    console.log('Received:', message);
    const data = JSON.parse(message);
    if (data.type === 'screenshot') {
      const { questionId, screenshot } = data;
      screenshots.set(questionId, screenshot);
      // Симуляция ответа
      const answer = `Processed screenshot ${questionId.split('-')[0]}`;
      ws.send(JSON.stringify({ type: 'answer', questionId, answer }));
      console.log(`Sent answer: ${answer} for questionId: ${questionId}`);
    } else if (data.type === 'userAnswer') {
      const { questionId, answer } = data;
      screenshots.set(questionId, { ...screenshots.get(questionId), userAnswer: answer });
      ws.send(JSON.stringify({ type: 'answer', questionId, answer: `User answer received: ${answer}` }));
    } else if (data.type === 'pageHTML') {
      console.log('Received page HTML');
    }
  });
  ws.on('close', () => console.log('Client disconnected'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
