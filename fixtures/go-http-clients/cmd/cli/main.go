package main

import (
	"fmt"

	"example.com/shop/client"
)

func main() {
	if err := client.Health(); err != nil {
		fmt.Println(err)
	}
	_ = client.New().Product(1)
	_ = client.NewOrders().Items("7")
}
