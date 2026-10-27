use zed_extension_api::{self as zed, LanguageServerId, Result, Worktree, settings::LspSettings};

const LAUNCH_SERVER: &str = include_str!("launch-server.cjs");
const TYPED_SQL_PROTOCOL_VERSION: u64 = 1;
const TYPED_SQL_PROTOCOL_CAPABILITIES: [&str; 3] =
    ["analysis-identity", "diagnostic-fixes", "status"];

struct TypedSqlExtension;

impl zed::Extension for TypedSqlExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<zed::Command> {
        let lsp_settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        let configured_binary = lsp_settings.binary;
        let env = configured_binary
            .as_ref()
            .and_then(|binary| binary.env.clone())
            .into_iter()
            .flat_map(|env| env.into_iter())
            .collect();

        if let Some(path) = configured_binary
            .as_ref()
            .and_then(|binary| binary.path.clone())
        {
            return Ok(zed::Command {
                command: path,
                args: configured_binary
                    .and_then(|binary| binary.arguments)
                    .unwrap_or_else(|| vec!["--stdio".to_string()]),
                env,
            });
        }

        // Node's package resolver handles pnpm symlinks and hoisted workspace
        // installations that the worktree file API cannot necessarily read.
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                "--input-type=commonjs".to_string(),
                "--eval".to_string(),
                LAUNCH_SERVER.to_string(),
                worktree.root_path(),
                worktree
                    .which("typed-sql-language-server")
                    .unwrap_or_default(),
                "--stdio".to_string(),
            ],
            env,
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        let mut settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?
            .settings
            .unwrap_or_else(|| zed::serde_json::json!({}));
        let root = settings.as_object_mut().ok_or_else(|| {
            "typed-sql language-server settings must be a JSON object".to_string()
        })?;
        let target = match root.get_mut("typedSql") {
            Some(value) => value.as_object_mut().ok_or_else(|| {
                "typedSql language-server settings must be a JSON object".to_string()
            })?,
            None => root,
        };
        target.insert(
            "protocolVersion".to_string(),
            zed::serde_json::Value::from(TYPED_SQL_PROTOCOL_VERSION),
        );
        target.insert(
            "protocolCapabilities".to_string(),
            zed::serde_json::Value::Array(
                TYPED_SQL_PROTOCOL_CAPABILITIES
                    .iter()
                    .map(|capability| zed::serde_json::Value::from(*capability))
                    .collect(),
            ),
        );
        Ok(Some(settings))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree(language_server_id.as_ref(), worktree)?.settings)
    }
}

zed::register_extension!(TypedSqlExtension);
