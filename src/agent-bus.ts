/** The bus uses the same signed envelope as research, but has its own event and key. */
export const AGENT_BUS_EVENT = "agent_bus.message";
export const AGENT_BUS_PATH = "/agent-bus/webhook";

export type AgentBusEvent = {
  type: typeof AGENT_BUS_EVENT;
  data: {
    agent: string;
    message: {
      id: number;
      ts: number;
      sender: string;
      recipient: string;
      body: string;
      data: unknown;
      visibility: "private" | "public";
    };
  };
};

export function busResource(agent: string): string {
  return `agent-bus:${agent}`;
}

export function parseBusEvent(value: unknown): AgentBusEvent | undefined {
  const event = value as AgentBusEvent | undefined;
  if (!event || event.type !== AGENT_BUS_EVENT) return undefined;
  const data = event.data;
  const message = data?.message;
  if (!data || typeof data.agent !== "string" || !data.agent.trim() || data.agent === "*" ||
      !message || !Number.isSafeInteger(message.id) || message.id < 1 || !Number.isFinite(message.ts) ||
      typeof message.sender !== "string" || !message.sender ||
      typeof message.body !== "string" ||
      (message.visibility !== "private" && message.visibility !== "public") ||
      (message.recipient !== data.agent && message.recipient !== "*") ||
      (message.recipient === "*" && message.sender === data.agent)) return undefined;
  return event;
}
