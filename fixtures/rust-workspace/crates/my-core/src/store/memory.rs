use super::Repo;
use crate::util::shout;

pub struct MemoryRepo;

impl Repo for MemoryRepo {
    fn get(&self, id: u32) -> Option<String> {
        Some(shout(&id.to_string()))
    }
}
