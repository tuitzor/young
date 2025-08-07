const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 10000;
const SECRET_KEY = process.env.SECRET_KEY || 'your_secret_key';

// Учетные данные для шести администраторов
const USERS = {
    'admin1': 'adminXA',
    'admin2': 'adminXB',
    'admin3': 'adminXC',
    'admin4': 'adminXD',
    'admin5': 'adminXE',
    'admin6': 'adminXF',
};

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR);
}

const frontendHelperData = new Map();

function generateToken(user) {
    return jwt.sign({ user }, SECRET_KEY, { expiresIn: '1h' });
}

function verifyToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(403).json({ message: 'No token provided' });
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(500).json({ message: 'Failed to authenticate token' });
        req.user = decoded.user;
        next();
    });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use('/screenshots', express.static(SCREENSHOTS_DIR));

app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (USERS[username] === password) {
        const token = generateToken(username);
        res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    ws.clientId = null;
    ws.role = null;

    ws.on('message', message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (err) {
            console.error('Failed to parse message:', err);
            return;
        }

        if (data.type === 'frontend_connect') {
            ws.role = data.role;
            ws.clientId = data.clientId;
            console.log(`Client connected. Role: ${ws.role}, ClientId: ${ws.clientId}`);
        }
        
        if (data.type === 'screenshot') {
            const { dataUrl, clientId } = data;
            if (!dataUrl || !clientId) {
                return ws.send(JSON.stringify({ type: 'error', message: 'Invalid screenshot data' }));
            }
            
            const helperId = clientId;
            const questionId = `question-${Date.now()}`;
            const imageBuffer = Buffer.from(dataUrl.split(';base64,').pop(), 'base64');
            const imageUrl = `/screenshots/${questionId}.png`;

            fs.writeFile(path.join(SCREENSHOTS_DIR, `${questionId}.png`), imageBuffer, err => {
                if (err) {
                    console.error('Ошибка сохранения скриншота:', err);
                    return;
                }
                console.log(`Скриншот ${questionId}.png сохранен.`);
                
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.role === 'frontend') {
                        client.send(JSON.stringify({
                            type: 'screenshot_info',
                            questionId,
                            imageUrl,
                            helperId,
                            clientId: client.clientId 
                        }));
                    }
                });
            });
            return;
        }
        
        if (ws.role !== 'frontend') {
            return;
        }
        
        if (data.type === 'request_initial_data') {
            const clientScreenshots = [];
            for (const [helperId, helperInfo] of frontendHelperData.entries()) {
                const screenshots = helperInfo.screenshots
                    .filter(s => !s.clientId || s.clientId === ws.clientId)
                    .map(s => ({
                        questionId: s.questionId,
                        imageUrl: s.imageUrl,
                        answer: s.answer,
                        helperId: helperId,
                    }));
                clientScreenshots.push(...screenshots);
            }
            ws.send(JSON.stringify({ type: 'initial_data', data: clientScreenshots }));
        } else if (data.type === 'submit_answer') {
            const { questionId, answer } = data;
            let helperIdForAnswer = null;
            let screenshotToUpdate = null;

            for (const [hId, helperInfo] of frontendHelperData.entries()) {
                screenshotToUpdate = helperInfo.screenshots.find(s => s.questionId === questionId);
                if (screenshotToUpdate) {
                    helperIdForAnswer = hId;
                    break;
                }
            }

            if (screenshotToUpdate) {
                screenshotToUpdate.answer = answer;
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.clientId === data.clientId) {
                        client.send(JSON.stringify({
                            type: 'answer',
                            questionId,
                            answer,
                            clientId: data.clientId 
                        }));
                    }
                });
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Screenshot not found' }));
            }
        } else if (data.type === 'request_helper_screenshots') {
            const { helperId, clientId } = data;
            const helperInfo = frontendHelperData.get(helperId);
            if (helperInfo) {
                const screenshots = helperInfo.screenshots.filter(s => !s.clientId || s.clientId === clientId);
                ws.send(JSON.stringify({
                    type: 'screenshots_by_helperId',
                    helperId,
                    screenshots
                }));
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Helper not found' }));
            }
        } else if (data.type === 'delete_screenshot') {
            const { questionId, helperId, clientId } = data;
            const helperInfo = frontendHelperData.get(helperId);
            if (helperInfo) {
                const initialLength = helperInfo.screenshots.length;
                helperInfo.screenshots = helperInfo.screenshots.filter(s => s.questionId !== questionId);
                if (helperInfo.screenshots.length < initialLength) {
                    const filePath = path.join(SCREENSHOTS_DIR, `${questionId}.png`);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        console.log(`Файл скриншота ${questionId}.png удален.`);
                    }
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'screenshot_deleted_specific',
                                questionId,
                                helperId,
                                clientId
                            }));
                        }
                    });
                }
            }
        } else if (data.type === 'clear_all_screenshots') {
            for (const [helperId, helperInfo] of frontendHelperData.entries()) {
                helperInfo.screenshots.forEach(s => {
                    const filePath = path.join(SCREENSHOTS_DIR, `${s.questionId}.png`);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                });
                frontendHelperData.delete(helperId);
            }
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'all_screenshots_cleared' }));
                }
            });
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected. Role: ${ws.role}, ClientId: ${ws.clientId}`);
    });
});
