"""Generate concise PowerPoint lessons from an original and approved slide."""

import base64
import json
import os
from pathlib import Path
from typing import Literal

import requests
from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openrouter/free")
TEACHING_SAMPLES_DIR = Path(__file__).resolve().parent / "teaching_samples"

SAMPLE_IMAGE_PAIRS = {
    "sample_a": ("slide_a_original.png", "slide_a_approved.png"),
    "sample_b": ("slide_b_original.png", "slide_b_approved.png"),
}

SUPPORTED_POWERPOINT_ACTIONS = (
    "select_object",
    "edit_text",
    "change_font_size",
    "change_font_weight",
    "change_text_alignment",
    "change_text_color",
    "move_object",
    "resize_object",
    "crop_image",
    "delete_object",
    "duplicate_object",
    "change_fill_color",
    "change_shape_color",
    "change_object_order",
)

SupportedPowerPointAction = Literal[
    "select_object",
    "edit_text",
    "change_font_size",
    "change_font_weight",
    "change_text_alignment",
    "change_text_color",
    "move_object",
    "resize_object",
    "crop_image",
    "delete_object",
    "duplicate_object",
    "change_fill_color",
    "change_shape_color",
    "change_object_order",
]


class TeachingBaseModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TeachingSampleRequest(TeachingBaseModel):
    sample_id: str = Field(min_length=1)


class TeachingStep(TeachingBaseModel):
    step: int = Field(ge=1)
    title: str = Field(min_length=1)
    instruction: str = Field(min_length=1)
    explanation: str = Field(min_length=1)
    target_area: str | None = None
    action: SupportedPowerPointAction | None = None
    value: str | int | float | None = None


class TeachingResponse(TeachingBaseModel):
    overview: str = Field(min_length=1)
    steps: list[TeachingStep] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def steps_are_ordered(self) -> "TeachingResponse":
        expected_steps = list(range(1, len(self.steps) + 1))
        if [step.step for step in self.steps] != expected_steps:
            raise ValueError("Teaching steps must be numbered consecutively from 1")
        return self


def get_sample_image_paths(sample_id: str) -> tuple[Path, Path]:
    """Return the configured local sample pair, with useful client errors."""
    filenames = SAMPLE_IMAGE_PAIRS.get(sample_id)
    if filenames is None:
        allowed_sample_ids = ", ".join(SAMPLE_IMAGE_PAIRS)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unsupported sample_id. Use one of: {allowed_sample_ids}",
        )

    original_image_path, approved_image_path = (
        TEACHING_SAMPLES_DIR / filename for filename in filenames
    )
    if not original_image_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Original sample image is missing: {original_image_path.name}",
        )
    if not approved_image_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Approved sample image is missing: {approved_image_path.name}",
        )

    return original_image_path, approved_image_path


def image_file_as_data_url(image_path: Path) -> str:
    encoded_image = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded_image}"


def teaching_prompt() -> str:
    supported_actions_text = ", ".join(SUPPORTED_POWERPOINT_ACTIONS)
    return f"""
You are Visual Coach's PowerPoint teaching assistant.

You are given two slide images:

1. ORIGINAL SLIDE
2. APPROVED EDITED SLIDE

The approved edited slide has already been accepted by the user and is the target result.

Do not critique either slide.
Do not suggest a different design.
Do not second-guess the approved edit.

Your job is to compare the original slide with the approved edited slide and teach the user how to reproduce the meaningful visible changes manually in Microsoft PowerPoint.

Create a practical step-by-step lesson.

Rules:

- Focus only on meaningful visual differences between the two slides.
- Ignore tiny rendering differences, anti-aliasing, compression, or insignificant pixel changes.
- Each step should contain one clear user action.
- Give each step a brief explanation of what the step does or why it is necessary.
- Keep the steps in a realistic order for PowerPoint.
- Refer to visible elements using simple descriptions such as "top-left title", "large image on the right", or "body text box".
- Use only the supplied supported PowerPoint actions.
- Do not invent PowerPoint features.
- Do not invent exact measurements, coordinates, font sizes, or colors unless they can be reasonably inferred from the images.
- If an exact value cannot be determined, use a relative instruction such as "increase the title size", "move the image slightly to the right", or "make the image larger".
- Do not include steps for parts of the slide that did not meaningfully change.
- Keep the lesson concise.
- Prefer roughly 3 to 8 useful steps instead of many tiny steps.

The user should understand both WHAT to do and briefly WHAT the step achieves.

Supported PowerPoint actions:

{supported_actions_text}

The supplied images are ordered as follows:
IMAGE 1 = ORIGINAL SLIDE
IMAGE 2 = APPROVED EDITED SLIDE

The APPROVED EDITED SLIDE is authoritative. Teach how to match it; never judge it.
""".strip()


def generate_teaching_plan(
    original_image_path: Path,
    approved_image_path: Path,
    *,
    model: str | None = None,
    openrouter_url: str = OPENROUTER_URL,
) -> TeachingResponse:
    """Send both slide images in one OpenRouter request and validate the lesson."""
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPENROUTER_API_KEY is not configured",
        )

    payload = {
        "model": model or OPENROUTER_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": teaching_prompt()},
                    {"type": "text", "text": "IMAGE 1 = ORIGINAL SLIDE"},
                    {
                        "type": "image_url",
                        "image_url": {"url": image_file_as_data_url(original_image_path)},
                    },
                    {
                        "type": "text",
                        "text": "IMAGE 2 = APPROVED EDITED SLIDE (authoritative target)",
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": image_file_as_data_url(approved_image_path)},
                    },
                ],
            }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "powerpoint_teaching_plan",
                "strict": True,
                "schema": TeachingResponse.model_json_schema(),
            },
        },
        "provider": {"require_parameters": True},
        "plugins": [{"id": "response-healing"}],
    }

    try:
        response = requests.post(
            openrouter_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not reach OpenRouter: {exc}",
        ) from exc

    if not response.ok:
        try:
            error_detail = response.json()
        except ValueError:
            error_detail = response.text
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"openrouter_status": response.status_code, "error": error_detail},
        )

    try:
        content = response.json()["choices"][0]["message"]["content"]
        return TeachingResponse.model_validate(json.loads(content))
    except (KeyError, IndexError, TypeError, ValueError, ValidationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OpenRouter returned an invalid teaching response",
        ) from exc
