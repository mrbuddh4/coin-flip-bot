"""
Coin Flip Randomness Service

A minimal FastAPI microservice that provides cryptographically secure
coin flip results (0 = creator wins, 1 = challenger wins) using Python's
`secrets` module (backed by the OS CSPRNG).

Environment variables:
  FLIP_SERVICE_API_KEY  Shared secret that callers must send in the
                        X-Api-Key header. Required — service will refuse
                        to start if unset.
  PORT                  TCP port to listen on (default: 8080).
"""

import os
import secrets
import sys
import logging

from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import JSONResponse
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
API_KEY: str = os.environ.get("FLIP_SERVICE_API_KEY", "")
PORT: int = int(os.environ.get("PORT", "8080"))

if not API_KEY:
    logger.error("FLIP_SERVICE_API_KEY environment variable is not set. Refusing to start.")
    sys.exit(1)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Coin Flip Service", docs_url=None, redoc_url=None)


def _check_api_key(x_api_key: str) -> None:
    """Constant-time comparison to prevent timing attacks."""
    if not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.post("/flip")
async def flip(x_api_key: str = Header(..., alias="x-api-key")) -> JSONResponse:
    """
    Return a cryptographically secure coin flip result.
    0 = creator wins, 1 = challenger wins.
    """
    _check_api_key(x_api_key)
    result = secrets.randbelow(2)
    logger.info("flip result=%d", result)
    return JSONResponse({"result": result})


@app.get("/health")
async def health() -> JSONResponse:
    """Liveness probe — no auth required."""
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, log_level="info")
