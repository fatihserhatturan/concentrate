package service

import (
	"go.uber.org/fx"

	"example.com/fxapp/store"
)

type Users struct {
	store store.UserStore
	audit *store.AuditLog
}

// NewUsers takes the interface (bound to sqlUserStore) and the audit log.
func NewUsers(users store.UserStore, audit *store.AuditLog) *Users {
	return &Users{store: users, audit: audit}
}

type MailerParams struct {
	fx.In

	Users *Users
	Audit *store.AuditLog `optional:"true"`
}

type Mailer struct{}

// fx.In: each field is a dependency.
func NewMailer(p MailerParams) *Mailer { return &Mailer{} }

// A provider nobody registers is not linked.
type Unused struct{}

func NewUnused(users *Users) *Unused { return &Unused{} }

var Module = fx.Module("service",
	fx.Provide(NewUsers, NewMailer),
)
