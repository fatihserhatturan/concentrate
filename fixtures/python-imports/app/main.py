from . import utils
from ..core import thing
from pkg.module import exported
import pkg.nested as nested


def main():
    return utils.utility() + thing() + exported() + nested.value()
