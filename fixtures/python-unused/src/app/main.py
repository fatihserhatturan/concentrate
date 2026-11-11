from kit import used_fn
from kit.core import UsedClass, LIMIT
from kit.star import *
from kit import whole


def run():
    return used_fn() + LIMIT + len([UsedClass(), starred(), whole.via_module()])
