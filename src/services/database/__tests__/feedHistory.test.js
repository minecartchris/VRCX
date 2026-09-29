import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execute: vi.fn(),
    executeNonQuery: vi.fn()
}));

vi.mock('../../sqlite.js', () => ({
    default: {
        execute: mocks.execute,
        executeNonQuery: mocks.executeNonQuery
    }
}));
vi.mock('../index.js', () => ({
    dbVars: {
        userPrefix: 'usr1'
    }
}));

import { FEED_HISTORY_TYPES, feedHistory } from '../feedHistory.js';

describe('feedHistory', () => {
    beforeEach(() => {
        mocks.execute.mockReset();
        mocks.executeNonQuery.mockReset();
    });

    test('covers every Feed page type', () => {
        expect(FEED_HISTORY_TYPES).toEqual(['GPS', 'Online', 'Offline', 'Status', 'Avatar', 'Bio', 'Plugin']);
    });

    test('indexes every friend-event feed table by time', async () => {
        await feedHistory.createFeedHistoryIndexes();

        expect(mocks.executeNonQuery.mock.calls.map(([sql]) => sql)).toEqual([
            'CREATE INDEX IF NOT EXISTS usr1_feed_gps_created_idx ON usr1_feed_gps (created_at)',
            'CREATE INDEX IF NOT EXISTS usr1_feed_online_offline_created_idx ON usr1_feed_online_offline (created_at)',
            'CREATE INDEX IF NOT EXISTS usr1_feed_status_created_idx ON usr1_feed_status (created_at)',
            'CREATE INDEX IF NOT EXISTS usr1_feed_avatar_created_idx ON usr1_feed_avatar (created_at)',
            'CREATE INDEX IF NOT EXISTS usr1_feed_bio_created_idx ON usr1_feed_bio (created_at)'
        ]);
    });

    test('keeps going when one index cannot be built', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.executeNonQuery.mockRejectedValueOnce(new Error('database or disk is full'));

        await expect(feedHistory.createFeedHistoryIndexes()).resolves.toBeUndefined();

        expect(mocks.executeNonQuery).toHaveBeenCalledTimes(5);
        consoleError.mockRestore();
    });

    describe('countFeedHistory', () => {
        test('counts each type older than the cutoff', async () => {
            mocks.execute.mockImplementation(async (callback, sql) => {
                callback([sql.includes('feed_gps') ? 12 : 3]);
            });

            const counts = await feedHistory.countFeedHistory(['GPS', 'Online'], '2026-01-01T00:00:00.000Z');

            expect(counts).toEqual({ GPS: 12, Online: 3 });
            expect(mocks.execute.mock.calls[0][1]).toBe(
                'SELECT COUNT(*) FROM usr1_feed_gps WHERE created_at < @cutoff'
            );
            expect(mocks.execute.mock.calls[0][2]).toEqual({ '@cutoff': '2026-01-01T00:00:00.000Z' });
            expect(mocks.execute.mock.calls[1][1]).toBe(
                'SELECT COUNT(*) FROM usr1_feed_online_offline WHERE type = @type AND created_at < @cutoff'
            );
            expect(mocks.execute.mock.calls[1][2]).toEqual({
                '@type': 'Online',
                '@cutoff': '2026-01-01T00:00:00.000Z'
            });
        });

        test('counts every entry when there is no cutoff', async () => {
            mocks.execute.mockImplementation(async (callback) => callback([7]));

            await feedHistory.countFeedHistory(['Bio'], null);

            expect(mocks.execute.mock.calls[0][1]).toBe('SELECT COUNT(*) FROM usr1_feed_bio');
            expect(mocks.execute.mock.calls[0][2]).toBeNull();
        });

        test('ignores types that are not feed types', async () => {
            mocks.execute.mockImplementation(async (callback) => callback([1]));

            const counts = await feedHistory.countFeedHistory(['GPS', 'users; DROP TABLE x', 'GPS'], null);

            expect(counts).toEqual({ GPS: 1 });
            expect(mocks.execute).toHaveBeenCalledTimes(1);
        });
    });

    describe('deleteFeedHistory', () => {
        test('deletes only the chosen types, older than the cutoff', async () => {
            mocks.executeNonQuery.mockResolvedValueOnce(5).mockResolvedValueOnce(2);

            const deleted = await feedHistory.deleteFeedHistory(['Offline', 'Plugin'], '2026-01-01T00:00:00.000Z');

            expect(deleted).toBe(7);
            expect(mocks.executeNonQuery).toHaveBeenCalledTimes(2);
            expect(mocks.executeNonQuery.mock.calls[0]).toEqual([
                'DELETE FROM usr1_feed_online_offline WHERE type = @type AND created_at < @cutoff',
                { '@type': 'Offline', '@cutoff': '2026-01-01T00:00:00.000Z' }
            ]);
            expect(mocks.executeNonQuery.mock.calls[1]).toEqual([
                'DELETE FROM usr1_feed_plugin WHERE created_at < @cutoff',
                { '@cutoff': '2026-01-01T00:00:00.000Z' }
            ]);
        });

        test('deletes every entry of a type when there is no cutoff', async () => {
            mocks.executeNonQuery.mockResolvedValue(40);

            await feedHistory.deleteFeedHistory(['Avatar'], null);

            expect(mocks.executeNonQuery).toHaveBeenCalledWith('DELETE FROM usr1_feed_avatar', null);
        });

        test('says how many entries were already deleted when a later type fails', async () => {
            mocks.executeNonQuery.mockResolvedValueOnce(5).mockRejectedValueOnce(new Error('database or disk is full'));

            const failure = await feedHistory.deleteFeedHistory(['GPS', 'Bio', 'Plugin'], null).catch((err) => err);

            expect(failure.message).toBe('database or disk is full');
            expect(failure.deletedSoFar).toBe(5);
            expect(mocks.executeNonQuery).toHaveBeenCalledTimes(2);
        });

        test('touches nothing when no known type is given', async () => {
            const deleted = await feedHistory.deleteFeedHistory(['gamelog_location'], null);

            expect(deleted).toBe(0);
            expect(mocks.executeNonQuery).not.toHaveBeenCalled();
        });
    });
});
