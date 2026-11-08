# Run one captured tool result through headroom's compress(), as the tool message of a short agent turn.
#   uv run --python 3.13 --with headroom-ai==0.43.1 python -I bench/compare/headroom_arm.py <payload.txt> <query>
# Prints the compressed tool message content to stdout.
import json
import sys

from headroom import compress

text = open(sys.argv[1], encoding="utf-8").read()
messages = [
    {"role": "user", "content": f"Search GitHub issues: {sys.argv[2]}"},
    {"role": "assistant", "content": None, "tool_calls": [{
        "id": "call_1", "type": "function",
        "function": {"name": "search_issues", "arguments": json.dumps({"q": sys.argv[2], "per_page": 30})},
    }]},
    {"role": "tool", "tool_call_id": "call_1", "content": text},
]
out = compress(messages, model="gpt-4o")
tool = next(m for m in out.messages if m.get("role") == "tool")
content = tool["content"]
sys.stdout.write(content if isinstance(content, str) else json.dumps(content))
