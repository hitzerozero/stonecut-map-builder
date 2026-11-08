# Stonecut Map Builder: full reference

Everything the tool does, every tool, every safety rule and setting, and its limits. For setup, see the [README](../README.md).

## What it does

- Sets up a test server for the Minecraft version you choose (1.20.1 or newer), vanilla or
  NeoForge. It finds Java on your computer and tells you what is missing and where to get it. It
  downloads only from Mojang and NeoForged, checks every file against the published hash, and
  installs nothing until you say yes.
- Starts, stops and restarts the server, and shows its log.
- Runs any server command, including commands from mods and datapacks.
- Places, fills, copies and clears blocks, packed into as few commands as possible.
- Reads the blocks in an area, with their full states and block data, so the agent can check and
  fix its work. Lists the entities in an area too.
- Reads and writes files inside the server folder: datapacks, configs and, if you allow it, mods.
- Imports a `.schem` file (Sponge schematic version 2 or 3, as WorldEdit saves) into the world, and
  exports an area to `.schem`, entities included: item frames with their item and rotation,
  paintings, armor stands with gear and pose, mobs with their data, minecarts and boats. Copies get
  new UUIDs, leads stay tied (to a fence or to another mob) and riders stay seated.
- Saves the area, entities included, before each change so the last change can be undone, and backs
  up the whole world on request.

## How it works

- **MCP server.** A Node.js program your agent starts. It offers the tools listed below and checks
  every input before anything runs.
- **Skill.** `skills/map-builder/SKILL.md`, in the open SKILL.md format. It tells the agent to ask
  the setup questions, confirm with you before installing or deleting anything, plan builds, build
  in steps, read back each step and back up first. For anything new (levels, portals, quests, mobs)
  the agent works out what it needs, tells you, and offers to set it up.
- **Test server.** A normal Minecraft server in its own folder, listening on 127.0.0.1 only, so only
  your computer can join. It runs in the background and keeps running between agent sessions.
- **RCON.** Minecraft's built-in remote console. The tool turns it on with a random password stored
  in the server's `server.properties`, and only connects to 127.0.0.1. Block changes are sent as
  commands over RCON. To read blocks and entities, the tool asks the server to save (`save-all flush`)
  and then reads the saved region and entity files directly. It never writes to them. Entities are
  placed with `/summon` after the blocks, so frames and paintings have a wall to hang on.
- **Add-on (later).** An optional server mod for NeoForge that will make reading, import and export
  fast for big maps. It is not available yet; everything above works without it.

## Requirements

- Node.js 20 or newer.
- Java for your Minecraft version: Java 17 for 1.20.1 to 1.20.4, Java 21 for 1.20.5 to 1.21.11,
  Java 25 for 26.1 and newer. The tool reads the exact version from Mojang and says if it is
  missing. Free builds: Eclipse Temurin (https://adoptium.net) or the Microsoft Build of OpenJDK.
- Minecraft Java Edition, to join the test server.
- An agent that supports MCP. Made for Claude Code; other MCP agents should work and are not tested yet.
- About 1 GB of free disk space for a vanilla server, more for NeoForge and big worlds.
- Windows, macOS or Linux.

## Install

### With the AI prompt

Add the tool with the command in step 3 of [Setup](../README.md#setup), then paste the prompt from
[docs/setup-with-ai.md](setup-with-ai.md) into your agent. It checks the connection, installs
the skill after asking you, and walks you through making the test server.

### Manually

1. Add the MCP server to your agent. For Claude Code, the command in step 3 of [Setup](../README.md#setup).
   For other MCP clients, run `npx -y stonecut-map-builder` as a stdio server.
2. From source instead of npm:

       git clone https://github.com/hitzerozero/stonecut-map-builder.git
       cd stonecut-map-builder
       npm install
       claude mcp add --scope user stonecut-map-builder -- node /full/path/to/stonecut-map-builder/dist/index.js

3. Install the skill. `npx -y stonecut-map-builder --skill-path` prints the folder of the bundled
   skill. Copy that `map-builder` folder into your agent's skills folder; for Claude Code that is
   `~/.claude/skills/map-builder` (all projects) or `.claude/skills/map-builder` in one project.
4. Optional: `npx -y stonecut-map-builder --init-config` writes the settings file with every
   setting at its default, and `--config-path` prints where it is. See [Safety](#safety).
5. In your agent, ask it to call `status`, then to set up a test server.

## The tools

| Tool | What it does | Read-only or changes things |
|---|---|---|
| `status` | Shows your safety settings, the active test server, Java found, undo history and world backups | Read-only |
| `plan_setup` | Looks up the exact versions, Java needed, every download with its source and hash, the folder and ports. Changes nothing | Read-only (contacts Mojang and NeoForged) |
| `create_server` | Carries out a plan after you said yes: downloads, checks hashes, writes the server settings | Changes things |
| `accept_eula` | Records that you accepted the Minecraft EULA, after the agent showed you the link and asked | Changes things |
| `use_server` | Switches to another server folder inside an allowed folder | Changes things |
| `start_server` | Starts the server in the background and waits until it answers | Changes things |
| `stop_server` | Stops the server cleanly (the world is saved) | Changes things |
| `restart_server` | Stops and starts the server | Changes things |
| `server_logs` | The last lines of the server log, optionally filtered | Read-only |
| `run_command` | Runs any server command and returns the reply; can save an area first for undo | Changes things |
| `place_blocks` | Places up to 10000 single blocks, packed into fills; supports block data | Changes things |
| `fill_blocks` | Fills boxes, also hollow, outline, keep or replace-only | Changes things |
| `copy_blocks` | Copies a box to another place | Changes things |
| `clear_blocks` | Sets a box to air and removes its entities (without drops) | Changes things |
| `read_blocks` | Returns the blocks in a box with full states and block entity ids | Read-only |
| `read_entities` | Lists the entities in a box with position, rotation, UUID, name, lead and data | Read-only |
| `undo` | Puts back the area changed by the last change, blocks and entities | Changes things |
| `import_schematic` | Pastes a `.schem` (v2 or v3) from the server folder into the world, entities included | Changes things |
| `export_schematic` | Saves a box as a `.schem` (v3 or v2) in the server folder, entities included | Changes things (writes a file) |
| `backup_world` | Copies the whole world into the server's backup folder | Changes things (adds a backup) |
| `restore_world` | Replaces the world with a backup; the current world is kept as a backup | Changes things |
| `list_files` | Lists files in the server folder | Read-only |
| `read_file` | Reads a file in the server folder | Read-only |
| `write_file` | Writes a file in the server folder | Changes things |

Every tool carries the MCP annotations `readOnlyHint`, `destructiveHint`, `idempotentHint` and
`openWorldHint`, so your agent can ask you before tools that change things.

## Safety

The safety rules are in the tool itself, not in agent settings, so they hold for any agent.

- **This computer only.** The test server listens on 127.0.0.1. RCON listens on 127.0.0.1 and the
  tool only connects to 127.0.0.1. Before every start the tool puts back `server-ip=127.0.0.1`, RCON
  on, its RCON port and password, the query port off and RCON output to players off, even if a file
  edit changed them. There is no setting to connect to another computer.
- **Allowed folders only.** Servers can only be made or used inside the allowed server folders.
  File tools work inside the active server's folder only. Absolute paths, `..`, Windows device
  names and paths that leave the folder through a symlink or junction are refused. The tool's own
  state folder (`.stonecut`), `eula.txt`, `level.dat` and the world's chunk files cannot be written
  through the file tools.
- **Official downloads with hash checks.** Server files come only over https from Mojang
  (piston-meta.mojang.com, piston-data.mojang.com) and NeoForged (maven.neoforged.net), and are
  checked against the hash they publish. A file with a wrong hash is deleted and nothing is
  installed. Java is never installed by the tool.
- **Your yes first.** `create_server` needs a plan from `plan_setup` that the agent showed you,
  and `accept_eula` needs your acceptance. The tool never writes `eula=true` by itself.
- **Undo and backups.** Each block change saves the area first. Areas too big for that are refused
  unless the agent ran `backup_world` and says so. The tool has no command to delete a world, and
  restoring a backup keeps the current world as another backup.
- **Entities.** Players are never copied, summoned or removed. Entity ids are checked before they go
  into a command, entity data goes through the tool's own NBT and SNBT code, every copy gets a new
  UUID, and the number of entities per call is limited (`maxEntities`). Entities are removed without
  loot, and items that drop anyway during a clear are removed too.
- **Size limits and clear errors.** Every change, read, import and file has a size limit. When a
  limit or rule stops something, the error says which one and how to change it.
- **What the tool cannot stop.** Your agent may have other tools, such as a shell, that are not
  bound by these rules. Keep your agent's own permission prompts on.

### Settings

The settings file is yours. The tool reads it at start and never changes it. It lives at:

- Windows: `%APPDATA%\stonecut-map-builder\config.json`
- macOS: `~/Library/Application Support/stonecut-map-builder/config.json`
- Linux: `$XDG_CONFIG_HOME/stonecut-map-builder/config.json`, usually `~/.config/stonecut-map-builder/config.json`

The environment variable `STONECUT_MAP_CONFIG` can point to another file. Every key is optional;
a missing file means all defaults. [config.example.json](../config.example.json) has every setting at
its default. Restart your agent after changing it.

| Setting | Default | What it does |
|---|---|---|
| `serverFolders` | `["~/stonecut-map-builder/servers"]` | Folders test servers may be made in or used from. Full paths, or starting with `~/` for your home folder. |
| `maxFillBlocks` | `100000` | Most blocks one place, fill, copy or clear call may change. |
| `maxReadBlocks` | `32768` | Most blocks one `read_blocks` call may read (for example 32 x 32 x 32). |
| `maxImportBlocks` | `500000` | Most blocks in one imported or exported schematic, and in one undo snapshot. |
| `maxFileBytes` | `10485760` | Largest file `read_file` and `write_file` handle (10 MB). |
| `maxEntities` | `256` | Most entities one export, import, clear, undo snapshot or `read_entities` call may handle. |
| `includeEntities` | `true` | Export, import, clear and undo snapshots include entities. `false` makes them blocks only; each call can also set `include_entities`. |
| `allowFileWrites` | `true` | `false` turns off `write_file` and `export_schematic`. |
| `allowModInstall` | `false` | `true` lets `write_file` add or change mods (`.jar` files and the `mods` folder). |
| `confirmDestructive` | `true` | `clear_blocks`, `import_schematic`, `undo`, `restore_world` and replacing an existing file need `confirm: true`, which the agent sets only after asking you. |
| `autoBackup` | `true` | Save each changed area first so `undo` can put it back. `false` makes changes faster and turns off undo. |
| `undoHistory` | `10` | How many changes can be undone. |
| `rconAddress` | `"127.0.0.1"` | Fixed. Any other value is refused: RCON never listens on a network address in this version. |
| `javaPath` | not set | A specific Java to use, if the one found automatically is not the one you want. |

## Limits

- Local test server only. It does not connect to real or hosted servers.
- Minecraft Java Edition 1.20.1 and newer, vanilla and NeoForge. Fabric, Paper and Forge are not
  tested yet. Bedrock Edition has no RCON and is not supported.
- Tested end to end on Windows with vanilla and NeoForge 1.21.11 servers, through an MCP client.
  The unit tests are set up to run on Windows, macOS and Linux. Other MCP agents are not tested yet.
- The add-on for fast reading, import and export is not available yet. Until then big imports go
  command by command over RCON, and reads are limited per call.
- Entities: players are never copied or removed. An entity counts as inside an area when its position
  is. Entity data longer than RCON allows is split over several commands; a single field that is
  still too long is left out, and the reply says which. Villager memories (job site, home) are not
  copied; villagers find new ones. Lead knots are not saved by the game; they are made again from
  the mob's lead.
- With nobody online, Minecraft 1.21.2 and newer pauses the server (`pause-when-empty-seconds` in
  `server.properties`): mobs, leads and redstone wait until someone joins. Commands and building
  work either way.
- `copy_blocks` copies blocks only, not entities; export and import an area to copy it with its
  entities.
- Block data longer than RCON allows (about 1400 bytes, for example a very full chest) is placed
  without its data, and the reply says where.
- One call can load at most 1024 chunks. Worlds saved with LZ4 chunk compression are not read.
