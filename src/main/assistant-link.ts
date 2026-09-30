// 桌面砚 → 「生活助手」服务的本机 HTTP 客户端。
// 职责边界：只负责与助手服务通信（HTTP + SSE + 断线重连），不保存记忆/事项，也不做提示词或回合逻辑。
// 令牌由调用方从设置（safeStorage）读出后传入，这里不落盘、不写日志。
import http from "node:http";

export type AssistantStatus = "unconfigured" | "running" | "stopped" | "unauthorized" | "error";

export type AssistantHealth = {
  ok: boolean;
  version: string;
  timezone: string;
  now: string;
  now_ms: number;
  model: string | null;
};

export type AssistantTurnRow = { id: number; role: "user" | "assistant"; text: string; at: string; at_ms: number };
export type AssistantItem = {
  id: number;
  title: string;
  notes: string | null;
  status: "open" | "done" | "cancelled";
  due_at: string | null;
  remind_at: string | null;
  recurrence: string;
};
export type AssistantFact = {
  id: number;
  subject: string;
  attribute: string;
  value: string;
  status: "active" | "pending" | "superseded";
  origin: string;
};
export type AssistantReminder = {
  delivery_id: number;
  item_id: number;
  title: string;
  notes: string | null;
  text: string;
  fire_at: string;
  fire_at_ms: number;
};
export type AssistantTurnEvent = { turn_id: number; channel: string; user_text: string; reply: string; at: string; at_ms: number };

export type AssistantLinkOptions = {
  baseUrl: string;
  token: string;
  /** 单次 HTTP 请求超时；模型回合最坏约 120 秒，默认 180 秒。 */
  timeoutMs?: number;
  log?: (message: string) => void;
  onStatus?: (status: AssistantStatus, detail?: string) => void;
  onReminder?: (reminder: AssistantReminder) => void;
  onTurn?: (turn: AssistantTurnEvent) => void;
};

export class AssistantError extends Error {
  code: "unreachable" | "unauthorized" | "http" | "timeout";
  status?: number;

  constructor(code: AssistantError["code"], message: string, status?: number) {
    super(message);
    this.name = "AssistantError";
    this.code = code;
    this.status = status;
  }
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class AssistantLink {
  private readonly options: AssistantLinkOptions;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private sseRequest: http.ClientRequest | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RECONNECT_MIN_MS;
  private lastEventId = "";
  private stopped = true;
  private currentStatus: AssistantStatus = "stopped";

  constructor(options: AssistantLinkOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  get status(): AssistantStatus {
    return this.currentStatus;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private setStatus(status: AssistantStatus, detail?: string): void {
    if (this.currentStatus === status && !detail) return;
    this.currentStatus = status;
    this.options.onStatus?.(status, detail);
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>, headers?: Record<string, string>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
      if (response.status === 401) {
        this.setStatus("unauthorized");
        throw new AssistantError("unauthorized", "访问令牌错误");
      }
      if (!response.ok) {
        const error = parsed.error as { message?: string } | undefined;
        throw new AssistantError("http", error?.message ?? `助手服务返回 HTTP ${response.status}`, response.status);
      }
      this.setStatus("running");
      return parsed as T;
    } catch (err) {
      if (err instanceof AssistantError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        this.setStatus("error", "请求超时");
        throw new AssistantError("timeout", "生活助手响应超时，可重试");
      }
      this.setStatus("stopped", "无法连接生活助手");
      throw new AssistantError("unreachable", "无法连接生活助手，请确认服务已启动");
    } finally {
      clearTimeout(timer);
    }
  }

  health(): Promise<AssistantHealth> {
    return this.request<AssistantHealth>("GET", "/v1/health");
  }

  sendTurn(text: string, idempotencyKey?: string): Promise<{ turn_id: number; reply: string; tool_calls: number }> {
    return this.request("POST", "/v1/turns", { text, channel: "yan" }, idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined);
  }

  history(before?: number, limit = 30): Promise<{ turns: AssistantTurnRow[]; has_more: boolean }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", String(before));
    return this.request("GET", `/v1/turns?${params.toString()}`);
  }

  items(status?: string): Promise<{ items: AssistantItem[] }> {
    return this.request("GET", `/v1/items${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  }

  updateItem(id: number, patch: Record<string, unknown>): Promise<AssistantItem> {
    return this.request("PATCH", `/v1/items/${id}`, patch);
  }

  facts(status?: string, query?: string): Promise<{ facts: AssistantFact[] }> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (query) params.set("query", query);
    const queryString = params.toString();
    return this.request("GET", `/v1/facts${queryString ? `?${queryString}` : ""}`);
  }

  confirmFact(id: number): Promise<{ id: number; status: string }> {
    return this.request("POST", `/v1/facts/${id}/confirm`);
  }

  forgetFact(id: number): Promise<{ removed: number }> {
    return this.request("POST", `/v1/facts/${id}/forget`);
  }

  ackDelivery(deliveryId: number): Promise<{ ok: boolean; already?: boolean }> {
    return this.request("POST", `/v1/deliveries/${deliveryId}/ack`);
  }

  // ---------- SSE ----------

  /** 开始订阅事件流；断线后指数退避重连，并用 Last-Event-ID 续传。 */
  startEvents(): void {
    this.stopped = false;
    this.openEvents();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sseRequest) {
      this.sseRequest.destroy();
      this.sseRequest = null;
    }
    this.setStatus("stopped");
  }

  private openEvents(): void {
    if (this.stopped) return;
    const url = new URL(`${this.baseUrl}/v1/events`);
    const request = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "text/event-stream",
          ...(this.lastEventId ? { "last-event-id": this.lastEventId } : {}),
        },
        agent: false,
      },
      (response) => {
        if (response.statusCode === 401) {
          response.resume();
          this.setStatus("unauthorized");
          this.scheduleReconnect();
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          this.log(`事件流返回 HTTP ${response.statusCode}`);
          this.scheduleReconnect();
          return;
        }
        this.retryMs = RECONNECT_MIN_MS;
        this.setStatus("running");
        response.setEncoding("utf-8");
        let buffer = "";
        response.on("data", (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            this.handleFrame(frame);
          }
        });
        response.on("end", () => this.scheduleReconnect());
        response.on("error", () => this.scheduleReconnect());
      },
    );
    request.on("error", () => {
      this.setStatus("stopped", "无法连接生活助手");
      this.scheduleReconnect();
    });
    this.sseRequest = request;
  }

  private handleFrame(frame: string): void {
    let id = "";
    let event = "";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (id) this.lastEventId = id;
    if (!event || !data.length) return;
    try {
      const payload = JSON.parse(data.join("\n")) as Record<string, unknown>;
      if (event === "reminder") this.options.onReminder?.(payload as unknown as AssistantReminder);
      else if (event === "turn") this.options.onTurn?.(payload as unknown as AssistantTurnEvent);
    } catch (err) {
      this.log(`事件解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openEvents();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
