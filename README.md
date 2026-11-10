# Stonecut Map Builder

Website: https://stonecut.studio/resources | npm: https://www.npmjs.com/package/stonecut-map-builder | YouTube: https://www.youtube.com/@StonecutStudios (videos coming soon)

Let your AI agent build Minecraft maps for you. Stonecut Map Builder gives Claude Code (or any agent
that supports MCP) its own private Minecraft test server on your computer. The agent sets it up,
builds on it, checks its own work block by block, and exports what it made as a schematic you can
paste on any server. Free and open source under the MIT license.

<!-- VIDEO: how it works (owner sends the link) -->

## Setup

1. Install Node.js 20 or newer from https://nodejs.org (the LTS download).
2. Have Claude Code installed and signed in.
3. Add the tool to Claude Code. If the `claude` command works in your terminal:
   - macOS and Linux: `claude mcp add --scope user stonecut-map-builder -- npx -y stonecut-map-builder`
   - Windows: `claude mcp add --scope user stonecut-map-builder -- cmd /c npx -y stonecut-map-builder`

   If you only use the Claude Code extension in VS Code, `claude` is usually not on your PATH
   ("not recognized" / "command not found"). Run the copy bundled with the extension instead:
   - Windows (PowerShell):

     ```powershell
     & (Get-ChildItem "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe" | Sort-Object { [version]($_.FullName -replace '.*claude-code-([\d.]+).*','$1') } | Select-Object -Last 1).FullName mcp add --scope user stonecut-map-builder -- cmd /c npx -y stonecut-map-builder
     ```

   - macOS and Linux:

     ```sh
     "$(ls -d ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude | sort -V | tail -n 1)" mcp add --scope user stonecut-map-builder -- npx -y stonecut-map-builder
     ```
4. Start Claude Code (in VS Code: "Developer: Reload Window"), type `/mcp` and check that
   stonecut-map-builder shows as connected.
5. Paste the setup prompt from [docs/setup-with-ai.md](docs/setup-with-ai.md). The agent installs
   the skill (it asks first), asks your Minecraft version and modpack, shows what it will download,
   and asks you to accept the Minecraft EULA. Nothing is installed without your yes.
6. It starts the server and gives you an address like `localhost:25565`. Join it from Minecraft
   (same version), ask the agent to make you operator, then ask it to build.

## Example requests

- "Build a small stone watchtower with a spiral staircase and a lookout on top, next to spawn."
- "Make a medieval market square with five stalls, a well in the middle and lanterns."
- "Read back the house you just built and fix anything that looks wrong."
- "Export the castle as a schematic so I can paste it on my server."

## Works with Stonecut Studio

Make a map or a piece on [stonecut.studio](https://stonecut.studio), download it as a `.schem`, put
it in your test server's folder, and ask your agent to import it. Then keep building on it with your
agent: add interiors, change materials, add quests or mobs, and export the result. Big maps are
bigger than the tool's import limit by default; download single pieces, or raise `maxImportBlocks`
(see the [reference](docs/reference.md#settings)).

<!-- SHOWCASE: images of builds (owner sends them) -->

## What it supports

- Minecraft Java Edition 1.20.1 and newer, vanilla and NeoForge. More versions and mod loaders are
  coming.
- Windows, macOS and Linux. Made for Claude Code; other MCP agents should work.
- Java for your Minecraft version: Java 17 for 1.20.1 to 1.20.4, Java 21 for 1.20.5 to 1.21.11,
  Java 25 for 26.1 and newer. The agent tells you if it is missing and where to get it.

## Safety

- The test server only listens on your own computer. Nothing connects to another machine.
- Server files come only from Mojang and NeoForged, checked against their published hashes.
- It only works inside the folders you allow. It installs nothing, and clears, replaces or restores nothing, before you say yes.
- Every change can be undone, and whole-world backups are one request away.
- Your agent may have other tools, like a shell, that these rules don't cover. Keep your agent's
  own permission prompts on.

The full rules and every setting are in the [reference](docs/reference.md#safety).

## Troubleshooting

Run `npx -y stonecut-map-builder doctor`. It checks Node, your settings, Java, the test server, the
skill and whether the tool starts, and says how to fix each problem. It changes nothing. See the
[reference](docs/reference.md#doctor).

## More

- [Full reference](docs/reference.md): every tool, setting and limit, and manual install.
- Security reports: [SECURITY.md](SECURITY.md).
- License: MIT, see [LICENSE](LICENSE).
