const messageInput = document.getElementById("messageInput");
const statusText = document.getElementById("statusText");
const slidePreview = document.getElementById("slidePreview");
const sendButton = document.getElementById("sendButton");
const responseBox = document.getElementById("responseBox");
const responseText = document.getElementById("responseText");
const showFixedVersionButton = document.getElementById("showFixedVersionButton");
const fixedVersionSection = document.getElementById("fixedVersionSection");
const fixedVersionImage = document.getElementById("fixedVersionImage");
const fixedVersionSummary = document.getElementById("fixedVersionSummary");
const hologramFeedback = document.getElementById("hologramFeedback");
const updateEditButton = document.getElementById("updateEditButton");
const hologramActions = document.getElementById("hologramActions");
const showTeachingButton = document.getElementById("showTeachingButton");
const toggleOverlayButton = document.getElementById("toggleOverlayButton");
const doneButton = document.getElementById("doneButton");
const teachingSection = document.getElementById("teachingSection");
const teachingPinnedImage = document.getElementById("teachingPinnedImage");
const teachingOverview = document.getElementById("teachingOverview");
const teachingStepBadge = document.getElementById("teachingStepBadge");
const teachingStepNumber = document.getElementById("teachingStepNumber");
const teachingStepTotal = document.getElementById("teachingStepTotal");
const teachingStepTitle = document.getElementById("teachingStepTitle");
const teachingStepInstruction = document.getElementById("teachingStepInstruction");
const teachingStepExplanation = document.getElementById("teachingStepExplanation");
const teachingStepTarget = document.getElementById("teachingStepTarget");
const previousTeachingButton = document.getElementById("previousTeachingButton");
const nextTeachingButton = document.getElementById("nextTeachingButton");

const BACKEND_URL = "https://ai-visual-coach.onrender.com";

let sessionId = null;
let lastCapturedSlideDataUrl = null;
let currentDiagnosis = null;
let currentHologramDataUrl = null;
let lastUserRequest = null;
let lastCapturedTabId = null;
let lastCapturedSlideBounds = null;
let teachingPlan = null;
let teachingStepIndex = 0;
let overlayVisible = false;

function setStatus(message) {
  console.log("[Visual Coach]", message);

  if (statusText) {
    statusText.textContent = message;
  }
}

async function getReadableBackendError(response, action) {
  let detail = "The server could not complete this request.";

  try {
    const body = await response.json();

    if (typeof body?.detail === "string" && body.detail.trim()) {
      detail = body.detail;
    } else if (body?.detail) {
      detail = JSON.stringify(body.detail);
    }
  } catch (error) {
    // Keep the user-facing fallback when the server did not return JSON.
  }

  return `${action}: ${detail}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load screenshot"));

    img.src = src;
  });
}

async function compactTeachingImage(dataUrl, maxDimension = 1280) {
  const image = await loadImage(dataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  if (!width || !height) {
    return dataUrl;
  }

  const scale = Math.min(1, maxDimension / Math.max(width, height));
  if (scale === 1) {
    return dataUrl;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

async function getOrCreateSession() {
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
          "change_font_size",
          "change_font_family",
          "change_font_weight",
          "change_font_color",
          "change_text_alignment",
          "change_shape_color",
          "change_spacing",
          "crop_image",
          "delete_object",
          "insert_text",
          "change_background_color",
          "move_object",
          "resize_object",
          "insert_user_sourced_image"
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

  return new Blob(bytes, {
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
          "change_font_size",
          "change_font_family",
          "change_font_weight",
          "change_font_color",
          "change_text_alignment",
          "change_shape_color",
          "change_spacing",
          "crop_image",
          "delete_object",
          "insert_text",
          "change_background_color",
          "move_object",
          "resize_object",
          "insert_user_sourced_image"
        ]
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      await getReadableBackendError(
        response,
        "Diagnosis could not be completed"
      )
    );
  }

  return await response.json();
}

function appendCoachMarkdown(parent, text) {
  const pattern = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(
        document.createTextNode(text.slice(lastIndex, match.index))
      );
    }

    const strong = document.createElement("strong");
    strong.textContent = match[1];
    parent.appendChild(strong);
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function renderCoachMarkdown(container, markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  let list = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      list = null;
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!list) {
        list = document.createElement("ul");
        Object.assign(list.style, {
          margin: "0 0 12px 18px",
          padding: "0",
          lineHeight: "1.5"
        });
        container.appendChild(list);
      }

      const item = document.createElement("li");
      item.style.marginBottom = "6px";
      appendCoachMarkdown(item, bullet[1]);
      list.appendChild(item);
      continue;
    }

    list = null;
    const paragraph = document.createElement("p");
    paragraph.style.margin = "0 0 12px 0";

    if (/^\*\*.+\*\*$/.test(line)) {
      paragraph.style.fontWeight = "600";
    }

    appendCoachMarkdown(paragraph, line);
    container.appendChild(paragraph);
  }
}

function renderDiagnosis(result) {
  let container =
    document.getElementById(
      "diagnosisOutput"
    );

  if (!container) {
    container =
      document.createElement("div");

    container.id =
      "diagnosisOutput";

    Object.assign(
      container.style,
      {
        marginTop: "18px",
        padding: "16px",
        border: "1px solid #353942",
        borderRadius: "14px",
        background: "#191c22"
      }
    );

    if (statusText?.parentNode) {
      statusText.parentNode.insertBefore(
        container,
        statusText.nextSibling
      );
    } else {
      document.body.appendChild(
        container
      );
    }
  }

  container.replaceChildren();

  const heading =
    document.createElement("h2");

  heading.textContent =
    "Visual Coach";

  Object.assign(
    heading.style,
    {
      margin: "0 0 10px 0",
      fontSize: "19px"
    }
  );

  const message = document.createElement("div");

  renderCoachMarkdown(
    message,
    result?.coach_message ||
      "I reviewed the slide, but I couldn't produce a clear recommendation."
  );

  Object.assign(
    message.style,
    {
      margin: "0",
      lineHeight: "1.5"
    }
  );

  container.appendChild(heading);
  container.appendChild(message);
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

      const bounds =
        await getSlideBounds(
          tab.id
        );

      if (!bounds) {
        throw new Error(
          "Could not locate slide"
        );
      }

      setStatus(
        "Capturing slide..."
      );

      await removeSlideOverlay(tab.id);
      overlayVisible = false;
      if (toggleOverlayButton) {
        toggleOverlayButton.textContent = "Show hologram";
      }

      const screenshot =
        await chrome.tabs.captureVisibleTab(
          tab.windowId,
          {
            format: "png"
          }
        );

      const cropped =
        await cropScreenshot(
          screenshot,
          bounds
        );

      lastCapturedSlideDataUrl =
        cropped;

      if (slidePreview) {
        slidePreview.src =
          cropped;

        slidePreview.style.display =
          "block";
      }

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

      renderDiagnosis(result);

      currentDiagnosis = result;
      currentHologramDataUrl = null;
      lastUserRequest = userRequest;

      if (fixedVersionImage) {
        fixedVersionImage.removeAttribute("src");
      }

      if (teachingPinnedImage) {
        teachingPinnedImage.removeAttribute("src");
      }

      lastCapturedTabId = tab.id;
      lastCapturedSlideBounds = bounds;

      if (fixedVersionSummary) {
        fixedVersionSummary.textContent = "";
      }

      if (hologramFeedback) {
        hologramFeedback.value = "";
      }

      if (fixedVersionSection) {
        fixedVersionSection.style.display = "none";
      }

      teachingPlan = null;
      teachingStepIndex = 0;

      if (hologramActions) {
        hologramActions.style.display = "none";
      }

      if (teachingSection) {
        teachingSection.style.display = "none";
      }

      if (showFixedVersionButton) {
        showFixedVersionButton.style.display = "block";
      }

      let overlayImage = null;

      if (result?.overlay_image) {
        overlayImage =
          result.overlay_image;
      }

      else if (result?.overlay?.image) {
        overlayImage =
          result.overlay.image;
      }

     

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
        "✓ Diagnosis received"
      );

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

async function generateFixedVersion() {
  if (
    !currentDiagnosis ||
    !lastUserRequest ||
    !lastCapturedSlideDataUrl
  ) {
    throw new Error(
      "Diagnose the current slide before generating a fixed version."
    );
  }

  const response = await fetch(
    `${BACKEND_URL}/hologram`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        session_id: currentDiagnosis.session_id,
        slide_id: currentDiagnosis.slide_id,
        user_request: lastUserRequest,
        slide_image: lastCapturedSlideDataUrl
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      await getReadableBackendError(
        response,
        "Fixed version could not be generated"
      )
    );
  }

  return await response.json();
}

async function reviseFixedVersion(userFeedback) {
  if (
    !currentDiagnosis ||
    !lastCapturedSlideDataUrl ||
    !currentHologramDataUrl ||
    !userFeedback?.trim()
  ) {
    throw new Error(
      "Describe the update and generate a fixed version first."
    );
  }

  const response = await fetch(
    `${BACKEND_URL}/revise-hologram`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        session_id: currentDiagnosis.session_id,
        slide_id: currentDiagnosis.slide_id,
        user_feedback: userFeedback,
        slide_image: lastCapturedSlideDataUrl,
        current_hologram_image: currentHologramDataUrl
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      await getReadableBackendError(
        response,
        "Update could not be applied"
      )
    );
  }

  return await response.json();
}

async function renderFixedVersion(result) {
  if (!result?.image_data_url) {
    throw new Error("The server did not return a fixed slide image.");
  }

  currentHologramDataUrl = result.image_data_url;

  if (fixedVersionImage) {
    fixedVersionImage.src = currentHologramDataUrl;
  }

  if (teachingPinnedImage) {
    teachingPinnedImage.src = currentHologramDataUrl;
  }

  if (fixedVersionSummary) {
    fixedVersionSummary.textContent = result.summary || "Fixed version ready.";
  }

  if (fixedVersionSection) {
    fixedVersionSection.style.display = "block";
  }

  teachingPlan = null;
  teachingStepIndex = 0;
  overlayVisible = false;
  if (toggleOverlayButton) {
    toggleOverlayButton.textContent = "Show hologram";
  }

  if (hologramActions) {
    hologramActions.style.display = "flex";
  }

  if (showTeachingButton) {
    showTeachingButton.style.display = "block";
  }

  if (teachingSection) {
    teachingSection.style.display = "none";
  }

  if (hologramFeedback) {
    hologramFeedback.disabled = false;
  }

  if (updateEditButton) {
    updateEditButton.disabled = false;
  }

  if (lastCapturedTabId && lastCapturedSlideBounds) {
    try {
      await showSlideOverlay(
        lastCapturedTabId,
        lastCapturedSlideBounds,
        currentHologramDataUrl
      );
      overlayVisible = true;
      if (toggleOverlayButton) {
        toggleOverlayButton.textContent = "Hide hologram";
      }
    } catch (error) {
      console.warn("[Visual Coach] Could not update slide preview overlay", error);
    }
  }
}

toggleOverlayButton?.addEventListener("click", async () => {
  if (!lastCapturedTabId || !lastCapturedSlideBounds || !currentHologramDataUrl) {
    setStatus("Generate a fixed version before changing the overlay");
    return;
  }

  try {
    toggleOverlayButton.disabled = true;

    if (overlayVisible) {
      await removeSlideOverlay(lastCapturedTabId);
      overlayVisible = false;
      toggleOverlayButton.textContent = "Show hologram";
      setStatus("Hologram hidden");
    } else {
      await showSlideOverlay(
        lastCapturedTabId,
        lastCapturedSlideBounds,
        currentHologramDataUrl
      );
      overlayVisible = true;
      toggleOverlayButton.textContent = "Hide hologram";
      setStatus("Hologram shown");
    }
  } catch (error) {
    console.error("[Visual Coach] Could not toggle slide overlay", error);
    setStatus("ERROR: Could not update the overlay");
  } finally {
    toggleOverlayButton.disabled = false;
  }
});

function setButtonLoading(button, loading, loadingLabel) {
  if (!button) return;

  if (loading) {
    if (!button.dataset.defaultLabel) {
      button.dataset.defaultLabel = button.textContent.trim();
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = `${loadingLabel} <span class="loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>`;
    return;
  }

  button.disabled = false;
  button.removeAttribute("aria-busy");
  if (button.dataset.defaultLabel) {
    button.textContent = button.dataset.defaultLabel;
  }
}

async function requestTeachingPlan() {
  if (
    !currentDiagnosis ||
    !lastCapturedSlideDataUrl ||
    !currentHologramDataUrl
  ) {
    throw new Error("Generate a fixed version before starting the lesson.");
  }

  const [slideImage, hologramImage] = await Promise.all([
    compactTeachingImage(lastCapturedSlideDataUrl),
    compactTeachingImage(currentHologramDataUrl),
  ]);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 75000);

  let response;
  try {
    response = await fetch(
      `${BACKEND_URL}/teach`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          session_id: currentDiagnosis.session_id,
          slide_id: currentDiagnosis.slide_id,
          slide_image: slideImage,
          current_hologram_image: hologramImage
        }),
        signal: controller.signal,
      }
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Teaching plan timed out. Please try Show me how again.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Teaching is not available on the backend yet. Redeploy the backend and try again.");
    }
    throw new Error(
      await getReadableBackendError(response, "Teaching plan could not be created")
    );
  }

  return await response.json();
}

function renderTeachingStep() {
  const steps = teachingPlan?.steps || [];
  const step = steps[teachingStepIndex];

  if (!step) {
    throw new Error("The teaching plan did not contain a usable step.");
  }

  if (teachingOverview) {
    teachingOverview.textContent = teachingPlan.overview || "Follow these steps to recreate the fixed version.";
  }

  if (teachingStepNumber) {
    teachingStepNumber.textContent = String(teachingStepIndex + 1);
  }

  if (teachingStepBadge) {
    teachingStepBadge.textContent = `Step ${teachingStepIndex + 1}`;
  }

  if (teachingStepTotal) {
    teachingStepTotal.textContent = String(steps.length);
  }

  if (teachingStepTitle) {
    teachingStepTitle.textContent = step.title;
  }

  if (teachingStepInstruction) {
    teachingStepInstruction.textContent = step.instruction;
  }

  if (teachingStepExplanation) {
    teachingStepExplanation.textContent = step.explanation;
  }

  if (teachingStepTarget) {
    const target = [
      step.target_area,
      step.action ? step.action.replaceAll("_", " ") : ""
    ].filter(Boolean).join(" · ");
    teachingStepTarget.textContent = target;
    teachingStepTarget.style.display = target ? "block" : "none";
  }

  if (previousTeachingButton) {
    previousTeachingButton.disabled = teachingStepIndex === 0;
  }

  if (nextTeachingButton) {
    nextTeachingButton.textContent = teachingStepIndex === steps.length - 1 ? "Finish" : "Next";
  }
}

async function endCoachingSession() {
  if (lastCapturedTabId) {
    try {
      await removeSlideOverlay(lastCapturedTabId);
    } catch (error) {
      console.warn("[Visual Coach] Could not remove slide overlay", error);
    }
  }

  try {
    await chrome.storage.session.remove("sessionId");
  } catch (error) {
    console.warn("[Visual Coach] Could not clear stored session", error);
  }

  sessionId = null;
  lastCapturedSlideDataUrl = null;
  currentDiagnosis = null;
  currentHologramDataUrl = null;
  lastUserRequest = null;
  lastCapturedTabId = null;
  lastCapturedSlideBounds = null;
  teachingPlan = null;
  teachingStepIndex = 0;
  overlayVisible = false;
  if (toggleOverlayButton) {
    toggleOverlayButton.textContent = "Show overlay";
  }

  document.getElementById("diagnosisOutput")?.remove();

  if (slidePreview) {
    slidePreview.removeAttribute("src");
    slidePreview.style.display = "none";
  }

  if (fixedVersionImage) {
    fixedVersionImage.removeAttribute("src");
  }

  if (teachingPinnedImage) {
    teachingPinnedImage.removeAttribute("src");
  }

  if (fixedVersionSummary) {
    fixedVersionSummary.textContent = "";
  }

  if (fixedVersionSection) {
    fixedVersionSection.style.display = "none";
  }

  if (hologramActions) {
    hologramActions.style.display = "none";
  }

  if (showFixedVersionButton) {
    showFixedVersionButton.style.display = "none";
  }

  if (teachingSection) {
    teachingSection.style.display = "none";
  }

  if (messageInput) {
    messageInput.value = "";
  }

  setStatus("Session ended. Send a new request to start again.");
}

showFixedVersionButton?.addEventListener(
  "click",
  async () => {
    try {
      setButtonLoading(showFixedVersionButton, true, "Generating");
      setStatus("Generating a fixed version...");

      const result = await generateFixedVersion();

      await renderFixedVersion(result);
      showFixedVersionButton.style.display = "none";
      setStatus("Fixed version ready");
    } catch (error) {
      console.error("[Visual Coach]", error);
      setStatus(`ERROR: ${error.message}`);
    } finally {
      setButtonLoading(showFixedVersionButton, false);
    }
  }
);

updateEditButton?.addEventListener(
  "click",
  async () => {
    const userFeedback = hologramFeedback?.value.trim();

    if (!userFeedback) {
      setStatus("Describe the change you want first");
      return;
    }

    if (!currentHologramDataUrl) {
      setStatus("Generate a fixed version before updating it");
      return;
    }

    try {
      setButtonLoading(updateEditButton, true, "Updating");
      hologramFeedback.disabled = true;
      setStatus("Updating the fixed version...");

      const result = await reviseFixedVersion(userFeedback);

      await renderFixedVersion(result);
      hologramFeedback.value = "";
      setStatus("Fixed version updated");
    } catch (error) {
      console.error("[Visual Coach]", error);
      setStatus(`ERROR: ${error.message}`);
    } finally {
      setButtonLoading(updateEditButton, false);
      hologramFeedback.disabled = false;
    }
  }
);

showTeachingButton?.addEventListener("click", async () => {
  try {
    setButtonLoading(showTeachingButton, true, "Preparing");
    setStatus("Preparing your PowerPoint steps...");

    if (overlayVisible && lastCapturedTabId) {
      try {
        await removeSlideOverlay(lastCapturedTabId);
      } catch (error) {
        console.warn("[Visual Coach] Could not hide hologram for teaching", error);
      }
      overlayVisible = false;
      if (toggleOverlayButton) {
        toggleOverlayButton.textContent = "Show hologram";
      }
    }

    teachingPlan = await requestTeachingPlan();
    teachingStepIndex = 0;
    renderTeachingStep();

    if (teachingSection) {
      teachingSection.style.display = "block";
    }

    showTeachingButton.style.display = "none";
    if (hologramFeedback) hologramFeedback.disabled = true;
    if (updateEditButton) updateEditButton.disabled = true;
    setStatus("Teaching steps ready");
  } catch (error) {
    console.error("[Visual Coach]", error);
    if (showTeachingButton) {
      showTeachingButton.style.display = "block";
    }
    setStatus(`ERROR: ${error.message}`);
  } finally {
    setButtonLoading(showTeachingButton, false);
  }
});

previousTeachingButton?.addEventListener("click", () => {
  if (!teachingPlan) return;
  teachingStepIndex = Math.max(0, teachingStepIndex - 1);
  renderTeachingStep();
});

nextTeachingButton?.addEventListener("click", async () => {
  if (!teachingPlan) return;

  if (teachingStepIndex >= teachingPlan.steps.length - 1) {
    await endCoachingSession();
    return;
  }

  teachingStepIndex += 1;
  renderTeachingStep();
});

doneButton?.addEventListener("click", endCoachingSession);

hologramFeedback?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    updateEditButton?.click();
  }
});

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

          opacity: "1.0"
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


function createTestRedOverlay(bounds) {
  // Create an image with the exact same aspect ratio as the slide
  const width = 1600;

  const aspectRatio =
    bounds.width / bounds.height;

  const height =
    Math.round(width / aspectRatio);

  const canvas =
    document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const ctx =
    canvas.getContext("2d");

  // Fake AI-generated image
  ctx.fillStyle = "#ff0000";

  ctx.fillRect(
    0,
    0,
    width,
    height
  );

  return canvas.toDataURL(
    "image/png"
  );
}
