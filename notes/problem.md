# The problem: silent truncation

Big tool results are a known problem and clients already deal with them. Their way of dealing with
them mostly hides what was lost from the model.

## Clients

- **Claude Code** [doc]: warns at 10,000 tokens, default cap 25,000 (`MAX_MCP_OUTPUT_TOKENS`). Larger
  successful results are saved to a file and replaced with the path. Error results over ~11,000
  characters keep only the first and last 5,000.
  [docs](https://code.claude.com/docs/en/mcp)
- **Cursor** [report]: spills to a file. One user couldn't tell what had been withheld; others report
  loops when the file is too big for the read tool.
  [forum](https://forum.cursor.com/t/cursor-truncates-mcp-tool-responses/168384)
- **ChatGPT connectors** [report]: cut "at a line boundary". The model got half a filter catalog and
  built invalid requests.
  [community](https://community.openai.com/t/tool-response-truncation-on-mcp-connector-responses-that-previously-worked/1383071)
- **MCP spec** [doc]: no size limit and no pagination for `tools/call` results. A proposal for
  negotiated response caps hasn't been adopted.
  [spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
  [discussion #2211](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2211)

## Servers

- **Atlassian Jira MCP** [report]: drops results past `maxResults`, and `totalCount` equals the page
  size, so agents think the first page is everything. "No way to distinguish 101 results from 1,649."
  [issue #118](https://github.com/atlassian/atlassian-mcp-server/issues/118)
- **Splunk MCP** [report]: caps queries at 1,000 events. One user found `truncated` and `total_rows`
  set in `structuredContent`, but the model only read the text block and gave made-up answers.
  [thread](https://community.splunk.com/t5/All-Apps-and-Add-ons/Splunk-MCP-Server-returns-fabricated-hallucinated-data-with/m-p/758220)
- **Sizes seen in the wild** [report]: Jira `getJiraIssue` 29,544 tokens with no limit parameter;
  Azure subscription list 44,221 tokens
  ([microsoft/mcp#428](https://github.com/microsoft/mcp/issues/428)); GitHub code-scanning alerts
  24,000 tokens, with an essential-fields proposal closed "not planned"
  ([gh-aw#11945](https://github.com/github/gh-aw/issues/11945)).
- **Datadog** [doc]: agents "would fill their context windows with log data and lose track of what
  they were doing". Their fix (drop rare fields by default, let the agent ask for them, change format)
  fit about 5× more records. That's the same design as ContextQuant, built in-house.
  [engineering blog](https://www.datadoghq.com/blog/engineering/mcp-server-agent-tools/)

## Why server-side fixes don't cover it

Asking servers to add `fields` or `limit` parameters is the right fix, but:

1. most MCP servers are thin REST wrappers that don't expose them;
2. the model doesn't know the field names until it has seen one response;
3. extra parameters make tool schemas bigger, which is its own token problem;
4. you can't change a third-party server.

A proxy is a way to add projection to servers you don't own. `contextquant_more(handle, offset, fields)`
is a sparse-fieldset API added after the fact.

## Two incidents I want to handle and don't yet

Both are cases where the server already reported it was incomplete and the model never saw it:

- Splunk: completeness flags live in `structuredContent`, which ContextQuant currently passes through
  untouched. Fix: copy `truncated` / `total` / cursor fields into the receipt the model reads.
- Jira: `totalCount == maxResults` with no cursor. Fix: flag it as "completeness unknown".
