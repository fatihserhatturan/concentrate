from . import base
from .base import Greeter
from pkg import Repository
from .models import User


class SqlRepo(base.Repository):
    def save(self, item: str) -> None:
        return None

    def load(self, key: str) -> str:
        return key


class UserRepo(SqlRepo):
    pass


class Cache(Repository):
    def save(self, item):
        return None


class Loud:
    def greet(self, name: str) -> str:
        return name.upper()


class Quiet:
    def whisper(self, name: str) -> str:
        return name


class Mixed(base.Plain, Loud):
    pass


def welcome(greeter: Greeter, user: User) -> str:
    return greeter.greet(user.name)
