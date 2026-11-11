import shop.util
import shop.util as helpers
from shop import Repository, MemoryRepo
from shop.util import slugify as slug, make_repo
from .. import util
from ..repo import AuditedRepo

default_repo = MemoryRepo()
typed_repo: Repository = AuditedRepo()


class OrderService:
    repo: Repository

    def __init__(self, repo: Repository):
        self.repo = repo
        self.audit = AuditedRepo()

    def place(self, name: str, other: Repository | None = None):
        label = slug(name)
        self.repo.save(label)
        self.audit.log(label)
        self.helper(label)
        local = MemoryRepo()
        local.save(label)
        made = make_repo()
        made.save(label)
        other.save_all([name])
        helpers.slugify(name)
        shop.util.slugify(name)
        util.slugify(name)
        default_repo.save(label)
        typed_repo.save(label)
        self.missing(label)
        unknown(label)
        return len(label)

    def helper(self, value):
        return OrderService.static_helper(value)

    @staticmethod
    def static_helper(value):
        return value

    @classmethod
    def create(cls):
        return cls.static_helper(1)


def run():
    service = OrderService(MemoryRepo())
    service.place("a")
    return service
