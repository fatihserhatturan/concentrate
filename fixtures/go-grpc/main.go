package main

import (
	"net"

	"google.golang.org/grpc"

	"example.com/grpcapp/pb"
	"example.com/grpcapp/service"
)

func main() {
	lis, _ := net.Listen("tcp", ":50051")
	s := grpc.NewServer()
	pb.RegisterGreeterServer(s, service.New())
	s.Serve(lis)
}
