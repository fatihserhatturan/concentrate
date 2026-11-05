package config

// go-flags options: env-namespace joins the group names with "_".
type FlagOptions struct {
	Port  int        `long:"port" env:"SERVER_PORT"`
	Store StoreGroup `group:"store" namespace:"store" env-namespace:"STORE"`
	Image struct {
		Type string `long:"type" env:"TYPE"`
		FS   struct {
			Path string `long:"path" env:"PATH"`
		} `group:"fs" namespace:"fs" env-namespace:"FS"`
	} `group:"image" namespace:"image" env-namespace:"IMAGE"`
	Admin AdminRPCGroup `group:"admin" namespace:"admin" env-namespace:"ADMIN"`
}

type StoreGroup struct {
	Type string   `long:"type" env:"TYPE"`
	RPC  RPCGroup `group:"rpc" namespace:"rpc" env-namespace:"RPC"`
}

type RPCGroup struct {
	API string `long:"api" env:"API"`
}

// An embedded group's options keep the enclosing namespace.
type AdminRPCGroup struct {
	RPCGroup
	PerSite bool `long:"per_site" env:"PER_SITE"`
}
