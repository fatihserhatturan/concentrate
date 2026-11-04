package config

const DefaultName = "tool"

const (
	Version = `1.0`
	retries = 3
)

var Verbose, Debug = true, false

var Unused = "nobody reads this"

type Options struct{}
