const captureButton = document.getElementById("captureButton");
const statusText = document.getElementById("statusText");
const slidePreview = document.getElementById("slidePreview");

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

captureButton.addEventListener(
  "click",
  async () => {
    console.log(
      "[Visual Coach] Capture button clicked"
    );

    setStatus("Capture started...");

    try {
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

      console.log(
        "Active tab:",
        tab.url
      );

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
       * STEP 1
       * Find the slide.
       */

      const bounds =
        await getSlideBounds(tab.id);

      console.log(
        "Slide bounds:",
        bounds
      );

      if (!bounds) {
        throw new Error(
          "Could not locate the slide"
        );
      }

      setStatus(
        `Slide found: ${Math.round(
          bounds.width
        )} × ${Math.round(
          bounds.height
        )}`
      );

      /*
       * STEP 2
       * Screenshot active tab.
       */

      setStatus(
        "Taking screenshot..."
      );

      const screenshot =
        await chrome.tabs.captureVisibleTab(
          tab.windowId,
          {
            format: "png"
          }
        );

      console.log(
        "Screenshot captured"
      );

      /*
       * STEP 3
       * Crop.
       */

      setStatus(
        "Cropping slide..."
      );

      const cropped =
        await cropScreenshot(
          screenshot,
          bounds
        );

      /*
       * STEP 4
       * Display result.
       */

      lastCapturedSlideDataUrl =
        cropped;

      if (slidePreview) {
        slidePreview.src =
          cropped;

        slidePreview.style.display =
          "block";
      }

      setStatus(
        "✓ Slide captured"
      );

      console.log(
        "Final slide image:",
        cropped
      );

    } catch (error) {

      console.error(
        "[Visual Coach] Capture failed:",
        error
      );

      setStatus(
        `ERROR: ${error.message}`
      );
    }
  }
);