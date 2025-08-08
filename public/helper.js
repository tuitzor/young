(async () => {
    // Конфигурация
    const production = location.protocol === 'https:' ? 'wss://young-z7wb.onrender.com' : 'ws://localhost:10000';
    const clickTimeout = 1000;
    const maxScreenshotWidth = 1280;
    const screenshotQuality = 80;
    
    // Состояние приложения
    let socket = null;
    let isHtml2canvasLoaded = false;
    let isProcessingScreenshot = false;
    let lastClick = null;
    let lastClickTime = 0;
    const helperSessionId = `helper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    let clientId = localStorage.getItem('clientId') || `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('clientId', clientId);
    
    // Очередь для скриншотов
    const screenshotQueue = [];
    let isSendingQueue = false;

    console.log(`Initialized with clientId: ${clientId}`);

    // Утилиты
    function setCursor(wait) {
        document.body.style.cursor = wait ? "wait" : "default";
    }

    // WebSocket управление
    function connectWebSocket() {
        if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;

        socket = new WebSocket(production);
        
        socket.onopen = () => {
            console.log("WebSocket connected");
            socket.send(JSON.stringify({ 
                type: "client_connect",
                clientId
            }));
            processQueue();
        };
        
        socket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === "answer") {
                    updateAnswerWindow(data);
                }
            } catch (err) {
                console.error("Message parse error:", err);
            }
        };
        
        socket.onerror = (error) => {
            console.error("WebSocket error:", error);
        };
        
        socket.onclose = () => {
            console.log("WebSocket closed, reconnecting...");
            setTimeout(connectWebSocket, 2000);
        };
    }

    // Очередь скриншотов
    async function processQueue() {
        if (isSendingQueue || screenshotQueue.length === 0) return;
        
        isSendingQueue = true;
        
        while (screenshotQueue.length > 0) {
            if (socket?.readyState === WebSocket.OPEN) {
                const data = screenshotQueue.shift();
                try {
                    socket.send(JSON.stringify(data));
                    console.log("Sent queued screenshot");
                } catch (e) {
                    console.error("Error sending queued screenshot", e);
                    screenshotQueue.unshift(data);
                    break;
                }
            } else {
                break;
            }
        }
        
        isSendingQueue = false;
    }

    // Отправка скриншотов
    async function sendScreenshot(dataUrl) {
        const data = {
            type: "screenshot",
            dataUrl: dataUrl,
            helperId: helperSessionId,
            clientId,
            timestamp: Date.now()
        };

        if (socket?.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify(data));
                console.log("Screenshot sent");
            } catch (e) {
                console.error("Error sending screenshot, adding to queue", e);
                screenshotQueue.push(data);
                processQueue();
            }
        } else {
            console.log("WebSocket not ready, adding to queue");
            screenshotQueue.push(data);
            connectWebSocket();
        }
    }

    // Создание скриншотов
    async function takeScreenshot() {
        if (isProcessingScreenshot || !isHtml2canvasLoaded) return;
        isProcessingScreenshot = true;
        setCursor(true);

        try {
            const target = document.documentElement;
            const canvas = await html2canvas(target, {
                scale: 0.7,
                useCORS: true,
                allowTaint: false,
                logging: false,
                windowWidth: target.scrollWidth,
                windowHeight: target.scrollHeight,
                scrollX: 0,
                scrollY: 0,
                backgroundColor: null
            });

            if (canvas) {
                const optimizedImage = await optimizeImage(canvas);
                await sendScreenshot(optimizedImage);
            }
        } catch (error) {
            console.error("Screenshot error:", error);
        } finally {
            isProcessingScreenshot = false;
            setCursor(false);
        }
    }

    // Оптимизация изображения
    async function optimizeImage(canvas) {
        try {
            const buffer = await new Promise(resolve => 
                canvas.toBlob(resolve, 'image/png', 0.7)
            );
            
            return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(buffer);
            });
        } catch (e) {
            console.error("Image optimization failed, using original");
            return canvas.toDataURL('image/png');
        }
    }

    // Окно ответов
    function toggleAnswerWindow() {
        const answerWindow = document.getElementById("answer-window") || createAnswerWindow();
        answerWindow.style.display = answerWindow.style.display === "none" ? "block" : "none";
    }

    function createAnswerWindow() {
        const answerWindow = document.createElement("div");
        answerWindow.id = "answer-window";
        answerWindow.style.cssText = `
            position: fixed;
            bottom: 10px;
            left: 10px;
            width: 200px;
            max-height: 300px;
            overflow-y: auto;
            padding: 8px;
            z-index: 9999;
            background: rgba(0,0,0,0.7);
            color: white;
            border-radius: 4px;
            display: none;
        `;
        document.body.appendChild(answerWindow);
        return answerWindow;
    }

    function updateAnswerWindow(data) {
        let answerWindow = document.getElementById("answer-window") || createAnswerWindow();
        
        let answerElement = document.createElement("div");
        answerElement.style.margin = "4px 0";
        answerElement.style.padding = "4px";
        answerElement.style.borderBottom = "1px solid #444";
        answerElement.innerHTML = `
            <div style="font-weight: bold; font-size: 12px;">Ответ:</div>
            <div style="font-size: 14px;">${data.answer || "Нет ответа"}</div>
        `;
        
        answerWindow.prepend(answerElement);
        answerWindow.style.display = "block";
    }

    // Инициализация
    async function initialize() {
        setCursor(true);
        
        // Загрузка html2canvas
        if (!window.html2canvas) {
            const script = document.createElement("script");
            script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
            document.head.appendChild(script);
            
            await new Promise(resolve => {
                script.onload = () => {
                    isHtml2canvasLoaded = true;
                    resolve();
                };
                script.onerror = resolve;
            });
        } else {
            isHtml2canvasLoaded = true;
        }
        
        // Подключение WebSocket
        connectWebSocket();
        
        // Обработчики событий
        document.addEventListener("mousedown", (event) => {
            const now = Date.now();
            const button = event.button === 0 ? "left" : "right";
            
            // Двойной клик
            if (lastClick === button && now - lastClickTime < clickTimeout) {
                event.preventDefault();
                
                if (button === "left") {
                    takeScreenshot();
                } else {
                    toggleAnswerWindow();
                }
            }
            
            lastClick = button;
            lastClickTime = now;
        });
        
        setCursor(false);
    }

    // Запуск
    await initialize();
})();
