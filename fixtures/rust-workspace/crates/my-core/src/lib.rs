pub mod store;
pub mod net;
mod util;
#[path = "legacy/old_helpers.rs"]
mod old_helpers;

pub use store::{Repo, memory::MemoryRepo as InMemory};
pub use util::*;

pub mod prelude {
    pub use crate::store::Repo;
    pub use crate::net::client::*;
}

pub mod inline {
    pub mod deep;
    pub fn here() {}
}
