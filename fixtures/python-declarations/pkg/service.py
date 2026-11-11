import functools

from flask import Flask

app = Flask(__name__)


class Service:
    limit = 3

    @staticmethod
    def make(name: str, *args, size: int = 3, **options) -> "Service":
        return Service()

    @classmethod
    def build(cls, config: dict[str, int] | None = None):
        return cls()

    @property
    def label(self) -> str:
        return "service"

    @functools.lru_cache(maxsize=8)
    def cached(self, key):
        return key

    async def fetch(self, url: str, /, retries=2, *, timeout: float = 1.5) -> bytes:
        return b""


@app.route("/health", methods=["GET"])
def health() -> dict:
    return {}


@functools.wraps(health)
@app.get("/x")
async def stacked(a, b: int = 1):
    return a
