const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 Not Found</h1>');
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const wss = new WebSocket.Server({ server });

let screenshots = [];
let adminSocket = null;
let connectedClients = new Map();

wss.on('connection', ws => {
    console.log('Client connected');

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            console.log('Received message:', data.type);

            if (data.type === 'admin_connect') {
                console.log('Admin panel connected.');
                adminSocket = ws;
                ws.send(JSON.stringify({ type: 'screenshots_init', screenshots: screenshots }));
            } else if (data.type === 'helper_connect') {
                console.log(`Helper connected with ID: ${data.helperId}, Client ID: ${data.clientId}`);
                connectedClients.set(ws, { helperId: data.helperId, clientId: data.clientId });
                ws.send(JSON.stringify({ type: 'screenshots_by_helperId', helperId: data.helperId, screenshots: screenshots.filter(s => s.helperId === data.helperId) }));
            } else if (data.type === 'screenshot') {
                const existingScreenshot = screenshots.find(s => s.dinoId === data.dinoId);
                if (existingScreenshot) {
                    existingScreenshot.dataUrl = data.dataUrl;
                    console.log('Screenshot updated:', data.dinoId);
                } else {
                    const newScreenshot = {
                        dinoId: data.dinoId || `dino-${data.helperId}-${Date.now()}`, // Используем dinoId, если он есть
                        questionId: `screenshot-${data.helperId}-${Date.now()}`,
                        dataUrl: data.dataUrl,
                        helperId: data.helperId,
                        clientId: data.clientId,
                        timestamp: Date.now(),
                        answer: null,
                        answered: false
                    };
                    screenshots.push(newScreenshot);
                    console.log('New screenshot added:', newScreenshot.questionId);
                }
                if (adminSocket) {
                    adminSocket.send(JSON.stringify({ type: 'new_screenshot', screenshot: screenshots[screenshots.length - 1] }));
                }
            } else if (data.type === 'update_answer') {
                const screenshot = screenshots.find(s => s.questionId === data.questionId);
                if (screenshot) {
                    screenshot.answer = data.answer;
                    screenshot.answered = true;
                    console.log(`Answer updated for ${data.questionId}:`, data.answer);
                    if (adminSocket) {
                        adminSocket.send(JSON.stringify({ type: 'answer_updated', questionId: data.questionId, answer: data.answer }));
                    }
                    const helper = Array.from(connectedClients.values()).find(h => h.helperId === screenshot.helperId);
                    if (helper && helper.ws) {
                        helper.ws.send(JSON.stringify({ type: 'answer', questionId: screenshot.questionId, answer: data.answer }));
                    }
                }
            } else if (data.type === 'delete_screenshot') {
                const initialLength = screenshots.length;
                screenshots = screenshots.filter(s => s.questionId !== data.questionId);
                if (screenshots.length < initialLength) {
                    console.log(`Screenshot deleted: ${data.questionId}`);
                    if (adminSocket) {
                        adminSocket.send(JSON.stringify({ type: 'screenshot_deleted', questionId: data.questionId }));
                    }
                }
            } else if (data.type === 'request_helper_screenshots' && data.helperId) {
                 ws.send(JSON.stringify({ type: 'screenshots_by_helperId', helperId: data.helperId, screenshots: screenshots.filter(s => s.helperId === data.helperId) }));
            }
        } catch (err) {
            console.error('Failed to parse message:', err.message);
        }
    });

    ws.on('close', () => {
        const clientData = connectedClients.get(ws);
        if (clientData) {
            const { helperId } = clientData;
            console.log(`Connection closed for Helper ID: ${helperId}`);
            
            const initialCount = screenshots.length;
            screenshots = screenshots.filter(s => s.helperId !== helperId);
            const deletedCount = initialCount - screenshots.length;
            console.log(`Removed ${deletedCount} screenshots for Helper ID: ${helperId}`);

            if (adminSocket) {
                adminSocket.send(JSON.stringify({ type: 'helper_disconnected', helperId: helperId }));
            }
            
            connectedClients.delete(ws);
        } else if (ws === adminSocket) {
            console.log('Admin panel disconnected.');
            adminSocket = null;
        } else {
            console.log('An unknown client disconnected.');
        }
    });
});

const port = process.env.PORT || 10000;
server.listen(port, () => {
    console.log(`Server started on port ${port}`);
});
