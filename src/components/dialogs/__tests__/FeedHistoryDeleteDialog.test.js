import { beforeEach, describe, expect, test, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const mocks = vi.hoisted(() => ({
    countFeedHistory: vi.fn(),
    deleteFeedHistory: vi.fn(),
    getSqliteTableSizes: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn()
}));

const stubs = vi.hoisted(() => ({
    Dialog: {
        name: 'DialogStub',
        props: ['open'],
        emits: ['update:open'],
        template: '<div v-if="open" data-testid="dialog"><slot /></div>'
    },
    Select: {
        name: 'SelectStub',
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template: '<div data-testid="period" :data-value="modelValue"><slot /></div>'
    }
}));

vi.mock('vue-i18n', () => ({
    useI18n: () => ({
        t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key)
    })
}));

vi.mock('vue-sonner', () => ({
    toast: {
        success: (...args) => mocks.toastSuccess(...args),
        error: (...args) => mocks.toastError(...args)
    }
}));

vi.mock('../../../services/database/feedHistory', () => ({
    FEED_HISTORY_TYPES: ['GPS', 'Online', 'Offline', 'Status', 'Avatar', 'Bio', 'Plugin']
}));

vi.mock('../../../stores', () => ({
    useFeedStore: () => ({
        countFeedHistory: mocks.countFeedHistory,
        deleteFeedHistory: mocks.deleteFeedHistory
    }),
    useAdvancedSettingsStore: () => ({
        getSqliteTableSizes: mocks.getSqliteTableSizes
    })
}));

vi.mock('@/components/ui/dialog', () => ({
    Dialog: stubs.Dialog,
    DialogContent: { template: '<div><slot /></div>' },
    DialogDescription: { template: '<div><slot /></div>' },
    DialogFooter: { template: '<div><slot /></div>' },
    DialogHeader: { template: '<div><slot /></div>' },
    DialogTitle: { template: '<div><slot /></div>' }
}));

vi.mock('@/components/ui/select', () => ({
    Select: stubs.Select,
    SelectContent: { template: '<div><slot /></div>' },
    SelectGroup: { template: '<div><slot /></div>' },
    SelectItem: { props: ['value'], template: '<div><slot /></div>' },
    SelectTrigger: { template: '<div><slot /></div>' },
    SelectValue: { template: '<span />' }
}));

vi.mock('@/components/ui/alert', () => ({
    Alert: { template: '<div><slot /></div>' },
    AlertDescription: { template: '<div><slot /></div>' }
}));

vi.mock('@/components/ui/button', () => ({
    Button: {
        props: ['disabled'],
        emits: ['click'],
        template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>'
    }
}));

vi.mock('@/components/ui/checkbox', () => ({
    Checkbox: {
        props: ['modelValue', 'disabled'],
        emits: ['update:modelValue'],
        template:
            '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />'
    }
}));

vi.mock('@/components/ui/spinner', () => ({ Spinner: { template: '<span />' } }));

vi.mock('lucide-vue-next', () => ({
    Trash2: { template: '<span />' },
    TriangleAlert: { template: '<span />' }
}));

import FeedHistoryDeleteDialog from '../FeedHistoryDeleteDialog.vue';

const COUNTS = { GPS: 10, Online: 5, Offline: 5, Status: 2, Avatar: 1, Bio: 0, Plugin: 3 };

/**
 * @returns {{ promise: Promise<any>; resolve: (value: any) => void; reject: (err: any) => void }}
 */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function summary(wrapper) {
    return wrapper.get('[data-testid="summary"]').text();
}

function deleteButton(wrapper) {
    return wrapper.findAll('button').find((button) => button.text().includes('dialog.feed_history_delete.'));
}

async function openDialog() {
    const wrapper = mount(FeedHistoryDeleteDialog, { props: { open: true } });
    await flushPromises();
    return wrapper;
}

describe('FeedHistoryDeleteDialog', () => {
    beforeEach(() => {
        Object.values(mocks).forEach((fn) => fn.mockReset());
        mocks.countFeedHistory.mockResolvedValue({ ...COUNTS });
        mocks.deleteFeedHistory.mockResolvedValue(26);
        mocks.getSqliteTableSizes.mockResolvedValue(undefined);
    });

    test('counts every type older than a year when opened', async () => {
        const before = Date.now();
        const wrapper = await openDialog();

        expect(mocks.countFeedHistory).toHaveBeenCalledTimes(1);
        const [types, cutoff] = mocks.countFeedHistory.mock.calls[0];
        expect(types).toEqual(['GPS', 'Online', 'Offline', 'Status', 'Avatar', 'Bio', 'Plugin']);
        const days = (before - new Date(cutoff).getTime()) / 86400000;
        expect(days).toBeGreaterThan(364);
        expect(days).toBeLessThan(367);
        expect(wrapper.get('[data-type="GPS"]').text()).toContain('10');
        expect(summary(wrapper)).toContain('"count":"26"');
        expect(deleteButton(wrapper).attributes('disabled')).toBeUndefined();
    });

    test('does not count until it is opened', async () => {
        mount(FeedHistoryDeleteDialog, { props: { open: false } });
        await flushPromises();

        expect(mocks.countFeedHistory).not.toHaveBeenCalled();
    });

    test('keeps delete disabled while counting', async () => {
        mocks.countFeedHistory.mockReturnValue(new Promise(() => {}));
        const wrapper = mount(FeedHistoryDeleteDialog, { props: { open: true } });
        await flushPromises();

        expect(summary(wrapper)).toBe('dialog.feed_history_delete.counting');
        expect(deleteButton(wrapper).attributes('disabled')).toBeDefined();
    });

    test('only totals the ticked types', async () => {
        const wrapper = await openDialog();

        await wrapper.get('[data-type="GPS"] input').setValue(false);

        expect(summary(wrapper)).toContain('"count":"16"');
    });

    test('says so when no type is ticked', async () => {
        const wrapper = await openDialog();

        for (const input of wrapper.findAll('input[type="checkbox"]')) {
            await input.setValue(false);
        }

        expect(summary(wrapper)).toBe('dialog.feed_history_delete.no_types');
        expect(deleteButton(wrapper).attributes('disabled')).toBeDefined();
    });

    test('says so when nothing matches', async () => {
        mocks.countFeedHistory.mockResolvedValue({ GPS: 0, Online: 0, Offline: 0, Status: 0, Avatar: 0, Bio: 0 });
        const wrapper = await openDialog();

        expect(summary(wrapper)).toBe('dialog.feed_history_delete.nothing');
        expect(deleteButton(wrapper).attributes('disabled')).toBeDefined();
    });

    test('recounts without a cutoff for entries of any age', async () => {
        const wrapper = await openDialog();

        wrapper.findComponent(stubs.Select).vm.$emit('update:modelValue', 'all');
        await flushPromises();

        expect(mocks.countFeedHistory).toHaveBeenLastCalledWith(expect.any(Array), null);
    });

    test('ignores a count that finished after the period changed', async () => {
        const slow = deferred();
        mocks.countFeedHistory.mockReturnValueOnce(slow.promise).mockResolvedValueOnce({ GPS: 1 });
        const wrapper = mount(FeedHistoryDeleteDialog, { props: { open: true } });
        await flushPromises();

        wrapper.findComponent(stubs.Select).vm.$emit('update:modelValue', '30');
        await flushPromises();
        slow.resolve({ ...COUNTS });
        await flushPromises();

        expect(summary(wrapper)).toContain('"count":"1"');
    });

    test('deletes the ticked types with the cutoff that was counted, then closes', async () => {
        const wrapper = await openDialog();
        const [, countedCutoff] = mocks.countFeedHistory.mock.calls[0];
        await wrapper.get('[data-type="Plugin"] input').setValue(false);

        await deleteButton(wrapper).trigger('click');
        await flushPromises();

        expect(mocks.deleteFeedHistory).toHaveBeenCalledWith(
            ['GPS', 'Online', 'Offline', 'Status', 'Avatar', 'Bio'],
            countedCutoff
        );
        expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('"count":"26"'));
        expect(mocks.getSqliteTableSizes).toHaveBeenCalled();
        expect(wrapper.emitted('update:open')).toEqual([[false]]);
    });

    test('stays open and recounts when the delete fails', async () => {
        mocks.deleteFeedHistory.mockRejectedValue(new Error('database is locked'));
        const wrapper = await openDialog();

        await deleteButton(wrapper).trigger('click');
        await flushPromises();

        expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('database is locked'));
        expect(wrapper.emitted('update:open')).toBeUndefined();
        expect(mocks.countFeedHistory).toHaveBeenCalledTimes(2);
    });

    test('says how much was deleted when it stopped part way', async () => {
        mocks.deleteFeedHistory.mockRejectedValue(
            Object.assign(new Error('database or disk is full'), { deletedSoFar: 1234 })
        );
        const wrapper = await openDialog();

        await deleteButton(wrapper).trigger('click');
        await flushPromises();

        expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('dialog.feed_history_delete.partial'));
        expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('1,234'));
        expect(wrapper.emitted('update:open')).toBeUndefined();
    });

    test('cannot be dismissed while deleting', async () => {
        const slow = deferred();
        mocks.deleteFeedHistory.mockReturnValue(slow.promise);
        const wrapper = await openDialog();

        await deleteButton(wrapper).trigger('click');
        wrapper.findComponent(stubs.Dialog).vm.$emit('update:open', false);

        expect(wrapper.emitted('update:open')).toBeUndefined();
        slow.resolve(1);
        await flushPromises();
        expect(wrapper.emitted('update:open')).toEqual([[false]]);
    });

    test('goes back to the cautious defaults after closing', async () => {
        const wrapper = await openDialog();
        wrapper.findComponent(stubs.Select).vm.$emit('update:modelValue', 'all');
        await flushPromises();

        await wrapper.setProps({ open: false });
        await wrapper.setProps({ open: true });
        await flushPromises();

        const [, cutoff] = mocks.countFeedHistory.mock.calls.at(-1);
        expect(cutoff).not.toBeNull();
    });
});
