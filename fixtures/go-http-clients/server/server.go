package server

import "net/http"

func Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/products", listProducts)
	mux.HandleFunc("GET /api/products/{id}", getProduct)
	mux.HandleFunc("POST /api/products", createProduct)
	mux.HandleFunc("DELETE /api/products/{id}", deleteProduct)
	mux.HandleFunc("GET /api/orders/{id}/items", orderItems)
	mux.HandleFunc("PUT /api/orders/{id}", updateOrder)
	mux.HandleFunc("GET /health", health)
	return mux
}

func listProducts(w http.ResponseWriter, r *http.Request)  {}
func getProduct(w http.ResponseWriter, r *http.Request)    {}
func createProduct(w http.ResponseWriter, r *http.Request) {}
func deleteProduct(w http.ResponseWriter, r *http.Request) {}
func orderItems(w http.ResponseWriter, r *http.Request)    {}
func updateOrder(w http.ResponseWriter, r *http.Request)   {}
func health(w http.ResponseWriter, r *http.Request)        {}
