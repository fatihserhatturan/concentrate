import os
from good import fine

LIMIT = = 3


def before():
    return fine()


def broken():
    x = = 1
    return x


class After:
    def kept(self):
        return os.sep

    def bad(self):
        return = 1

    def also_kept(self):
        return 2
