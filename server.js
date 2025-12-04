const express = require('express');
const ws = require('ws');
const app = express();
app.use(express.static('public'));

const server = app.listen(process.env.PORT || 10000);
const wss = new ws.Server({ server });

const rooms = new Map(); // sessionId -> { test, answers: {1:"a", 3:"c", ...}, clients: [] }

wss.on('connection', (socket) => {
    socket.on('message', (msg) => {
        const data = JSON.parse(msg);

        if (data.type === "student_connect") {
            socket.sessionId = data.sessionId;
            socket.send(JSON.stringify({ type: "connected" }));
        }

        if (data.type === "new_test_room") {
            rooms.set(data.sessionId, {
                sessionId: data.sessionId,
                url: data.url,
                total: data.total,
                tests: data.tests,
                answers: {},
                timestamp: Date.now()
            });
            broadcastToAdmins();
        }

        if (data.type === "answer_selected" && socket.isAdmin) {
            const room = rooms.get(data.sessionId);
            if (room) {
                room.answers[data.questionIndex] = data.letter;
                // Отправляем студенту обновлённые ответы
                wss.clients.forEach(client => {
                    if (client.sessionId === data.sessionId && client.readyState === ws.OPEN) {
                        client.send(JSON.stringify({
                            type: "answers_update",
                            sessionId: data.sessionId,
                            answers: room.answers
                        }));
                    }
                });
                broadcastToAdmins();
            }
        }

        if (data.type === "admin_connect") {
            socket.isAdmin = true;
            broadcastToAdmins(socket);
        }
    });
});

function broadcastToAdmins(singleSocket = null) {
    const roomList = Array.from(rooms.values()).map(r => ({
        sessionId: r.sessionId,
        url: r.url,
        total: r.total,
        answered: Object.keys(r.answers).length,
        timestamp: r.timestamp
    }));

    const target = singleSocket || [...wss.clients].filter(c => c.isAdmin);
    target.forEach(admin => {
        if (admin.readyState === ws.OPEN) {
            admin.send(JSON.stringify({
                type: "rooms_update",
                rooms: roomList
            }));
            // Если админ открыл комнату — шлём полные данные
            if (singleSocket && admin === singleSocket) {
                const fullData = Object.fromEntries(rooms);
                admin.send(JSON.stringify({ type: "full_rooms_data", rooms: fullData }));
            }
        }
    });
}

app.get('/', (req, res) => res.sendFile(__dirname + '/public/admin.html'));
console.log("СЕРВЕР ЗАПУЩЕН — ГОТОВ К БОЮ");
