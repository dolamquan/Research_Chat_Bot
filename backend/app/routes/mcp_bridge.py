from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from langsmith import traceable
from pydantic import BaseModel, Field

from app.mcp.bridge import MCP_SERVER_NAME, call_mcp_tool, list_mcp_tools


router = APIRouter(prefix="/mcp", tags=["mcp"])


class McpCallRequest(BaseModel):
    tool_name: str = Field(..., min_length=1)
    arguments: Dict[str, Any] = Field(default_factory=dict)


@router.get("/tools")
def get_mcp_tools() -> Dict[str, Any]:
    return {
        "server": MCP_SERVER_NAME,
        "tools": list_mcp_tools(),
    }


@router.post("/call")
@traceable(name="mcp_bridge_call", run_type="tool")
def call_tool(request: McpCallRequest) -> Dict[str, Any]:
    try:
        result = call_mcp_tool(request.tool_name, request.arguments)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "status": "success",
        "server": MCP_SERVER_NAME,
        "tool_name": request.tool_name,
        "result": result,
    }
