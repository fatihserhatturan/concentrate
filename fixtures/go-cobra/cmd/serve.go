package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

var serveCmd = &cobra.Command{
	Use:  "serve [flags]",
	RunE: runServe,
}

var versionCmd = &cobra.Command{
	Use: "version",
	Run: func(cmd *cobra.Command, args []string) {
		printVersion()
	},
}

func runServe(cmd *cobra.Command, args []string) error {
	return nil
}

func printVersion() {
	fmt.Println("1.0")
}

func newMigrateCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use: "migrate",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runServe(cmd, args)
		},
	}
	return cmd
}

var migrateCmd = newMigrateCmd()
