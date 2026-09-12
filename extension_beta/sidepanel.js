const messageInput = document.getElementById("messageInput");
const statusText = document.getElementById("statusText");
const slidePreview = document.getElementById("slidePreview");
const sendButton = document.getElementById("sendButton");
const responseBox = document.getElementById("responseBox");
const responseText = document.getElementById("responseText");


// Leave blank until your Render backend exists.
const BACKEND_URL = "https://ai-visual-coach.onrender.com";

let sessionId = null;

let lastCapturedSlideDataUrl = null;

function displayDiagnosis(result) {
  responseBox.style.display = "block";

  // If backend returns your DiagnoseResponse structure
  if (result?.problems) {
    let output = "";

    for (const problem of result.problems) {
      output += `Issue: ${problem.issue}\n`;

      if (problem.evidence) {
        output += `Evidence: ${problem.evidence}\n`;
      }

      if (problem.fix) {
        output += `Suggestion: ${problem.fix}\n`;
      }

      if (problem.target_area) {
        output += `Target: ${problem.target_area}\n`;
      }

      if (problem.supported_action) {
        output += `Action: ${problem.supported_action}\n`;
      }

      output += "\n";
    }

    responseText.textContent =
      output.trim();

    return;
  }

  // Fallback: display whatever came back
  responseText.textContent =
    JSON.stringify(
      result,
      null,
      2
    );
}

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
        session_id: currentSessionId,
        slide_id: slideId,

        user_request: userRequest,

        slide_image: lastCapturedSlideDataUrl,

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

      await removeSlideOverlay(tab.id);

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

      displayDiagnosis(result);

      let overlayImage = null;

      // Future AI response formats
      if (result?.overlay_image) {
        overlayImage =
          result.overlay_image;
      }

      else if (result?.overlay?.image) {
        overlayImage =
          result.overlay.image;
      }

      // AI doesn't return one yet
      if (!overlayImage) {
        overlayImage =
          createTemplateOverlay();
      }

      // Support raw base64 later too
      if (
        overlayImage &&
        !overlayImage.startsWith("data:") &&
        !overlayImage.startsWith("http")
      ) {
        overlayImage =
          `data:image/png;base64,${overlayImage}`;
      }

      await showSlideOverlay(
        tab.id,
        bounds,
        overlayImage
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

function createTemplateOverlay() {
  const svg = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1600"
      height="900"
      viewBox="0 0 1600 900"
    >
      <!-- Highlight box -->
      <rect
        x="470"
        y="180"
        width="660"
        height="250"
        rx="24"
        fill="rgba(255, 215, 0, 0.12)"
        stroke="#FFD54A"
        stroke-width="10"
        stroke-dasharray="20 14"
      />

      <!-- Arrow -->
      <path
        d="M 350 550 Q 450 470 560 410"
        fill="none"
        stroke="#FFD54A"
        stroke-width="14"
        stroke-linecap="round"
      />

      <polygon
        points="560,410 520,425 545,455"
        fill="#FFD54A"
      />

      <!-- Suggestion -->
      <rect
        x="170"
        y="560"
        width="560"
        height="120"
        rx="22"
        fill="rgba(15, 17, 22, 0.9)"
      />

      <text
        x="210"
        y="615"
        fill="white"
        font-size="34"
        font-family="Arial, sans-serif"
        font-weight="600"
      >
        Template suggestion
      </text>

      <text
        x="210"
        y="655"
        fill="#CCCCCC"
        font-size="25"
        font-family="Arial, sans-serif"
      >
        AI visual guidance will appear here.
      </text>
    </svg>
  `;

  return (
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(svg)
  );
}


async function showSlideOverlay(
  tabId,
  bounds,
  imageUrl
) {
  await chrome.scripting.executeScript({
    target: {
      tabId
    },

    args: [
      bounds,
      imageUrl
    ],

    func: (bounds, imageUrl) => {
      // Remove previous overlay
      const existing =
        document.getElementById(
          "visual-coach-slide-overlay"
        );

      if (existing) {
        existing.remove();
      }

      const overlay =
        document.createElement("div");

      overlay.id =
        "visual-coach-slide-overlay";

      Object.assign(
        overlay.style,
        {
          position: "fixed",

          left: `${bounds.x}px`,
          top: `${bounds.y}px`,

          width: `${bounds.width}px`,
          height: `${bounds.height}px`,

          zIndex: "2147483647",

          pointerEvents: "none",

          overflow: "hidden",

          opacity: "0.7"
        }
      );

      const image =
        document.createElement("img");

      image.src = imageUrl;

      Object.assign(
        image.style,
        {
          width: "100%",
          height: "100%",

          objectFit: "fill",

          pointerEvents: "none",

          userSelect: "none"
        }
      );

      overlay.appendChild(image);

      document.body.appendChild(
        overlay
      );
    }
  });
}

async function removeSlideOverlay(tabId) {
  await chrome.scripting.executeScript({
    target: {
      tabId
    },

    func: () => {
      const overlay =
        document.getElementById(
          "visual-coach-slide-overlay"
        );

      if (overlay) {
        overlay.remove();
      }
    }
  });
}