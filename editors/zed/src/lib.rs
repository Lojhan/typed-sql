use std::path::PathBuf;

use zed_extension_api::{self as zed, LanguageServerId, Result, Worktree, settings::LspSettings};

const DEVELOPMENT_SERVER: &str =
    "packages/language-server/dist/packages/language-server/src/server.js";
const INSTALLED_SERVER: &str =
    "node_modules/@typed-sql/language-server/dist/packages/language-server/src/server.js";

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

        if worktree
            .read_text_file("node_modules/@typed-sql/language-server/package.json")
            .is_ok()
        {
            let server = PathBuf::from(worktree.root_path()).join(INSTALLED_SERVER);
            return Ok(zed::Command {
                command: zed::node_binary_path()?,
                args: vec![server.to_string_lossy().into_owned(), "--stdio".to_string()],
                env,
            });
        }

        if let Some(command) = worktree.which("typed-sql-language-server") {
            return Ok(zed::Command {
                command,
                args: vec!["--stdio".to_string()],
                env,
            });
        }

        if worktree
            .read_text_file("packages/language-server/package.json")
            .is_err()
        {
            return Err(
                "typed-sql language server was not found; run `pnpm add -D @typed-sql/language-server@next`, or configure lsp.typed-sql.binary.path"
                    .to_string(),
            );
        }

        let server = PathBuf::from(worktree.root_path()).join(DEVELOPMENT_SERVER);
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![server.to_string_lossy().into_owned(), "--stdio".to_string()],
            env,
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        Ok(LspSettings::for_worktree(language_server_id.as_ref(), worktree)?.settings)
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
