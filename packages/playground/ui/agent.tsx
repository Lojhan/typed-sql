import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./icon";
import type { State, Value } from "./types";
import "./agent.css";

interface Profile {
  id: string;
  name: string;
  protocol: string;
  command: string;
}
interface Conversation {
  id: string;
  title: string;
  profileId: string;
  status: "idle" | "running" | "failed" | "cancelled";
  messages: { id: string; role: string; text: string; createdAt: string }[];
  proposals: {
    id: string;
    file: string;
    before: string | null;
    after: string;
    revision: string | null;
    status: "pending" | "accepted" | "rejected";
    description: string;
  }[];
  error?: string;
  toolCalls?: {
    id: string;
    name: string;
    state: "running" | "completed" | "failed";
    createdAt: string;
    updatedAt: string;
  }[];
}
const toolLabels: Record<string, string> = {
  typed_sql_get_schema: "Get schema",
  typed_sql_get_object: "Inspect object",
  typed_sql_list_migrations: "List migrations",
  typed_sql_list_files: "List files",
  typed_sql_read_file: "Read file",
  typed_sql_analyze_sql: "Analyze SQL",
  typed_sql_query_readonly: "Query read only",
  typed_sql_get_result: "Get captured result",
  typed_sql_propose_file: "Propose file",
};
interface Agents {
  workspaceToolsAvailable?: boolean;
  profiles: Profile[];
  conversations: { id: string; title: string; profileId: string; updatedAt: string }[];
  configurationPath: string;
}
export function AgentPanel({
  state,
  source,
  onOpen,
  onChanged,
  onTrust,
}: {
  state: State;
  source?: { file: string; source: string; revision: string | null };
  result?: Value;
  onOpen: (file: string) => void;
  onChanged: (file: string) => void;
  onTrust: () => void;
}) {
  const [agents, setAgents] = useState<Agents | null>(null),
    [profile, setProfile] = useState(""),
    [conversation, setConversation] = useState<Conversation | null>(null),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [configure, setConfigure] = useState(false),
    [name, setName] = useState("Local agent"),
    [command, setCommand] = useState(""),
    [args, setArgs] = useState("[]"),
    [includeSource, setIncludeSource] = useState(true),
    [includeSchema, setIncludeSchema] = useState(false),
    [includeResult, setIncludeResult] = useState(false),
    [workspaceTools, setWorkspaceTools] = useState(false),
    [review, setReview] = useState<string | null>(null);
  const [resultRun, setResultRun] = useState("");
  useEffect(() => {
    if (!state.trusted || !agents?.workspaceToolsAvailable) setWorkspaceTools(false);
  }, [state.trusted, agents?.workspaceToolsAvailable]);
  const selectedRun = state.runs.find((run) => run.id === resultRun);
  const result = selectedRun?.results[0]?.value;
  const end = useRef<HTMLDivElement>(null);
  const selectionKey = `typed-sql-agent-selection-v1:${state.project.name}:${state.project.config}:${state.target ?? "offline"}`;
  const selectionVersion = useRef(0);
  const mounted = useRef(true);
  const trusted = useRef(state.trusted);
  trusted.current = state.trusted;
  const currentConversation = useRef(conversation?.id ?? "");
  currentConversation.current = conversation?.id ?? "";
  const persistSelection = useCallback(
    (profileId: string, conversationId = "") => {
      try {
        localStorage.setItem(selectionKey, JSON.stringify({ profileId, conversationId }));
      } catch {
        /* Browser storage can be disabled. */
      }
    },
    [selectionKey],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selectionVersion.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const next = await api<Agents>("agents");
    if (mounted.current) setAgents(next);
    return next;
  }, []);
  useEffect(() => {
    const request = ++selectionVersion.current;
    setConversation(null);
    void (async () => {
      const next = await refresh();
      if (!mounted.current || selectionVersion.current !== request) return;
      let saved: { profileId?: unknown; conversationId?: unknown } | null = null;
      try {
        saved = JSON.parse(localStorage.getItem(selectionKey) ?? "null");
      } catch {
        /* Ignore invalid browser state. */
      }
      const selectedProfile =
        next.profiles.find((item) => item.id === saved?.profileId)?.id ?? next.profiles[0]?.id ?? "";
      const selectedConversation = next.conversations.find(
        (item) => item.id === saved?.conversationId && item.profileId === selectedProfile,
      );
      setProfile(selectedProfile);
      persistSelection(selectedProfile, selectedConversation?.id);
      if (state.trusted && selectedConversation) {
        const restored = await api<Conversation>(
          `agents/conversation?id=${encodeURIComponent(selectedConversation.id)}`,
        );
        if (
          mounted.current &&
          trusted.current &&
          selectionVersion.current === request &&
          restored.id === selectedConversation.id &&
          restored.profileId === selectedProfile
        )
          setConversation(restored);
      }
    })().catch((error) => {
      if (mounted.current && selectionVersion.current === request) setError(error.message);
    });
    return () => {
      selectionVersion.current++;
    };
  }, [state.trusted, selectionKey, persistSelection, refresh]);
  useEffect(() => {
    if (!state.trusted || conversation?.status !== "running") return;
    let cancelled = false;
    const id = conversation.id,
      request = selectionVersion.current;
    const interval = setInterval(
      () =>
        void api<Conversation>(`agents/conversation?id=${encodeURIComponent(id)}`).then(
          (next) => {
            if (
              !cancelled &&
              mounted.current &&
              trusted.current &&
              selectionVersion.current === request &&
              currentConversation.current === id
            )
              setConversation(next);
          },
          (error) => {
            if (!cancelled && mounted.current && selectionVersion.current === request) setError(error.message);
          },
        ),
      700,
    );
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversation?.id, conversation?.status, state.trusted]);
  const lastMessage = conversation?.messages.at(-1)?.text;
  const activity = [
    ...(conversation?.toolCalls?.map((call) => `${call.id}:${call.state}`) ?? []),
    ...(conversation?.proposals.map((proposal) => `${proposal.id}:${proposal.status}`) ?? []),
  ].join("|");
  useEffect(() => {
    if (lastMessage || activity) end.current?.scrollIntoView({ block: "nearest" });
  }, [lastMessage, activity]);
  const pendingActions = useRef(0);
  const perform = async (fn: () => Promise<void>) => {
    pendingActions.current++;
    setBusy(true);
    setError("");
    let request = selectionVersion.current;
    try {
      const task = fn();
      request = selectionVersion.current;
      await task;
    } catch (error) {
      if (mounted.current && selectionVersion.current === request)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      pendingActions.current--;
      if (mounted.current) setBusy(pendingActions.current > 0);
    }
  };
  const create = async () => {
    if (!state.trusted) {
      onTrust();
      return;
    }
    const request = ++selectionVersion.current;
    const next = await api<Conversation>("agents/new", { profileId: profile });
    if (!mounted.current || selectionVersion.current !== request) return;
    setConversation(next);
    persistSelection(profile, next.id);
    await refresh();
    if (mounted.current && selectionVersion.current === request) return next;
  };
  const send = async () => {
    if (!message.trim()) return;
    if (!state.trusted) {
      onTrust();
      return;
    }
    const active = conversation && conversation.profileId === profile ? conversation : await create();
    if (!active) return;
    const request = selectionVersion.current;
    const submittedMessage = message;
    const context = {
      ...(includeSource && source?.revision ? { source } : {}),
      ...(includeSchema ? { schema: state.board } : {}),
      ...(includeResult && result !== undefined
        ? {
            result: {
              origin: {
                runId: selectedRun?.id,
                file: selectedRun?.file,
                sourceRevision: selectedRun?.sourceRevision,
                target: selectedRun?.target,
                schemaHash: selectedRun?.schemaHash,
              },
              value: result,
            },
          }
        : {}),
    };
    const next = await api<Conversation>("agents/prompt", {
      conversationId: active.id,
      message: submittedMessage,
      context,
      ...(workspaceTools && agents?.workspaceToolsAvailable ? { workspaceTools: true } : {}),
    });
    if (mounted.current && trusted.current && selectionVersion.current === request) {
      setConversation(next);
      setMessage((current) => (current === submittedMessage ? "" : current));
    }
  };
  const saveProfile = async () => {
    if (!state.trusted) {
      onTrust();
      return;
    }
    const parsed: unknown = JSON.parse(args);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
      throw new Error("Arguments must be a JSON array of strings");
    const id =
      name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-|-$/g, "") || "local";
    const request = ++selectionVersion.current;
    await api("agents/configure", { profile: { id, name, command, args: parsed } });
    await refresh();
    if (mounted.current && selectionVersion.current === request) {
      setProfile(id);
      setConversation(null);
      persistSelection(id);
      setConfigure(false);
    }
  };
  const decide = async (proposalId: string, action: "accept" | "reject") => {
    if (!conversation) return;
    const proposal = conversation.proposals.find((item) => item.id === proposalId);
    const id = conversation.id,
      request = selectionVersion.current;
    const next = await api<Conversation>("agents/proposal", { conversationId: id, proposalId, action });
    if (mounted.current && selectionVersion.current === request && currentConversation.current === id) {
      setConversation(next);
      setReview(null);
    }
    if (action === "accept" && proposal) onChanged(proposal.file);
  };
  return (
    <section className="agent-workspace">
      <div className="agent-toolbar">
        <select
          aria-label="Agent profile"
          value={profile}
          onChange={(event) => {
            selectionVersion.current++;
            setProfile(event.target.value);
            setConversation(null);
            setReview(null);
            persistSelection(event.target.value);
          }}
        >
          <option value="">Select local agent</option>
          {agents?.profiles.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Agent conversation"
          value={conversation?.id ?? ""}
          onChange={(event) => {
            const id = event.target.value;
            const request = ++selectionVersion.current;
            persistSelection(profile, id);
            setConversation(null);
            setReview(null);
            if (!id) return;
            if (!state.trusted) {
              onTrust();
              return;
            }
            void perform(async () => {
              const next = await api<Conversation>(`agents/conversation?id=${encodeURIComponent(id)}`);
              if (
                mounted.current &&
                trusted.current &&
                selectionVersion.current === request &&
                next.profileId === profile &&
                next.id === id
              )
                setConversation(next);
            });
          }}
        >
          <option value="">New conversation</option>
          {agents?.conversations
            .filter((item) => item.profileId === profile)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.id === conversation?.id ? conversation.title : item.title}
              </option>
            ))}
        </select>
        <button
          type="button"
          disabled={!profile || busy || conversation?.status === "running"}
          onClick={() =>
            void perform(async () => {
              await create();
            })
          }
        >
          New chat
        </button>
        <button type="button" onClick={() => setConfigure((value) => !value)}>
          Configure
        </button>
      </div>
      {error ? (
        <div className="inline-error" role="alert">
          {error}
        </div>
      ) : null}
      {configure || agents?.profiles.length === 0 ? (
        <form
          className="agent-config"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(saveProfile);
          }}
        >
          <h3>Connect an ACP agent</h3>
          <label>
            Preset
            <select
              aria-label="Agent preset"
              defaultValue="custom"
              onChange={(event) => {
                if (event.target.value === "codex") {
                  setName("Codex");
                  setCommand("codex-acp");
                  setArgs("[]");
                } else if (event.target.value === "opencode") {
                  setName("OpenCode");
                  setCommand("opencode");
                  setArgs('["acp"]');
                }
              }}
            >
              <option value="custom">Custom ACP process</option>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
            </select>
          </label>
          <label>
            Name
            <input aria-label="Agent name" value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Executable
            <input
              aria-label="Agent executable"
              value={command}
              placeholder="Local ACP-compatible executable"
              onChange={(event) => setCommand(event.target.value)}
              required
            />
          </label>
          <label>
            Arguments
            <textarea
              aria-label="Agent arguments"
              rows={2}
              value={args}
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
          <div className="config-footer">
            <span>Starts a trusted local process. Configured globally for your account.</span>
            <button type="submit" disabled={busy || !command}>
              Save profile
            </button>
          </div>
        </form>
      ) : null}
      <div className="agent-messages" role="log" aria-label="Agent conversation">
        {!conversation?.messages.length ? (
          <div className="agent-empty">
            <Icon name="agent" />
            <strong>{profile ? "Start a conversation" : "Choose a local ACP agent"}</strong>
            <p>
              {profile
                ? "Ask about a query, inspect a result, or propose a change."
                : "Connect an installed agent to work with the selected project."}
            </p>
          </div>
        ) : (
          conversation.messages.map((item) => (
            <article className={`agent-message ${item.role}`} key={item.id}>
              <header>
                {item.role === "user" ? "You" : item.role === "assistant" ? "Agent" : "Tool"}
                <time>{new Date(item.createdAt).toLocaleTimeString()}</time>
              </header>
              <div>{item.text}</div>
            </article>
          ))
        )}
        {conversation?.toolCalls?.map((call) => (
          <div
            className={`agent-tool-call ${call.state}`}
            role="status"
            aria-label={`Workspace tool: ${toolLabels[call.name] ?? call.name}`}
            key={call.id}
          >
            <Icon name={call.state === "completed" ? "check" : call.state === "failed" ? "warning" : "play"} />
            <span>{toolLabels[call.name] ?? call.name}</span>
            <small>{call.state === "running" ? "Running" : call.state === "completed" ? "Completed" : "Failed"}</small>
            <time>{new Date(call.createdAt).toLocaleTimeString()}</time>
          </div>
        ))}
        {conversation?.proposals.map((proposal) => (
          <section className={`agent-proposal ${proposal.status}`} key={proposal.id}>
            <header>
              <strong>{proposal.file}</strong>
              <span>{proposal.status}</span>
            </header>
            <p>{proposal.description}</p>
            {review === proposal.id ? (
              <div className="proposal-diff">
                <div>
                  <small>Current</small>
                  <pre>{proposal.before ?? "(new file)"}</pre>
                </div>
                <div>
                  <small>Proposed</small>
                  <pre>{proposal.after}</pre>
                </div>
              </div>
            ) : null}
            <div className="proposal-actions">
              <button
                type="button"
                onClick={() => setReview((current) => (current === proposal.id ? null : proposal.id))}
              >
                {review === proposal.id ? "Hide diff" : "Review diff"}
              </button>
              {proposal.status === "pending" ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void perform(() => decide(proposal.id, "reject"))}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy || review !== proposal.id}
                    onClick={() => void perform(() => decide(proposal.id, "accept"))}
                  >
                    Apply reviewed change
                  </button>
                </>
              ) : proposal.status === "accepted" || proposal.before !== null ? (
                <button type="button" onClick={() => onOpen(proposal.file)}>
                  Open file
                </button>
              ) : null}
            </div>
          </section>
        ))}
        {conversation?.error ? <div className="inline-error">{conversation.error}</div> : null}
        <div ref={end} />
      </div>
      <form
        className="agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(send);
        }}
      >
        <div className="context-options">
          <label>
            <input
              type="checkbox"
              checked={includeSource}
              disabled={!source?.revision}
              onChange={(event) => setIncludeSource(event.target.checked)}
            />
            {source ? `${source.file.split("/").at(-1)}${source.revision ? "" : " · save to attach"}` : "Active file"}
          </label>
          <label
            title={
              !agents?.workspaceToolsAvailable
                ? "Workspace tools are unavailable from this host."
                : !state.trusted
                  ? "Enable trusted project execution to use workspace tools."
                  : "Allow scoped file, schema and migration inspection, bounded read-only database queries, and reviewed file proposals."
            }
          >
            <input
              type="checkbox"
              checked={workspaceTools}
              disabled={!agents?.workspaceToolsAvailable || !state.trusted}
              onChange={(event) => setWorkspaceTools(event.target.checked)}
            />
            Workspace tools
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeSchema}
              onChange={(event) => setIncludeSchema(event.target.checked)}
            />
            Schema
          </label>
          <label>
            <input
              type="checkbox"
              checked={includeResult}
              disabled={result === undefined}
              onChange={(event) => setIncludeResult(event.target.checked)}
            />
            Captured result
          </label>
          <select
            aria-label="Agent captured result context"
            value={resultRun}
            onChange={(event) => setResultRun(event.target.value)}
          >
            <option value="">Select captured run</option>
            {state.runs
              .filter((run) => run.results.length)
              .map((run) => (
                <option key={run.id} value={run.id}>
                  {run.file} · {run.sourceRevision.slice(0, 8)} · {run.target ?? "unverified"}
                </option>
              ))}
          </select>
          <span>{conversation?.status === "running" ? "Agent is working…" : profile ? "ACP · local process" : ""}</span>
        </div>
        {workspaceTools && agents?.workspaceToolsAvailable ? (
          <p className="agent-tools-scope">
            Tools can inspect scoped files, schema and migration history, run bounded read-only queries, and propose
            reviewed file changes.
          </p>
        ) : null}
        <textarea
          aria-label="Message local agent"
          value={message}
          rows={3}
          placeholder="Ask about your project…"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void perform(send);
            }
          }}
        />
        <div className="composer-actions">
          <span>File changes require review. Queries run through the workspace controls.</span>
          {conversation?.status === "running" ? (
            <button
              type="button"
              onClick={() =>
                void perform(async () => {
                  const id = conversation.id,
                    request = ++selectionVersion.current;
                  const next = await api<Conversation>("agents/cancel", { conversationId: id });
                  if (mounted.current && selectionVersion.current === request && currentConversation.current === id)
                    setConversation(next);
                })
              }
            >
              Stop
            </button>
          ) : (
            <button type="submit" className="primary-button" disabled={!profile || !message.trim() || busy}>
              Send ↑
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
