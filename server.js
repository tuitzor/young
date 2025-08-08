const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients with their IDs and roles
const clients = new Map();

wss.on('connection', (ws) => {
  console.log('New client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Register client with role and clientId
      if (data.role && data.clientId) {
        clients.set(data.clientId, ws);
        ws.clientId = data.clientId;
        ws.role = data.role; // 'admin' or 'helper'
        console.log(`Client registered: ${data.clientId} as ${data.role}`);
        ws.send(JSON.stringify({ type: 'connected', message: `Connected as ${data.role}` }));
        return;
      }

      // Handle screenshot data
      if (data.type === 'screenshot' && data.targetClientId) {
        // Send to all admins
        clients.forEach((client, clientId) => {
          if (client.role === 'admin' && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'screenshot',
              screenshot: data.screenshot,
              questionId: data.questionId,
              senderId: data.clientId
            }));
            console.log(`Screenshot sent to admin: ${clientId}`);
          }
        });

        // Send confirmation to sender (if not admin)
        const senderWs = clients.get(data.clientId);
        if (senderWs && senderWs.role !== 'admin' && senderWs.readyState === WebSocket.OPEN) {
          senderWs.send(JSON.stringify({
            type: 'answer',
            questionId: data.questionId,
            answer: 'Screenshot received by admin'
          }));
          console.log(`Confirmation sent to sender: ${data.clientId}`);
        }

        // Handle case where targetClientId is not found
        if (data.targetClientId !== 'admin' && !clients.has(data.targetClientId)) {
          if (senderWs && senderWs.readyState === WebSocket.OPEN) {
            senderWs.send(JSON.stringify({
              type: 'error',
              message: `Target client ${data.targetClientId} not found`
            }));
          }
          console.log(`Target client ${data.targetClientId} not found`);
        }
      }

      // Handle response from admin to client
      if (data.type === 'response' && data.role === 'admin' && data.targetClientId) {
        const targetWs = clients.get(data.targetClientId);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: 'answer',
            questionId: data.questionId,
            answer: data.answer
          }));
          console.log(`Response sent to client: ${data.targetClientId}`);
        } else {
          console.log(`Target client ${data.targetClientId} not found or not connected`);
          ws.send(JSON.stringify({
            type: 'error',
            message: `Target client ${data.targetClientId} not found`
          }));
        }
      }

      // Handle page HTML (optional, for debugging)
      if (data.type === 'pageHTML') {
        console.log('Received page HTML from client:', data.clientId);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    if (ws.clientId) {
      clients.delete(ws.clientId);
      console.log(`Client disconnected: ${ws.clientId} (${ws.role})`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Image proxy endpoint
app.get('/proxy-image', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).send('No URL provided');
  }
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error('Failed to fetch image');
    }
    const buffer = await response.buffer();
    res.set('Content-Type', response.headers.get('content-type'));
    res.send(buffer);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).send('Failed to proxy image');
  }
});

// Serve the recipient interface
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
