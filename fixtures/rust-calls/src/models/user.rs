pub struct User {
    pub name: String,
}

impl User {
    pub fn new(name: &str) -> Self {
        User { name: name.to_string() }
    }

    pub fn try_new(name: &str) -> Result<Self, String> {
        Ok(Self::new(name))
    }

    pub fn greet(&self) -> String {
        self.shout_name()
    }

    fn shout_name(&self) -> String {
        crate::util::helpers::shout(&self.name)
    }
}
