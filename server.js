const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store connected clients with their IDs
const clients = new Map();

wss.on('connection', (ws) => {
  console.log('New client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Register client with a unique ID
      if (data.role === 'helper' && data.clientId) {
        clients.set(data.clientId, ws);
        ws.clientId = data.clientId;
        console.log(`Client registered: ${data.clientId}`);
        ws.send(JSON.stringify({ type: 'connected', message: 'Connected to server' }));
        return;
      }

      // Handle screenshot data
      if (data.type === 'screenshot' && data.targetClientId) {
        const targetWs = clients.get(data.targetClientId);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: 'screenshot',
            screenshot: data.screenshot,
            questionId: data.questionId,
            senderId: ws.clientId || 'anonymous'
          }));
          console.log(`Screenshot sent to client: ${data.targetClientId}`);
        } else {
          console.log(`Target client ${data.targetClientId} not found or not connected`);
          ws.send(JSON.stringify({ type: 'error', message: `Target client ${data.targetClientId} not found` }));
        }
      }

      // Handle page HTML (optional, for debugging)
      if (data.type === 'pageHTML') {
        console.log('Received page HTML from client:', ws.clientId);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    if (ws.clientId) {
      clients.delete(ws.clientId);
      console.log(`Client disconnected: ${ws.clientId}`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Image proxy endpoint for base64 conversion
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

// Serve a simple frontend for the recipient client
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Screenshot Receiver</title>
        <style>
          #screenshot-container { max-width: 100%; }
          img { max-width: 100%; height: auto; margin-bottom: 10px; }
        </style>
      </head>
      <body>
        <h1>Screenshot Receiver</h1>
        <input type="text" id="clientId" placeholder="Enter your Client ID">
        <button onclick="connect()">Connect</button>
        <div id="screenshot-container"></div>
        <script>
          let ws;
          function connect() {
            const clientId = document.getElementById('clientId').value;
            if (!clientId) {
              alert('Please enter a Client ID');
              return;
            }
            ws = new WebSocket('wss://young-z7wb.onrender.com');
            ws.onopen = () => {
              ws.send(JSON.stringify({ role: 'helper', clientId }));
              console.log('Connected as:', clientId);
            };
            ws.onmessage = (event) => {
              const data = JSON.parse(event.data);
              if (data.type === 'screenshot') {
                const img = document.createElement('img');
                img.src = data.screenshot;
                document.getElementById('screenshot-container').prepend(img);
                console.log('Received screenshot from:', data.senderId);
              } else if (data.type === 'error') {
                console.error('Server error:', data.message);
              }
            };
            ws.onclose = () => {
              console.log('Disconnected, reconnecting in 5s...');
              setTimeout(connect, 5000);
            };
          }
        </script>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});