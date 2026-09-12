const activateButton = document.getElementById("activateButton");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");

let active = false;

function updateUI() {
  if (active) {
    activateButton.textContent = "Deactivate Visual Coach";
    activateButton.classList.add("active");

    statusText.textContent = "Coach active";
    statusDot.classList.add("active");
  } else {
    activateButton.textContent = "Activate Visual Coach";
    activateButton.classList.remove("active");

    statusText.textContent = "Coach inactive";
    statusDot.classList.remove("active");
  }
}


activateButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab) {
    statusText.textContent = "No active tab";
    return;
  }

  if (!active) {

    try {
      const result = await chrome.tabs.sendMessage(
        tab.id,
        {
          type: "ACTIVATE_VISUAL_COACH"
        }
      );

      if (!result.success) {

        if (result.reason === "NOT_GOOGLE_SLIDES") {
          statusText.textContent = "Open a Google Slides presentation";
        }

        if (result.reason === "SLIDE_NOT_FOUND") {
          statusText.textContent = "Could not detect slide";
        }

        return;
      }

      console.log("Detected slide:", result.slide);

      active = true;

      await chrome.storage.local.set({
        visualCoachActive: true
      });

      updateUI();

    } catch (error) {

      console.error(error);

      statusText.textContent = "Reload Google Slides and try again";
    }

  } else {

    await chrome.tabs.sendMessage(
      tab.id,
      {
        type: "DEACTIVATE_VISUAL_COACH"
      }
    );

    active = false;

    await chrome.storage.local.set({
      visualCoachActive: false
    });

    updateUI();
  }
});


chrome.storage.local.get(
  ["visualCoachActive"],
  (result) => {

    active =
      result.visualCoachActive ?? false;

    updateUI();
  }
);