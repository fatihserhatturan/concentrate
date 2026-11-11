from abc import ABC, abstractmethod


class Repository(ABC):
    @abstractmethod
    def save(self, item: str) -> None: ...

    def save_all(self, items: list) -> int:
        for item in items:
            self.save(item)
        return len(items)


class MemoryRepo(Repository):
    def __init__(self):
        self.items = []

    def save(self, item: str) -> None:
        self.items.append(item)


class AuditedRepo(MemoryRepo):
    def save(self, item: str) -> None:
        super().save(item)
        self.log(item)

    def log(self, item):
        return item
