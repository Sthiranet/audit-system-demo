//! demo-director: everything that exists only for the presentation. It runs every party in one
//! process, in memory, and exposes the actions the UI calls. Reset rebuilds the network from scratch.

pub mod api;
pub mod views;
pub mod world;

pub use world::{DemoError, Shared, World, set_auto};
