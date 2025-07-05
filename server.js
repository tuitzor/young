const express = require('express');
const { Server } = require('ws');
const http = require('http');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

let users = {}; // { username: { password, role } }
let answers = {}; // Хранит ответы для каждого questionId

// Загрузка пользователей из файла
async function loadUsers() {
    try {
        const data = await fs.readFile(path.join(__dirname, 'users.json'), 'utf8');
        users = JSON.parse(data);
    } catch (err) {
        console.log('No users.json found, starting with admin');
        users = { 'admin': { password: 'adminpass', role: 'admin' } }; // Старший админ по умолчанию
       
