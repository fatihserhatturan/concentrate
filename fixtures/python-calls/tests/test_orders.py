import unittest

from shop.services.orders import run


def test_run():
    assert run()


class TestOrders:
    def test_place(self, service):
        assert service.place("x")

    def build(self):
        return 1


class OrderCase(unittest.TestCase):
    def setUp(self):
        self.service = run()

    def test_it(self):
        self.assertTrue(self.service)

    def helper(self):
        return 1
