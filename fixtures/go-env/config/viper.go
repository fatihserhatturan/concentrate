package config

import (
	"strings"

	"github.com/spf13/viper"
)

func init() {
	viper.SetEnvPrefix("app")
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	viper.AutomaticEnv()
	viper.BindEnv("redis", "REDIS_ADDR")
}

func LogLevel() string {
	return viper.GetString("log.level")
}
