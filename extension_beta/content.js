console.log("[Visual Coach] Content script loaded");

function findCurrentSlide() {
  const backgroundPaths = document.querySelectorAll('[id*="-bg"] path');

  let bestMatch = null;
  let biggestArea = 0;

  for (const path of backgroundPaths) {
    const rect = path.getBoundingClientRect();

    if (rect.width < 300 || rect.height < 200) continue;

    const visible =
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;

    if (!visible) continue;

    const area = rect.width * rect.height;

    if (area > biggestArea) {
      biggestArea = area;
      bestMatch = rect;
    }
  }

  if (!bestMatch) {
    const svgs = document.querySelectorAll("svg");

    for (const svg of svgs) {
      const rect = svg.getBoundingClientRect();

      if (rect.width < 300 || rect.height < 200) continue;

      const visible =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;

      if (!visible) continue;

      const ratio = rect.width / rect.height;
      const looksLikeSlide =
        Math.abs(ratio - 16 / 9) < 0.2 ||
        Math.abs(ratio - 4 / 3) < 0.2;

      if (!looksLikeSlide) continue;

      const area = rect.width * rect.height;

      if (area > biggestArea) {
        biggestArea = area;
        bestMatch = rect;
      }
    }
  }

  if (!bestMatch) return null;

  return {
    x: bestMatch.left,
    y: bestMatch.top,
    width: bestMatch.width,
    height: bestMatch.height,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_SLIDE_BOUNDS") {
    if (
      location.hostname !== "docs.google.com" ||
      !location.pathname.includes("/presentation/")
    ) {
      sendResponse({
        success: false,
        reason: "NOT_GOOGLE_SLIDES"
      });
      return true;
    }

    const slide = findCurrentSlide();

    if (!slide) {
      sendResponse({
        success: false,
        reason: "SLIDE_NOT_FOUND"
      });
      return true;
    }

    sendResponse({
      success: true,
      slide
    });

    return true;
  }
});