package main

import (
	"fmt"
	"example.com/myapp/internal/service"
)

func main() {
	svc := service.New("hello")
	fmt.Println(svc)
}
