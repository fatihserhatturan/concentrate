import os
from urllib.parse import urljoin

import aiohttp
import httpx
import requests
from requests import get as http_get

BASE = "http://localhost:8000"
ORDERS = "/api/orders"
session = requests.Session()


class Gateway:
    PREFIX = "/api"

    def __init__(self):
        self.client = httpx.Client(base_url=BASE)

    def product(self, product_id):
        return self.client.get(f"{self.PREFIX}/products/{product_id}")


def products():
    return requests.get(BASE + "/api/products", timeout=3)


def health():
    return http_get("http://localhost:8000/health")


def create():
    return session.post(f"{BASE}{ORDERS}", json={})


def update(order_id):
    return requests.request("PUT", "/api/orders/%s" % order_id)


def from_env():
    return httpx.get(os.environ["UPSTREAM_URL"] + "/api/products?limit=1")


def joined(item):
    return requests.delete(urljoin(BASE, "/api/products/{}".format(item)))


async def fetch_all():
    async with httpx.AsyncClient(base_url="http://localhost:8000") as client:
        await client.get("/api/products")
    async with aiohttp.ClientSession() as http:
        async with http.get("http://localhost:8000/api/products") as response:
            return await response.text()


def in_process(app):
    local = httpx.Client(app=app, base_url="http://testserver")
    return local.get("/api/products")


def unrelated(cache):
    return cache.get("key"), {}.get("x")
