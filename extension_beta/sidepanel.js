const messageInput = document.getElementById("messageInput");
const statusText = document.getElementById("statusText");
const slidePreview = document.getElementById("slidePreview");
const sendButton = document.getElementById("sendButton");

// Leave blank until your Render backend exists.
const BACKEND_URL = "https://ai-visual-coach.onrender.com";

let sessionId = null;

let lastCapturedSlideDataUrl = null;

function setStatus(message) {
  console.log("[Visual Coach]", message);

  if (statusText) {
    statusText.textContent = message;
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load screenshot"));

    img.src = src;
  });
}

async function getOrCreateSession() {
  // Check if we already created one
  const stored =
    await chrome.storage.session.get(
      "sessionId"
    );

  if (stored.sessionId) {
    sessionId = stored.sessionId;

    console.log(
      "[Visual Coach] Existing session:",
      sessionId
    );

    return sessionId;
  }

  console.log(
    "[Visual Coach] Creating session..."
  );

  const response = await fetch(
    `${BACKEND_URL}/session`,
    {
      method: "POST"
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to create session: ${response.status}`
    );
  }

  const data = await response.json();

  sessionId = data.session_id;

  await chrome.storage.session.set({
    sessionId
  });

  console.log(
    "[Visual Coach] Session created:",
    sessionId
  );

  return sessionId;
}

function getSlideId(url) {
  try {
    const parsed = new URL(url);

    const match =
      parsed.hash.match(
        /slide=id\.([^&]+)/
      );

    if (match) {
      return `id.${match[1]}`;
    }
  } catch (error) {
    console.error(
      "Could not get slide ID:",
      error
    );
  }

  return "unknown-slide";
}

async function diagnoseSlide(tab) {
  const currentSessionId =
    sessionId ||
    await getOrCreateSession();

  const slideId =
    getSlideId(tab.url);

  console.log(
    "[Visual Coach] Diagnosing:",
    {
      session_id:
        currentSessionId,

      slide_id:
        slideId
    }
  );

  const response = await fetch(
    `${BACKEND_URL}/diagnose`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        session_id:
          currentSessionId,

        slide_id:
          slideId,

        supported_actions: [
          "highlight",
          "arrow",
          "dim"
        ]
      })
    }
  );

  if (!response.ok) {
    const text =
      await response.text();

    throw new Error(
      `/diagnose failed ${response.status}: ${text}`
    );
  }

  return await response.json();
}

async function getSlideBounds(tabId) {
  setStatus("Searching for slide...");

  const results = await chrome.scripting.executeScript({
    target: { tabId },

    func: () => {
      const candidates = [];

      // Try Google Slides background elements first
      const backgrounds =
        document.querySelectorAll('[id*="-bg"] path');

      for (const element of backgrounds) {
        const rect = element.getBoundingClientRect();

        if (
          rect.width > 300 &&
          rect.height > 200 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < window.innerHeight &&
          rect.left < window.innerWidth
        ) {
          candidates.push(rect);
        }
      }

      // Fallback: look through SVG elements
      if (candidates.length === 0) {
        const svgs = document.querySelectorAll("svg");

        for (const svg of svgs) {
          const rect = svg.getBoundingClientRect();

          if (
            rect.width < 300 ||
            rect.height < 200
          ) {
            continue;
          }

          const ratio = rect.width / rect.height;

          const looksLikeSlide =
            Math.abs(ratio - 16 / 9) < 0.15 ||
            Math.abs(ratio - 4 / 3) < 0.15;

          if (!looksLikeSlide) {
            continue;
          }

          if (
            rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth
          ) {
            candidates.push(rect);
          }
        }
      }

      if (candidates.length === 0) {
        return null;
      }

      // Pick biggest visible candidate
      candidates.sort(
        (a, b) =>
          b.width * b.height -
          a.width * a.height
      );

      const rect = candidates[0];

      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,

        // Useful later when converting CSS pixels
        // into screenshot pixels
        dpr: window.devicePixelRatio || 1
      };
    }
  });

  return results?.[0]?.result ?? null;
}

async function cropScreenshot(
  screenshotDataUrl,
  bounds
) {
  const image = await loadImage(screenshotDataUrl);

  /*
    Do NOT blindly multiply by devicePixelRatio.

    Instead calculate the actual scale between
    viewport CSS pixels and screenshot pixels.
  */

  const viewportInfo =
    await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

  const [tab] = viewportInfo;

  const viewportResult =
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },

      func: () => ({
        width: window.innerWidth,
        height: window.innerHeight
      })
    });

  const viewport =
    viewportResult[0].result;

  const scaleX =
    image.width / viewport.width;

  const scaleY =
    image.height / viewport.height;

  const sourceX =
    Math.round(bounds.x * scaleX);

  const sourceY =
    Math.round(bounds.y * scaleY);

  const sourceWidth =
    Math.round(bounds.width * scaleX);

  const sourceHeight =
    Math.round(bounds.height * scaleY);

  console.log("Crop:", {
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    screenshotWidth: image.width,
    screenshotHeight: image.height,
    viewport
  });

  const canvas =
    document.createElement("canvas");

  canvas.width = sourceWidth;
  canvas.height = sourceHeight;

  const ctx =
    canvas.getContext("2d");

  ctx.drawImage(
    image,

    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,

    0,
    0,
    sourceWidth,
    sourceHeight
  );

  return canvas.toDataURL(
    "image/png"
  );
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");

  const mimeMatch = header.match(/:(.*?);/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/png";

  const binary = atob(base64);

  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], {
    type: mimeType
  });
}

async function sendSlideToBackend(userRequest) {
  if (!BACKEND_URL) {
    throw new Error(
      "Backend not configured."
    );
  }

  const currentSessionId =
    sessionId ||
    await getOrCreateSession();

  const [tab] =
    await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

  if (!tab) {
    throw new Error(
      "Could not find active tab"
    );
  }

  const slideId =
    getSlideId(tab.url);

  console.log(
    "[Visual Coach] User request:",
    userRequest
  );

  console.log(
    "[Visual Coach] Sending diagnosis:",
    {
      session_id: currentSessionId,
      slide_id: slideId,
      user_request: userRequest
    }
  );

  const response = await fetch(
    `${BACKEND_URL}/diagnose`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        session_id:
          currentSessionId,

        slide_id:
          slideId,

        supported_actions: [
          "highlight",
          "arrow",
          "dim"
        ]

        /*
         * FUTURE:
         *
         * When /diagnose accepts a prompt,
         * uncomment this:
         *
         * user_request: userRequest
         *
         */
      })
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Backend returned ${response.status}: ${errorText}`
    );
  }

  return await response.json();
}

messageInput.addEventListener(
  "keydown",
  (event) => {

    if (
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();

      sendButton.click();
    }
  }
);

sendButton.addEventListener(
  "click",
  async () => {

    const userRequest =
      messageInput.value.trim();

    if (!userRequest) {
      setStatus(
        "Enter a message first"
      );

      return;
    }

    try {
      sendButton.disabled = true;
      messageInput.disabled = true;

      /*
       * STEP 1:
       * Find active Google Slides tab
       */

      setStatus(
        "Finding slide..."
      );

      const [tab] =
        await chrome.tabs.query({
          active: true,
          currentWindow: true
        });

      if (!tab?.id) {
        throw new Error(
          "Could not find active tab"
        );
      }

      if (
        !tab.url?.startsWith(
          "https://docs.google.com/presentation/"
        )
      ) {
        throw new Error(
          "Current page is not Google Slides"
        );
      }

      /*
       * STEP 2:
       * Find slide bounds
       */

      const bounds =
        await getSlideBounds(
          tab.id
        );

      if (!bounds) {
        throw new Error(
          "Could not locate slide"
        );
      }

      /*
       * STEP 3:
       * Screenshot
       */

      setStatus(
        "Capturing slide..."
      );

      const screenshot =
        await chrome.tabs.captureVisibleTab(
          tab.windowId,
          {
            format: "png"
          }
        );

      /*
       * STEP 4:
       * Crop
       */

      const cropped =
        await cropScreenshot(
          screenshot,
          bounds
        );

      lastCapturedSlideDataUrl =
        cropped;

      /*
       * STEP 5:
       * Preview
       */

      if (slidePreview) {
        slidePreview.src =
          cropped;

        slidePreview.style.display =
          "block";
      }

      /*
       * STEP 6:
       * Send diagnosis
       */

      setStatus(
        "Analyzing..."
      );

      const result =
        await sendSlideToBackend(
          userRequest
        );

      console.log(
        "[Visual Coach] Backend response:",
        result
      );

      setStatus(
        "✓ Response received"
      );

      /*
       * Later:
       * Display AI message here.
       */

      messageInput.value = "";

    } catch (error) {

      console.error(
        "[Visual Coach]",
        error
      );

      setStatus(
        `ERROR: ${error.message}`
      );

    } finally {

      sendButton.disabled = false;
      messageInput.disabled = false;
    }
  }
);

async function initialize() {
  try {
    setStatus(
      "Starting session..."
    );

    await getOrCreateSession();

    setStatus("Ready");

  } catch (error) {

    console.error(
      "[Visual Coach]",
      error
    );

    setStatus(
      `ERROR: ${error.message}`
    );
  }
}

initialize();