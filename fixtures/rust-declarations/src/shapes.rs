use std::fmt::Display;

pub trait Shape: Display {
    fn area(&self) -> f64;
    fn name(&self) -> String {
        String::from("shape")
    }
}

pub trait Scalable<T> {
    fn scale(&mut self, by: T);
}

#[derive(Debug, Clone, PartialEq)]
pub struct Circle {
    pub radius: f64,
}

#[derive(Debug)]
pub struct Meters(pub f64, u8);

pub struct Wrapper<T> {
    inner: T,
}

#[derive(Debug, Clone, Copy)]
#[repr(u8)]
pub enum Kind {
    Round,
    Square { side: f64 },
    Other(u8),
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        3.14 * self.radius * self.radius
    }
}

impl Display for Circle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "circle")
    }
}

impl Scalable<f64> for Circle {
    fn scale(&mut self, by: f64) {
        self.radius *= by;
    }
}

impl<T> Wrapper<T> {
    pub fn new(inner: T) -> Self {
        Wrapper { inner }
    }

    pub fn into_inner(self) -> T {
        self.inner
    }
}

impl Kind {
    pub fn is_round(&self) -> bool {
        matches!(self, Kind::Round)
    }
}
