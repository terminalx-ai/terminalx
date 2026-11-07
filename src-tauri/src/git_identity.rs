use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
}

impl GitIdentity {
    pub fn valid(&self) -> bool {
        !self.name.trim().is_empty()
            && self.name.len() <= 200
            && !self
                .name
                .chars()
                .any(|c| c.is_control() || c == '<' || c == '>')
            && self.email.len() <= 254
            && self.email.split('@').count() == 2
            && self.email.split('@').all(|part| !part.is_empty())
            && !self
                .email
                .chars()
                .any(|c| c.is_control() || c.is_whitespace() || c == '<' || c == '>')
    }
}

