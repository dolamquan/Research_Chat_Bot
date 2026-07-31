import json
import os
import subprocess
from typing import Any, Dict, List


REDDIT_ENV_VARS = [
    "REDDIT_USERNAME",
    "REDDIT_CLIENT_ID",
    "REDDIT_CLIENT_SECRET",
    "REDDIT_PASSWORD",
    "REDDIT_USER_AGENT",
]


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _timeout() -> int:
    return int(_env("REDDIT_MCP_TIMEOUT_SECONDS", "60") or "60")


def _frame(payload: Dict[str, Any]) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


def _parse_frames(output: bytes) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []
    cursor = 0
    marker = b"\r\n\r\n"

    while cursor < len(output):
        header_end = output.find(marker, cursor)
        if header_end == -1:
            break

        header = output[cursor:header_end].decode("ascii", errors="ignore")
        length = 0
        for line in header.splitlines():
            if line.lower().startswith("content-length:"):
                length = int(line.split(":", 1)[1].strip())
                break

        body_start = header_end + len(marker)
        body_end = body_start + length
        if length <= 0 or body_end > len(output):
            break

        try:
            messages.append(json.loads(output[body_start:body_end].decode("utf-8")))
        except json.JSONDecodeError:
            pass

        cursor = body_end

    return messages


def _docker_command() -> List[str]:
    image = _env("REDDIT_MCP_DOCKER_IMAGE", "mcp/reddit")
    command = ["docker", "run", "--rm", "-i"]

    for name in REDDIT_ENV_VARS:
        if _env(name):
            command.extend(["-e", name])

    command.append(image)
    return command


def _mcp_messages(method: str, params: Dict[str, Any] | None = None) -> bytes:
    return b"".join(
        [
            _frame(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {
                            "name": "researchmind",
                            "version": "0.1.0",
                        },
                    },
                }
            ),
            _frame({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}),
            _frame(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": method,
                    "params": params or {},
                }
            ),
        ]
    )


def _run_mcp(method: str, params: Dict[str, Any] | None = None) -> Dict[str, Any]:
    backend = _env("REDDIT_MCP_BACKEND", "docker").lower()
    if backend not in {"docker", "auto"}:
        raise RuntimeError("REDDIT_MCP_BACKEND must be docker or auto")

    try:
        completed = subprocess.run(
            _docker_command(),
            input=_mcp_messages(method, params),
            capture_output=True,
            timeout=_timeout(),
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("Docker is not installed or not available on PATH") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Reddit MCP Docker server timed out") from exc

    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="ignore").strip()
        raise RuntimeError(stderr or "Reddit MCP Docker server failed")

    for message in _parse_frames(completed.stdout):
        if message.get("id") != 2:
            continue
        if message.get("error"):
            raise RuntimeError(json.dumps(message["error"]))
        result = message.get("result")
        return result if isinstance(result, dict) else {"result": result}

    stderr = completed.stderr.decode("utf-8", errors="ignore").strip()
    raise RuntimeError(stderr or "Reddit MCP server returned no JSON-RPC result")


def _content_to_payload(result: Dict[str, Any]) -> Any:
    content = result.get("content")
    if not isinstance(content, list):
        return result

    text_parts = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            text_parts.append(str(item.get("text", "")))

    text = "\n".join(part for part in text_parts if part).strip()
    if not text:
        return result

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"text": text}


def list_reddit_tools() -> List[Dict[str, Any]]:
    result = _run_mcp("tools/list")
    tools = result.get("tools", [])
    if not isinstance(tools, list):
        return []
    return [tool for tool in tools if isinstance(tool, dict)]


def _choose_tool(preferred: List[str]) -> str:
    configured = _env("REDDIT_MCP_SEARCH_TOOL")
    if configured:
        return configured

    tools = list_reddit_tools()
    names = [str(tool.get("name", "")) for tool in tools]
    lowered = {name.lower(): name for name in names}

    for name in preferred:
        if name.lower() in lowered:
            return lowered[name.lower()]

    for name in names:
        candidate = name.lower()
        if "search" in candidate and ("post" in candidate or "reddit" in candidate):
            return name

    available = ", ".join(names) or "none"
    raise RuntimeError(f"No compatible Reddit search tool found. Available tools: {available}")


def _normalize_post(raw: Dict[str, Any]) -> Dict[str, Any]:
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    permalink = str(data.get("permalink") or "")
    url = str(data.get("url") or data.get("link") or "")
    if permalink.startswith("/"):
        url = f"https://www.reddit.com{permalink}"
    elif not url and permalink:
        url = permalink

    return {
        "id": str(data.get("id") or data.get("name") or url or data.get("title") or "reddit-post"),
        "title": str(data.get("title") or data.get("name") or "Reddit post"),
        "text": str(
            data.get("selftext")
            or data.get("body")
            or data.get("text")
            or data.get("excerpt")
            or data.get("description")
            or ""
        ),
        "url": url,
        "subreddit": str(data.get("subreddit") or data.get("subreddit_name_prefixed") or ""),
        "author": str(data.get("author") or ""),
        "score": data.get("score"),
        "num_comments": data.get("num_comments") or data.get("comments"),
        "created_utc": data.get("created_utc"),
    }


def _extract_items(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ["posts", "results", "items", "data", "children"]:
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return [payload]


def search_reddit_posts(query: str, subreddit: str | None = None, limit: int = 10) -> Dict[str, Any]:
    if not query.strip():
        raise ValueError("query is required")

    tool_name = _choose_tool(["search_posts", "search_reddit", "reddit_search", "search"])
    arguments: Dict[str, Any] = {
        "query": query.strip(),
        "limit": max(1, min(limit, 25)),
    }
    if subreddit:
        arguments["subreddit"] = subreddit.strip().removeprefix("r/")

    result = _run_mcp("tools/call", {"name": tool_name, "arguments": arguments})
    payload = _content_to_payload(result)
    posts = [_normalize_post(item) for item in _extract_items(payload)]

    return {
        "provider": "reddit_mcp",
        "tool_name": tool_name,
        "query": query.strip(),
        "subreddit": subreddit or "",
        "posts": posts[: max(1, min(limit, 25))],
    }
