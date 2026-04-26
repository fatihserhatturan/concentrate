use crate::utils::format;
mod utils;

struct Service {
    name: String,
}

impl Service {
    fn new(name: String) -> Self {
        Self { name: format(name) }
    }

    fn run(&self) {
        println!("{}", self.name);
        self.helper();
    }

    fn helper(&self) {
        format(self.name.clone());
    }
}

fn make() {
    Service::new(String::new());
}

pub async fn fetch(id: String) {
    println!("{}", id);
}
