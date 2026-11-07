import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import {
  Bar,
  BarLabel,
  Button,
  ControlGroup,
  EmptyState,
  FieldLabel,
  FormField,
  FormPanel,
  Input,
  Notice,
  Panel,
  Select,
  TextArea,
  View,
} from "./components";
import { Icon } from "./icon";
import { RichOutputBoundary } from "./rich-output-boundary";
import type { State, Value } from "./types";
import "./agent.css";

const AgentMarkdown = lazy(() => import("./agent-markdown"));
const AnalysisCard = lazy(() => import("./analysis-card").then((module) => ({ default: module.AnalysisCard })));
interface Profile {
  id: string;
  name: string;
  protocol: string;
  command: string;
}
interface Conversation {
  id: string;
  title: string;
  updatedAt?: string;
  profileId: string;
  workspaceTools?: boolean;
  toolMode?: "off" | "ask" | "allow";
  permissions?: { id: string; name: string; input: string }[];
  status: "idle" | "running" | "failed" | "cancelled";
  messages: { id: string; role: string; text: string; createdAt: string; order?: number }[];
  proposals: {
    id: string;
    file: string;
    before: string | null;
    after: string;
    revision: string | null;
    status: "pending" | "accepted" | "rejected";
    description: string;
    createdAt?: string;
    order?: number;
  }[];
  error?: string;
  toolCalls?: {
    id: string;
    name: string;
    state: "running" | "completed" | "failed";
    createdAt: string;
    updatedAt: string;
    details?: string;
    origin?: "agent" | "workspace";
    order?: number;
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
  typed_sql_query_analysis: "Capture analysis data",
  typed_sql_get_analysis_data: "Read analysis data",
  typed_sql_present: "Present analysis",
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
  onAnalysis,
}: {
  state: State;
  source?: { file: string; source: string; revision: string | null };
  result?: Value;
  onOpen: (file: string) => void;
  onChanged: (file: string) => void;
  onTrust: () => void;
  onAnalysis: (id: string, title?: string) => void;
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
    [toolMode, setToolMode] = useState<"off" | "ask" | "allow">("ask"),
    [review, setReview] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<{ id: string; title: string; createdAt: string; order?: number }[]>([]);
  const [resultRun, setResultRun] = useState("");
  const workspaceTools = toolMode !== "off";
  useEffect(() => {
    setToolMode(conversation?.id ? (conversation.toolMode ?? (conversation.workspaceTools ? "allow" : "off")) : "ask");
  }, [conversation?.id, conversation?.toolMode, conversation?.workspaceTools]);
  const workspace = useRef<HTMLElement>(null);
  const [compactComposer, setCompactComposer] = useState(true);
  useLayoutEffect(() => {
    if (!workspace.current) return;
    setCompactComposer(workspace.current.clientWidth < 850);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompactComposer(entry.contentRect.width < 850);
    });
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  const selectedRun = state.runs.find((run) => run.id === resultRun);
  const result = selectedRun?.results[0]?.value;
  const end = useRef<HTMLDivElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followEnd = useRef(true);
  const [visibleEntries, setVisibleEntries] = useState(100);
  useEffect(() => {
    if (!conversation?.id) return;
    setVisibleEntries(100);
    followEnd.current = true;
  }, [conversation?.id]);
  useEffect(() => {
    if (!transcript.current) return;
    const observer = new ResizeObserver(() => {
      if (followEnd.current) end.current?.scrollIntoView({ block: "nearest" });
    });
    observer.observe(transcript.current);
    return () => observer.disconnect();
  }, []);
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
  useEffect(() => {
    setArtifacts([]);
    if (!state.trusted || !conversation?.id) return;
    let cancelled = false;
    const fetch = () =>
      void api<{ id: string; title: string; createdAt: string; order?: number }[]>(
        `analyses?conversation=${encodeURIComponent(conversation.id)}`,
      ).then(
        (next) => {
          if (!cancelled) setArtifacts(next);
        },
        () => {},
      );
    fetch();
    const interval = conversation.status === "running" ? setInterval(fetch, 700) : undefined;
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversation?.id, conversation?.status, state.trusted]);
  const rawTimeline = [
    ...(conversation?.messages ?? []).map((value) => ({ kind: "message" as const, value, at: value.createdAt })),
    ...(conversation?.toolCalls ?? []).map((value) => ({ kind: "tool" as const, value, at: value.createdAt })),
    ...(conversation?.proposals ?? []).map((value) => ({
      kind: "proposal" as const,
      value,
      at: value.createdAt ?? conversation?.updatedAt ?? "",
    })),
    ...artifacts.map((value) => ({ kind: "analysis" as const, value, at: value.createdAt })),
  ].toSorted((a, b) => a.at.localeCompare(b.at) || (a.value.order ?? 0) - (b.value.order ?? 0));
  type ToolCall = NonNullable<Conversation["toolCalls"]>[number];
  const timeline: (
    | Exclude<(typeof rawTimeline)[number], { kind: "tool" }>
    | { kind: "tools"; value: { id: string; calls: ToolCall[] } }
  )[] = [];
  let group: { id: string; calls: ToolCall[] } | undefined;
  for (const entry of rawTimeline) {
    if (entry.kind === "message" && entry.value.role === "user") group = undefined;
    if (entry.kind !== "tool") {
      timeline.push(entry);
      continue;
    }
    if (!group) {
      group = { id: entry.value.id, calls: [] };
      timeline.push({ kind: "tools", value: group });
    }
    group.calls.push(entry.value);
  }
  const lastMessage = conversation?.messages.at(-1)?.text;
  const activity = [
    ...(conversation?.toolCalls?.map((call) => `${call.id}:${call.state}`) ?? []),
    ...(conversation?.proposals.map((proposal) => `${proposal.id}:${proposal.status}`) ?? []),
  ].join("|");
  useEffect(() => {
    if (followEnd.current && (lastMessage || activity)) end.current?.scrollIntoView({ block: "nearest" });
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
      toolMode: agents?.workspaceToolsAvailable ? toolMode : "off",
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
    <View className="agent-workspace" ref={workspace}>
      <Bar wrap className="agent-toolbar">
        <Select
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
        </Select>
        <Select
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
        </Select>
        <Button
          disabled={!profile || busy || conversation?.status === "running"}
          onClick={() =>
            void perform(async () => {
              await create();
            })
          }
        >
          New chat
        </Button>
        <Button onClick={() => setConfigure((value) => !value)}>Configure</Button>
      </Bar>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {configure || agents?.profiles.length === 0 ? (
        <FormPanel
          className="agent-config"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(saveProfile);
          }}
        >
          <h3>Connect an ACP agent</h3>
          <FormField label="Preset">
            <Select
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
            </Select>
          </FormField>
          <FormField label="Name">
            <Input aria-label="Agent name" value={name} onChange={(event) => setName(event.target.value)} required />
          </FormField>
          <FormField label="Executable">
            <Input
              aria-label="Agent executable"
              value={command}
              placeholder="Local ACP-compatible executable"
              onChange={(event) => setCommand(event.target.value)}
              required
            />
          </FormField>
          <FormField label="Arguments">
            <TextArea
              aria-label="Agent arguments"
              rows={2}
              value={args}
              onChange={(event) => setArgs(event.target.value)}
            />
          </FormField>
          <ControlGroup wrap className="config-footer">
            <span>Starts a trusted local process. Configured globally for your account.</span>
            <Button type="submit" disabled={busy || !command}>
              Save profile
            </Button>
          </ControlGroup>
        </FormPanel>
      ) : null}
      <div
        className="agent-messages"
        role="log"
        aria-label="Agent conversation"
        onScroll={(event) => {
          const el = event.currentTarget;
          followEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        <div ref={transcript}>
          {conversation?.permissions?.map((permission) => (
            <Panel key={permission.id} className="agent-permission">
              <strong>Allow {toolLabels[permission.name] ?? permission.name}?</strong>
              <details>
                <summary>Tool arguments</summary>
                <pre>{permission.input}</pre>
              </details>
              <ControlGroup>
                {(["once", "allow", "deny"] as const).map((action) => (
                  <Button
                    key={action}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const next = await api<Conversation>("agents/permission", {
                          conversationId: conversation.id,
                          permissionId: permission.id,
                          action,
                        });
                        setConversation(next);
                      })
                    }
                  >
                    {action === "once" ? "Allow once" : action === "allow" ? "Allow for this conversation" : "Deny"}
                  </Button>
                ))}
              </ControlGroup>
            </Panel>
          ))}
          {timeline.length > visibleEntries ? (
            <Button onClick={() => setVisibleEntries((count) => count + 100)}>Show earlier activity</Button>
          ) : null}
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
          ) : null}
          {timeline.slice(-visibleEntries).map((entry) => {
            if (entry.kind === "message") {
              const item = entry.value;
              return (
                <article className={`agent-message ${item.role}`} key={item.id}>
                  <header>
                    {item.role === "user" ? "You" : item.role === "assistant" ? "Agent" : "Tool"}
                    <time>{new Date(item.createdAt).toLocaleTimeString()}</time>
                  </header>
                  <RichOutputBoundary fallback={<pre>{item.text}</pre>}>
                    <Suspense fallback={<div>{item.text}</div>}>
                      <AgentMarkdown
                        text={item.text}
                        streaming={
                          item.id === conversation?.messages.at(-1)?.id &&
                          item.role === "assistant" &&
                          conversation?.status === "running"
                        }
                      />
                    </Suspense>
                  </RichOutputBoundary>
                </article>
              );
            }
            if (entry.kind === "tools") {
              const calls = entry.value.calls.filter(
                (call) =>
                  !(
                    call.origin === "agent" &&
                    call.state !== "failed" &&
                    entry.value.calls.some(
                      (other) => other.origin === "workspace" && call.name.endsWith(`.${other.name}`),
                    )
                  ),
              );
              const running = calls.some((call) => call.state === "running");
              const failed = calls.filter((call) => call.state === "failed").length;
              return (
                <details className="agent-activity" key={entry.value.id}>
                  <summary>
                    <Icon name={running ? "play" : failed ? "warning" : "check"} />
                    {running ? "Working" : "Activity"} · {calls.length} tool {calls.length === 1 ? "call" : "calls"}
                    {failed ? ` · ${failed} failed` : ""}
                  </summary>
                  {calls.map((call) => (
                    <Panel padding="none" key={call.id}>
                      <Bar
                        wrap
                        separator="none"
                        className={`agent-tool-call ${call.state}`}
                        role="status"
                        aria-label={`${call.origin === "agent" ? "Agent tool" : "Workspace tool"}: ${toolLabels[call.name.split(".").at(-1)!] ?? call.name}`}
                        key={call.id}
                      >
                        <Icon
                          name={call.state === "completed" ? "check" : call.state === "failed" ? "warning" : "play"}
                        />
                        <span>{toolLabels[call.name.split(".").at(-1)!] ?? call.name}</span>
                        <small>
                          {call.state === "running" ? "Running" : call.state === "completed" ? "Completed" : "Failed"}
                        </small>
                        <time>{new Date(call.createdAt).toLocaleTimeString()}</time>
                      </Bar>
                      {call.details ? (
                        <details className="agent-tool-details">
                          <summary>Result details</summary>
                          {call.origin === "agent" ? (
                            <Suspense fallback={<pre>{call.details}</pre>}>
                              <AgentMarkdown text={call.details} />
                            </Suspense>
                          ) : (
                            <pre>{call.details}</pre>
                          )}
                        </details>
                      ) : null}
                    </Panel>
                  ))}
                </details>
              );
            }
            if (entry.kind === "analysis")
              return (
                <Suspense key={entry.value.id} fallback={<EmptyState>Loading analysis…</EmptyState>}>
                  <RichOutputBoundary>
                    <AnalysisCard id={entry.value.id} onOpen={onAnalysis} onSaved={onChanged} />
                  </RichOutputBoundary>
                </Suspense>
              );
            const proposal = entry.value;
            return (
              <Panel className={`agent-proposal ${proposal.status}`} key={proposal.id}>
                <Bar as="header" separator="none" padding="none">
                  <BarLabel as="strong" truncate title={proposal.file}>
                    {proposal.file}
                  </BarLabel>
                  <span>{proposal.status}</span>
                </Bar>
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
                <ControlGroup wrap className="proposal-actions">
                  <Button onClick={() => setReview((current) => (current === proposal.id ? null : proposal.id))}>
                    {review === proposal.id ? "Hide diff" : "Review diff"}
                  </Button>
                  {proposal.status === "pending" ? (
                    <>
                      <Button disabled={busy} onClick={() => void perform(() => decide(proposal.id, "reject"))}>
                        Reject
                      </Button>
                      <Button
                        variant="primary"
                        disabled={busy || review !== proposal.id}
                        onClick={() => void perform(() => decide(proposal.id, "accept"))}
                      >
                        Apply reviewed change
                      </Button>
                    </>
                  ) : proposal.status === "accepted" || proposal.before !== null ? (
                    <Button onClick={() => onOpen(proposal.file)}>Open file</Button>
                  ) : null}
                </ControlGroup>
              </Panel>
            );
          })}
          {conversation?.error ? <Notice tone="error">{conversation.error}</Notice> : null}
          <div ref={end} />
        </div>
      </div>
      <FormPanel
        padding="none"
        className="agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void perform(send);
        }}
      >
        <Bar className="context-options">
          <FieldLabel>
            Tools
            <Select
              aria-label="Workspace tools"
              value={toolMode}
              disabled={!agents?.workspaceToolsAvailable || !state.trusted || conversation?.status === "running"}
              onChange={(event) => setToolMode(event.target.value as "off" | "ask" | "allow")}
            >
              <option value="ask">Ask before use</option>
              <option value="allow">Allow for this conversation</option>
              <option value="off">Off</option>
            </Select>
          </FieldLabel>
          <details
            className={compactComposer ? "file-menu agent-context-menu" : "agent-context-inline"}
            open={!compactComposer}
          >
            <summary className="ui-menu-trigger" aria-label="Context settings">
              Context
            </summary>
            <div className={compactComposer ? "ui-menu agent-context-fields" : "agent-context-fields"}>
              <FieldLabel>
                <Input
                  type="checkbox"
                  checked={includeSource}
                  disabled={!source?.revision}
                  onChange={(event) => setIncludeSource(event.target.checked)}
                />
                {source
                  ? `${source.file.split("/").at(-1)}${source.revision ? "" : " · save to attach"}`
                  : "Active file"}
              </FieldLabel>

              <FieldLabel>
                <Input
                  type="checkbox"
                  checked={includeSchema}
                  onChange={(event) => setIncludeSchema(event.target.checked)}
                />
                Schema
              </FieldLabel>
              <FieldLabel>
                <Input
                  type="checkbox"
                  checked={includeResult}
                  disabled={result === undefined}
                  onChange={(event) => setIncludeResult(event.target.checked)}
                />
                Captured result
              </FieldLabel>
              <Select
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
              </Select>
            </div>
          </details>
          <span className="agent-process-status">
            {conversation?.status === "running" ? "Working…" : profile ? "ACP · local" : ""}
          </span>
        </Bar>
        {workspaceTools && agents?.workspaceToolsAvailable ? (
          <p className="agent-tools-scope">
            Read-only queries and project inspection · file changes always require review.
          </p>
        ) : null}
        <TextArea
          aria-label="Message local agent"
          variant="plain"
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
        <Bar separator="none" className="composer-actions">
          <BarLabel truncate title="File changes require review. Queries run through the workspace controls.">
            File changes require review. Queries run through the workspace controls.
          </BarLabel>
          {conversation?.status === "running" ? (
            <Button
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
            </Button>
          ) : (
            <Button variant="primary" type="submit" disabled={!profile || !message.trim() || busy}>
              Send ↑
            </Button>
          )}
        </Bar>
      </FormPanel>
    </View>
  );
}
