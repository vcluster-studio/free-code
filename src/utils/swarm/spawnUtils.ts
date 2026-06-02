/**
 * Shared utilities for spawning teammates across different backends.
 */

import { existsSync } from 'fs'
import { basename } from 'node:path'
import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { quote } from '../bash/shellQuote.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { whichSyncOnRealFS } from '../which.js'
import { getTeammateModeFromSnapshot } from './backends/teammateModeSnapshot.js'
import { TEAMMATE_COMMAND_ENV_VAR } from './constants.js'

/**
 * Gets the command to use for spawning teammate processes.
 * Returns a path that is resolvable by real shells (e.g. tmux panes),
 * skipping Bun virtual filesystem paths (/$bunfs/...).
 */
/** Returns true if the path is a Bun virtual filesystem path that won't be
 * resolvable by external shells (e.g. tmux panes). Bun's existsSync sees
 * these inside the VFS, but real shells cannot resolve /$bunfs/root/... */
function isBunfsPath(path: string): boolean {
  return path.startsWith('/$bunfs/')
}

export function getTeammateCommand(): string {
  // 1. User-provided override via environment variable
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }

  // 2. process.execPath is the actual executable path on the real filesystem.
  // In Bun compiled binaries, this is the real path (e.g. /usr/bin/claude)
  // even when argv[0]="bun" and argv[1]=/$bunfs/root/claude.
  if (process.execPath && existsSync(process.execPath) && !isBunfsPath(process.execPath)) {
    return process.execPath
  }

  // 3. argv[0] may be the actual executable path on disk
  const argv0 = process.argv[0]
  if (argv0 && existsSync(argv0) && !isBunfsPath(argv0)) {
    return argv0
  }

  // 4. PATH lookup on the real filesystem (bypasses Bun.which VFS)
  const name = basename(argv0 ?? process.execPath)
  const resolved = whichSyncOnRealFS(name)
  if (resolved) {
    return resolved
  }

  // If nothing works, return the bare name and rely on shell PATH lookup
  return name
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  }

  // Propagate --model if explicitly set via CLI
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // Propagate --settings if set via CLI
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --teammate-mode so tmux teammates use the same mode as leader
  const sessionMode = getTeammateModeFromSnapshot()
  flags.push(`--teammate-mode ${sessionMode}`)

  // Propagate --chrome / --no-chrome if explicitly set on the CLI
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * Environment variables that must be explicitly forwarded to tmux-spawned
 * teammates. Tmux may start a new login shell that doesn't inherit the
 * parent's env, so we forward any that are set in the current process.
 */
const TEAMMATE_ENV_VARS = [
  // API provider selection — without these, teammates default to firstParty
  // and send requests to the wrong endpoint (GitHub issue #23561)
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // Custom API endpoint
  'ANTHROPIC_BASE_URL',
  // Config directory override
  'CLAUDE_CONFIG_DIR',
  // Teammate command override — without this, teammates fall back to
  // broken bunfs virtual paths (/$bunfs/root/...) when spawning their own
  // sub-agents (GitHub issue #23561)
  'CLAUDE_CODE_TEAMMATE_COMMAND',
  // CCR marker — teammates need this for CCR-aware code paths. Auth finds
  // its own way via /home/claude/.claude/remote/.oauth_token regardless;
  // the FD env var wouldn't help (pipe FDs don't cross tmux).
  'CLAUDE_CODE_REMOTE',
  // Auto-memory gate (memdir/paths.ts) checks REMOTE && !MEMORY_DIR to
  // disable memory on ephemeral CCR filesystems. Forwarding REMOTE alone
  // would flip teammates to memory-off when the parent has it on.
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  // Upstream proxy — the parent's MITM relay is reachable from teammates
  // (same container network). Forward the proxy vars so teammates route
  // customer-configured upstream traffic through the relay for credential
  // injection. Without these, teammates bypass the proxy entirely.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const

/**
 * Builds the `env KEY=VALUE ...` string for teammate spawn commands.
 * Always includes CLAUDECODE=1 and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1,
 * plus any provider/config env vars that are set in the current process.
 * Also always sets TEAMMATE_COMMAND to ensure teammates use the correct
 * binary path, avoiding broken bunfs virtual paths on Windows/Bun.
 */
export function buildInheritedEnvVars(): string {
  const envVars = ['CLAUDECODE=1', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1']

  // Always set TEAMMATE_COMMAND so teammates inherit the correct binary path
  // This avoids repeated PATH lookups or broken bunfs virtual paths
  envVars.push(`${TEAMMATE_COMMAND_ENV_VAR}=${quote([getTeammateCommand()])}`)

  for (const key of TEAMMATE_ENV_VARS) {
    // Skip TEAMMATE_COMMAND_ENV_VAR since we already set it above
    if (key === TEAMMATE_COMMAND_ENV_VAR) continue
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      envVars.push(`${key}=${quote([value])}`)
    }
  }

  return envVars.join(' ')
}
