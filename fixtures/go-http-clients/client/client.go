package client

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path"
	"strings"
)

type Client struct {
	http    *http.Client
	baseURL string
}

func New() *Client {
	return &Client{http: &http.Client{}, baseURL: os.Getenv("SHOP_API_URL")}
}

// A literal URL on a local origin, and a package constant.
func Health() error {
	_, err := http.Get("http://localhost:8080/health?verbose=1")
	return err
}

// fmt.Sprintf with a dynamic id, on a *http.Client field.
func (c *Client) Product(id int) error {
	_, err := c.http.Get(fmt.Sprintf("/api/products/%d", id))
	return err
}

// NewRequestWithContext with a method constant and a package variable
// declared in another file.
func (c *Client) CreateProduct(ctx context.Context, body string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, productsPath, strings.NewReader(body))
	if err != nil {
		return err
	}
	_, err = c.http.Do(req)
	return err
}

// NewRequest with a literal method and path.Join.
func DeleteProduct(id string) error {
	req, _ := http.NewRequest("DELETE", path.Join(Prefix, "products", id), nil)
	_, err := http.DefaultClient.Do(req)
	return err
}

// The env base URL joined with a constant.
func Products() error {
	_, err := http.Get(os.Getenv("SHOP_API_URL") + "/products")
	return err
}

// A struct field base URL stays unresolved: not linked.
func (c *Client) Orders() error {
	_, err := c.http.Get(c.baseURL + "/orders")
	return err
}

// A Get on something that is not an HTTP client is not a request.
type cache struct{}

func (cache) Get(key string) string { return key }

func Lookup(c cache) string {
	return c.Get("/api/products")
}
