import pytest

from shop.services.orders import OrderService


@pytest.fixture
def service():
    return OrderService(None)


def make_helper():
    return 1
