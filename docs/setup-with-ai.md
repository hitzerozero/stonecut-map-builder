# Set up with AI

This is the prompt for the "Set up with AI" button on the downloads page. The person copies it
into their agent (for example Claude Code) after adding the tool with the one command shown on the
page:

If Claude Code is installed as a command-line tool (the `claude` command works in a terminal):

- macOS and Linux: `claude mcp add --scope user stonecut-map-builder -- npx -y stonecut-map-builder`
- Windows: `claude mcp add --scope user stonecut-map-builder -- cmd /c npx -y stonecut-map-builder`

If they only use the Claude Code extension in VS Code, `claude` is usually not on their PATH (the
terminal says "claude is not recognized" or "command not found"). The extension ships its own copy
of the CLI; these commands find the newest one and run it:

- Windows (PowerShell):

  ```powershell
  & (Get-ChildItem "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe" | Sort-Object { [version]($_.FullName -replace '.*claude-code-([\d.]+).*','$1') } | Select-Object -Last 1).FullName mcp add --scope user stonecut-map-builder -- cmd /c npx -y stonecut-map-builder
  ```

- macOS and Linux:

  ```sh
  "$(ls -d ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude | sort -V | tail -n 1)" mcp add --scope user stonecut-map-builder -- npx -y stonecut-map-builder
  ```

After adding it, restart Claude Code (in VS Code: run "Developer: Reload Window" from the command
palette).

## The prompt

```text
Set up Stonecut Map Builder for me, so you can build Minecraft maps on a private test server on
this computer. Follow these steps in order, and ask me before you install, download or change
anything.

1. Check that the MCP server "stonecut-map-builder" is connected and that you can call its
   status tool. If it is not connected, tell me the one command to add it for my system, ask me
   to restart you after running it, and stop here.
   - Claude Code in a terminal, macOS/Linux:
     claude mcp add --scope user stonecut-map-builder -- npx -y stonecut-map-builder
   - Claude Code in a terminal, Windows:
     claude mcp add --scope user stonecut-map-builder -- cmd /c npx -y stonecut-map-builder
   - Claude Code in VS Code (the claude command is usually not installed, so use the copy
     bundled with the extension), Windows PowerShell:
     & (Get-ChildItem "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe" | Sort-Object { [version]($_.FullName -replace '.*claude-code-([\d.]+).*','$1') } | Select-Object -Last 1).FullName mcp add --scope user stonecut-map-builder -- cmd /c npx -y stonecut-map-builder
   - Claude Code in VS Code, macOS/Linux:
     "$(ls -d ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude | sort -V | tail -n 1)" mcp add --scope user stonecut-map-builder -- npx -y stonecut-map-builder
   If you are running inside VS Code, give me the VS Code command. To restart in VS Code I run
   "Developer: Reload Window" from the command palette.

2. Install the map-builder skill. Run: npx -y stonecut-map-builder --skill-path
   It prints the folder of the bundled skill. Ask me, then copy that map-builder folder into my
   personal skills folder (for Claude Code: ~/.claude/skills/map-builder). Read the skill and
   follow it from now on.

3. Call status. Tell me in plain words what my safety settings are, where the settings file is,
   and whether I already have a test server.

4. Ask me which Minecraft Java version I play and whether I use a modpack. Recommend a separate
   test server. Then call plan_setup and show me the plan: what will be downloaded, from where,
   the folder and the ports. If Java is missing, tell me which version and where to get it, and
   wait until I have it.

5. Only after I say yes, create the server. Then show me the Minecraft EULA link and ask me
   whether I accept it. Do not accept it for me.

6. Start the server and tell me exactly how to join it from Minecraft. Offer to make me operator.

Rules: only use the local test server on this computer, never another server. Install nothing
without my yes. Back up before big changes. Tell me what you are about to change before you
change it.
```

## What the person sees

1. The agent confirms the tool is connected (or gives the command to add it and asks for a restart).
2. It asks to copy the skill, then lists the safety settings in plain words.
3. It asks for the Minecraft version and modpack, and shows the plan: the Mojang (and NeoForged)
   downloads with their hashes, the folder and the ports.
4. After their yes it creates the server and shows the EULA link.
5. After they accept, it starts the server and gives the join address, for example `localhost:25565`.
