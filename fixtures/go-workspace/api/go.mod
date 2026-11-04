module example.com/api

go 1.22

require (
	example.com/store v0.0.0
	example.com/util v0.0.0
	github.com/lib/pq v1.10.9
)

replace example.com/util => ../util
