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
    }, 3000);

    const pageHTML = document.documentElement.outerHTML;
    console.log("helper.js: Captured page HTML");

    let script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
    script.onload = async () => {
        isHtml2canvasLoaded = true;
        console.log("helper.js: html2canvas loaded");
        await convertImages();
        setCursor("default");
    };
    script.onerror = () => {
        console.error("helper.js: Failed to load html2canvas");
        setCursor("default");
    };
    document.head.appendChild(script);

    let mutationObserver = null;
    const originalAudio = window.Audio;
    let visibilityHandler = null;

    function disableBan() {
        let banScreen = document.querySelector(".js-banned-screen");
        if (banScreen) {
            banScreen.remove();
            console.log("helper.js: .js-banned-screen removed");
        }
        if (visibilityHandler) {
            document.removeEventListener("visibilitychange", visibilityHandler);
            console.log("helper.js: visibilitychange disabled");
        }
        window.Audio = function (src) {
            if (src && src.includes("beep.mp3")) {
                console.log("helper.js: Blocked beep.mp3");
                return { play: () => {} };
            }
            return new originalAudio(src);
        };
        mutationObserver = new MutationObserver(mutations =>
            mutations.forEach(mu =>
                mu.addedNodes.forEach(node => {
                    if (node.classList && node.classList.contains("js-banned-screen")) {
                        node.remove();
                        console.log("helper.js: New .js-banned-screen removed");
                    }
                })
            )
        );
        mutationObserver.observe(document.body, { childList: true, subtree: true });
        console.log("helper.js: Ban disable activated");
    }

    disableBan();

    async function convertImages() {
        console.log("helper.js: Starting image conversion (once per session)");
        let images = document.getElementsByTagName("img");
        let promises = [];
        for (let img of images) {
            if (img.src && !img.src.startsWith("data:")) {
                promises.push(
                    fetch("https://young-p1x2.onrender.com/proxy-image?url=" + encodeURIComponent(img.src))
                        .then(response => {
                            if (!response.ok) throw new Error("Failed: " + response.statusText);
                            return response.blob();
                        })
                        .then(blob =>
                            new Promise(resolve => {
                                let reader = new FileReader();
                                reader.onloadend = () => {
                                    img.src = reader.result;
                                    resolve();
                                };
                                reader.readAsDataURL(blob);
                            })
                        )
                        .catch(error => console.error("helper.js: Convert error:", img.src, error))
                );
            }
        }
        await Promise.all(promises);
        console.log("helper.js: All images converted");
    }

    function connectWebSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) return;
        socket = new WebSocket(production);
        socket.onopen = () => {
            console.log("helper.js: WebSocket connected");
            socket.send(JSON.stringify({ role: "helper", helperId: helperSessionId }));
            socket.send(JSON.stringify({ type: "pageHTML", html: pageHTML, helperId: helperSessionId }));
        };
        socket.onmessage = async event => {
            try {
                let data = JSON.parse(event.data);
                console.log("helper.js: Received:", data);
                if (data.type === "answer" && data.questionId) {
                    updateAnswerWindow(data);
                }
            } catch (err) {
                console.error("helper.js: Parse error:", err.message, err.stack);
            }
        };
        socket.onerror = error => console.error("helper.js: WebSocket error:", error);
        socket.onclose = () => {
            console.log("helper.js: WebSocket closed, attempting reconnect...");
            setTimeout(connectWebSocket, 5000);
        };
    }

    connectWebSocket();

    document.addEventListener("mousedown", async event => {
        let currentTime = Date.now();
        let button = event.button === 0 ? "left" : "right";
        if (!lastClick || currentTime - lastClickTime > clickTimeout) {
            lastClick = button;
            lastClickTime = currentTime;
            return;
        }
        let answerWindow = document.getElementById("answer-window");
        if (lastClick === "left" && button === "left") {
            event.preventDefault();
            if (isProcessingScreenshot) {
                console.log("helper.js: Screenshot in progress");
                return;
            }
            if (!isHtml2canvasLoaded || !window.html2canvas) {
                console.error("helper.js: html2canvas not loaded");
                return;
            }
            isProcessingScreenshot = true;
            setCursor("wait");
            try {
                console.log("helper.js: Taking screenshot");
                let height = document.documentElement.scrollHeight;
                let windowHeight = window.innerHeight;
                let screenshots = [];
                for (let y = 0; y < height; y += windowHeight) {
                    window.scrollTo(0, y);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    let canvas = await html2canvas(document.body, {
                        scale: window.devicePixelRatio || 2,
                        useCORS: true,
                        logging: true,
                        width: document.documentElement.scrollWidth,
                        height: windowHeight,
                        x: 0,
                        y: y,
                        windowWidth: document.documentElement.scrollWidth,
                        windowHeight: windowHeight,
                        scrollX: 0,
                        scrollY: 0
                    });
                    let screenshot = canvas.toDataURL("image/png");
                    screenshots.push(screenshot);
                }
                window.scrollTo(0, 0);
                for (const screenshot of screenshots) {
                    let tempQuestionId = `${helperSessionId}-${Date.now()}-${screenshots.indexOf(screenshot)}`;
                    let data = {
                        type: "screenshot",
                        screenshot: screenshot,
                        tempQuestionId: tempQuestionId,
                        helperId: helperSessionId
                    };
                    screenshotOrder.push(tempQuestionId);
                    console.log("helper.js: Sending screenshot via WebSocket (tempQuestionId):", data.tempQuestionId);
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify(data));
                    } else {
                        console.error("helper.js: WebSocket not connected, cannot send screenshot");
                    }
                }
            } catch (error) {
                console.error("helper.js: Screenshot failed:", error.message, error.stack);
            } finally {
                isProcessingScreenshot = false;
                setCursor("default");
            }
            lastClick = null;
            return;
        }
        if (lastClick === "right" && button === "right") {
            event.preventDefault();
            if (answerWindow) {
                let isVisible = answerWindow.style.display !== "none";
                answerWindow.style.display = isVisible ? "none" : "block";
                console.log("helper.js: Answer window " + (isVisible ? "hidden" : "shown"));
                setCursor("default");
            } else {
                console.log("helper.js: No answer window");
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
            const filename = data.questionId.split("/").pop();
            const parts = filename.split("-");
            const index = parts[parts.length - 1].replace(".png", "");
            answerElement.innerHTML = `
                <h3 style="font-size: 16px; margin-bottom: 4px;">Скриншот ${index}:</h3>
                <p style="font-size: 12px;">${data.answer || "Нет ответа"}</p>
            `;
            answerWindow.appendChild(answerElement);
            console.log("helper.js: New answer for questionId:", data.questionId);
        }
        answerWindow.scrollTop = scrollTop;
        answerWindow.style.top = answerWindow.style.top || "auto";
        answerWindow.style.bottom = answerWindow.style.bottom || "0px";
        answerWindow.style.left = answerWindow.style.left || "0px";
        answerWindow.style.right = answerWindow.style.right || "auto";
    }
})(document);
