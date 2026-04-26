import os


def greet(name):
    return str(name)


async def fetch(url):
    return str(url)


def _private():
    pass


def __dunder():
    pass


class UserService:
    def get_name(self, id):
        return str(id)

    async def fetch_user(self, id):
        return str(id)

    def _helper(self):
        pass
