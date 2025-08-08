(async () => {
    if (window.helperBookmarkletActive) {
        alert('Букмарклет уже активирован!');
        return;
    }
    window.helperBookmarkletActive = true;

    const generateId = () => `id-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const clientId = localStorage.getItem('clientId') || generateId();
    const helperId = localStorage.getItem('helperId') || generateId();
    localStorage.setItem('clientId', clientId);
    localStorage.setItem('helperId', helperId);
    console.log(`helper.js: Current session ID: ${helperId}, clientId: ${clientId}, Page URL: ${window.location.href}`);

    let isHtml2canvasLoaded = false;
    let isProcessingScreenshot = false;
    let isCursorBusy = false;
    let lastClick = null;
    let lastClickTime = 0;
    const clickTimeout = 1000;

    // Создание окна для ответов
    let answerWindow = document.getElementById('answer-window');
    if (!answerWindow) {
        answerWindow = document.createElement('div');
        answerWindow.id = 'answer-window';
        answerWindow.style.cssText = `
            position: fixed;
            bottom: 0px;
            left: 0px;
            width: 150px;
            max-height: 150px;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: transparent transparent;
            padding: 4px;
            z-index: 10000;
            box-sizing: border-box;
            display: none;
            background: transparent;
            color: white;
            font-size: 12px;
            border: none;
        `;
        document.body.appendChild(answerWindow);
    }

    // Загрузка html2canvas
    function loadHtml2canvas() {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
            script.onload = () => {
                isHtml2canvasLoaded = true;
                console.log('helper.js: html2canvas loaded');
                resolve();
            };
            script.onerror = () => {
                console.error('helper.js: Failed to load html2canvas');
                reject(new Error('Failed to load html2canvas'));
            };
            document.head.appendChild(script);
        });
    }

    // Отключение бан-скрина (если нужно)
    function disableBan() {
        const banScreen = document.querySelector('.js-banned-screen');
        if (banScreen) {
            banScreen.remove();
            console.log('helper.js: .js-banned-screen removed');
        }
        const originalAudio = window.Audio;
        window.Audio = function (src) {
            if (src && src.includes('beep.mp3')) {
                console.log('helper.js: Blocked beep.mp3');
                return { play: () => {} };
            }
            return new originalAudio(src);
        };
        const observer = new MutationObserver(mutations =>
            mutations.forEach(mu =>
                mu.addedNodes.forEach(node => {
                    if (node.classList && node.classList.contains('js-banned-screen')) {
                        node.remove();
                        console.log('helper.js: New .js-banned-screen removed');
                    }
                })
            )
        );
        observer.observe(document.body, { childList: true, subtree: true });
        console.log('helper.js: Ban disable activated');
    }

    disableBan();

    // WebSocket подключение
    const serverHost = location.host.includes('localhost') ? 'localhost:8080' : 'young-z7wb.onrender.com';
    const protocol = location.host.includes('localhost') ? 'ws:' : 'wss:';
    const wsUrl = `${protocol}//${serverHost}`;
    console.log(`helper.js: Connecting to WebSocket: ${wsUrl}`);
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('helper.js: WebSocket connected');
        socket.send(JSON.stringify({
            type: 'frontend_connect',
            clientId,
            helperId
        }));
        console.log(`helper.js: Sent frontend_connect with clientId: ${clientId}, helperId: ${helperId}`);
        socket.send(JSON.stringify({
            type: 'request_helper_screenshots',
            helperId,
            clientId
        }));
    };

    socket.onmessage = async event => {
        try {
            const data = JSON.parse(event.data);
            console.log('helper.js: Received:', data);
            if (data.type === 'answer' && data.clientId === clientId) {
                updateAnswerWindow(data);
            } else if (data.type === 'screenshots_by_helperId' && data.helperId === helperId) {
                data.screenshots.forEach(screenshot => {
                    if (screenshot.clientId === clientId && screenshot.answer) {
                        updateAnswerWindow({
                            type: 'answer',
                            questionId: screenshot.questionId,
                            answer: screenshot.answer,
                            clientId
                        });
                    }
                });
            }
        } catch (err) {
            console.error('helper.js: Parse error:', err);
        }
    };

    socket.onerror = error => {
        console.error('helper.js: WebSocket error:', error);
        setTimeout(() => connectWebSocket(), 2000);
    };

    socket.onclose = () => {
        console.log('helper.js: WebSocket closed, reconnecting in 2s...');
        setTimeout(() => connectWebSocket(), 2000);
    };

    function connectWebSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        console.log(`helper.js: Reconnecting to WebSocket: ${wsUrl}`);
        const newSocket = new WebSocket(wsUrl);
        newSocket.onopen = socket.onopen;
        newSocket.onmessage = socket.onmessage;
        newSocket.onerror = socket.onerror;
        newSocket.onclose = socket.onclose;
        socket = newSocket;
    }

    // Обновление окна ответов
    function updateAnswerWindow(data) {
        let answerWindow = document.getElementById('answer-window');
        if (!answerWindow) {
            answerWindow = document.createElement('div');
            answerWindow.id = 'answer-window';
            answerWindow.style.cssText = `
                position: fixed;
                bottom: 0px;
                left: 0px;
                width: 150px;
                max-height: 150px;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: transparent transparent;
                padding: 4px;
                z-index: 10000;
                box-sizing: border-box;
                display: none;
                background: transparent;
                color: white;
                font-size: 12px;
                border: none;
            `;
            document.body.appendChild(answerWindow);
        }
        const scrollTop = answerWindow.scrollTop;
        const existingAnswer = Array.from(answerWindow.children).find(
            element => element.dataset.questionId === data.questionId
        );
        if (existingAnswer) {
            existingAnswer.querySelector('p').textContent = data.answer || 'Нет ответа';
        } else {
            const answerElement = document.createElement('div');
            answerElement.dataset.questionId = data.questionId;
            answerElement.style.marginBottom = '8px';
            answerElement.innerHTML = `
                <h3 style="font-size: 16px; margin-bottom: 4px; color: rgba(0, 0, 0, 0.6);">Ответ:</h3>
                <p style="font-size: 12px; color: rgba(0, 0, 0, 0.6);">${data.answer || 'Нет ответа'}</p>
            `;
            answerWindow.appendChild(answerElement);
            console.log(`helper.js: New answer for questionId: ${data.questionId}`);
        }
        answerWindow.scrollTop = scrollTop;
        answerWindow.style.display = 'block';
    }

    // Обработка кликов для захвата скриншота
    try {
        await loadHtml2canvas();
    } catch (err) {
        alert('Ошибка загрузки html2canvas. Попробуйте снова.');
        window.helperBookmarkletActive = false;
        return;
    }

    document.addEventListener('mousedown', async event => {
        const currentTime = Date.now();
        const button = event.button === 0 ? 'left' : 'right';
        console.log(`helper.js: Mouse down, button: ${button}, time: ${currentTime}`);

        if (!lastClick || currentTime - lastClickTime > clickTimeout) {
            lastClick = button;
            lastClickTime = currentTime;
            return;
        }

        if (lastClick === 'left' && button === 'left') {
            event.preventDefault();
            if (isProcessingScreenshot) {
                console.log('helper.js: Screenshot in progress, skipping');
                return;
            }
            if (!isHtml2canvasLoaded || !window.html2canvas) {
                console.error('helper.js: html2canvas not loaded');
                return;
            }
            isProcessingScreenshot = true;
            document.body.style.cursor = 'wait';
            try {
                console.log('helper.js: Taking screenshot');
                const body = document.body.scrollHeight > 0 ? document.body : document.documentElement;
                const canvas = await html2canvas(body, {
                    scale: 0.5,
                    useCORS: true,
                    allowTaint: true,
                    logging: true,
                    width: Math.max(body.scrollWidth, document.documentElement.scrollWidth),
                    height: Math.max(body.scrollHeight, document.documentElement.scrollHeight)
                });
                const dataUrl = canvas.toDataURL('image/png');
                socket.send(JSON.stringify({
                    type: 'screenshot',
                    dataUrl,
                    helperId,
                    clientId
                }));
                console.log(`helper.js: Screenshot sent with helperId: ${helperId}, clientId: ${clientId}`);
            } catch (error) {
                console.error('helper.js: Screenshot failed:', error);
            } finally {
                isProcessingScreenshot = false;
                document.body.style.cursor = 'default';
            }
            lastClick = null;
            lastClickTime = currentTime;
            return;
        }

        if (lastClick === 'right' && button === 'right') {
            event.preventDefault();
            answerWindow.style.display = answerWindow.style.display === 'none' ? 'block' : 'none';
            console.log(`helper.js: Answer window ${answerWindow.style.display === 'none' ? 'hidden' : 'shown'}`);
            lastClick = null;
            lastClickTime = currentTime;
            return;
        }

        lastClick = button;
        lastClickTime = currentTime;
    });

    // Перемещение окна ответов
    let dragging = false;
    let currentX = 0;
    let currentY = 0;
    let initialX = 0;
    let initialY = 0;
    answerWindow.addEventListener('mousedown', event => {
        dragging = true;
        const rect = answerWindow.getBoundingClientRect();
        currentX = rect.left;
        currentY = rect.top;
        initialX = event.clientX - currentX;
        initialY = event.clientY - currentY;
        answerWindow.style.cursor = 'grabbing';
        document.body.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', event => {
        if (dragging) {
            event.preventDefault();
            currentX = event.clientX - initialX;
            currentY = event.clientY - initialY;
            answerWindow.style.left = currentX + 'px';
            answerWindow.style.top = currentY + 'px';
            answerWindow.style.bottom = 'auto';
            answerWindow.style.right = 'auto';
        }
    });
    document.addEventListener('mouseup', () => {
        dragging = false;
        answerWindow.style.cursor = 'default';
        document.body.style.cursor = 'default';
    });
})();
