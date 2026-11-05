package main

import (
	"fmt"

	"example.com/locals/config"
	"example.com/locals/store"
)

// A package variable of main's own package.
var local = store.New()

func main() {
	local.All()
	config.DB.Get("a")
	config.Default.All()
	// A call on a package variable's method result.
	local.Get("b").Label()

	// Ranges over a call's result, directly and through a local.
	for _, item := range local.All() {
		fmt.Println(item.Label())
	}
	byName := config.DB.ByName()
	for _, entry := range byName {
		fmt.Println(entry.Label())
	}
}
