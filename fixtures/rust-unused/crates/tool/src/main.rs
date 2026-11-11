use kit::geometry;
use kit::{Mode, Used};

pub fn main_helper() {}

fn main() {
    let _ = kit::used_fn();
    let _ = geometry::area(1, 2);
    let _ = (Mode::Fast, Used, kit::LIMIT);
}
