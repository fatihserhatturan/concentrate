from starlette.responses import JSONResponse
from starlette.routing import Route


async def items(request):
    return JSONResponse([])


async def item(request):
    return JSONResponse({})


api_routes = [
    Route("/items", items, methods=["GET", "POST"]),
    Route("/items/{id:int}", item),
]
