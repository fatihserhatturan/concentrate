mod models;
mod services;
mod util;

use models::{Kind, User};
use services::repo::{self, Repo, SqlRepo};
use services::notifier::Notifier;
use util::helpers as h;

struct App {
    repo: SqlRepo,
    notifier: Box<dyn Notifier>,
}

impl App {
    fn new() -> Self {
        App { repo: SqlRepo::open(), notifier: Box::new(services::notifier::Email) }
    }

    fn run(&self, who: &User) {
        let found = self.repo.find(1);
        self.notify_all(who);
        self.notifier.send("hi");
        Self::log("run");
        h::shout("run");
        util::helpers::whisper("x");
        crate::util::helpers::whisper("y");
    }

    fn notify_all(&self, user: &User) {
        user.greet();
    }

    fn log(message: &str) {
        println!("{}", message);
    }
}

fn broadcast<N: Notifier>(n: &N) {
    n.send("all");
}

fn dynamic(n: &dyn Notifier) {
    n.send("dyn");
}

fn main() {
    let app = App::new();
    let user = User::new("ann");
    let made = User::try_new("bob").unwrap();
    let repo = repo::connect();
    let by_literal = User { name: String::new() };
    app.run(&user);
    made.greet();
    by_literal.greet();
    repo.find(2);
    Repo::find(&repo, 3);
    <SqlRepo as Repo>::find(&repo, 4);
    let kind = Kind::Admin(1);
    kind.label();
    Kind::default_label();
    broadcast(&services::notifier::Email);
    let closure = |x: u32| x + 1;
    closure(3);
    unknown_fn();
    Vec::<u8>::new();
    square!(3);
}

macro_rules! square {
    ($x:expr) => { $x * $x };
}
