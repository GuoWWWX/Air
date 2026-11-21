pub mod chains;
pub mod custom_groups;
pub mod mihomo;
pub mod monitoring;
pub mod network;
pub mod proxy;
pub mod routing;
pub mod storage;
pub mod subscriptions;

pub type AirResult<T> = Result<T, String>;
