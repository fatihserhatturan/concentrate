from typing import Annotated, Generator

from fastapi import Depends, FastAPI

app = FastAPI()


class Db:
    pass


class UserRepo:
    def __init__(self, db: Db):
        self.db = db


class UserService:
    def __init__(self, repo: "UserRepo" = Depends(lambda: None)):
        self.repo = repo


def get_db() -> Generator[Db, None, None]:
    yield Db()


def get_repo(db: Db = Depends(get_db)) -> UserRepo:
    return UserRepo(db)


def get_service(repo: UserRepo = Depends(get_repo)) -> UserService:
    return UserService(repo)


Service = Annotated[UserService, Depends(get_service)]


class Report:
    def __init__(self, service: UserService = Depends(get_service), db: Db = Depends(get_db)):
        self.service = service


@app.get("/users")
def users(service: Service) -> list:
    return []


@app.get("/handled")
def handled(repo: UserRepo = Depends(get_repo)) -> dict:
    return {}
