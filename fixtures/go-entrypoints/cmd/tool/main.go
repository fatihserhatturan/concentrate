package main

import (
	"fmt"

	"example.com/tool/config"
	"example.com/tool/mathx"
)

var verbose = false

func init() {
	verbose = config.Verbose
}

func main() {
	fmt.Println(mathx.Add(1, 2), config.DefaultName, verbose)
	Run()
}

// Run is exported but nothing imports package main.
func Run() {}
