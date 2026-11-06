import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./icon";
import type { State, Value } from "./types";

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
}
interface Agents {
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
    [review, setReview] = useState<string | null>(null);
  const [resultRun, setResultRun] = useState("");
  const selectedRun = state.runs.find((run) => run.id === resultRun);
  const result = selectedRun?.results[0]?.value;
  const end = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    const next = await api<Agents>("agents");
    setAgents(next);
    setProfile((current) => current || next.profiles[0]?.id || "");
  }, []);
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
  }, [refresh]);
  useEffect(() => {
    if (conversation?.status !== "running") return;
    let cancelled = false;
    const interval = setInterval(
      () =>
        void api<Conversation>(`agents/conversation?id=${encodeURIComponent(conversation.id)}`).then(
          (next) => {
            if (!cancelled) setConversation(next);
          },
          (error) => {
            if (!cancelled) setError(error.message);
          },
        ),
      700,
    );
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversation?.id, conversation?.status, conversation]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, []);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    const next = await api<Conversation>("agents/new", { profileId: profile });
    setConversation(next);
    await refresh();
    return next;
  };
  const send = async () => {
    if (!message.trim()) return;
    if (!state.trusted) {
      onTrust();
      return;
    }
    const active = conversation && conversation.profileId === profile ? conversation : await create();
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
    setConversation(await api<Conversation>("agents/prompt", { conversationId: active.id, message, context }));
    setMessage("");
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
    await api("agents/configure", { profile: { id, name, command, args: parsed } });
    await refresh();
    setProfile(id);
    setConfigure(false);
  };
  const decide = async (proposalId: string, action: "accept" | "reject") => {
    if (!conversation) return;
    const proposal = conversation.proposals.find((item) => item.id === proposalId);
    setConversation(
      await api<Conversation>("agents/proposal", { conversationId: conversation.id, proposalId, action }),
    );
    if (action === "accept" && proposal) onChanged(proposal.file);
    setReview(null);
  };
  return (
    <section className="agent-workspace">
      <div className="agent-toolbar">
        <select
          aria-label="Agent profile"
          value={profile}
          onChange={(event) => {
            setProfile(event.target.value);
            setConversation(null);
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
            if (!id) {
              setConversation(null);
              return;
            }
            void perform(async () =>
              setConversation(await api<Conversation>(`agents/conversation?id=${encodeURIComponent(id)}`)),
            );
          }}
        >
          <option value="">New conversation</option>
          {agents?.conversations
            .filter((item) => item.profileId === profile)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
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
              defaultValue="custom"
              onChange={(event) => {
                if (event.target.value === "opencode") {
                  setName("OpenCode");
                  setCommand("opencode");
                  setArgs('["acp"]');
                }
              }}
            >
              <option value="custom">Custom ACP process</option>
              <option value="opencode">OpenCode</option>
            </select>
          </label>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Executable
            <input
              value={command}
              placeholder="Local ACP-compatible executable"
              onChange={(event) => setCommand(event.target.value)}
              required
            />
          </label>
          <label>
            Arguments
            <textarea rows={2} value={args} onChange={(event) => setArgs(event.target.value)} />
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
              ) : (
                <button type="button" onClick={() => onOpen(proposal.file)}>
                  Open file
                </button>
              )}
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
                void perform(async () =>
                  setConversation(await api<Conversation>("agents/cancel", { conversationId: conversation.id })),
                )
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
