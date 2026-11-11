pub mod memory;

pub trait Repo {
    fn get(&self, id: u32) -> Option<String>;
}
