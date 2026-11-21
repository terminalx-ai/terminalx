//! A local HTTP server for the chat apps' tests (PRO-481): it records each
//! request and answers it as the test says, so a connector is run against the
//! services' own request and response shapes with nothing switched off in it.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

/// One request as it reached the server.
#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    /// The path with its query.
    pub path: String,
    /// Header names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).unwrap_or(serde_json::Value::Null)
    }
}

/// What the server answers: a status, extra headers, and a body.
pub type Answer = (u16, Vec<(String, String)>, String);

pub struct Server {
    pub base: String,
    pub seen: Arc<Mutex<Vec<Request>>>,
}

impl Server {
    pub fn requests(&self) -> Vec<Request> {
        self.seen.lock().unwrap().clone()
    }
}

pub fn serve(answer: impl Fn(&Request) -> Answer + Send + Sync + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let answer = Arc::new(answer);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (log, answer) = (log.clone(), answer.clone());
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_owned();
                let path = parts.next().unwrap_or_default().to_owned();
                let mut headers = Vec::new();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        let name = name.trim().to_ascii_lowercase();
                        if name == "content-length" {
                            length = value.trim().parse().unwrap_or(0);
                        }
                        headers.push((name, value.trim().to_owned()));
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let request = Request { method, path, headers, body: String::from_utf8_lossy(&body).into_owned() };
                let (status, extra, reply) = answer(&request);
                log.lock().unwrap().push(request);
                let extra: String = extra.iter().map(|(name, value)| format!("{name}: {value}\r\n")).collect();
                let head = format!("HTTP/1.1 {status} Answer\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n", reply.len());
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(reply.as_bytes());
            });
        }
    });
    Server { base, seen }
}
