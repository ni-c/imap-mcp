# vhs script for the demo GIF: `vhs docs/demo.tape` writes public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * the server built (npm run build) and a reachable target instance
#   * export IMAP_URL / IMAP_TOKEN before running
#
# Rules learned the hard way:
#   * inside Hide blocks use vhs's own `Sleep`, never the shell's — shell sleep
#     blocks and the tape ends before any output is recorded
#   * MCP meta-tools need `arguments: {}` explicitly; it cannot be omitted
#   * start from the running server, do not record the setup

Output public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Type "clear" Enter
Sleep 500ms
Show

Type "# 1. the server is configured and built" Enter
Sleep 1s
Type "# 2. list what it exposes" Enter
Sleep 1s
Type "npx -y @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list | jq -r '.tools[].name'" Enter
Sleep 6s
Type "# 3. call a read-only tool" Enter
Sleep 1s
Type "npx -y @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name list_items | head -20" Enter
Sleep 8s
