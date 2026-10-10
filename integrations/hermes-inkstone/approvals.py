"""Human-only slash command surface. Never registered as a model-callable tool."""
import secrets
import threading
import time
import uuid
from .client import Client, load_connection


class HumanApprovals:
    def __init__(self):
        self.pending = {}
        self.lock = threading.Lock()

    def command(self, raw_args):
        try:
            args = raw_args.strip().split()
            url, token = load_connection()
            client = Client(url, token)
            if not args or args == ["approvals"]:
                return self.preview(client)
            if len(args) == 2 and args[0] in ("approve", "deny"):
                return self.decide(client, args[1], args[0] == "approve")
            return "用法：/inkstone approvals；查看后使用 /inkstone approve <确认码> 或 /inkstone deny <确认码>。"
        except (ValueError, OSError):
            return "无法连接砚，请检查插件配对与电脑端远程接入。"

    def preview(self, client):
        result = client.read({"action": "questions"})
        if not result.get("ok"):
            return "无法读取砚的待审批操作，请检查连接与配对。"
        now = time.time()
        lines = []
        with self.lock:
            self.pending = {code: item for code, item in self.pending.items() if item["expires"] > now}
            for question in result.get("data", {}).get("questions", []):
                if not question.get("sensitive") or question.get("method") != "confirm":
                    continue
                if not question.get("approvalDigest"):
                    lines.append("此电脑端尚不支持人工批准回传，请更新砚后再试。")
                    continue
                if question.get("deadline", 0) and question["deadline"] <= now * 1000:
                    continue
                code = secrets.token_hex(4)
                expires = min(now + 120, question["deadline"] / 1000) if question.get("deadline", 0) else now + 120
                self.pending[code] = {"question": question, "expires": expires, "request_id": "human-" + str(uuid.uuid4()),
                                      "url": client.url, "token": client.token, "decision": None}
                # Display the full operation; no truncation that could hide the dangerous part.
                lines.append(f"会话 {question.get('sessionId')} · 运行 {question.get('runId')}\n"
                             f"{question.get('title', '')}\n{question.get('message', '')}\n"
                             f"允许：/inkstone approve {code}\n拒绝：/inkstone deny {code}\n确认码两分钟内有效，原请求可能更早过期。")
            while len(self.pending) > 64:
                self.pending.pop(next(iter(self.pending)))
        return "\n\n".join(lines) if lines else "砚目前没有等待人工批准的操作。"

    def decide(self, client, code, confirmed):
        with self.lock:
            item = self.pending.get(code)
            if not item or item["expires"] <= time.time():
                self.pending.pop(code, None)
                return "确认码已失效，请先运行 /inkstone approvals 重新查看具体操作。"
            if item["url"] != client.url or item["token"] != client.token:
                self.pending.pop(code, None)
                return "连接或配对已变化，请重新查看审批。"
            if item["decision"] is not None and item["decision"] != confirmed:
                return "上一决定的结果尚待确认，请重试原命令或在砚中核实，不要改用相反决定。"
            item["decision"] = confirmed
            question = item["question"]
            # The host checks that this exact preview still describes a pending confirmation.
            from urllib.parse import quote
            result = client.request("POST", "/questions/" + quote(question["id"], safe="") + "/approval", {
                "sessionId": question["sessionId"], "runId": question["runId"],
                "digest": question["approvalDigest"], "confirmed": confirmed
            }, item["request_id"])
            if result.get("outcomeUnknown"):
                return "连接中断，决定可能已经送达。请重试相同命令以复用请求编号，或到砚中核实。"
            self.pending.pop(code, None)
        if result.get("ok"):
            return f"已将你的{'允许' if confirmed else '拒绝'}传回砚，只作用于此条请求。"
        if result.get("httpStatus") == 404:
            return "请求已处理/过期，或电脑端不支持批准回传；请更新砚并重新查看。"
        return "批准未被接受：目标可能变化、设备已撤销或请求已过期。请重新查看，未自动批准。"
