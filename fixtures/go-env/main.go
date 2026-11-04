package main

import (
	"log"
	"os"

	"example.com/envapp/config"
	"example.com/envapp/server"
)

var mode = os.Getenv("APP_MODE")

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	if _, ok := os.LookupEnv("DEBUG"); ok {
		log.Println("debug", mode)
	}
	dsn := os.ExpandEnv("host=${DB_HOST} user=$DB_USER")
	log.Println(dsn, config.LogLevel())
	server.Run(cfg)
}
