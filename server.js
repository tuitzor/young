// server.js — полностью рабочий
const express = require('express');
const ws = require('ws');
const app = express();
app.use(express.static('public'));

const server = app.listen(process.env.PORT || 10000);
const wss = new ws.Server({ server });

const rooms = new Map(); // studentId → {studentId, url, total, questions[], answers{}, timestamp}

wss.on('connection', socket => {
    socket.on('message', msg => {
        const d = JSON.parse(msg);

        if (d.type === "student_connect") {
            // Студент подключился
        }

        if (d.type === "send_test") {
            rooms.set(d.studentId, {
                studentId: d.studentId,
                url: d.url,
                total: d.total,
                questions: d.questions,
                answers: {},
                timestamp: Date.now()
            });
            broadcastRooms();
        }

        if (d.type === "set_answer") {
            const room = rooms.get(d.studentId);
            if (room) {
                if (!room.answers) room.answers = {};
                room.answers[d.questionIndex] = d.letter;

                // Отправляем студенту обновлённые ответы
                wss.clients.forEach(client => {
                    if (client.studentId === d.studentId && client.readyState === ws.OPEN) {
                        client.send(JSON.stringify({
                            type: "correct_answers",
                            studentId: d.studentId,
                            answers: room.answers
                        }));
                    }
                });

                broadcastRooms();
            }
        }

        if (d.type === "admin_connect" || d.type === "request_rooms") {
            broadcastRooms(socket);
        }
    });

    socket.on('close', () => {
        // Можно добавить удаление пустых комнат
    });
});

function broadcastRooms(single = null) {
    const list = Array.from(rooms.values()).map(r => ({
        studentId: r.studentId,
        url: r.url,
        total: r.total,
        answers: r.answers || {},
        timestamp: r.timestamp
    }));

    const targets = single ? [single] : [...wss.clients].filter(c => c.readyState === ws.OPEN);
    targets.forEach(c => c.send(JSON.stringify({ type: "room_list", rooms: list })));
}

console.log("Сервер запущен — всё в одном файле!");
