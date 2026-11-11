from typing import Annotated

from fastapi import Depends, Header


def get_db():
    yield object()


def verify_key(x_key: str = Header()):
    return x_key


def rate_limit():
    return True


def require_admin(db=Depends(get_db)):
    return True


def current_user(db=Depends(get_db)):
    return {"id": 1}


CurrentUser = Annotated[dict, Depends(current_user)]
