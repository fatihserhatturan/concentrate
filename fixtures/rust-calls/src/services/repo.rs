use crate::models::User;

pub trait Repo {
    fn find(&self, id: u32) -> Option<User>;
    fn count(&self) -> usize {
        0
    }
}

pub struct SqlRepo;

impl SqlRepo {
    pub fn open() -> Self {
        SqlRepo
    }
}

impl Repo for SqlRepo {
    fn find(&self, id: u32) -> Option<User> {
        let _ = self.count();
        None
    }
}

pub fn connect() -> SqlRepo {
    SqlRepo::open()
}
