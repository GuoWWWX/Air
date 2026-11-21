use std::{net::Ipv4Addr, time::Duration};
use tokio::{io::copy_bidirectional, net::{TcpSocket, TcpStream}, task::{JoinHandle, JoinSet}, time::sleep};

#[cfg(all(windows, feature = "desktop"))]
use std::{
    collections::HashMap,
    net::{SocketAddr, SocketAddrV4},
    sync::{Arc, Mutex},
};

pub(super) const PREFERRED_PORT: u16 = 7890;

#[cfg(all(windows, feature = "desktop"))]
pub(super) type ClientMap = Arc<Mutex<HashMap<SocketAddrV4, SocketAddrV4>>>;

#[cfg(all(windows, feature = "desktop"))]
struct ForwardedClient {
    clients: ClientMap,
    socket: SocketAddrV4,
}

#[cfg(all(windows, feature = "desktop"))]
impl ForwardedClient {
    fn register(clients: ClientMap, upstream: &TcpStream, peer: SocketAddr) -> Option<Self> {
        let (SocketAddr::V4(socket), SocketAddr::V4(original)) =
            (upstream.local_addr().ok()?, peer)
        else {
            return None;
        };
        clients.lock().ok()?.insert(socket, original);
        Some(Self { clients, socket })
    }
}

#[cfg(all(windows, feature = "desktop"))]
impl Drop for ForwardedClient {
    fn drop(&mut self) {
        if let Ok(mut clients) = self.clients.lock() {
            clients.remove(&self.socket);
        }
    }
}

pub(super) fn bind_loopback(port: u16) -> std::io::Result<TcpSocket> {
    // Windows may allow a service to bind a specific IPv4 address alongside a
    // dual-stack wildcard listener. Check from the desktop client's loopback first.
    let endpoint = (Ipv4Addr::LOCALHOST, port).into();
    let socket = TcpSocket::new_v4()?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawSocket;
        use windows_sys::Win32::Networking::WinSock::{setsockopt, SOL_SOCKET, SO_EXCLUSIVEADDRUSE};
        let exclusive: i32 = 1;
        let result = unsafe {
            setsockopt(socket.as_raw_socket() as _, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
                (&exclusive as *const i32).cast(), std::mem::size_of_val(&exclusive) as i32)
        };
        if result != 0 { return Err(std::io::Error::last_os_error()); }
    }
    socket.bind(endpoint)?;
    Ok(socket)
}

// Keep the active mixed port and established connections when another proxy releases 7890.
pub(super) struct Forwarder {
    task: JoinHandle<()>,
    #[cfg(all(windows, feature = "desktop"))]
    pub clients: ClientMap,
}

impl Forwarder {
    pub(super) fn start(port: u16, mixed_port: u16) -> Self {
        #[cfg(all(windows, feature = "desktop"))]
        let clients = ClientMap::default();
        #[cfg(all(windows, feature = "desktop"))]
        let forwarded = clients.clone();
        let task = tokio::spawn(async move {
            let listener = loop {
                if let Ok(listener) = bind_loopback(port).and_then(|socket| socket.listen(128)) {
                    break listener;
                }
                sleep(Duration::from_secs(1)).await;
            };
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    _ = connections.join_next(), if !connections.is_empty() => {}
                    incoming = listener.accept() => match incoming {
                        Ok((mut client, _peer)) => {
                            #[cfg(all(windows, feature = "desktop"))]
                            let forwarded = forwarded.clone();
                            connections.spawn(async move {
                                if let Ok(mut upstream) = TcpStream::connect((Ipv4Addr::LOCALHOST, mixed_port)).await {
                                    #[cfg(all(windows, feature = "desktop"))]
                                    let _client = ForwardedClient::register(forwarded, &upstream, _peer);
                                    let _ = copy_bidirectional(&mut client, &mut upstream).await;
                                }
                            });
                        }
                        Err(_) => sleep(Duration::from_secs(1)).await,
                    }
                }
            }
        });
        Self {
            task,
            #[cfg(all(windows, feature = "desktop"))]
            clients,
        }
    }
}

impl Drop for Forwarder {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, time::timeout};

    #[tokio::test]
    async fn accepts_new_connections_after_the_previous_owner_releases_the_port() {
        let previous = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let endpoint = previous.local_addr().unwrap();
        let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let forwarder = Forwarder::start(endpoint.port(), upstream.local_addr().unwrap().port());
        let client = TcpStream::connect(endpoint).await.unwrap();
        previous.accept().await.unwrap();
        drop(client);
        drop(previous);
        timeout(Duration::from_secs(5), async {
            let mut client = loop {
                if let Ok(client) = TcpStream::connect(endpoint).await { break client; }
                sleep(Duration::from_millis(50)).await;
            };
            let (mut server, _forwarded_peer) = upstream.accept().await.unwrap();
            client.write_all(b"request").await.unwrap();
            let mut buf = [0; 7];
            server.read_exact(&mut buf).await.unwrap();
            assert_eq!(&buf, b"request");
            #[cfg(all(windows, feature = "desktop"))]
            {
                let SocketAddr::V4(forwarded_peer) = _forwarded_peer else { unreachable!() };
                let SocketAddr::V4(original) = client.local_addr().unwrap() else { unreachable!() };
                assert_eq!(forwarder.clients.lock().unwrap().get(&forwarded_peer), Some(&original));
            }
            server.write_all(b"reply").await.unwrap();
            client.shutdown().await.unwrap();
            server.shutdown().await.unwrap();
            let mut response = Vec::new();
            client.read_to_end(&mut response).await.unwrap();
            assert_eq!(response, b"reply");
        }).await.unwrap();
        drop(forwarder);
    }
}
