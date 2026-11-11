from fastapi import Depends, FastAPI

from .deps import rate_limit, verify_key
from .routers import items, users

app = FastAPI(dependencies=[Depends(verify_key)])
app.include_router(users.router, prefix="/api/v1")
app.include_router(items.router, prefix="/v1", dependencies=[Depends(rate_limit)])


@app.get("/health")
def health():
    return {"ok": True}


def ping():
    return "pong"


app.add_api_route("/ping", ping, methods=["GET"])
