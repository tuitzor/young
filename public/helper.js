(async () => {
    let production = "wss://young-p1x2.onrender.com";
    let socket = null;
    let isHtml2canvasLoaded = false;
    let isProcessingScreenshot = false;
    let isCursorBusy = false;
    let screenshotOrder = [];
    let lastClick = null;
    let lastClickTime = 0;
    const clickTimeout = 1000;
    const helperSessionId = `helper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    console.log("helper.js: Current session ID:", helperSessionId);

    function setCursor(state) {
        if (state === "wait" && !isCursorBusy) {
            isCursorBusy = true;
            document.body.style.cursor = "wait";
            console.log("helper.js: Cursor set to wait");
        } else if (state === "default" && isCursorBusy) {
            isCursorBusy = false;
            document.body.style.cursor = "default";
            console.log("helper.js: Cursor reset to default");
        }
    }

    // Инициализация скриншота без ожидания
    setCursor("wait");
    setTimeout(() => {
        setCursor("default");
    }, 1000);

    const pageHTML = document.documentElement.outerHTML;
    console.log("helper.js: Captured page HTML");

    // Загрузка html2canvas без блокировки интерфейса
    let script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    script.async = true;
    script.onload = () => {
        isHtml2canvasLoaded = true;
        console.log("helper.js: html2canvas loaded");
        setCursor("default");
    };
    script.onerror = () => {
        console.error("helper.js: Failed to load html2canvas");
        setCursor("default");
    };
    document.head.appendChild(script);

    // Упрощенная функция для обхода бана
    function disableBan() {
        window.Audio = function(src) {
            if (src && src.includes("beep.mp3")) {
                console.log("helper.js: Blocked beep.mp3");
                return { play: () => {} };
            }
            return new (window.Audio || window.webkitAudioContext)(src);
        };
        
        const observer = new MutationObserver(() => {
            const banScreen = document.querySelector(".js-banned-screen");
            if (banScreen) {
                banScreen.remove();
                console.log("helper.js: Removed ban screen");
            }
        });
        
        observer.observe(document.body, { childList: true, subtree: true });
        console.log("helper.js: Ban protection activated");
    }

    disableBan();

    // Функция для создания WebSocket соединения
    function connectWebSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        
        socket = new WebSocket(production);
        
        socket.onopen = () => {
            console.log("helper.js: WebSocket connected");
            socket.send(JSON.stringify({ 
                role: "helper", 
                helperId: helperSessionId,
                bypassAuth: true // Флаг для обхода авторизации
            }));
            socket.send(JSON.stringify({ 
                type: "pageHTML", 
                html: pageHTML, 
                helperId: helperSessionId 
            }));
        };
        
        socket.onmessage = event => {
            try {
                const data = JSON.parse(event.data);
                console.log("helper.js: Received:", data);
                if (data.type === "answer") {
                    updateAnswerWindow(data);
                }
            } catch (err) {
                console.error("helper.js: Parse error:", err);
            }
        };
        
        socket.onerror = error => {
            console.error("helper.js: WebSocket error:", error);
        };
        
        socket.onclose = () => {
            console.log("helper.js: WebSocket closed, reconnecting...");
            setTimeout(connectWebSocket, 5000);
        };
    }

    connectWebSocket();

    // Улучшенная функция для создания скриншотов
    async function takeScreenshot() {
        if (isProcessingScreenshot || !isHtml2canvasLoaded) {
            console.log("helper.js: Screenshot already in progress or html2canvas not loaded");
            return;
        }

        isProcessingScreenshot = true;
        setCursor("wait");
        
        try {
            console.log("helper.js: Starting screenshot process");
            
            const height = document.documentElement.scrollHeight;
            const windowHeight = window.innerHeight;
            const screenshots = [];
            const scrollPosition = window.scrollY;
            
            // Делаем скриншоты по частям
            for (let y = 0; y < height; y += windowHeight) {
                window.scrollTo(0, y);
                await new Promise(resolve => setTimeout(resolve, 100));
                
                const canvas = await html2canvas(document.body, {
                    scale: window.devicePixelRatio || 1,
                    useCORS: true,
                    logging: false,
                    width: document.documentElement.scrollWidth,
                    height: Math.min(windowHeight, height - y),
                    x: 0,
                    y: y,
                    windowWidth: document.documentElement.scrollWidth,
                    windowHeight: windowHeight,
                    scrollX: 0,
                    scrollY: y,
                    allowTaint: true,
                    foreignObjectRendering: true
                });
                
                screenshots.push(canvas.toDataURL("image/png"));
            }
            
            // Возвращаем скролл на прежнее место
            window.scrollTo(0, scrollPosition);
            
            // Отправляем скриншоты
            for (const screenshot of screenshots) {
                const tempQuestionId = `${helperSessionId}-${Date.now()}-${screenshots.indexOf(screenshot)}`;
                
                const data = {
                    type: "screenshot",
                    screenshot: screenshot,
                    tempQuestionId: tempQuestionId,
                    helperId: helperSessionId,
                    bypassAuth: true // Флаг для обхода авторизации
                };
                
                screenshotOrder.push(tempQuestionId);
                
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify(data));
                    console.log("helper.js: Screenshot sent:", tempQuestionId);
                } else {
                    console.error("helper.js: WebSocket not connected, storing screenshot locally");
                    // Можно добавить локальное хранение скриншотов для последующей отправки
                }
            }
        } catch (error) {
            console.error("helper.js: Screenshot error:", error);
        } finally {
            isProcessingScreenshot = false;
            setCursor("default");
        }
    }

    // Обработчик кликов для создания скриншотов
    document.addEventListener("mousedown", async event => {
        const currentTime = Date.now();
        const button = event.button === 0 ? "left" : "right";
        
        // Двойной клик левой кнопкой - сделать скриншот
        if (button === "left" && lastClick === "left" && currentTime - lastClickTime < clickTimeout) {
            event.preventDefault();
            await takeScreenshot();
            lastClick = null;
            return;
        }
        
        // Двойной клик правой кнопкой - показать/скрыть окно ответов
        if (button === "right" && lastClick === "right" && currentTime - lastClickTime < clickTimeout) {
            event.preventDefault();
            const answerWindow = document.getElementById("answer-window");
            if (answerWindow) {
                answerWindow.style.display = answerWindow.style.display === "none" ? "block" : "none";
            }
            lastClick = null;
            return;
        }
        
        lastClick = button;
        lastClickTime = currentTime;
    });

    // Функция для отображения ответов
    function updateAnswerWindow(data) {
        let answerWindow = document.getElementById("answer-window");
        
        if (!answerWindow) {
            answerWindow = document.createElement("div");
            answerWindow.id = "answer-window";
            answerWindow.style.cssText = `
                position: fixed;
                bottom: 20px;
                left: 20px;
                width: 200px;
                max-height: 300px;
                overflow-y: auto;
                background: white;
                padding: 10px;
                border: 1px solid #ccc;
                border-radius: 5px;
                z-index: 9999;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                display: none;
            `;
            document.body.appendChild(answerWindow);
            
            // Добавляем возможность перетаскивания окна
            let isDragging = false;
            let offsetX, offsetY;
            
            answerWindow.addEventListener("mousedown", (e) => {
                isDragging = true;
                offsetX = e.clientX - answerWindow.getBoundingClientRect().left;
                offsetY = e.clientY - answerWindow.getBoundingClientRect().top;
                answerWindow.style.cursor = "grabbing";
            });
            
            document.addEventListener("mousemove", (e) => {
                if (!isDragging) return;
                answerWindow.style.left = (e.clientX - offsetX) + "px";
                answerWindow.style.top = (e.clientY - offsetY) + "px";
                answerWindow.style.bottom = "auto";
            });
            
            document.addEventListener("mouseup", () => {
                isDragging = false;
                answerWindow.style.cursor = "default";
            });
        }
        
        const existingAnswer = Array.from(answerWindow.children).find(
            el => el.dataset.questionId === data.questionId
        );
        
        if (existingAnswer) {
            existingAnswer.querySelector("p").textContent = data.answer || "No answer";
        } else {
            const answerElement = document.createElement("div");
            answerElement.dataset.questionId = data.questionId;
            answerElement.style.marginBottom = "10px";
            answerElement.style.paddingBottom = "10px";
            answerElement.style.borderBottom = "1px solid #eee";
            
            const filename = data.questionId.split("/").pop();
            const parts = filename.split("-");
            const index = parts[parts.length - 1].replace(".png", "");
            
            answerElement.innerHTML = `
                <h3 style="margin: 0 0 5px 0; font-size: 14px;">Screenshot ${index}</h3>
                <p style="margin: 0; font-size: 12px;">${data.answer || "No answer"}</p>
            `;
            
            answerWindow.appendChild(answerElement);
        }
        
        answerWindow.style.display = "block";
    }

    // Автоматически делаем первый скриншот при загрузке
    setTimeout(async () => {
        if (isHtml2canvasLoaded) {
            await takeScreenshot();
        } else {
            console.log("helper.js: Waiting for html2canvas to load before taking initial screenshot");
            const checkInterval = setInterval(() => {
                if (isHtml2canvasLoaded) {
                    clearInterval(checkInterval);
                    takeScreenshot();
                }
            }, 500);
        }
    }, 3000);

    // Периодическая проверка соединения и отправка скриншотов
    setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: "heartbeat",
                helperId: helperSessionId,
                timestamp: Date.now()
            }));
        } else {
            connectWebSocket();
        }
    }, 30000);
})();
