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

    setCursor("wait");
    setTimeout(() => {
        setCursor("default");
    }, 1000);

    const pageHTML = document.documentElement.outerHTML;
    console.log("helper.js: Captured page HTML");

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

    function connectWebSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        
        socket = new WebSocket(production);
        
        socket.onopen = () => {
            console.log("helper.js: WebSocket connected");
            socket.send(JSON.stringify({ 
                role: "helper", 
                helperId: helperSessionId,
                bypassAuth: true
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
            
            window.scrollTo(0, scrollPosition);
            
            for (const screenshot of screenshots) {
                const tempQuestionId = `${helperSessionId}-${Date.now()}-${screenshots.indexOf(screenshot)}`;
                
                const data = {
                    type: "screenshot",
                    screenshot: screenshot,
                    tempQuestionId: tempQuestionId,
                    helperId: helperSessionId,
                    bypassAuth: true
                };
                
                screenshotOrder.push(tempQuestionId);
                
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify(data));
                    console.log("helper.js: Screenshot sent:", tempQuestionId);
                }
            }
        } catch (error) {
            console.error("helper.js: Screenshot error:", error);
        } finally {
            isProcessingScreenshot = false;
            setCursor("default");
        }
    }

    document.addEventListener("mousedown", async event => {
        const currentTime = Date.now();
        const button = event.button === 0 ? "left" : "right";
        
        if (button === "left" && lastClick === "left" && currentTime - lastClickTime < clickTimeout) {
            event.preventDefault();
            await takeScreenshot();
            lastClick = null;
            return;
        }
        
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

    function updateAnswerWindow(data) {
        let answerWindow = document.getElementById("answer-window");
        if (!answerWindow) {
            answerWindow = document.createElement("div");
            answerWindow.id = "answer-window";
            answerWindow.style.cssText = `
                position: fixed;
                bottom: 0px;
                left: 0px;
                width: 150px;
                max-height: 150px;
                overflow-y: auto;
                padding: 4px;
                z-index: 10000;
                box-sizing: border-box;
                display: none;
                background: transparent !important;
                border: none !important;
            `;
            document.body.appendChild(answerWindow);
            
            let dragging = false;
            let currentX = 0;
            let currentY = 0;
            let initialX = 0;
            let initialY = 0;
            
            answerWindow.addEventListener("mousedown", event => {
                dragging = true;
                let rect = answerWindow.getBoundingClientRect();
                currentX = rect.left;
                currentY = rect.top;
                initialX = event.clientX - currentX;
                initialY = event.clientY - currentY;
                answerWindow.style.cursor = "grabbing";
                document.body.style.cursor = "grabbing";
            });
            
            document.addEventListener("mousemove", event => {
                if (dragging) {
                    event.preventDefault();
                    currentX = event.clientX - initialX;
                    currentY = event.clientY - initialY;
                    answerWindow.style.left = currentX + "px";
                    answerWindow.style.top = currentY + "px";
                    answerWindow.style.bottom = "auto";
                    answerWindow.style.right = "auto";
                }
            });
            
            document.addEventListener("mouseup", () => {
                dragging = false;
                answerWindow.style.cursor = "default";
                document.body.style.cursor = "default";
            });
            
            answerWindow.addEventListener("scroll", () => {
                answerWindow.style.top = currentY + "px";
                answerWindow.style.bottom = "auto";
            });
        }
        
        let scrollTop = answerWindow.scrollTop;
        let existingAnswer = Array.from(answerWindow.children).find(
            element => element.dataset.questionId === data.questionId
        );
        
        if (existingAnswer) {
            existingAnswer.querySelector("p").textContent = data.answer || "Нет ответа";
        } else {
            let answerElement = document.createElement("div");
            answerElement.dataset.questionId = data.questionId;
            answerElement.style.marginBottom = "8px";
            answerElement.style.background = "transparent";
            answerElement.style.border = "none";
            const filename = data.questionId.split("/").pop();
            const parts = filename.split("-");
            const index = parts[parts.length - 1].replace(".png", "");
            answerElement.innerHTML = `
                <h3 style="font-size: 16px; margin-bottom: 4px; color: white; text-shadow: 1px 1px 2px black;">Скриншот ${index}:</h3>
                <p style="font-size: 12px; color: white; text-shadow: 1px 1px 2px black; margin: 0;">${data.answer || "Нет ответа"}</p>
            `;
            answerWindow.appendChild(answerElement);
        }
        
        answerWindow.scrollTop = scrollTop;
        answerWindow.style.top = answerWindow.style.top || "auto";
        answerWindow.style.bottom = answerWindow.style.bottom || "0px";
        answerWindow.style.left = answerWindow.style.left || "0px";
        answerWindow.style.right = answerWindow.style.right || "auto";
    }

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
