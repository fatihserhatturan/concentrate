from fastapi import FastAPI

app = FastAPI()


@app.get("/api/products")
def products():
    return []


@app.get("/api/products/{product_id}")
def product(product_id: int):
    return {}


@app.post("/api/orders")
def create_order():
    return {}


@app.get("/health")
def health():
    return {"ok": True}


@app.put("/api/orders/{order_id}")
def update_order(order_id: int):
    return {}
