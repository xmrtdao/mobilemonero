//! XMRT DAO Gossipsub Mesh Node - libp2p v0.55
use libp2p::{
    gossipsub::{self, Message, MessageId, Topic},
    identity::Keypair,
    mdns::tokio,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, Transport, PeerId, Swarm,
};
use log::{info, warn, error};
use serde::{Deserialize, Serialize};
use std::{collections::hash_map::DefaultHasher, hash::{Hash, Hasher}, time::Duration};
use tokio::{io, io::AsyncBufReadExt, time, sync::mpsc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshMessage {
    pub agent: String,
    pub message_type: String,
    pub payload: serde_json::Value,
    pub timestamp: u64,
}

#[derive(NetworkBehaviour)]
struct XMRTMeshBehaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: tokio::Behaviour,
}

fn message_id(msg: &Message) -> MessageId {
    let mut hasher = DefaultHasher::new();
    msg.data.hash(&mut hasher);
    MessageId::from(hasher.finish().to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::init();

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(run())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let local_key = Keypair::generate_ed25519();
    let local_peer_id = PeerId::from(local_key.public());
    info!("Local peer id: {}", local_peer_id);

    // TCP Transport
    let transport = tcp::tokio::Transport::new(tcp::Config::default())
        .upgrade(libp2p::core::upgrade::Version::V1Lazy)
        .authenticate(libp2p::noise::Config::new(&local_key)?)
        .multiplex(libp2p::yamux::Config::default())
        .boxed();

    // Gossipsub Config
    let gossipsub_config = gossipsub::ConfigBuilder::default()
        .heartbeat_interval(Duration::from_secs(10))
        .validation_mode(gossipsub::ValidationMode::Strict)
        .message_id_fn(message_id)
        .build()?;

    let mut gossipsub = gossipsub::Behaviour::new(
        gossipsub::MessageAuthenticity::Signed(local_key.clone()),
        gossipsub_config,
    )?;

    // Subscribe to topics
    for topic_name in &["agent-heartbeat", "agent-tasks", "agent-discovery", "fleet-broadcast"] {
        let topic = Topic::new(topic_name.to_string());
        gossipsub.subscribe(&topic)?;
        info!("Subscribed to: {}", topic.hash());
    }

    let mdns = tokio::Behaviour::new(Default::default(), local_peer_id)?;
    let behaviour = XMRTMeshBehaviour { gossipsub, mdns };
    let swarm_config = libp2p::swarm::Config::with_tokio_executor()
        .with_idle_connection_timeout(Duration::from_secs(60));
    let mut swarm = Swarm::new(transport, behaviour, local_peer_id, swarm_config);

    swarm.listen_on("/ip4/0.0.0.0/tcp/0".parse()?)?;

    let args: Vec<String> = std::env::args().collect();
    let agent = args.get(1).map(|s| s.as_str()).unwrap_or("hermes");
    info!("XMRT Mesh Node starting as: {}", agent);

    // Channel for stdin
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    
    // Spawn stdin reader
    tokio::spawn(async move {
        let mut stdin = io::BufReader::new(io::stdin()).lines();
        while let Ok(Some(line)) = stdin.next_line().await {
            let _ = tx.send(line);
        }
    });

    // Send initial heartbeat
    time::sleep(Duration::from_secs(2)).await;
    let heartbeat = MeshMessage {
        agent: agent.to_string(),
        message_type: "heartbeat".to_string(),
        payload: serde_json::json!({"status": "alive"}),
        timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
    };
    let topic = Topic::new("agent-heartbeat");
    let data = serde_json::to_vec(&heartbeat)?;
    if let Err(e) = swarm.behaviour_mut().gossipsub.publish(topic, data) {
        warn!("Failed to send heartbeat: {}", e);
    }

    let mut heartbeat_interval = time::interval(Duration::from_secs(30));

    loop {
        tokio::select! {
            _ = heartbeat_interval.tick() => {
                let msg = MeshMessage {
                    agent: agent.to_string(),
                    message_type: "heartbeat".to_string(),
                    payload: serde_json::json!({"status": "alive", "ts": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()}),
                    timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
                };
                let topic = Topic::new("agent-heartbeat");
                if let Err(e) = swarm.behaviour_mut().gossipsub.publish(topic, serde_json::to_vec(&msg)?) {
                    warn!("Heartbeat failed: {}", e);
                }
            }
            line = rx.recv() => {
                if let Some(line) = line {
                    let msg = MeshMessage {
                        agent: agent.to_string(),
                        message_type: "broadcast".to_string(),
                        payload: serde_json::json!({"text": line}),
                        timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
                    };
                    let topic = Topic::new("fleet-broadcast");
                    if let Err(e) = swarm.behaviour_mut().gossipsub.publish(topic, serde_json::to_vec(&msg)?) {
                        error!("Publish failed: {}", e);
                    } else {
                        info!("Published: {}", line);
                    }
                }
            }
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } => info!("Listening on: {}", address),
                    SwarmEvent::ConnectionEstablished { peer_id, .. } => info!("Connected: {}", peer_id),
                    SwarmEvent::Behaviour(XMRTMeshBehaviourEvent::Gossipsub(gossipsub::Event::Message { message, .. })) => {
                        info!("Received: {}", String::from_utf8_lossy(&message.data));
                    }
                    SwarmEvent::Behaviour(XMRTMeshBehaviourEvent::Mdns(mdns_event)) => {
                        if let tokio::Event::Discovered(list) = mdns_event {
                            for (peer_id, addr) in list {
                                info!("mDNS discovered: {} via {}", peer_id, addr);
                                swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}
