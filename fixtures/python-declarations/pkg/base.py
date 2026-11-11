from abc import ABC, abstractmethod
from typing import Protocol


class Repository(ABC):
    @abstractmethod
    def save(self, item: str) -> None: ...

    @abstractmethod
    def load(self, key: str) -> str: ...

    def describe(self) -> str:
        return "repository"


class Greeter(Protocol):
    def greet(self, name: str) -> str: ...


class Plain:
    pass
