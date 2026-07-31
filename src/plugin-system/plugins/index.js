import { chatboxClockPlugin } from './chatboxClock';
import { chatboxCustomTextPlugin } from './chatboxCustomText';
import { chatboxHeartRatePlugin } from './chatboxHeartRate';
import { chatboxInstanceStatsPlugin } from './chatboxInstanceStats';
import { chatboxNetworkStatsPlugin } from './chatboxNetworkStats';
import { chatboxNowPlayingPlugin } from './chatboxNowPlaying';
import { chatboxSessionStatsPlugin } from './chatboxSessionStats';
import { chatboxSystemStatsPlugin } from './chatboxSystemStats';
import { chatboxWeatherPlugin } from './chatboxWeather';
import { discordWebhookPlugin } from './discordWebhook';
import { friendWatchlistPlugin } from './friendWatchlist';
import { instanceRadarPlugin } from './instanceRadar';
import { joinLeaveTtsPlugin } from './joinLeaveTts';
import { keywordAlertsPlugin } from './keywordAlerts';
import { oscAfkStatusPlugin } from './oscAfkStatus';
import { oscAvatarParametersPlugin } from './oscAvatarParameters';
import { oscChatboxPlugin } from './oscChatbox';
import { playtimeInsightsPlugin } from './playtimeInsights';

/**
 * Every plugin that ships with VRCX. All of them are opt-in: the manager only
 * starts the ones the user has enabled.
 *
 * @type {import('../registry').PluginManifest[]}
 */
export const builtinPlugins = [
    oscChatboxPlugin,
    chatboxClockPlugin,
    chatboxCustomTextPlugin,
    chatboxInstanceStatsPlugin,
    chatboxSystemStatsPlugin,
    chatboxHeartRatePlugin,
    chatboxWeatherPlugin,
    chatboxNowPlayingPlugin,
    chatboxSessionStatsPlugin,
    chatboxNetworkStatsPlugin,
    oscAvatarParametersPlugin,
    oscAfkStatusPlugin,
    friendWatchlistPlugin,
    instanceRadarPlugin,
    joinLeaveTtsPlugin,
    keywordAlertsPlugin,
    discordWebhookPlugin,
    playtimeInsightsPlugin
];
