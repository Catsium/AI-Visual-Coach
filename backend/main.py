import os
from datetime import datetime, timezone
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


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
    problems: list[DiagnosisChange]
    additions: list[DiagnosisChange]


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# This milestone intentionally keeps coaching sessions in one application process.
sessions: dict[UUID, datetime] = {}


@app.get("/")
def root():
    return {"status": "Visual Coach backend running"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/session", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
def create_session() -> SessionResponse:
    session_id = uuid4()
    sessions[session_id] = datetime.now(timezone.utc)
    return SessionResponse(session_id=session_id)


@app.post("/diagnose", response_model=DiagnoseResponse)
def diagnose(request: DiagnoseRequest) -> DiagnoseResponse:
    if request.session_id not in sessions:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Unknown session_id")

    supported_action = request.supported_actions[0] if request.supported_actions else None
    fix = (
        "Use the extension's supported action to improve clarity."
        if supported_action is not None
        else "Review the title and primary content to make their hierarchy clearer."
    )

    return DiagnoseResponse(
        session_id=request.session_id,
        problems=[
            DiagnosisChange(
                issue="Visual hierarchy needs review",
                evidence="Mock diagnosis: image analysis is not enabled in this milestone.",
                fix=fix,
                target_area="top-center",
                supported_action=supported_action,
            )
        ],
        additions=[],
    )
