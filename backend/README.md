# AI Visual Coach backend

This FastAPI service currently creates application-owned coaching sessions and
returns mock diagnosis data. It does not call OpenAI, generate holograms, or
implement teaching plans.

## Run locally

From PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

`GET /health`:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

Response:

```json
{"status":"ok"}
```

Create a coaching session and keep its ID for the diagnosis request:

```powershell
$session = Invoke-RestMethod -Method Post http://127.0.0.1:8000/session
$session
```

Response:

```json
{"session_id":"0c81094d-4f2c-4e5e-a7b5-915a57a24c96"}
```

Request a mock diagnosis using that session ID:

```powershell
$body = @{
  session_id = $session.session_id
  user_request = "Make this slide clearer"
  slide_image = "data:image/png;base64,placeholder"
  supported_actions = @("change_font_size", "adjust_alignment")
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/diagnose `
  -ContentType "application/json" -Body $body
```

The mock response uses the first supplied supported action. If
`supported_actions` is empty, `supported_action` is `null`; the service never
invents an unsupported action.

## CORS

For unpacked Chrome-extension development, CORS allows all origins without
credentials when `CORS_ALLOWED_ORIGINS` is unset. For a deployed environment,
set a comma-separated allowlist of exact origins:

```powershell
$env:CORS_ALLOWED_ORIGINS = "chrome-extension://your-extension-id,https://your-frontend.example"
```

An explicitly empty `CORS_ALLOWED_ORIGINS` value allows no browser origins.
No `OPENAI_API_KEY` is needed or used for this milestone.

## Render

The existing `Dockerfile` already listens on Render's `PORT`. Set the service
root directory to `backend`, deploy with that Dockerfile, and configure
`CORS_ALLOWED_ORIGINS` with the production extension origin. Sessions are
stored only in process, so a restart or scale-out clears them; add durable
storage only when later milestones need persistent session metadata.

## Tests

```powershell
cd backend
python -m unittest discover -s tests -v
```
