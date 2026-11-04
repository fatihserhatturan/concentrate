package client

import (
	"github.com/go-resty/resty/v2"
)

type Orders struct {
	api *resty.Client
}

func NewOrders() *Orders {
	return &Orders{api: resty.New().SetBaseURL("http://localhost:8080")}
}

func (o *Orders) Items(id string) error {
	_, err := o.api.R().SetPathParam("id", id).Get(ordersPath + "/" + id + "/items")
	return err
}

func (o *Orders) Update(id string, order any) error {
	req := o.api.R().SetBody(order)
	_, err := req.Put("/api/orders/" + id)
	return err
}

func Ping() error {
	client := resty.New()
	_, err := client.R().Execute(resty.MethodGet, "http://localhost:8080/health")
	return err
}
