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

// viper.Unmarshal fills the struct from the keys AutomaticEnv reads.
type Settings struct {
	Port    int `mapstructure:"port"`
	Timeout string
	Ignored string `mapstructure:"-"`
}

func Load() (settings Settings, err error) {
	err = viper.Unmarshal(&settings)
	return
}
