#!/usr/bin/env python3
"""The Plane MCP verify-first test (Plane design §7.2, V2), and the MCP step of the smoke suite.

    plane-mcp-check                               the worker's launcher, project KAAVA
    plane-mcp-check --identifier ANOM -- <cmd…>   any other launcher

It starts the server the way Claude Code does (stdio), lists its tools, then creates, reads,
updates and comments on a throwaway work item and deletes it again. Exit 0 only if every step
passed. Run it with the Python that has plane-mcp-server installed: it needs the `mcp` package.
"""

import argparse
import asyncio
import json
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REQUIRED_TOOLS = {"project", "workitem", "workitem_comment"}


def payload(result):
    """A tool result as Python data; raises on a tool error."""
    text = "".join(getattr(c, "text", "") for c in result.content)
    if result.isError:
        raise RuntimeError(text[:500])
    if result.structuredContent is not None:
        data = result.structuredContent
        return data.get("result", data) if isinstance(data, dict) and len(data) == 1 else data
    try:
        return json.loads(text)
    except ValueError:
        return text


def items(data):
    return data.get("results", data) if isinstance(data, dict) else data


async def run(command, identifier):
    server = StdioServerParameters(command=command[0], args=command[1:])
    async with stdio_client(server) as (read, write), ClientSession(read, write) as mcp:
        await mcp.initialize()
        tools = {t.name for t in (await mcp.list_tools()).tools}
        step(f"{len(tools)} tools")
        if missing := REQUIRED_TOOLS - tools:
            raise RuntimeError(f"missing tools: {sorted(missing)}")

        async def call(tool, **args):
            return payload(await mcp.call_tool(tool, args))

        projects = items(await call("project", action="list"))
        project = next((p for p in projects if p.get("identifier") == identifier), None)
        if project is None:
            raise RuntimeError(f"project {identifier} is not visible to this token")
        pid = project["id"]
        step(f"list projects: {identifier} found")

        made = await call("workitem", action="create", project_id=pid,
                          name="plane-mcp-check: delete me")
        wid = made["id"]
        step(f"create: {identifier}-{made.get('sequence_id', '?')}")
        try:
            got = await call("workitem", action="retrieve", project_id=pid, workitem_id=wid)
            assert got["id"] == wid, got
            step("retrieve")
            await call("workitem", action="update", project_id=pid, workitem_id=wid,
                       name="plane-mcp-check: updated")
            got = await call("workitem", action="retrieve", project_id=pid, workitem_id=wid)
            assert got["name"] == "plane-mcp-check: updated", got["name"]
            step("update")
            await call("workitem_comment", action="create", project_id=pid, workitem_id=wid,
                       comment_html="<p>plane-mcp-check</p>")
            comments = items(await call("workitem_comment", action="list", project_id=pid,
                                        workitem_id=wid))
            assert any("plane-mcp-check" in (c.get("comment_html") or "") for c in comments)
            step("comment")
        finally:
            await call("workitem", action="delete", project_id=pid, workitem_id=wid)
            step("delete")


def step(message):
    print(f"plane-mcp-check: ok {message}", file=sys.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="plane-mcp-check", description=__doc__.splitlines()[0])
    ap.add_argument("--identifier", default="KAAVA", help="Plane project to test in")
    ap.add_argument("command", nargs="*", default=["/opt/kaava/bin/plane-mcp"])
    args = ap.parse_args(argv)
    try:
        asyncio.run(run(args.command, args.identifier))
    except Exception as err:  # every failure is a test failure; say which
        print(f"plane-mcp-check: FAILED {type(err).__name__}: {err}", file=sys.stderr)
        return 1
    print("plane-mcp-check: passed", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
