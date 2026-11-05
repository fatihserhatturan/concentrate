package server

import (
	nethttp "net/http"

	"github.com/go-kratos/kratos/v2/transport/http"

	v1 "example.com/kr/api/v1"
	"example.com/kr/internal/service"
)

func audit(next nethttp.Handler) nethttp.Handler {
	return next
}

func health(ctx http.Context) error {
	return nil
}

func metrics(w nethttp.ResponseWriter, r *nethttp.Request) {}

func NewHTTPServer(greeter *service.GreeterService) *http.Server {
	srv := http.NewServer()
	srv.HandleFunc("/metrics", metrics)
	srv.HandlePrefix("/q/", nethttp.FileServer(nethttp.Dir(".")))
	admin := srv.Route("/admin").Group("/v1", audit)
	admin.GET("/health", health)
	admin.Handle("POST", "/reload", health, audit)
	v1.RegisterGreeterHTTPServer(srv, greeter)
	return srv
}
