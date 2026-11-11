import enum
from collections import namedtuple
from dataclasses import dataclass, field
from typing import ClassVar, NamedTuple, TypedDict

import attr
from pydantic import BaseModel

VERSION = "1.0"
DEFAULT_LIMIT: int = 10
registry = {}
_private = None


@dataclass(frozen=True)
class User:
    name: str
    age: int = 0
    tags: list = field(default_factory=list)
    count: ClassVar[int] = 0


class Point(NamedTuple):
    x: float
    y: float = 0.0


class Movie(TypedDict):
    title: str
    year: int


@attr.s
class Legacy:
    name = attr.ib()
    size: int = attr.ib(default=1)


class Item(BaseModel):
    sku: str
    price: float = 0.0


class Color(enum.Enum):
    RED = 1
    BLUE = 2


Pair = namedtuple("Pair", ["a", "b"])
