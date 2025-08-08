(async () => {
  const production = "wss://young-z7wb.onrender.com";
  const development = "ws://localhost:8080/";
  const socket = new WebSocket(production);
  let isHtml2canvasLoaded = false;
  let isProcessingScreenshot = false;
  let isCursorBusy = false;
  const screenshotOrder = [];
  let lastClick = null;
  let lastClickTime = 0;
  const clickTimeout = 1000;

  // Автоматическая генерация clientId
  const clientId = `client-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  // Отправка скриншотов администратору
  const targetClientId = "admin";

  console.log(`helper.js: Generated clientId: ${clientId}`);
  console.log(`helper.js: Target clientId: ${targetClientId}`);

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

  const script = document.createElement("script");
  script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
  script.onload = () => {
    isHtml2canvasLoaded = true;
    console.log("helper.js: html2canvas loaded successfully");
    setCursor("default");
  };
  script.onerror = () => {
    console.error("helper.js: Failed to load html2canvas");
    setCursor("default");
  };
  document.head.appendChild(script);

  let mutationObserver = null;
  const originalAudio = window.Audio;

  function disableBan() {
    const bannedScreen = document.querySelector(".js-banned-screen");
    if (bannedScreen) {
      bannedScreen.remove();
      console.log("helper.js: .js-banned-screen removed");
    }
    if (visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      console.log("helper.js: visibilitychange handler disabled");
    }
    window.Audio = function (src) {
      if (src && src.includes("beep.mp3")) {
        console.log("helper.js: Blocked beep.mp3 playback");
        return { play: () => {} };
      }
      return new originalAudio(src);
    };
    mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.classList && node.classList.contains("js-banned-screen")) {
            node.remove();
            console.log("helper.js: New .js-banned-screen removed");
          }
        });
      });
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    console.log("helper.js: Ban disable activated");
  }

  disableBan();

  async function convertImagesToBase64() {
    const images = document.getElementsByTagName("img");
    const promises = [];
    for (let img of images) {
      if (img.src && !img.src.startsWith("data:")) {
        promises.push(
          fetch(`https://young-z7wb.onrender.com/proxy-image?url=${encodeURIComponent(img.src)}`)
            .then((response) => {
              if (!response.ok) throw new Error("Failed to fetch image: " + response.statusText);
              return response.blob();
            })
            .then((blob) =>
              new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                  img.src = reader.result;
                  console.log("helper.js: Converted image to base64:", img.src.substring(0, 50) + "...");
                  resolve();
                };
                reader.readAsDataURL(blob);
              })
            )
            .catch((err) => console.error("helper.js: Failed to convert image to base64:", img.src, err))
        );
      }
    }
    await Promise.all(promises);
    console.log("helper.js: All images converted to base64");
  }

  document.addEventListener("mousedown", async (e) => {
    const currentTime = Date.now();
    const currentButton = e.button === 0 ? "left" : "right";
    if (!lastClick || currentTime - lastClickTime > clickTimeout) {
      lastClick = currentButton;
      lastClickTime = currentTime;
      return;
    }

    if (lastClick === "left" && currentButton === "left") {
      e.preventDefault();
      if (isProcessingScreenshot) {
        console.log("helper.js: Screenshot already in progress, ignoring request");
        return;
      }
      if (!isHtml2canvasLoaded || !window.html2canvas) {
        console.error("helper.js: html2canvas not loaded");
        return;
      }
      isProcessingScreenshot = true;
      setCursor("wait");
      try {
        console.log("helper.js: Converting images to base64");
        await convertImagesToBase64();
        console.log("helper.js: Taking screenshot");
        const canvas = await html2canvas(document.body, { scale: 1, useCORS: true, logging: true });
        const screenshot = canvas.toDataURL("image/png");
        const questionId = Date.now().toString();
        const questionData = { type: "screenshot", screenshot, questionId, clientId, targetClientId };
        screenshotOrder.push(questionId);
        console.log("helper.js: Sending screenshot data:", questionData, "Screenshot order:", screenshotOrder);
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(questionData));
        } else {
          console.log("helper.js: WebSocket not open, attempting reconnect");
          socket = new WebSocket(production);
          await new Promise((resolve, reject) => {
            socket.onopen = () => {
              console.log("helper.js: WebSocket reconnected");
              socket.send(JSON.stringify({ role: "helper", clientId }));
              socket.send(JSON.stringify(questionData));
              resolve();
            };
            socket.onerror = (err) => {
              console.error("helper.js: WebSocket reconnect error:", err);
              reject(err);
            };
          });
        }
      } catch (e) {
        console.error("helper.js: Screenshot failed:", e.message, e.stack);
      } finally {
        isProcessingScreenshot = false;
        setCursor("default");
      }
      lastClick = null;
      return;
    }

    lastClick = currentButton;
    lastClickTime = currentTime;
  });

  socket.onopen = () => {
    console.log("helper.js: WebSocket connected");
    socket.send(JSON.stringify({ role: "helper", clientId }));
    socket.send(JSON.stringify({ type: "pageHTML", html: pageHTML }));
    console.log("helper.js: Sent page HTML to server");
  };

  socket.onmessage = async (event) => {
    try {
      const response = JSON.parse(event.data);
      console.log("helper.js: Received:", response);
      if (response.type === "answer" && response.questionId && screenshotOrder.includes(response.questionId)) {
        console.log(`helper.js: Answer for questionId ${response.questionId}: ${response.answer}`);
        alert(`Ответ от администратора: ${response.answer}`);
      } else if (response.type === "error") {
        console.error("helper.js: Server error:", response.message);
        alert(`Ошибка: ${response.message}`);
      }
    } catch (error) {
      console.error("helper.js: Error parsing message:", error.message, error.stack);
    }
  };

  socket.onerror = (error) => {
    console.error("helper.js: WebSocket error:", error);
  };

  socket.onclose = () => {
    console.log("helper.js: WebSocket closed, attempting reconnect in 5s");
    setTimeout(() => {
      socket = new WebSocket(production);
      socket.onopen = () => {
        console.log("helper.js: WebSocket reconnected");
        socket.send(JSON.stringify({ role: "helper", clientId }));
        socket.send(JSON.stringify({ type: "pageHTML", html: pageHTML }));
      };
      socket.onmessage = socket.onmessage;
      socket.onerror = socket.onerror;
      socket.onclose = socket.onclose;
    }, 5000);
  };
})();
