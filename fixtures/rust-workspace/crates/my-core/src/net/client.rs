use self::inner::Wire;
use crate::{store::{self, Repo}, util};

mod inner {
    pub struct Wire;
    pub(super) fn tag() {}
    pub mod nested {
        use super::super::Connection;
        pub fn up() { let _ = Connection; }
    }
}

pub struct Connection;

pub fn connect() -> Wire {
    let _ = util::shout("x");
    let _: Option<&dyn Repo> = None;
    store::memory::MemoryRepo;
    inner::tag();
    Wire
}
