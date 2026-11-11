mod commands;

use clap::{Args, Parser, Subcommand};

#[derive(Parser)]
#[command(name = "tool", version)]
struct Cli {
    #[arg(short, long)]
    verbose: bool,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run the server.
    Serve {
        #[arg(long)]
        port: u16,
    },
    RunMigrations(MigrateArgs),
    Db(DbArgs),
    #[command(name = "version-info")]
    Version,
}

#[derive(Args)]
struct MigrateArgs {
    dry_run: bool,
}

#[derive(Args)]
struct DbArgs {
    #[command(subcommand)]
    action: DbCommands,
}

#[derive(Subcommand)]
enum DbCommands {
    Reset,
    Seed { count: u32 },
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::Serve { port } => commands::serve(port),
        Commands::RunMigrations(args) => commands::migrate(args.dry_run),
        Commands::Db(db) => match db.action {
            DbCommands::Reset => commands::reset(),
            DbCommands::Seed { count } => commands::seed(count),
        },
        Commands::Version => println!("1.0"),
    }
}
