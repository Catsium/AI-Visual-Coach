console.log("[Visual Coach] Content script loaded");

function findCurrentSlide() {
  // Primary method:
  // Google Slides currently gives slide backgrounds IDs containing "-bg"
  const backgroundPaths = document.querySelectorAll('[id*="-bg"] path');

  let bestMatch = null;
  let biggestArea = 0;

  for (const path of backgroundPaths) {
    const rect = path.getBoundingClientRect();

    // Ignore invisible/tiny elements
    if (rect.width < 300 || rect.height < 200) {
      continue;
    }

    // Must actually be on screen
    const visible =
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;

    if (!visible) {
      continue;
    }

    const area = rect.width * rect.height;

    if (area > biggestArea) {
      biggestArea = area;
      bestMatch = {
        element: path,
        rect
      };
    }
  }

  // Fallback in case Google changes that DOM structure
  if (!bestMatch) {
    console.warn(
      "[Visual Coach] Main selector failed. Trying SVG fallback..."
    );

    const svgs = document.querySelectorAll("svg");

    for (const svg of svgs) {
      const rect = svg.getBoundingClientRect();

      if (rect.width < 300 || rect.height < 200) {
        continue;
      }

      const visible =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;

      if (!visible) {
        continue;
      }

      const ratio = rect.width / rect.height;

      // Common presentation ratios:
      // 16:9 = 1.777...
      // 4:3 = 1.333...
      const looksLikeSlide =
        Math.abs(ratio - 16 / 9) < 0.2 ||
        Math.abs(ratio - 4 / 3) < 0.2;

      if (!looksLikeSlide) {
        continue;
      }

      const area = rect.width * rect.height;

      if (area > biggestArea) {
        biggestArea = area;
        bestMatch = {
          element: svg,
          rect
        };
      }
    }
  }

  if (!bestMatch) {
    return null;
  }

  return {
    x: bestMatch.rect.left,
    y: bestMatch.rect.top,
    width: bestMatch.rect.width,
    height: bestMatch.rect.height
  };
}


// -----------------------------------------------------
// Debug overlay
// -----------------------------------------------------

let debugOverlay = null;

function showSlideDetection(rect) {
  if (debugOverlay) {
    debugOverlay.remove();
  }

  debugOverlay = document.createElement("div");

  debugOverlay.id = "visual-coach-slide-debug";

  Object.assign(debugOverlay.style, {
    position: "fixed",
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,

    border: "4px solid #22c55e",
    boxSizing: "border-box",

    pointerEvents: "none",
    zIndex: "2147483647",

    boxShadow: "0 0 15px rgba(34, 197, 94, 0.5)"
  });

  const label = document.createElement("div");

  label.textContent = "Visual Coach: Slide detected";

  Object.assign(label.style, {
    position: "absolute",
    top: "-34px",
    left: "0",

    background: "#22c55e",
    color: "white",

    padding: "6px 10px",
    borderRadius: "6px",

    fontFamily: "Arial, sans-serif",
    fontSize: "13px",
    fontWeight: "600"
  });

  debugOverlay.appendChild(label);

  document.body.appendChild(debugOverlay);
}


// -----------------------------------------------------
// Activation
// -----------------------------------------------------

function activateVisualCoach() {
  // Make sure we're actually inside Google Slides
  if (
    location.hostname !== "docs.google.com" ||
    !location.pathname.includes("/presentation/")
  ) {
    console.warn("[Visual Coach] This is not Google Slides.");
    return {
      success: false,
      reason: "NOT_GOOGLE_SLIDES"
    };
  }

  const slide = findCurrentSlide();

  if (!slide) {
    console.error("[Visual Coach] Could not find current slide.");

    return {
      success: false,
      reason: "SLIDE_NOT_FOUND"
    };
  }

  console.log("[Visual Coach] Slide found:", slide);

  showSlideDetection(slide);

  return {
    success: true,
    slide
  };
}


// -----------------------------------------------------
// Messages from side panel
// -----------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {

    if (message.type === "ACTIVATE_VISUAL_COACH") {
      const result = activateVisualCoach();

      sendResponse(result);
    }

    if (message.type === "DEACTIVATE_VISUAL_COACH") {
      if (debugOverlay) {
        debugOverlay.remove();
        debugOverlay = null;
      }

      sendResponse({
        success: true
      });
    }

    return true;
  }
);