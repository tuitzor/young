(async () => {
    const config = {
        serverUrl: "wss://young-p1x2.onrender.com",
        helperSessionId: `helper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        clickTimeout: 1000,
        reconnectDelay: 5000,
        html2canvasUrl: "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
        screenshotChunkHeight: window.innerHeight,
        screenshotDelay: 100
    };

    console.log("Helper initialized with session ID:", config.helperSessionId);

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

    // UI Functions
    function setCursor(state) {
        if (state === "wait" && !state.isCursorBusy) {
            state.isCursorBusy = true;
            document.body.style.cursor = "wait";
        } else if (state === "default" && state.isCursorBusy) {
            state.isCursorBusy = false;
            document.body.style.cursor = "default";
        }
    }

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
                scrollbar-width: thin;
                scrollbar-color: transparent transparent;
                padding: 4px;
                border-radius: 2px;
                z-index: 10000;
                box-sizing: border-box;
                display: none;
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
            answerElement.innerHTML = `
                <h3 style="font-size: 16px; margin-bottom: 4px;">Ответ:</h3>
                <p style="font-size: 12px;">${data.answer || "Нет ответа"}</p>
            `;
            answerWindow.appendChild(answerElement);
        }
        
        answerWindow.scrollTop = scrollTop;
    }

    // Security Functions
    function disableBan() {
        let banScreen = document.querySelector(".js-banned-screen");
        if (banScreen) {
            banScreen.remove();
        }
        
        const originalAudio = window.Audio;
        window.Audio = function (src) {
            if (src && src.includes("beep.mp3")) {
                return { play: () => {} };
            }
            return new originalAudio(src);
        };
        
        state.mutationObserver = new MutationObserver(mutations => {
            mutations.forEach(mu => {
                mu.addedNodes.forEach(node => {
                    if (node.classList && node.classList.contains("js-banned-screen")) {
                        node.remove();
                    }
                });
            });
        });
        
        state.mutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Image Conversion
    async function convertImages() {
        const images = Array.from(document.querySelectorAll("img[src]:not([src^='data:'])"));
        const conversions = images.map(img => {
            return fetch(`${config.serverUrl}/proxy-image?url=${encodeURIComponent(img.src)}`)
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.blob();
                })
                .then(blob => {
                    return new Promise(resolve => {
                        const reader = new FileReader();
                        reader.onload = () => {
                            img.src = reader.result;
                            resolve();
                        };
                        reader.readAsDataURL(blob);
                    });
                })
                .catch(error => {
                    console.error("Image conversion failed:", img.src, error);
                });
        });

        await Promise.all(conversions);
    }

    // Screenshot Functions
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

    // WebSocket Functions
    function connectWebSocket() {
        if (state.socket?.readyState === WebSocket.OPEN) return;
        
        state.socket = new WebSocket(config.serverUrl);
        
        state.socket.onopen = () => {
            console.log("WebSocket connected");
            state.socket.send(JSON.stringify({ 
                role: "helper", 
                helperId: config.helperSessionId
            }));
            
            const pageHTML = document.documentElement.outerHTML;
            state.socket.send(JSON.stringify({ 
                type: "pageHTML", 
                html: pageHTML, 
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

    // Event Handlers
    function handleDoubleClick(event) {
        const currentTime = Date.now();
        const button = event.button === 0 ? "left" : "right";
        
        if (!state.lastClick || currentTime - state.lastClickTime > config.clickTimeout) {
            state.lastClick = button;
            state.lastClickTime = currentTime;
            return;
        }
        
        const answerWindow = document.getElementById("answer-window");
        
        if (state.lastClick === "left" && button === "left") {
            event.preventDefault();
            takeFullPageScreenshot();
        } else if (state.lastClick === "right" && button === "right") {
            event.preventDefault();
            if (answerWindow) {
                const isVisible = answerWindow.style.display !== "none";
                answerWindow.style.display = isVisible ? "none" : "block";
            }
        }
        
        state.lastClick = null;
    }

    // Initialization
    async function init() {
        setCursor("wait");
        
        // Load html2canvas
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
        
        // Convert images
        await convertImages();
        
        // Setup security
        disableBan();
        
        // Connect WebSocket
        connectWebSocket();
        
        // Setup event listeners
        document.addEventListener("mousedown", handleDoubleClick);
        
        setCursor("default");
    }

    // Start the application
    await init();
})();
