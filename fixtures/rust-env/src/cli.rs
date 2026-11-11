use clap::{Arg, Parser};

#[derive(Parser)]
struct Cli {
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,
    #[arg(long, env)]
    worker_count: u32,
    #[arg(long)]
    plain: bool,
}

pub fn parse() -> Cli {
    Cli::parse()
}

pub fn builder() -> clap::Command {
    clap::Command::new("tool").arg(Arg::new("token").env("API_TOKEN"))
}
