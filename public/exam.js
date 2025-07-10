document.addEventListener('DOMContentLoaded', () => {
    const serverUrl = window.location.origin; // Используем текущий домен для подключения к серверу
    let websocket;
    let currentToken = localStorage.getItem('jwtToken'); // Пытаемся получить токен из локального хранилища
    let selectedClientId = null; // ID студента, выбранного в списке

    // DOM-элементы
    const loginSection = document.getElementById('login-section');
    const examSection = document.getElementById('exam-section');
    const loginForm = document.getElementById('login-form');
    const loginMessage = document.getElementById('login-message');
    const logoutButton = document.getElementById('logout-button');
    const activeClientsList = document.getElementById('active-clients');
    const noClientsMessage = activeClientsList.querySelector('.no-clients-message');
    const clientDetailsSection = document.getElementById('client-details');
    const currentClientIdSpan = document.getElementById('current-client-id');
    const currentScreenshot = document.getElementById('current-screenshot');
    const screenshotStatus = document.getElementById('screenshot-status');
    const currentHtml = document.getElementById('current-html');
    const htmlStatus = document.getElementById('html-status');
    const tabButtons = document.querySelectorAll('.tab-button');
    const disconnectClientButton = document.getElementById('disconnect-client-button');

    const clientsData = new Map(); // Хранилище данных для всех подключенных клиентов (clientId -> {screenshot, html})

    // --- Функции управления UI ---

    function showSection(section) {
        document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
        section.classList.remove('hidden');
        section.classList.add('active');
    }

    function displayMessage(element, message, type) {
        element.textContent = message;
        element.className = `message ${type}`;
    }

    function clearMessages() {
        loginMessage.textContent = '';
        loginMessage.className = 'message';
    }

    function updateClientList() {
        // Очищаем список, кроме "Нет активных студентов"
        activeClientsList.querySelectorAll('li:not(.no-clients-message)').forEach(li => li.remove());

        if (clientsData.size === 0) {
            noClientsMessage.style.display = 'block';
            clientDetailsSection.style.display = 'none'; // Скрываем детали, если нет клиентов
        } else {
            noClientsMessage.style.display = 'none';
            clientDetailsSection.style.display = 'block'; // Показываем детали, если есть клиенты
            
            clientsData.forEach((data, clientId) => {
                const li = document.createElement('li');
                li.id = `client-${clientId}`; // ID для легкого доступа
                li.textContent = `Студент: ${clientId.substring(0, 8)}...`; // Короткий ID для отображения
                li.dataset.clientId = clientId; // Полный ID в data-атрибуте
                
                li.addEventListener('click', () => selectClient(clientId));
                activeClientsList.appendChild(li);
            });

            // Если выбранный клиент отключился или его нет, выбираем первого
            if (selectedClientId === null || !clientsData.has(selectedClientId)) {
                if (clientsData.size > 0) {
                    selectClient(clientsData.keys().next().value); // Выбираем первого клиента
                } else {
                    selectedClientId = null;
                    currentClientIdSpan.textContent = '';
                    currentScreenshot.src = '';
                    screenshotStatus.textContent = 'Ожидание скриншота...';
                    currentHtml.value = '';
                    htmlStatus.textContent = 'Ожидание HTML...';
                }
            } else {
                // Если выбранный клиент все еще активен, обновляем его статус в списке
                selectClient(selectedClientId); 
            }
        }
    }

    function selectClient(clientId) {
        selectedClientId = clientId;
        currentClientIdSpan.textContent = clientId.substring(0, 12); // Отображаем часть ID

        // Снимаем выделение со всех элементов списка
        activeClientsList.querySelectorAll('li').forEach(li => li.classList.remove('selected'));
        // Выделяем выбранный элемент
        const selectedLi = document.getElementById(`client-${clientId}`);
        if (selectedLi) {
            selectedLi.classList.add('selected');
        }

        // Отображаем данные выбранного клиента
        const data = clientsData.get(clientId);
        if (data) {
            currentScreenshot.src = data.latestScreenshot || '';
            screenshotStatus.textContent = data.latestScreenshot ? '' : 'Ожидание скриншота...';
            currentHtml.value = data.latestHtml || '';
            htmlStatus.textContent = data.latestHtml ? '' : 'Ожидание HTML...';
        } else {
            // Если данных нет, очищаем поля
            currentScreenshot.src = '';
            screenshotStatus.textContent = 'Ожидание скриншота...';
            currentHtml.value = '';
            htmlStatus.textContent = 'Ожидание HTML...';
        }
    }

    // --- Функции WebSocket ---

    function connectWebSocket() {
        if (websocket && websocket.readyState === WebSocket.OPEN) {
            console.log('WebSocket уже подключен.');
            return;
        }

        websocket = new WebSocket(`ws://${window.location.host}`); // Подключаемся к текущему хосту
        // Если вы деплоите на Render.com (HTTPS), используйте wss:
        // websocket = new WebSocket(`wss://${window.location.host}`);


        websocket.onopen = () => {
            console.log('WebSocket подключение установлено. Отправляем токен для авторизации...');
            if (currentToken) {
                websocket.send(JSON.stringify({
                    type: 'auth_panel',
                    token: currentToken
                }));
            } else {
                console.warn('Нет токена для авторизации. Перенаправление на логин.');
