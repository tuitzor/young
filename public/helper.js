(async () => {
    // Конфигурация
    const config = {
        serverUrl: "wss://young-p1x2.onrender.com",
        helperSessionId: `helper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        clickTimeout: 1000,
        reconnectDelay: 5000,
        html2canvasUrl: "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
        screenshotChunkHeight: window.innerHeight,
        screenshotDelay: 100
    };

    // Состояние приложения
    const state = {
        socket: null,
        isHtml2canvasLoaded: false,
        isProcessingScreenshot: false,
        isCursorBusy: false,
        screenshotOrder: [],
        lastClick: null,
        lastClickTime: 0,
        mutationObserver: null
    };

    // Функция добавления стилей
    function addStyles() {
        const style = document.createElement("style");
        style.textContent = `
            .helper-answer-window {
                position: fixed;
                bottom: 0px;
                left: 0px;
                width: 150px;
                max-height: 150px;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: transparent transparent;
                padding: 4px;
                border-radius: 2px;
                z-index: 10000;
                box-sizing: border-box;
                display: none;
                background: white;
                border: 1px solid #ccc;
            }
            .helper-answer-content h3 {
                font-size: 16px;
                margin-bottom: 4px;
            }
            .helper-answer-content p {
                font-size: 12px;
                margin: 0;
            }
        `;
        document.head.appendChild(style);
    }

    // Управление курсором
    function setCursor(cursorState) {
        if (cursorState === "wait" && !state.isCursorBusy) {
            state.isCursorBusy = true;
            document.body.style.cursor = "wait";
        } else if (cursorState === "default" && state.isCursorBusy) {
            state.isCursorBusy = false;
            document.body.style.cursor = "default";
        }
    }

    // Окно с ответами
    function updateAnswerWindow(data) {
        let answerWindow = document.getElementById("answer-window");
        if (!answerWindow) {
            answerWindow = document.createElement("div");
            answerWindow.id = "answer-window";
            answerWindow.className = "helper-answer-window";
            document.body.appendChild(answerWindow);
            
            // Делаем окно перетаскиваемым
            let dragging = false;
            let currentX = 0;
            let currentY = 0;
            let initialX = 0;
            let initialY = 0;
            
            answerWindow.addEventListener("mousedown", (e) => {
                dragging = true;
                const rect = answerWindow.getBoundingClientRect();
                currentX = rect.left;
                currentY = rect.top;
                initialX = e.clientX - currentX;
                initialY = e.clientY - currentY;
                answerWindow.style.cursor = "grabbing";
                e.preventDefault();
            });
            
            document.addEventListener("mousemove", (e) => {
                if (dragging) {
                    currentX = e.clientX - initialX;
                    currentY = e.clientY - initialY;
                    answerWindow.style.left = `${currentX}px`;
                    answerWindow.style.top = `${currentY}px`;
                }
            });
            
            document.addEventListener("mouseup", () => {
                dragging = false;
                answerWindow.style.cursor = "default";
            });
        }
        
        answerWindow.innerHTML = `
            <div class="helper-answer-content">
                <h3>Ответ:</h3>
                <p>${data.answer || "Нет ответа"}</p>
            </div>
        `;
        answerWindow.style.display = "block";
    }

    // Защита от бана
    function disableBanProtection() {
        // Удаляем существующие бан-экраны
        document.querySelectorAll(".js-banned-screen").forEach(el => el.remove());
        
        // Блокируем звук бана
        const originalAudio = window.Audio;
        window.Audio = function(src) {
            if (src?.includes("beep.mp3")) {
                return { play: () => {} };
            }
            return new originalAudio(src);
        };

        // Наблюдатель для новых бан-экранов
        state.mutationObserver = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.classList?.contains("js-banned-screen")) {
                        node.remove();
                    }
                });
            });
        });

        state.mutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // Создание скриншотов
    async function takeFullPageScreenshot() {
        if (state.isProcessingScreenshot || !state.isHtml2canvasLoaded) {
            console.log("Screenshot skipped - already processing or html2canvas not loaded");
            return;
        }

        state.isProcessingScreenshot = true;
        setCursor("wait");

        try {
            const totalHeight = document.documentElement.scrollHeight;
            const screenshots = [];

            for (let y = 0; y < totalHeight; y += config.screenshotChunkHeight) {
                window.scrollTo(0, y);
                await new Promise(resolve => setTimeout(resolve, config.screenshotDelay));

                const canvas = await html2canvas(document.body, {
                    scale: window.devicePixelRatio || 2,
                    useCORS: true,
                    width: document.documentElement.scrollWidth,
                    height: config.screenshotChunkHeight,
                    x: 0,
                    y: y,
                    windowWidth: document.documentElement.scrollWidth,
                    windowHeight: config.screenshotChunkHeight,
                    scrollX: 0,
                    scrollY: 0
                });

                screenshots.push(canvas.toDataURL("image/png"));
            }

            window.scrollTo(0, 0);
            await sendScreenshots(screenshots);
        } catch (error) {
            console.error("Screenshot failed:", error);
        } finally {
            state.isProcessingScreenshot = false;
            setCursor("default");
        }
    }

    // Отправка скриншотов на сервер
    async function sendScreenshots(screenshots) {
        for (const [index, screenshotData] of screenshots.entries()) {
            const tempQuestionId = `${config.helperSessionId}-${Date.now()}-${index}`;
            state.screenshotOrder.push(tempQuestionId);

            const message = {
                type: "screenshot",
                screenshot: screenshotData,
                tempQuestionId,
                helperId: config.helperSessionId,
                // Ключевое изменение для обхода авторизации
                bypassAuth: true
            };

            if (state.socket?.readyState === WebSocket.OPEN) {
                state.socket.send(JSON.stringify(message));
                console.log("Screenshot sent:", tempQuestionId);
            } else {
                console.error("WebSocket not connected, cannot send screenshot");
            }
        }
    }

    // WebSocket соединение
    function connectWebSocket() {
        if (state.socket?.readyState === WebSocket.OPEN) return;

        state.socket = new WebSocket(config.serverUrl);

        state.socket.onopen = () => {
            console.log("WebSocket connected");
            
            // Отправляем данные подключения помощника
            state.socket.send(JSON.stringify({
                role: "helper",
                helperId: config.helperSessionId,
                // Ключевое изменение для обхода авторизации
                bypassAuth: true
            }));
            
            // Отправляем HTML страницы
            state.socket.send(JSON.stringify({
                type: "pageHTML",
                html: document.documentElement.outerHTML,
                helperId: config.helperSessionId
            }));
        };

        state.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log("Received:", data);
                
                if (data.type === "answer" && data.questionId) {
                    updateAnswerWindow(data);
                }
            } catch (error) {
                console.error("Message parse error:", error);
            }
        };

        state.socket.onerror = (error) => {
            console.error("WebSocket error:", error);
        };

        state.socket.onclose = () => {
            console.log("WebSocket closed. Reconnecting...");
            setTimeout(connectWebSocket, config.reconnectDelay);
        };
    }

    // Обработчик двойного клика
    function handleDoubleClick(event) {
        const currentTime = Date.now();
        const button = event.button === 0 ? "left" : "right";
        
        if (!state.lastClick || currentTime - state.lastClickTime > config.clickTimeout) {
            state.lastClick = button;
            state.lastClickTime = currentTime;
            return;
        }

        if (state.lastClick === "left" && button === "left") {
            event.preventDefault();
            takeFullPageScreenshot();
        } else if (state.lastClick === "right" && button === "right") {
            event.preventDefault();
            const answerWindow = document.getElementById("answer-window");
            if (answerWindow) {
                answerWindow.style.display = answerWindow.style.display === "none" ? "block" : "none";
            }
        }

        state.lastClick = null;
    }

    // Инициализация
    async function init() {
        setCursor("wait");
        
        try {
            // Загрузка html2canvas
            await new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = config.html2canvasUrl;
                script.onload = () => {
                    state.isHtml2canvasLoaded = true;
                    resolve();
                };
                script.onerror = () => {
                    reject(new Error("Failed to load html2canvas"));
                };
                document.head.appendChild(script);
            });

            // Добавляем стили
            addStyles();

            // Включаем защиту от бана
            disableBanProtection();

            // Подключаемся к WebSocket
            connectWebSocket();

            // Назначаем обработчик кликов
            document.addEventListener("mousedown", handleDoubleClick);

            setCursor("default");
        } catch (error) {
            console.error("Initialization failed:", error);
            setCursor("default");
        }
    }

    // Запускаем приложение
    await init();
})();
