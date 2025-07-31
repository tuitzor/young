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
                bottom: 20px;
                left: 20px;
                width: 250px;
                max-height: 200px;
                background: white;
                border: 1px solid #ddd;
                border-radius: 5px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                padding: 10px;
                z-index: 10000;
                overflow-y: auto;
            }
            .helper-answer-content h3 {
                margin: 0 0 8px 0;
                font-size: 14px;
                color: #333;
            }
            .helper-answer-content p {
                margin: 0;
                font-size: 13px;
                line-height: 1.4;
                color: #555;
            }
        `;
        document.head.appendChild(style);
    }

    // Функции управления UI
    function setCursor(cursorState) {
        if (cursorState === "wait" && !state.isCursorBusy) {
            state.isCursorBusy = true;
            document.body.style.cursor = "wait";
        } else if (cursorState === "default" && state.isCursorBusy) {
            state.isCursorBusy = false;
            document.body.style.cursor = "default";
        }
    }

    function updateAnswerWindow(data) {
        let answerWindow = document.getElementById("answer-window");
        if (!answerWindow) {
            answerWindow = document.createElement("div");
            answerWindow.id = "answer-window";
            answerWindow.className = "helper-answer-window";
            document.body.appendChild(answerWindow);
        }
        
        answerWindow.innerHTML = `
            <div class="helper-answer-content">
                <h3>Ответ помощника:</h3>
                <p>${data.answer || "Ответ не предоставлен"}</p>
            </div>
        `;
        answerWindow.style.display = "block";
    }

    // Функции безопасности
    function disableBanProtection() {
        // Удаление существующих бан-скринов
        document.querySelectorAll(".js-banned-screen").forEach(el => el.remove());
        
        // Блокировка звуков бана
        const originalAudio = window.Audio;
        window.Audio = function(src) {
            if (src?.includes("beep.mp3")) {
                return { play: () => console.log("Ban sound blocked") };
            }
            return new originalAudio(src);
        };

        // Наблюдатель за новыми бан-скринами
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

    // Функции работы со скриншотами
    async function takeFullPageScreenshot() {
        if (state.isProcessingScreenshot || !state.isHtml2canvasLoaded) return;

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

    async function sendScreenshots(screenshots) {
        for (const [index, screenshotData] of screenshots.entries()) {
            const tempQuestionId = `${config.helperSessionId}-${Date.now()}-${index}`;
            state.screenshotOrder.push(tempQuestionId);

            const message = {
                type: "screenshot",
                screenshot: screenshotData,
                tempQuestionId,
                helperId: config.helperSessionId
            };

            if (state.socket?.readyState === WebSocket.OPEN) {
                state.socket.send(JSON.stringify(message));
            }
        }
    }

    // Функции WebSocket
    function connectWebSocket() {
        if (state.socket?.readyState === WebSocket.OPEN) return;

        state.socket = new WebSocket(config.serverUrl);

        state.socket.onopen = () => {
            console.log("WebSocket connected");
            sendInitialData();
        };

        state.socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleSocketMessage(data);
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

    function sendInitialData() {
        const pageHTML = document.documentElement.outerHTML;
        
        state.socket.send(JSON.stringify({
            role: "helper",
            helperId: config.helperSessionId
        }));

        state.socket.send(JSON.stringify({
            type: "pageHTML",
            html: pageHTML,
            helperId: config.helperSessionId
        }));
    }

    function handleSocketMessage(data) {
        console.log("Received message:", data);
        
        if (data.type === "answer" && data.questionId) {
            updateAnswerWindow(data);
        }
    }

    // Обработчики событий
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
                script.onerror = reject;
                document.head.appendChild(script);
            });

            // Добавление стилей
            addStyles();

            // Настройка безопасности
            disableBanProtection();

            // Подключение WebSocket
            connectWebSocket();

            // Установка обработчиков событий
            document.addEventListener("mousedown", handleDoubleClick);

            setCursor("default");
        } catch (error) {
            console.error("Initialization failed:", error);
            setCursor("default");
        }
    }

    // Запуск приложения
    await init();
})();
