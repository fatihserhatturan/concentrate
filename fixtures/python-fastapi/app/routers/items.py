from fastapi import APIRouter, WebSocket

router = APIRouter(prefix="/items")


@router.get("/{item_id}")
def read_item(item_id: int):
    return {"id": item_id}


@router.websocket("/ws")
async def items_ws(websocket: WebSocket):
    await websocket.accept()
