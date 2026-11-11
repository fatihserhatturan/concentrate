from __future__ import annotations

import os
import shop.models as m
import shop.utils
from typing import TYPE_CHECKING

from . import pricing
from .. import utils as helpers
from ..models import Order, Customer as Buyer
from shop.utils import *

if TYPE_CHECKING:
    from ..cli import main


def place_order(name):
    order = Order(Buyer(name), 10)
    return pricing.price(order) + len(slugify(name)) + len(os.sep)
