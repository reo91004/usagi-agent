// 시험용 stdio MCP 서버(cli-mcp.test.ts, Codex 실제 확인): 읽기 search_emails · 쓰기 send_email.
// 불린 도구·인자와 FAKE_SECRET 이 왔는지를 FAKE_LOG 에 한 줄씩 남긴다. 아무것도 보내지 않는다
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const obj = (props) => ({ type: "object", properties: props, required: Object.keys(props) });
const s = new Server({ name: "fake-mail", version: "1.0.0" }, { capabilities: { tools: {} } });
s.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "search_emails", description: "Search the mailbox. Returns matching emails.", inputSchema: obj({ query: { type: "string" } }), annotations: { readOnlyHint: true } },
    { name: "send_email", description: "Send an email to someone.", inputSchema: obj({ to: { type: "string" }, body: { type: "string" } }), annotations: { destructiveHint: true } },
  ],
}));
s.setRequestHandler(CallToolRequestSchema, async (r) => {
  appendFileSync(process.env.FAKE_LOG ?? "/dev/null", `${new Date().toISOString()} ${r.params.name} ${JSON.stringify(r.params.arguments ?? {})} secret=${process.env.FAKE_SECRET ? "set" : "unset"}\n`);
  const text = r.params.name === "send_email" ? "sent" : JSON.stringify([{ id: "m1", from: "prof@lab.ac.kr", subject: "PROBE-65 실험 결과 공유 부탁" }]);
  return { content: [{ type: "text", text }] };
});
await s.connect(new StdioServerTransport());
