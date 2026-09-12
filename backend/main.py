import base64
import binascii
import io
import json
import os
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError
import requests
import psycopg
from openai import OpenAI
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from teaching import (
    TeachingResponse,
    TeachingSampleRequest,
    generate_teaching_plan,
    get_sample_image_paths,
)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openrouter/free")

SUPPORTED_ACTION_DEFINITIONS = {
    "change_font_size": "Change the size of existing text.",
    "change_font_weight": "Change existing text between regular and bold weight.",
    "change_font_color": "Change the colour of existing text.",
    "change_text_alignment": "Change the alignment of existing text.",
    "move_object": "Move an existing object on the slide.",
    "resize_object": "Resize an existing object on the slide.",
    "insert_user_sourced_image": (
        "Insert an image that the user finds and supplies, then position or resize it."
    ),
}


def get_database_url() -> str:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DATABASE_URL is not configured",
        )
    return database_url


def get_db():
    return psycopg.connect(get_database_url(), row_factory=dict_row)


def get_allowed_origins() -> list[str]:
    """Return configured browser origins, or a development-safe wildcard."""
    configured_origins = os.getenv("CORS_ALLOWED_ORIGINS")
    if configured_origins is None:
        return ["*"]
    return [origin.strip() for origin in configured_origins.split(",") if origin.strip()]


class SessionResponse(BaseModel):
    session_id: UUID


class DiagnoseRequest(BaseModel):
    session_id: UUID
    slide_id: str = Field(min_length=1)
    user_request: str = Field(min_length=1)
    slide_image: str = Field(min_length=1)
    supported_actions: list[str] = Field(default_factory=list)


class DiagnosisChange(BaseModel):
    issue: str
    evidence: str
    fix: str
    target_area: str | None = None
    supported_action: str | None = None


class DiagnoseResponse(BaseModel):
    session_id: UUID
    slide_id: str
    coach_message: str
    problems: list[DiagnosisChange]
    additions: list[DiagnosisChange]


class HologramRequest(BaseModel):
    session_id: UUID
    slide_id: str = Field(min_length=1)
    user_request: str = Field(min_length=1)
    slide_image: str


class ReviseHologramRequest(HologramRequest):
    current_hologram: str = ""
    feedback: str = Field(min_length=1)


class HologramResponse(BaseModel):
    session_id: UUID
    slide_id: str
    hologram_image: str
    summary: str


class PromptCompilerResponse(BaseModel):
    can_apply: bool
    image_prompt: str
    summary: str
    rejection_reason: str


def normalize_image_data(slide_image: str) -> str:
    """Accept a browser data URL, public URL, or raw base64 PNG string."""
    if slide_image.startswith(("data:image/", "http://", "https://")):
        return slide_image
    return f"data:image/png;base64,{slide_image}"


def diagnosis_json_schema() -> dict:
    change_schema = {
        "type": "object",
        "properties": {
            "issue": {"type": "string"},
            "evidence": {"type": "string"},
            "fix": {"type": "string"},
            "target_area": {"type": ["string", "null"]},
            "supported_action": {"type": ["string", "null"]},
        },
        "required": [
            "issue",
            "evidence",
            "fix",
            "target_area",
            "supported_action",
        ],
        "additionalProperties": False,
    }

    return {
        "type": "object",
        "properties": {
            "coach_message": {
                "type": "string"
            },
            "problems": {
                "type": "array",
                "items": change_schema,
            },
            "additions": {
                "type": "array",
                "items": change_schema,
            },
        },
        "required": ["coach_message", "problems", "additions"],
        "additionalProperties": False,
    }


def sanitize_supported_actions(
    changes: list["DiagnosisChange"], allowed_actions: set[str]
) -> list["DiagnosisChange"]:
    """Never allow model output to invent an unsupported PowerPoint action."""
    for change in changes:
        if change.supported_action not in allowed_actions:
            change.supported_action = None
    return changes


def call_openrouter_diagnosis(
    request: "DiagnoseRequest",
    previous_slide_context: list[dict],
) -> tuple[list["DiagnosisChange"], list["DiagnosisChange"]]:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPENROUTER_API_KEY is not configured",
        )

    supported_actions_text = (
        ", ".join(request.supported_actions)
        if request.supported_actions
        else "NONE"
    )

    previous_context_text = (
        json.dumps(previous_slide_context, ensure_ascii=False)
        if previous_slide_context
        else "No previous slides have been diagnosed in this presentation."
    )

    prompt = f"""
You are Visual Coach, an assistant reviewing one presentation slide.

User goal:
{request.user_request}

Supported presentation-editing actions for this prototype:
{supported_actions_text}

Previous slide diagnosis context from the same presentation:
{previous_context_text}

Analyze only what is visibly supported by the supplied slide image.

Your job is to:
1. identify the most important visible design problems,
2. explain why they matter,
3. recommend practical improvements,
4. suggest useful additions when they would improve the message,
5. produce a concise user-facing coach_message,
6. also return the structured diagnosis required by the application.

The user-facing response should read like a short design coach note, not raw JSON or debugging information.

General rules:
- Recommend only changes that can be taught using the supplied supported actions.
- If no supplied supported action can implement a proposed finding, omit that finding entirely.
- Never include an unsupported finding merely to give general design advice.
- Do not invent presentation-editing capabilities.
- Analyze only what can reasonably be seen in the supplied slide image.
- Keep evidence concrete and tied to visible parts of the slide.
- Keep fixes practical and actionable.
- target_area should be a short visual description such as "top-left title", "lower half", or null.
- Use previous-slide context only when it genuinely helps maintain consistency across the presentation.
- Return problems for things that should be changed.
- Return additions only when adding something would genuinely improve the slide.
- Prioritize the 2 to 4 most important problems.
- Do not overwhelm the user with small or low-value issues.
- Prefer specific advice over vague advice.

Visual and image suggestions:
- Suggest adding an image when it would meaningfully improve the slide's message, balance, clarity, or visual interest.
- Do not suggest an image only because there is empty space.
- The image should support the slide's actual message.
- When suggesting an image, describe what kind of image would work and why.
- Be specific enough to guide the user.
- For example, prefer "a warm photo of people sharing a meal" over "add a picture".
- Prefer one strong supporting visual over several unnecessary images.
- If a user-sourced image should be added, use "insert_user_sourced_image" as supported_action.
- Do not suggest image insertion if "insert_user_sourced_image" is not in the supplied supported actions.
- The image suggestion does not need to match an exact generated image later; it should describe the useful visual direction.

Structured diagnosis rules:
- Each problem or addition must contain:
  - issue
  - evidence
  - fix
  - target_area
  - supported_action
- issue should clearly describe one problem.
- evidence should explain what is visibly causing that problem.
- fix should explain what should change.
- supported_action must match one of the supplied supported actions, or be null.
- Do not combine several unrelated problems into one structured item.

coach_message rules:
- coach_message is the only diagnosis text shown directly to the user.
- Write coach_message in clear CEFR B1 / intermediate English.
- Use common words and short, clear sentences.
- Keep the tone helpful, direct, and practical.
- Do not sound overly formal or technical.
- Give enough detail to be useful; do not make the response too short.

Structure coach_message exactly like this:

1. Start with 1 to 2 short sentences giving an overall summary of the slide.
   - Mention what works when relevant.
   - Mention what feels weak, unclear, unbalanced, or unfinished.

2. Then include the Markdown heading:

**Main problems**

3. Under **Main problems**, list 2 to 4 short bullet points.
   - Put the most important problem first.
   - Each bullet should describe one clear problem.
   - Make the problems specific to the visible slide.

4. Then include the Markdown heading:

**What I would change**

5. Under **What I would change**, write 2 to 4 short sentences.
   - Explain the best next changes.
   - Give concrete design advice.
   - When useful, suggest a specific type of image or visual.
   - Explain enough for the user to understand the intended direction.

Formatting rules for coach_message:
- Use **bold Markdown** only for important phrases or key changes.
- Do not bold entire paragraphs.
- Do not use technical design jargon unless necessary.
- Do not include internal field names such as supported_action or target_area.
- Do not mention JSON, schemas, APIs, or prototype limitations.
- Do not repeat the structured diagnosis word-for-word.
- Keep the response readable inside a narrow side panel.

Example style:

Overall, the slide is clean, but it feels unfinished because the title is alone and there is little visual support.

**Main problems**
- The **title is too large**, so it takes most of the attention.
- There is **no visual example** supporting the main message.
- The lower part of the slide feels empty.

**What I would change**
Make the title slightly smaller and move it higher. Add **one strong image** that supports the topic, such as a warm photo of people sharing a meal. Keep the rest of the slide simple so the image strengthens the message without making it busy.

Do not copy the example wording. Base the response on the actual slide.
"""

    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": normalize_image_data(request.slide_image)},
                    },
                ],
            }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "visual_coach_diagnosis",
                "strict": True,
                "schema": diagnosis_json_schema(),
            },
        },
        "provider": {
            "require_parameters": True,
        },
        "plugins": [{"id": "response-healing"}],
    }

    try:
        response = requests.post(
            OPENROUTER_URL,
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
        parsed = json.loads(content)

        coach_message = str(parsed.get("coach_message", "")).strip()

        problems = [
            DiagnosisChange.model_validate(item)
            for item in parsed.get("problems", [])
        ]
        additions = [
            DiagnosisChange.model_validate(item)
            for item in parsed.get("additions", [])
        ]
    except (KeyError, IndexError, TypeError, ValueError, ValidationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="OpenRouter returned an invalid diagnosis response",
        ) from exc

    allowed_actions = set(request.supported_actions)
    return (
        coach_message,
        sanitize_supported_actions(problems, allowed_actions),
        sanitize_supported_actions(additions, allowed_actions),
    )


def prompt_compiler_json_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "can_apply": {"type": "boolean"},
            "image_prompt": {"type": "string"},
            "summary": {"type": "string"},
            "rejection_reason": {"type": "string"},
        },
        "required": [
            "can_apply",
            "image_prompt",
            "summary",
            "rejection_reason",
        ],
        "additionalProperties": False,
    }


def call_openrouter_prompt_compiler(
    diagnosis: dict,
    user_request: str,
    feedback: str | None = None,
) -> PromptCompilerResponse:
    """Compile an image-edit prompt without sending either source image to Luna."""
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPENROUTER_API_KEY is not configured",
        )

    revision_text = feedback if feedback is not None else "No revision feedback."
    prompt = f"""
You are the text-only prompt compiler for a presentation slide image editor.

Complete saved structured diagnosis:
{json.dumps(diagnosis, ensure_ascii=False)}

Canonical supported action definitions:
{json.dumps(SUPPORTED_ACTION_DEFINITIONS, ensure_ascii=False)}

Original user request:
{user_request}

Latest revision feedback:
{revision_text}

Decide whether the requested image edit can be expressed using only the diagnosed
changes and canonical supported actions. For a revision, reject feedback that asks
for any meaningful change outside those saved diagnosed changes. Never introduce
new facts, text, objects, branding, or imagery beyond the diagnosis.

If it is supported, set can_apply to true, write a precise image_prompt containing
only the allowed changes, provide a short user-facing summary, and use an empty
rejection_reason. If it is unsupported, set can_apply to false, leave image_prompt
and summary empty, and explain the constraint briefly in rejection_reason.
"""

    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [{"type": "text", "text": prompt}],
            }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "slide_image_prompt",
                "strict": True,
                "schema": prompt_compiler_json_schema(),
            },
        },
        "provider": {"require_parameters": True},
        "plugins": [{"id": "response-healing"}],
    }

    try:
        response = requests.post(
            OPENROUTER_URL,
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
            detail="Prompt compilation failed.",
        ) from exc

    if not response.ok:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Prompt compilation failed.",
        )

    try:
        content = response.json()["choices"][0]["message"]["content"]
        compiled = PromptCompilerResponse.model_validate_json(content)
        if compiled.can_apply and (
            not compiled.image_prompt.strip() or not compiled.summary.strip()
        ):
            raise ValueError("Accepted compiler response is incomplete")
        if not compiled.can_apply and not compiled.rejection_reason.strip():
            raise ValueError("Rejected compiler response has no reason")
    except (KeyError, IndexError, TypeError, ValueError, ValidationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Prompt compiler returned an invalid response.",
        ) from exc

    return compiled


def load_saved_diagnosis(session_id: UUID, slide_id: str) -> dict:
    """Load the exact persisted diagnosis after confirming the session exists."""
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT session_id
                    FROM coach_sessions
                    WHERE session_id = %s
                    """,
                    (session_id,),
                )
                if cur.fetchone() is None:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Unknown session_id",
                    )

                cur.execute(
                    """
                    SELECT diagnosis
                    FROM coach_slides
                    WHERE session_id = %s
                      AND slide_id = %s
                      AND diagnosis IS NOT NULL
                    """,
                    (session_id, slide_id),
                )
                row = cur.fetchone()
    except HTTPException:
        raise
    except psycopg.Error as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database error while loading diagnosis.",
        ) from exc

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Diagnose this slide before generating an edited version.",
        )

    diagnosis = row["diagnosis"]
    changes = diagnosis.get("problems", []) + diagnosis.get("additions", [])
    if any(change.get("supported_action") is None for change in changes):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The saved diagnosis contains an unsupported change.",
        )
    return diagnosis


def decode_image_data_url(data_url: str, filename: str) -> io.BytesIO:
    header, separator, encoded = data_url.partition(",")
    if (
        separator != ","
        or not header.startswith("data:image/")
        or not header.endswith(";base64")
        or not encoded
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image data URL.",
        )
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image data URL.",
        ) from exc
    if not image_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image data URL.",
        )

    image = io.BytesIO(image_bytes)
    image.name = filename
    return image


def generate_hologram_image(prompt: str, images: list[io.BytesIO]) -> str:
    try:
        response = OpenAI(api_key=os.getenv("OPENAI_API_KEY")).images.edit(
            model=os.getenv("OPENAI_IMAGE_MODEL", "gpt-image-2.5-flare"),
            image=images,
            prompt=prompt,
            quality=os.getenv("OPENAI_IMAGE_QUALITY", "medium"),
            output_format="png",
        )
        encoded = response.data[0].b64_json
        if not isinstance(encoded, str) or not encoded:
            raise ValueError("Image response did not contain b64_json")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Image generation failed.",
        ) from exc
    return f"data:image/png;base64,{encoded}"


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"status": "Visual Coach backend running"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/teach/sample", response_model=TeachingResponse)
def teach_sample(request: TeachingSampleRequest) -> TeachingResponse:
    original_image_path, approved_image_path = get_sample_image_paths(request.sample_id)
    return generate_teaching_plan(
        original_image_path,
        approved_image_path,
        model=OPENROUTER_MODEL,
        openrouter_url=OPENROUTER_URL,
    )


@app.post("/session", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
def create_session() -> SessionResponse:
    session_id = uuid4()

    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO coach_sessions (session_id)
                    VALUES (%s)
                    """,
                    (session_id,),
                )
    except psycopg.Error as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database error while creating session: {exc}",
        ) from exc

    return SessionResponse(session_id=session_id)


@app.post("/diagnose", response_model=DiagnoseResponse)
def diagnose(request: DiagnoseRequest) -> DiagnoseResponse:
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT session_id
                    FROM coach_sessions
                    WHERE session_id = %s
                    """,
                    (request.session_id,),
                )

                if cur.fetchone() is None:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Unknown session_id",
                    )

                cur.execute(
                    """
                    SELECT slide_id, diagnosis
                    FROM coach_slides
                    WHERE session_id = %s
                      AND slide_id <> %s
                      AND diagnosis IS NOT NULL
                    ORDER BY updated_at DESC
                    LIMIT 5
                    """,
                    (request.session_id, request.slide_id),
                )
                previous_slide_context = list(cur.fetchall())

    except HTTPException:
        raise
    except psycopg.Error as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database error while loading session context: {exc}",
        ) from exc

    coach_message, problems, additions = call_openrouter_diagnosis(
        request,
        previous_slide_context=previous_slide_context,
    )

    diagnosis = DiagnoseResponse(
        session_id=request.session_id,
        slide_id=request.slide_id,
        coach_message=coach_message,
        problems=problems,
        additions=additions,
    )

    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO coach_slides (
                        session_id,
                        slide_id,
                        diagnosis,
                        updated_at
                    )
                    VALUES (%s, %s, %s, NOW())
                    ON CONFLICT (session_id, slide_id)
                    DO UPDATE SET
                        diagnosis = EXCLUDED.diagnosis,
                        updated_at = NOW()
                    """,
                    (
                        request.session_id,
                        request.slide_id,
                        Jsonb(diagnosis.model_dump(mode="json")),
                    ),
                )
    except psycopg.Error as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Database error while saving diagnosis: {exc}",
        ) from exc

    return diagnosis
@app.post("/hologram", response_model=HologramResponse)
def create_hologram(request: HologramRequest) -> HologramResponse:
    diagnosis = load_saved_diagnosis(request.session_id, request.slide_id)
    original_image = decode_image_data_url(request.slide_image, "original-slide.png")
    compiled = call_openrouter_prompt_compiler(
        diagnosis=diagnosis,
        user_request=request.user_request,
    )
    if not compiled.can_apply:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=compiled.rejection_reason,
        )

    return HologramResponse(
        session_id=request.session_id,
        slide_id=request.slide_id,
        hologram_image=generate_hologram_image(
            prompt=compiled.image_prompt,
            images=[original_image],
        ),
        summary=compiled.summary,
    )


@app.post("/revise-hologram", response_model=HologramResponse)
def revise_hologram(request: ReviseHologramRequest) -> HologramResponse:
    if not request.current_hologram:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No generated image is available to revise.",
        )

    diagnosis = load_saved_diagnosis(request.session_id, request.slide_id)
    current_image = decode_image_data_url(
        request.current_hologram,
        "current-hologram.png",
    )
    original_image = decode_image_data_url(request.slide_image, "original-slide.png")
    compiled = call_openrouter_prompt_compiler(
        diagnosis=diagnosis,
        user_request=request.user_request,
        feedback=request.feedback,
    )
    if not compiled.can_apply:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=compiled.rejection_reason,
        )

    return HologramResponse(
        session_id=request.session_id,
        slide_id=request.slide_id,
        hologram_image=generate_hologram_image(
            prompt=compiled.image_prompt,
            images=[current_image, original_image],
        ),
        summary=compiled.summary,
    )

