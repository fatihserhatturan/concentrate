use clap::Command;

pub fn cli() -> Command {
    Command::new("builder")
        .subcommand(Command::new("build").about("Build it"))
        .subcommand(Command::new("clean"))
}

pub fn run() {
    let matches = cli().get_matches();
    match matches.subcommand() {
        Some(("build", _sub)) => build_project(),
        Some(("clean", _sub)) => clean_project(),
        _ => {}
    }
}

fn build_project() {}

fn clean_project() {}
