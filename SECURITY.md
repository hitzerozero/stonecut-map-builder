# Security

## Reporting a problem

Please report security problems privately through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability**. Do not open a public issue for a security problem.

Include what you did, what happened, what you expected, and the tool version
(`npx -y stonecut-map-builder --version`). We aim to answer within 7 days and to publish a fix
and an advisory once it is fixed.

## Supported versions

Only the latest released version gets security fixes.

## What counts

Anything that breaks the safety rules in the [reference](docs/reference.md#safety), for example:

- a path that reads or writes outside the test server folder, or into the tool's own `.stonecut` folder;
- RCON or the test server becoming reachable from another computer;
- a way to run a program, or to add a mod or other code, while `allowModInstall` is off;
- the RCON password reaching the agent;
- a download from a source other than Mojang or NeoForged, or one used without a matching hash;
- a tool that changes something while marked read-only;
- a way to accept the Minecraft EULA or install something without the person's yes;
- block names, file contents or schematic data that make the tool send a command nobody asked for.
  Command blocks and functions inside a schematic or datapack are content the game runs, not a
  flaw in the tool (see Limits in the reference).

Problems in Minecraft, NeoForge, Java or your agent itself should go to those projects.
