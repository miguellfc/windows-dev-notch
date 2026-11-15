//! Services shared by the main-process modules.

pub mod fs_atomic;
pub mod logger;
pub mod quit;
#[cfg(test)]
pub(crate) mod test_dir;
pub mod timers;
pub mod usage;
