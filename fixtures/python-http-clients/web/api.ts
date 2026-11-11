export async function loadProducts() {
  const response = await fetch("/api/products");
  return response.json();
}

export async function loadProduct(id: number) {
  return fetch(`/api/products/${id}`).then((r) => r.json());
}

export async function placeOrder(body: unknown) {
  return fetch("/api/orders", { method: "POST", body: JSON.stringify(body) });
}
