from fastapi import FastAPI

app = FastAPI()

@app.get("/")
def root():
    return {"status": "Visual Coach backend running"}

@app.get("/health")
def health():
    return {"status": "ok"}