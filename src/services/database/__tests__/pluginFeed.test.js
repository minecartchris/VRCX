import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execute: vi.fn()
}));

vi.mock('../../sqlite.js', () => ({
    default: {
        execute: mocks.execute,
        executeNonQuery: vi.fn()
    }
}));
vi.mock('../index.js', () => ({
    dbVars: {
        maxTableSize: 500,
        userPrefix: 'usr1'
    }
}));

import { feed } from '../feed.js';

describe('feed.lookupPluginFeedDatabase', () => {
    beforeEach(() => {
        mocks.execute.mockReset();
        mocks.execute.mockResolvedValue(undefined);
    });

    test('filters to favourites in the query, before the limit', async () => {
        await feed.lookupPluginFeedDatabase('', '', '2026-09-01T00:00:00.000Z', 50, ['usr_a', 'usr_b']);

        const [, sql, args] = mocks.execute.mock.calls[0];
        expect(sql).toContain('AND user_id IN (@vip_0, @vip_1)');
        expect(sql.indexOf('user_id IN')).toBeLessThan(sql.indexOf('LIMIT @limit'));
        expect(args).toMatchObject({
            '@vip_0': 'usr_a',
            '@vip_1': 'usr_b',
            '@dateTo': '2026-09-01T00:00:00.000Z',
            '@limit': 50
        });
    });

    test('reads every plugin entry when there are no favourites to filter by', async () => {
        await feed.lookupPluginFeedDatabase('', '', '', 50);

        expect(mocks.execute.mock.calls[0][1]).not.toContain('user_id IN');
    });
});
