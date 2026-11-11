from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ..deps import current_user, get_db, require_admin

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/")
def list_users(db=Depends(get_db), q: str = Query(None)):
    return []


@router.post("/", dependencies=[Depends(require_admin)])
def create_user(user: dict, db=Depends(get_db)):
    return user


@router.get("/{user_id}")
async def read_user(user_id: int, me: Annotated[dict, Depends(current_user)]):
    return me
