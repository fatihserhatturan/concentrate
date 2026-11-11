from shop.services.orders import place_order
from shop.services import pricing
import requests


def test_place_order():
    assert place_order("a") > 0
