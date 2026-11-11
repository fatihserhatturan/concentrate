from starlette.applications import Starlette
from starlette.endpoints import HTTPEndpoint
from starlette.responses import PlainTextResponse
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.staticfiles import StaticFiles

from api_routes import api_routes


async def homepage(request):
    return PlainTextResponse("home")


class UserEndpoint(HTTPEndpoint):
    async def get(self, request):
        return PlainTextResponse("user")

    async def delete(self, request):
        return PlainTextResponse("deleted")


async def ws(websocket):
    await websocket.accept()


routes = [
    Route("/", homepage),
    Route("/users/{name}", UserEndpoint),
    Mount("/api", routes=api_routes),
    Mount("/static", StaticFiles(directory="static")),
    WebSocketRoute("/ws", ws),
]

app = Starlette(routes=routes)
