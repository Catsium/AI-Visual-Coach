import json
import os
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError
import requests
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openrouter/free")


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
You are Visual Coach, an assistant reviewing one PowerPoint slide.

User goal:
{request.user_request}

Supported PowerPoint actions for this prototype:
{supported_actions_text}

Previous slide diagnosis context from the same presentation:
{previous_context_text}

Analyze only what is visibly supported by the supplied slide image.

Rules:
- Recommend only changes that can be taught using the supplied supported actions.
- If no supported action can implement a proposed change, set supported_action to null.
- Do not invent PowerPoint capabilities.
- Keep evidence concrete and tied to what is visible on the slide.
- Keep fixes concise and actionable.
- target_area should be a short visual description such as "top-left title" or null.
- Use previous-slide context only when it genuinely helps consistency across the presentation.
- Return problems for things that should be changed.
- Return additions only when adding something is genuinely useful.
- Prioritize the 1 to 3 changes that matter most. Do not overwhelm the user with minor issues.
- coach_message is the only user-facing diagnosis text.
- Write coach_message in CEFR B1 / intermediate English.
- Use common words, short sentences, and clear explanations.
- Keep it concise without removing useful design advice.
- Start with one short overall observation.
- Then use the Markdown heading **Main problems** followed by at most 3 short bullet points.
- Then use the Markdown heading **What I would change** followed by 1 to 3 short sentences.
- Use **bold Markdown** only for the most important words or changes.
- Do not use technical design jargon unless it is necessary.
- Do not include internal fields such as supported_action or target_area in coach_message.
- Do not repeat every structured diagnosis field inside coach_message.
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

