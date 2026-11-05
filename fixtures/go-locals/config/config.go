package config

import "example.com/locals/store"

// Package variables of another package: a constructor's result and a
// declared type.
var DB = store.New()

var Default *store.Store
