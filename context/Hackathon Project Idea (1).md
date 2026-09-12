# AI Visual Coach — Agreed Product Flow

## Introduction

This project is an AI visual coach designed to help users understand, visualize, and carry out improvements to visual work without immediately taking control away from them.

The broader product idea is not limited to PowerPoint. The long-term direction is an assistant that can work alongside users in different creative environments. For the hackathon, however, the prototype will focus on **PowerPoint Web in Chrome** because it is the most realistic environment for demonstrating the full interaction within the available build time.

The product is intended to do more than simply redesign a slide automatically. Its role is to:

- understand what the user is trying to improve,
- identify visible problems, fixes, and useful additions,
- explain those findings clearly,
- optionally generate a visual version of the proposed improvements,
- display that generated version directly over the user's real slide as a hologram,
- allow the user to visually compare the proposed version with the original through adjustable opacity,
- allow the user to request revisions to the hologram,
- and, when requested, guide the user through making the chosen changes themselves.

The current prototype will be implemented as a **Chrome extension used alongside PowerPoint Web**.

The generated visual preview is referred to as a **hologram**. It is a full-slide visual overlay positioned directly over the visible slide area. It is not an editable slide and does not replace the user's original slide. It acts as a temporary visual reference that lets the user see what the proposed improvements could look like before making any changes.

---

# Product Flow

## Step 1 — User Asks for Help

The interaction starts when the user opens the Chrome extension while working in **PowerPoint Web** and asks for help with the current slide.

The user's request provides the goal or context for the analysis.

Examples of requests could include:

- making the slide look more professional,
- making the message easier to understand,
- reducing clutter,
- improving the visual hierarchy,
- or asking generally what could be improved.

The assistant does not automatically modify the slide at this point.

Once the user requests help, the extension captures the current slide so that the assistant can analyze both:

1. what the user wants help with, and
2. what is visibly present on the slide.

The capture should focus on the **slide itself**, rather than treating the entire PowerPoint interface as the design being reviewed.

---

## Step 2 — Analyze the Slide

The captured slide and the user's request are sent to the AI for visual analysis.

The analysis should identify:

- visible problems,
- appropriate fixes,
- and useful additions where relevant.

The result should be returned in a **structured format** so the same analysis can be reused later in the product flow.

For each issue, the structured diagnosis should contain the important user-facing information, such as:

- the issue,
- what visible evidence caused the issue to be identified,
- and the proposed fix.

Useful additions can also be included when the assistant believes something should be added rather than only changed.

The diagnosis may also contain the relevant target area or region of the slide so that the identified issue can remain connected to the part of the slide it refers to.

This structured diagnosis becomes the shared source of information for the rest of the interaction.

It is used for:

- the diagnosis shown to the user,
- the instructions sent to the image-generation model,
- and the later teaching process.

The system should not independently reinvent the proposed solution at every stage.

---

## Step 3 — Show the Text Diagnosis

Before generating any image, the extension shows the user the findings from the analysis.

The diagnosis should clearly present the identified:

- problems,
- fixes,
- and additions.

The purpose of this step is to let the user understand what the assistant noticed before spending an image-generation request.

The user may decide that the written explanation is already enough and make the changes themselves.

Image generation should therefore **not happen automatically** after every diagnosis.

Instead, the user is given the choice to request a visual representation of the proposed improvements.

---

## Step 4 — User Requests a Visual Preview

If the user wants to see what the recommended changes could look like, they can request a visual preview.

The same structured diagnosis from the analysis step is reused directly.

The image-generation request contains:

- the original slide image,
- the user's goal,
- the identified problems,
- the proposed fixes,
- and the proposed additions.

These are sent to **OpenAI Image 2.5** to generate an improved visual version of the slide.

The generated result is treated as a visual reference for the proposed direction rather than as a replacement for the user's original PowerPoint slide.

---

## Step 5 — Display the Full-Slide Hologram

Once the generated image is returned, the extension places it directly over the visible slide in PowerPoint Web.

The hologram should cover **only the slide portion of the screen**.

It should not cover:

- the PowerPoint toolbar,
- the browser interface,
- the slide navigator,
- or unrelated parts of the PowerPoint interface.

The generated slide should be aligned with the real slide so the two occupy the same visible area.

The hologram is a non-destructive overlay.

It does not edit the user's PowerPoint file.

It simply lets the user see the proposed design directly on top of the work they are already viewing.

### Hologram Implementation — Image Overlay

The hologram is a generated image displayed as a visual layer directly over the slide inside PowerPoint Web. A Chrome extension can insert this image into the webpage through a content script. The overlay remains separate from the PowerPoint file. [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

The basic mechanism is:

1. Establish the visible slide's position, width, and height.
2. Obtain the generated preview with the same aspect ratio as the source slide.
3. Position and size the preview over the slide rectangle, leaving the surrounding interface visible.
4. Connect the opacity slider to the image layer: 0% shows the original, 100% shows the proposal, and intermediate values blend them.
5. Allow pointer interaction to pass through the image layer so it does not block the underlying PowerPoint content.

CSS provides the opacity and pointer-interaction controls for this behaviour. [Opacity](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/opacity), [pointer events](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/pointer-events)

### What Is Feasible and What Remains Unverified

Displaying and adjusting an image over a known rectangle uses standard browser functionality. Automatically locating that rectangle in PowerPoint Web and keeping it aligned through resizing, zoom changes, or interface changes still requires a practical test.

Aligning the outside edges of the generated image does not guarantee that the objects inside it match the original positions. Generated content must still be checked against the intended improvements.

**Agreed slide-region selection:** The MVP will attempt automatic detection of the visible slide, with manual rectangle selection available if detection fails or is unreliable. Both approaches establish the slide region used for capture and hologram placement.

Start with a short practical test of automatic detection. If it is not reliable within that initial attempt, use the manual fallback so the core experience can still be completed. Manual selection may require recalibration after zoom, resizing, or other layout changes. The exact automatic detection method remains to be tested.

No PowerPoint-specific runtime validation is established by this explanation. The remaining review issues will be discussed individually before further product decisions are added.

* The generated hologram must only apply changes that are included in the structured diagnosis and supported by the prototype.
* Do not introduce additional design changes that the user cannot recreate through the supported PowerPoint actions.
* Every meaningful visible change in the generated hologram should be something the later teaching flow can guide the user through.
---

## Step 6 — Change Hologram Opacity

The user can adjust the opacity of the hologram.

The opacity control allows the user to move between the original slide and the generated proposal without switching between separate images.

At low opacity, the original slide is more visible.

At high opacity, the generated hologram becomes more visible.

At an intermediate opacity, the user can visually compare the original and proposed designs directly on top of one another.

This makes it easier to notice differences such as:

- changed positioning,
- changed spacing,
- stronger or weaker emphasis,
- different colours,
- resized elements,
- and other visual changes.

The opacity only changes the appearance of the hologram overlay.

It does not change the actual PowerPoint slide.

* User-requested revisions must remain within the same supported PowerPoint actions.
* Do not allow a revision to introduce changes that the prototype cannot later teach the user to recreate.

---

## Step 7 — User Gives Feedback on the Hologram

After seeing the hologram, the user can request changes to the generated direction.

For example, the user may want to:

- try a different colour,
- try a different font direction,
- adjust the visual style,
- or otherwise change part of the generated proposal.

The current hologram and the user's feedback are used to create a revised version.

The revision should continue from the selected hologram rather than starting the entire design process again from scratch.

Once the revised image is generated, it replaces the current hologram shown over the slide.

The user can continue using the opacity control to compare the revised hologram with the original slide.

---

## Step 8 — User Asks to Be Taught

If the user likes the chosen hologram and wants to recreate the improvements themselves, they can choose **Teach Me How**.

At this point, the assistant uses the existing:

- original slide,
- structured diagnosis,
- selected hologram,
- fixes,
- additions,
- and the visual direction the user chose.

The goal is now to guide the user from their current slide toward the chosen result.

The assistant does not automatically take over the entire editing process.

Instead, it begins a guided sequence of actions for the user to perform inside PowerPoint Web.

---

## Step 9 — Step-by-Step Guided Instructions

The teaching process is broken into numbered steps.

Each step should contain:

1. the action the user needs to perform,
2. a short, simple one-sentence explanation of what that step changes or achieves,
3. and a visual highlight showing the relevant button, control, object, or action the user needs to use.

For example:

**Step 1 — Increase the headline size.**  
This gives the title stronger visual priority.

The extension should highlight the relevant area or PowerPoint control needed for that step.

The user then performs the action themselves.

The process continues step by step until the required changes have been completed.

The instructions should remain tied to the chosen hologram and the fixes that produced it.

### When a proposed improvement needs an image

1. **Explain what image is needed.** Describe its purpose and the characteristics that matter for the design. For example: “Find a wide city skyline photograph with open sky behind the heading.” The user does not need the exact picture shown in the hologram.

2. **Let the user obtain a suitable image.** Pause the relevant teaching steps while the user finds and downloads an image, or chooses one they already have. Image searching is handled by the user.

3. **Guide the user through adding it in PowerPoint.** Once the image is ready, give the insertion instructions and highlight the relevant PowerPoint Web controls. The user performs the actions themselves.

4. **Guide the supported formatting changes.** Base the guidance on the image the user actually selected and how it appears in their slide. Work toward the chosen design's layout, visual hierarchy, and style, adapting the instructions where the replacement image differs from the hologram. Use only formatting operations supported by the prototype.

5. **Continue the remaining improvements.** Resume the other teaching steps so every proposed change is covered. The finished slide may use different imagery while achieving the intended design; an exact copy of the hologram's generated picture is not required.

---

## Step 10 — Finished Result

After the user completes all of the guided steps, they are left with the finished version of the slide created through their own actions.

The overall interaction therefore moves from:

**asking for help → understanding the problems → seeing a proposed visual direction → refining it → learning how to recreate it → completing the improved slide.**

The original slide remains under the user's control throughout the process, while the AI provides the analysis, visual reference, feedback loop, and guided assistance needed to reach the chosen result.

---

# Agreed Clarifications — 12 September 2026

## MVP Boundary — Teach Every Proposed Change

For the hackathon prototype, the priority is to reliably teach every proposed change rather than offer unrestricted redesign.

The assistant should propose only improvements that fall within a limited set of changes it can reliably guide the user through making in PowerPoint Web. This boundary applies to the initial fixes, proposed additions, and later hologram revisions. The exact supported changes still need to be selected and tested.

The diagnosis, chosen hologram, and teaching steps must describe the same supported improvements. A generated image that introduces an unsupported change does not satisfy this boundary simply because the image looks convincing. How such mismatches will be detected and handled remains open.

The limited scope reflects the hackathon's roughly four-hour build allowance. The team is prioritizing a complete interaction in PowerPoint Web before expanding the range of improvements or supporting additional creative environments.

### Suggested Demo Explanation

“For this hackathon, we're focusing on PowerPoint Web and a limited set of improvements that we can guide users through from start to finish. The short build window means broader design changes and more applications are outside this version's scope. Our priority is making every proposed change something the user can learn to carry out.”

This describes the intended scope; reliability must still be demonstrated and tested.
