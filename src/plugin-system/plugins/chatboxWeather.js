import { getJson } from '../http';
import { registerChatboxSource } from '../chatbox';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/**
 * WMO weather interpretation codes, condensed to an icon per band.
 * https://open-meteo.com/en/docs
 *
 * @param {number} code
 * @returns {string}
 */
export function weatherIcon(code) {
    if (code === 0) return '☀️';
    if (code <= 2) return '🌤️';
    if (code === 3) return '☁️';
    if (code <= 48) return '🌫️';
    if (code <= 57) return '🌦️';
    if (code <= 67) return '🌧️';
    if (code <= 77) return '🌨️';
    if (code <= 82) return '🌧️';
    if (code <= 86) return '🌨️';
    return '⛈️';
}

/**
 * Current conditions for a named location, via Open-Meteo (no API key needed).
 *
 * @type {import('../registry').PluginManifest}
 */
export const chatboxWeatherPlugin = {
    id: 'chatbox-weather',
    name: 'Chatbox: Weather',
    nameKey: 'view.plugins.items.chatbox_weather.name',
    descriptionKey: 'view.plugins.items.chatbox_weather.description',
    description:
        'Adds current weather for a location of your choice, powered by Open-Meteo.',
    icon: 'ri-cloud-line',
    category: 'chatbox',
    requires: ['osc-chatbox'],
    tags: ['chatbox', 'weather'],
    settingsSchema: [
        {
            key: 'location',
            type: 'string',
            label: 'Location',
            description: 'City name, e.g. "Berlin" or "Portland, US".',
            default: ''
        },
        {
            key: 'units',
            type: 'select',
            label: 'Units',
            default: 'celsius',
            options: [
                { value: 'celsius', label: 'Celsius' },
                { value: 'fahrenheit', label: 'Fahrenheit' }
            ]
        },
        {
            key: 'showLocationName',
            type: 'boolean',
            label: 'Show location name',
            default: false
        },
        {
            key: 'refreshMinutes',
            type: 'number',
            label: 'Refresh every (minutes)',
            default: 15,
            min: 5,
            max: 240
        },
        {
            key: 'order',
            type: 'number',
            label: 'Position',
            default: 60,
            min: 0,
            max: 999
        }
    ],

    async setup(ctx) {
        const settings = ctx.settings;
        if (!settings.location) {
            ctx.setStatus(
                'Set a location in this plugin’s settings.',
                'warning'
            );
            return;
        }

        let place = null;
        let current = null;

        async function resolvePlace() {
            const url = `${GEOCODE_URL}?name=${encodeURIComponent(settings.location)}&count=1&format=json`;
            const json = await getJson(url);
            const result = json?.results?.[0];
            if (!result) {
                throw new Error(`No match for "${settings.location}"`);
            }
            place = {
                name: result.name,
                latitude: result.latitude,
                longitude: result.longitude
            };
        }

        async function refresh() {
            try {
                if (!place) {
                    await resolvePlace();
                }
                const url =
                    `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
                    `&current=temperature_2m,weather_code&temperature_unit=${settings.units}`;
                const json = await getJson(url);
                if (!json?.current) {
                    throw new Error('Malformed forecast response');
                }
                current = {
                    temperature: Math.round(json.current.temperature_2m),
                    code: json.current.weather_code,
                    unit: settings.units === 'fahrenheit' ? '°F' : '°C'
                };
                ctx.setStatus(
                    `${place.name}: ${current.temperature}${current.unit}`,
                    'ok'
                );
            } catch (err) {
                ctx.setStatus(
                    err instanceof Error ? err.message : String(err),
                    'warning'
                );
            }
        }

        await refresh();
        ctx.interval(
            () => {
                refresh().catch((err) =>
                    ctx.error('weather refresh failed', err)
                );
            },
            settings.refreshMinutes * 60 * 1000
        );

        const unregister = registerChatboxSource({
            id: ctx.id,
            label: 'Weather',
            order: settings.order,
            render() {
                if (!current) {
                    return null;
                }
                const prefix =
                    settings.showLocationName && place ? `${place.name} ` : '';
                return `${prefix}${weatherIcon(current.code)} ${current.temperature}${current.unit}`;
            }
        });
        ctx.onDispose(unregister);
    }
};
