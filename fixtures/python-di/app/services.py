class Database:
    def __init__(self, url=None):
        self.url = url


class Repository:
    def __init__(self, db):
        self.db = db


class Mailer:
    def __init__(self, db):
        self.db = db


def make_mailer(db) -> Mailer:
    return Mailer(db)


class OrderService:
    def __init__(self, repo, mail=None, extra=None):
        self.repo = repo
