LIMIT = 10
UNUSED_LIMIT = 20


def used_fn():
    return LIMIT


def unused_fn():
    return 1


def _private_dead():
    return 2


def only_in_tests():
    return 3


class UsedClass:
    pass


class OrphanClass:
    pass
