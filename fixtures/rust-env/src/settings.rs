use config::{Config, Environment};
use serde::Deserialize;

#[derive(Deserialize)]
struct Server {
    host: String,
    #[serde(rename = "listen_port")]
    port: u16,
}

#[derive(Deserialize)]
struct Settings {
    server: Server,
    log_level: String,
}

pub fn load() -> Settings {
    let cfg = Config::builder()
        .add_source(Environment::with_prefix("APP").separator("__"))
        .build()
        .unwrap();
    let _level = cfg.get_string("log_level");
    cfg.try_deserialize::<Settings>().unwrap()
}

#[derive(Deserialize)]
struct Worker {
    queue_name: String,
    #[serde(rename = "MAX_JOBS")]
    max: u32,
}

pub fn worker() -> Worker {
    let w: Worker = envy::prefixed("WORKER_").from_env().unwrap();
    w
}
