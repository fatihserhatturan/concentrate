pub mod geometry;

pub const LIMIT: u32 = 10;
pub const UNUSED_LIMIT: u32 = 20;

pub enum Mode {
    Fast,
    Slow,
}

pub trait Plugin {
    fn run(&self);
}

pub struct Used;

pub struct Orphan;

pub type Alias = u32;

pub fn used_fn() -> u32 {
    internal() + helper_used_inside()
}

pub fn unused_fn() {}

pub(crate) fn internal() -> u32 {
    1
}

fn helper_used_inside() -> u32 {
    2
}

fn private_dead() {}

#[cfg(test)]
mod tests {
    #[test]
    fn works() {
        super::private_dead();
    }

    fn only_in_tests() {}
}
