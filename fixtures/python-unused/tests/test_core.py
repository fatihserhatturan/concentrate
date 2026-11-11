from kit.core import only_in_tests


def test_it():
    assert only_in_tests()
