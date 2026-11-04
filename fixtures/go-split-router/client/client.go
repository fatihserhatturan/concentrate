package client

import "net/http"

// Two routes differ only by the trailing slash: each URL reaches its own.
func Items() {
	_, _ = http.Get("http://localhost:1323/api/items")
	_, _ = http.Get("http://localhost:1323/api/items/")
}
