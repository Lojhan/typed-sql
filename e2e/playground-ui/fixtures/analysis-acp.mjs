import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const sessionId = "analysis-fixture";
const text = (value) =>
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } } },
  });
let toolServer;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: 1 });
  else if (message.method === "session/new") {
    toolServer = message.params.mcpServers[0];
    reply(message.id, { sessionId });
  } else if (message.method === "session/prompt") {
    try {
      let counter = 0;
      const call = async (method, params) => {
        const response = await fetch(toolServer.url, {
          method: "POST",
          headers: {
            ...Object.fromEntries(toolServer.headers.map((h) => [h.name, h.value])),
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++counter, method, params }),
        });
        const result = await response.json();
        if (result.error || result.result?.isError) throw new Error(JSON.stringify(result));
        return result.result;
      };
      await call("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "analysis-fixture", version: "1" },
      });
      text("## Active users\n\nI’m checking the captured users by region and team.\n\n");
      const { structuredContent: dataset } = await call("tools/call", {
        name: "typed_sql_query_analysis",
        arguments: {
          sql: "SELECT region, team, COUNT(*) AS users FROM public.users WHERE active = :active GROUP BY region, team ORDER BY region, team",
          values: [true],
        },
      });
      await call("tools/call", {
        name: "typed_sql_present",
        arguments: {
          version: 1,
          title: "Active users",
          description: "Active means the stored active flag is true. Counts cover the complete query result.",
          datasetId: dataset.datasetId,
          layout: "grid",
          views: [
            { id: "total", kind: "metric", title: "Active user count", y: 2 },
            {
              id: "hierarchy",
              kind: "sunburst",
              title: "Users by region and team",
              hierarchy: [0, 1],
              y: 2,
              linkFilter: "region",
            },
            { id: "table", kind: "table", title: "User breakdown" },
          ],
          filters: [
            { id: "region", label: "Region", kind: "select", column: 0 },
            { id: "active", label: "Active flag", kind: "toggle", column: 0, mode: "query", parameter: 0 },
          ],
        },
      });
      const { structuredContent: status } = await call("tools/call", {
        name: "typed_sql_query_analysis",
        arguments: { sql: "SELECT active, COUNT(*) AS users FROM public.users GROUP BY active ORDER BY active" },
      });
      await call("tools/call", {
        name: "typed_sql_present",
        arguments: {
          version: 1,
          title: "Active share",
          datasetId: status.datasetId,
          views: [{ id: "share", kind: "donut", title: "Active versus inactive", x: 0, y: 1 }],
        },
      });
      const { structuredContent: gallery } = await call("tools/call", {
        name: "typed_sql_query_analysis",
        arguments: {
          sql: "SELECT id, CASE WHEN active THEN 1 ELSE 0 END AS active_count, region, team FROM public.users ORDER BY id",
        },
      });
      const kinds = [
        "bar",
        "stacked-bar",
        "line",
        "area",
        "scatter",
        "histogram",
        "pie",
        "donut",
        "sunburst",
        "treemap",
        "heatmap",
        "funnel",
        "sankey",
      ];
      const views = kinds.map((kind) => ({
        id: kind,
        title: `Example ${kind}`,
        kind,
        x: ["scatter", "histogram", "line", "area"].includes(kind) ? 0 : 2,
        y: 1,
        ...(["stacked-bar", "heatmap", "sankey"].includes(kind) ? { series: 3 } : {}),
        ...(["sunburst", "treemap"].includes(kind) ? { hierarchy: [2, 3] } : {}),
      }));
      for (let i = 0; i < views.length; i += 8)
        await call("tools/call", {
          name: "typed_sql_present",
          arguments: {
            version: 1,
            title: `Chart examples ${i / 8 + 1}`,
            datasetId: gallery.datasetId,
            layout: "grid",
            views: views.slice(i, i + 8),
          },
        });
      const { structuredContent: partial } = await call("tools/call", {
        name: "typed_sql_query_analysis",
        arguments: { sql: "SELECT id FROM public.measurements ORDER BY id" },
      });
      await call("tools/call", {
        name: "typed_sql_present",
        arguments: {
          version: 1,
          title: "Partial capture",
          datasetId: partial.datasetId,
          views: [{ id: "partial", kind: "line", title: "Captured measurement sample", x: 0, y: 0 }],
        },
      });
      text(
        "There are **6 active users**, out of **8 total users**.\n\n- Europe: **3**\n- United States: **3**\n\n| Region | Users |\n| --- | ---: |\n| EU | 3 |\n| US | 3 |\n\n```sql\nSELECT COUNT(*) FROM public.users WHERE active = true;\n```\n\n[Documentation](https://example.com/docs)\n\n![tracking](https://example.com/tracker.png)\n\n<script>globalThis.agentInjected=true</script>\n\n[bad](javascript:alert(1))",
      );
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "native",
            title: "Explain captured results",
            status: "in_progress",
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "native",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "Checked totals against captured SQL aggregates." } },
            ],
          },
        },
      });
      reply(message.id, { stopReason: "end_turn" });
    } catch (error) {
      text(`Fixture failed: ${error.message}`);
      reply(message.id, { stopReason: "refusal" });
    }
  }
}
