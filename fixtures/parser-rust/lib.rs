pub struct UserService {
    name: String,
}

struct Internal;

impl UserService {
    pub fn new(name: String) -> Self {
        UserService { name }
    }

    pub async fn fetch(&self, id: String) -> String {
        format!("{}-{}", self.name, id)
    }

    fn helper(&self) -> String {
        self.name.clone()
    }
}

pub fn create(name: String) -> UserService {
    UserService::new(name)
}

async fn process(id: String) -> String {
    format!("{}", id)
}

fn internal() {}
