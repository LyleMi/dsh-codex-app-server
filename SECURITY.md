# Security policy

## Supported versions

Until `1.0.0`, only the latest published prerelease receives security fixes.

## Reporting a vulnerability

Do not open a public issue for suspected credential exposure, command injection, sandbox escape, approval bypass, cross-session event routing, or process cleanup failures. Use GitHub private vulnerability reporting for this repository. Include the affected version, platform, Codex/DSH versions, reproduction steps, impact, and whether logs contain secrets. Remove tokens, account identifiers, auth URLs, and home-directory paths from attachments.

You should receive an acknowledgement within seven days. No bounty or disclosure deadline is promised; coordinated disclosure timing will be agreed after triage.

This plugin does not manage Codex credentials. If an OpenAI account or token may be compromised, also follow OpenAI's account-security process and revoke affected credentials independently.
