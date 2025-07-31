const express = require('express');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-very-secure-jwt-secret-1234567890abcdef';
const admins = [
    { username: 'admin1', passwordHash: bcrypt.hashSync('admin1A', 10) },
    { username: 'admin2', passwordHash: bcrypt.hashSync('admin2A', 10) },
    { username: 'admin3', passwordHash: bcrypt.hashSync('admin3A', 10) },
    { username: 'admin4', passwordHash: bcrypt.hashSync('admin4A', 10) },
    { username: 'admin5', passwordHash: bcrypt.hashSync('admin5A', 10) },
    { username: 'admin6', passwordHash: bcrypt.hashSync('admin6A', 10) }
];

app.use(cors());
app.use(express.json());
app.use('/screenshots', express.static(path.join(__dirname, 'public', 'screenshots')));
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(port, () => {
    console.log(`Server running on port: ${port}`);
});

const wss = new WebSocket.Server({ server });
console.log(`WebSocket server running on ws://localhost:${port}`);

let helpers = [];
let screenshots = [];

async function ensureScreenshotDir() {
    const screenshotDir = path.join(__dirname, 'public', 'screenshots');
    try {
        await fs.access(screenshotDir);
        console.log(`Server: Screenshot directory exists: ${screenshotDir}`);
    } catch {
        await fs.mkdir(screenshotDir, { recursive: true });
        console.log(`Server: Screenshot directory created: ${screenshotDir}`);
    }
}

async function loadScreenshots() {
    const screenshotDir = path.join(__dirname, 'public', 'screenshots');
    try {
        await ensureScreenshotDir();
        const files = await fs.readdir(screenshotDir);
        screenshots = [];
        for (const file of files) {
            if (file.endsWith('.png')) {
                const [helperId, questionId] = file.split('_');
                const answerPath = path.join(screenshotDir, `${helperId}_${questionId}.txt`);
                let answer = '';
                try {
                    answer = await fs.readFile(answerPath, 'utf8');
                } catch {}
                screenshots.push({
                    helperId,
                    questionId: questionId.replace('.png', ''),
                    imageUrl: `/screenshots/${file}`,
                    answer
                });
            }
        }
        helpers = [...new Set(screenshots.map(s => s.helperId))].map(helperId => ({
            helperId,
            hasAnswer: screenshots.some(s => s.helperId === helperId && s.answer)
        }));
        console.log(`Server: Loaded ${screenshots.length} screenshots for ${helpers.length} helpers`);
    } catch (err) {
        console.error('Server: Error loading screenshots:', err);
    }
}

app.get('/healthz', (req, res) => res.send('OK'));

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    console.log(`Server: Login attempt with username: ${username}`);
    if (!username || !password) {
        console.log('Server: Missing username or password');
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    const admin = admins.find(a => a.username === username);
    if (!admin) {
        console.log(`Server: User ${username} not found`);
        return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
    const passwordMatch = await bcrypt.compare(password, admin.passwordHash);
    console.log(`Server: Password for ${username} ${passwordMatch ? 'matched' : 'did not match'}`);
    if (!passwordMatch) {
        return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
    try {
        const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '1h' });
        console.log(`Server: Token created for ${username}`);
        res.status(200).json({ success: true, token });
    } catch (err) {
        console.error('Server: Error creating token:', err);
        res.status(500).json({ success: false, message: 'Server error during login' });
    }
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        console.log('Server: Token missing');
        return res.status(401).json({ success: false, message: 'Token missing' });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        console.log(`Server: Token verified for ${decoded.username}`);
        next();
    } catch (err) {
        console.log('Server: Invalid token');
        return res.status(403).json({ success: false, message: 'Invalid token' });
    }
}

app.get('/api/admin/list', authenticateToken, async (req, res) => {
    try {
        console.log(`Server: Helper list requested by ${req.user.username}`);
        res.json(helpers);
    } catch (err) {
        console.error('Server: Error fetching list:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

wss.on('connection', (ws) => {
    console.log('Server: New WebSocket client connected');
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Server: Received message:', data);
            if (data.type === 'frontend_connect') {
                ws.send(JSON.stringify({ type: 'initial_data', data: helpers }));
            } else if (data.type === 'submit_screenshot') {
                const { helperId, questionId, screenshot } = data;
                const screenshotPath = path.join(__dirname, 'public', 'screenshots', `${helperId}_${questionId}.png`);
                const base64Data = screenshot.replace(/^data:image\/png;base64,/, '');
                await fs.writeFile(screenshotPath, base64Data, 'base64');
                console.log(`Server: Screenshot saved: ${screenshotPath}`);
                screenshots.push({ helperId, questionId, imageUrl: `/screenshots/${helperId}_${questionId}.png`, answer: '' });
                if (!helpers.some(h => h.helperId === helperId)) {
                    helpers.push({ helperId, hasAnswer: false });
                }
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'screenshot_info',
                            helperId,
                            questionId,
                            imageUrl: `/screenshots/${helperId}_${questionId}.png`
                        }));
                    }
                });
            } else if (data.type === 'submit_answer') {
                const { questionId, answer } = data;
                const screenshot = screenshots.find(s => s.questionId === questionId);
                if (screenshot) {
                    screenshot.answer = answer;
                    const answerPath = path.join(__dirname, 'public', 'screenshots', `${screenshot.helperId}_${questionId}.txt`);
                    await fs.writeFile(answerPath, answer);
                    console.log(`Server: Answer saved for question ${questionId}`);
                    const helper = helpers.find(h => h.helperId === screenshot.helperId);
                    if (helper) {
                        helper.hasAnswer = screenshots.some(s => s.helperId === helper.helperId && s.answer);
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'update_helper_card',
                                    helperId: helper.helperId,
                                    hasAnswer: helper.hasAnswer
                                }));
                            }
                        });
                    }
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'answer', questionId, answer }));
                        }
                    });
                }
            } else if (data.type === 'delete_screenshot') {
                const { questionId } = data;
                const screenshot = screenshots.find(s => s.questionId === questionId);
                if (screenshot) {
                    const screenshotPath = path.join(__dirname, 'public', 'screenshots', `${screenshot.helperId}_${questionId}.png`);
                    const answerPath = path.join(__dirname, 'public', 'screenshots', `${screenshot.helperId}_${questionId}.txt`);
                    try {
                        await fs.unlink(screenshotPath);
                        console.log(`Server: Screenshot deleted: ${screenshotPath}`);
                        try {
                            await fs.unlink(answerPath);
                            console.log(`Server: Answer deleted: ${answerPath}`);
                        } catch {}
                        screenshots = screenshots.filter(s => s.questionId !== questionId);
                        const helper = helpers.find(h => h.helperId === screenshot.helperId);
                        if (helper && !screenshots.some(s => s.helperId === helper.helperId)) {
                            helpers = helpers.filter(h => h.helperId !== helper.helperId);
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({ type: 'helper_deleted', helperId: helper.helperId }));
                                }
                            });
                        } else if (helper) {
                            helper.hasAnswer = screenshots.some(s => s.helperId === helper.helperId && s.answer);
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'update_helper_card',
                                        helperId: helper.helperId,
                                        hasAnswer: helper.hasAnswer
                                    }));
                                }
                            });
                        }
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ type: 'screenshot_deleted_specific', questionId }));
                            }
                        });
                    } catch (err) {
                        console.error('Server: Error deleting screenshot:', err);
                    }
                }
            } else if (data.type === 'request_helper_screenshots') {
                const { helperId } = data;
                const helperScreenshots = screenshots.filter(s => s.helperId === helperId);
                ws.send(JSON.stringify({ type: 'screenshots_by_helperId', helperId, screenshots: helperScreenshots }));
            }
        } catch (err) {
            console.error('Server: Error processing message:', err);
        }
    });
    ws.on('close', () => console.log('Server: WebSocket client disconnected'));
});

loadScreenshots();
