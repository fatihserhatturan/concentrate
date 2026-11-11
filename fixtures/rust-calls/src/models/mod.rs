pub mod user;

pub use user::User;

pub enum Kind {
    Admin(u8),
    Guest,
}

impl Kind {
    pub fn label(&self) -> &'static str {
        "kind"
    }

    pub fn default_label() -> &'static str {
        "guest"
    }
}
