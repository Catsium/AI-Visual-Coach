1. **Get extension + PowerPoint mechanics running**

   * Get the Chrome extension working in PowerPoint Web.
   * Have the main extension UI ready, with the side panel for user interaction.
   * Set up the content script and background/service worker.
   * Make sure the extension can communicate properly with PowerPoint Web.

2. **Detect the slide area + prove the hologram**

   * Detect the visible PowerPoint slide area.
   * Store the slide position, width, and height.
   * Crop the screenshot down to just the slide area.
   * Place a dummy image directly over only the slide area.
   * Start at around **70% opacity**.
   * Add an opacity slider.
   * Make sure pointer interaction can pass through the hologram so it does not block normal PowerPoint interaction.
   * If automatic detection is unreliable, fall back to manually selecting the slide rectangle.

3. **Connect backend + create an Agents API session**

   * Set up the backend with the OpenAI API key.
   * When the user starts a new coaching interaction, create one **Agents API session** for that coaching session.
   * Keep the session ID until the coaching flow is finished or reset.
   * Test that a simple request can go:
     * extension → backend → Agents API session → backend → extension.
   * Use the Agents API session for the AI conversation and context.
   * Keep slide, hologram, UI, and workflow state in the application.

4. **Make user input + screenshot, then return the diagnosis**

   * User asks for help through the extension.
   * Capture the current visible PowerPoint tab.
   * Crop the screenshot down to just the slide using the detected slide area.
   * Send:
     * the user's request,
     * the cropped slide screenshot,
     * and the available supported PowerPoint actions
       to the agent.
   * The agent should already be instructed to only recommend changes that use supported PowerPoint actions.
   * Have the agent return structured diagnosis containing:
     * problems,
     * evidence,
     * fixes,
     * useful additions,
     * the relevant target area where possible,
     * and the supported action used for each change.
   * Show this diagnosis to the user.

5. **Generate + display the hologram**

   * After the diagnosis, user can choose whether they want a visual example.
   * If they press **Generate Hologram**, send:
     * the original cropped slide screenshot,
     * the user's original goal,
     * the diagnosis,
     * the fixes,
     * and the additions
       through the backend to **GPT Image 2.5 Flare**.
   * Receive the generated slide image back.
   * Place the generated image directly over only the PowerPoint slide.
   * Replace the dummy hologram from Step 2 with the generated image.
   * Keep the hologram settings available so the user can:
     * increase opacity,
     * decrease opacity,
     * hide/show the hologram.

6. **Hologram feedback loop**

   * If the user wants to change the generated edit, for example:
     * different colours,
     * different font direction,
     * slightly different style,
     * other small visual changes,
       they can give feedback through the extension.
   * Keep using the same Agents API session so the Visual Coach keeps the conversation context.
   * Keep the actual current hologram in the application's own state.
   * Send:
     * the current hologram,
     * and the user's latest feedback
       through the backend to **GPT Image 2.5 Flare**.
   * Generate a revised hologram.
   * Replace the current hologram with the new version while keeping the original slide unchanged.
   * User can repeat this loop until they are happy with the result.

7. **Teach Me How**

   * Once the user is happy with the hologram, they can choose **Teach Me How**.
   * Ask the agent to create the complete teaching plan using the existing coaching session.
   * The teaching plan should only use supported PowerPoint actions.
   * Each step should contain:
     * the action the user needs to take,
     * a brief explanation of what the step changes,
     * and the PowerPoint control/object that should be highlighted.
   * Generate the full plan once.
   * Keep the plan in the application and only show one step at a time.
   * For each step:
     * show the current instruction,
     * briefly explain what it changes,
     * highlight the relevant PowerPoint control/object,
     * let the user perform the action,
     * let the user press **Done / Next**.
   * Do not call the AI again for every step.
   * Continue until every planned change has been covered.

8. **Finished**

   * At the end, show a **Finished** button.
   * Remove the active highlights.
   * Hide/remove the hologram if needed.
   * Clear or reset the current teaching session.
   * Reset the extension's slide, hologram, UI, and workflow state.
   * Close/end the current coaching flow.
   * Discard or stop using that Agents API session.
