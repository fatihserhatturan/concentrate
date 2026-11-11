mod config;

use my_core::prelude::*;
use my_core::{InMemory, store::memory, net::client::connect as open};
use core_alias::util::shout;
use config::Settings;
use serde::Serialize;
use std::collections::HashMap;

fn main() {
    let _ = open();
    let _ = (InMemory, memory::MemoryRepo, shout("a"), Settings, HashMap::<u8, u8>::new());
}
