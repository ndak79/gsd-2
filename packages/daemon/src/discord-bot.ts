/**
 * DiscordBot — wraps discord.js Client with login/destroy lifecycle, auth guard,
 * and integration with the daemon's SessionManager.
 *
 * Auth model (D016): single Discord user ID allowlist. All non-owner interactions
 * silently ignored; rejections logged at debug level (userId only, no PII).
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  type Interaction,
  type Guild,
} from 'discord.js';
import type { DaemonConfig, VerbosityLevel } from './types.js';
import type { Logger } from './logger.js';
import type { SessionManager } from './session-manager.js';
import { ChannelManager } from './channel-manager.js';
import { buildCommands, registerGuildCommands, formatSessionStatus } from './commands.js';
import type { EventBridge } from './event-bridge.js';

// ---------------------------------------------------------------------------
// Pure helpers — exported for testability
// ---------------------------------------------------------------------------

/**
 * Auth guard: returns true iff userId matches the configured owner_id.
 * Rejects empty or missing ownerId to fail closed.
 */
export function isAuthorized(userId: string, ownerId: string): boolean {
  if (!ownerId || !userId) return false;
  return userId === ownerId;
}

/**
 * Validates that all required discord config fields are present.
 * Throws with a descriptive message on the first missing field.
 */
export function validateDiscordConfig(
  config: DaemonConfig['discord'],
): asserts config is NonNullable<DaemonConfig['discord']> {
  if (!config) {
    throw new Error('Discord config is undefined');
  }
  if (!config.token || config.token.trim() === '') {
    throw new Error('Discord config missing required field: token');
  }
  if (!config.guild_id || config.guild_id.trim() === '') {
    throw new Error('Discord config missing required field: guild_id');
  }
  if (!config.owner_id || config.owner_id.trim() === '') {
    throw new Error('Discord config missing required field: owner_id');
  }
}

// ---------------------------------------------------------------------------
// DiscordBot class
// ---------------------------------------------------------------------------

export interface DiscordBotOptions {
  config: NonNullable<DaemonConfig['discord']>;
  logger: Logger;
  sessionManager: SessionManager;
}

export class DiscordBot {
  private client: Client | null = null;
  private destroyed = false;
  private channelManager: ChannelManager | null = null;
  private eventBridge: EventBridge | null = null;

  private readonly config: NonNullable<DaemonConfig['discord']>;
  private readonly logger: Logger;
  private readonly sessionManager: SessionManager;

  constructor(opts: DiscordBotOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.sessionManager = opts.sessionManager;
  }

  /**
   * Create the discord.js Client, register event handlers, and log in.
   * Throws on login failure — the caller (Daemon) decides whether to continue without the bot.
   */
  async login(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    client.once('ready', (readyClient) => {
      const guildNames = readyClient.guilds.cache.map((g) => g.name).join(', ');
      this.logger.info('bot ready', {
        username: readyClient.user.tag,
        guilds: guildNames,
      });

      // Register slash commands for the configured guild
      const rest = new REST({ version: '10' }).setToken(this.config.token);
      const commands = buildCommands();
      registerGuildCommands(
        rest,
        readyClient.user.id,
        this.config.guild_id,
        commands,
        this.logger,
      ).catch((err) => {
        // Should not reach here — registerGuildCommands catches internally
        this.logger.warn('unexpected command registration error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    client.on('interactionCreate', (interaction: Interaction) => {
      this.handleInteraction(interaction);
    });

    await client.login(this.config.token);
    this.client = client;
    this.destroyed = false;
  }

  /**
   * Destroy the discord.js Client. Idempotent — safe to call multiple times
   * or before login().
   */
  async destroy(): Promise<void> {
    if (this.destroyed || !this.client) {
      this.destroyed = true;
      return;
    }

    try {
      // discord.js destroy() is synchronous but may throw on double-destroy
      this.client.destroy();
      this.logger.info('bot destroyed');
    } catch (err) {
      // Swallow cleanup errors — shutdown must not fail
      this.logger.debug('bot destroy error (swallowed)', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.client = null;
      this.destroyed = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  /**
   * Lazily create a ChannelManager from the configured guild.
   * Returns null if the client isn't ready or the guild isn't found.
   */
  getChannelManager(): ChannelManager | null {
    if (this.channelManager) return this.channelManager;
    if (!this.client?.isReady()) return null;

    const guild = this.client.guilds.cache.get(this.config.guild_id);
    if (!guild) {
      this.logger.warn('guild not found for channel manager', { guildId: this.config.guild_id });
      return null;
    }

    this.channelManager = new ChannelManager({ guild, logger: this.logger });
    return this.channelManager;
  }

  /**
   * Return the underlying discord.js Client, or null if not logged in.
   * Used by Daemon to pass to EventBridge as BridgeClient.
   */
  getClient(): Client | null {
    return this.client;
  }

  /**
   * Set the EventBridge reference so the bot can dispatch /gsd-verbose commands.
   * Called by Daemon after creating the EventBridge.
   */
  setEventBridge(bridge: EventBridge): void {
    this.eventBridge = bridge;
  }

  // ---------------------------------------------------------------------------
  // Private: interaction handling
  // ---------------------------------------------------------------------------

  private handleInteraction(interaction: Interaction): void {
    if (!isAuthorized(interaction.user.id, this.config.owner_id)) {
      this.logger.debug('auth rejected', { userId: interaction.user.id });
      return;
    }

    // Only handle chat input (slash) commands
    if (!interaction.isChatInputCommand()) {
      this.logger.debug('non-command interaction', {
        type: interaction.type,
        userId: interaction.user.id,
      });
      return;
    }

    const { commandName } = interaction;
    this.logger.info('command handled', { commandName, userId: interaction.user.id });

    switch (commandName) {
      case 'gsd-status': {
        const sessions = this.sessionManager.getAllSessions();
        const content = formatSessionStatus(sessions);
        interaction.reply({ content, ephemeral: true }).catch((err) => {
          this.logger.warn('gsd-status reply failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      }
      case 'gsd-start':
      case 'gsd-stop':
        interaction.reply({ content: 'Coming soon — use #gsd-control', ephemeral: true }).catch((err) => {
          this.logger.warn(`${commandName} reply failed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      case 'gsd-verbose': {
        if (!this.eventBridge) {
          interaction.reply({ content: 'Event bridge not available.', ephemeral: true }).catch((err) => {
            this.logger.warn('gsd-verbose reply failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
          break;
        }
        const level = (interaction.options.getString('level') ?? 'default') as VerbosityLevel;
        const channelId = interaction.channelId;
        this.eventBridge.getVerbosityManager().setLevel(channelId, level);
        interaction.reply({ content: `Verbosity set to **${level}** for this channel.`, ephemeral: true }).catch((err) => {
          this.logger.warn('gsd-verbose reply failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      }
      default:
        interaction.reply({ content: 'Unknown command', ephemeral: true }).catch((err) => {
          this.logger.warn('unknown command reply failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        break;
    }
  }
}
