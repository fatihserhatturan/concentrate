pub mod shapes;
pub mod runtime;

#[cfg(test)]
mod tests;

pub type Id = u64;
pub type Pair<T> = (T, T);

pub const MAX_SIDES: usize = 12;
pub static GREETING: &str = "hello";
const PRIVATE_LIMIT: u32 = 3;

macro_rules! square {
    ($x:expr) => { $x * $x };
}

#[macro_export]
macro_rules! double {
    ($x:expr) => { $x + $x };
}

pub fn area_of_square(side: f64) -> f64 {
    square!(side)
}

pub fn largest<T: PartialOrd + Copy>(items: &[T]) -> Option<T> {
    items.first().copied()
}

#[cfg(test)]
mod inline_tests {
    use super::*;

    fn make() -> f64 { 2.0 }

    #[test]
    fn squares() {
        assert_eq!(area_of_square(make()), 4.0);
    }

    #[bench]
    fn bench_square() {}
}
